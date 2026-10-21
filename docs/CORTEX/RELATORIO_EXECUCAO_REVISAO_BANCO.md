# Relatório de execução — correção completa do banco (2026-10-14/15)

> Missão: corrigir de verdade os problemas confirmados do banco do CÓRTEX (PostgreSQL + Prisma + RLS), com evidência, sem tocar em bancos compartilhados, staging ou produção, **sem commit, push ou deploy** e **sem criar a conta Super Admin**. Este arquivo lista **o que foi feito, com quais comandos, o que passou, o que falhou (e como foi corrigido) e o que depende de decisão humana ou de infraestrutura**. Análise dos achados: [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md). Decisões: [DECISIONS](DECISIONS.md) (124–142). Resultados de teste em tabela: [resultados-testes](revisao-banco/resultados-testes.md).

## 1. Linha de base

| Item | Observado |
|---|---|
| Ponto de partida | 106 tabelas / 106 modelos; **40** migrations (a revisão anterior deixou pendências confirmadas sem correção: `refresh_tokens`, FK composta nas outras relações, livros mutáveis, `CASCADE`, papel dono × execução, fuso, índices) |
| Ambiente | PostgreSQL 18.6 (Windows, local) e Redis locais; `lnsystem_db` (dev) e `lnsystem_test` (teste), dados sintéticos. Papel de conexão `lnsystem`: não superusuário, sem `BYPASSRLS`, **dono** das tabelas; leitura `lnsystem_backup` (BYPASSRLS, só leitura) |
| Estado final | **57** migrations (55 + 2 da Central de Monitoramento, 2026-10-18/19), `prisma migrate diff` banco → schema **vazio**, 113 tabelas com RLS habilitada e forçada |

## 2. O que foi implementado, por prioridade

**P0 — isolamento e RLS**
- `refresh_tokens`: `tokenHash` (SHA-256, igual em SQL e na aplicação) no lugar do token em texto; `companyId` preenchido só pelo usuário (136 linhas, plataforma continua nula); policy sem o ramo `IS NULL`; **sessões existentes preservadas** (migration `20261014170000`; abortável).
- Referência cruzada entre empresas impossível no banco: FK composta `(companyId, X) → pai(companyId, id)` em **94** relações (`20261014180000`), `companyId → companies` em **65** tabelas e `(companyId, branchId) → branches` em **55** (`20261015100000`), trigger de mesma empresa em 3 referências que não admitem FK composta (`20261015160000`). Cada migration com **guarda** de dados (aborta com dado cruzado); dado legado de empresa inexistente **preservado** com a FK `NOT VALID` (1 recebível no dev).
- Livros append-only por RLS: `stock_movements`, `cash_movements`, `policy_changes`, `service_order_status_history` (`20261015120000`).

**P1 — integridade referencial**
- 21 FKs `CASCADE` → `RESTRICT` sobre histórico/dinheiro/estoque/auditoria (`20261015110000`) e 8 `SET NULL` sem caminho de exclusão → `RESTRICT`.
- Lista das 66 relações avaliada: todas as financeiras/estoque/auth/críticas viraram FK composta; ficaram sem FK apenas `quote_items.productId` (tabela sem `companyId`) e `audit_logs.userId` (retenção) — documentado.

**P2 — migrations e consistência Prisma**
- Schema × banco × `_prisma_migrations`: `migrate diff` **vazio**; checksums conferem (única reconciliação, já documentada: comentário de `20261014160000`; **nenhum** checksum alterado à mão nesta missão); `db:replay-check` reaplica do zero e prova **4 cenários** com dado inconsistente (guarda, atomicidade, recuperação por `migrate resolve --rolled-back`, legado preservado).
- `ticketNumber` e `support_kb_articles_search_idx`: o SQL apresentado **nunca foi migration** (saída do `migrate diff` antigo); o schema passou a descrever os objetos (rodada anterior), diff vazio.

**P3 — qualidade, estabilidade, desempenho**
- Índices: 5 duplicados removidos (+1 anterior) e 13 redundantes com o alvo único `(companyId, id)`; **16 índices ausentes** criados (9 tabelas sem índice por `companyId` + 7 FKs) — `20261015130000`, `…140000`, `…170000`.
- Fuso do banco = UTC (`20261015150000`); nenhum dado alterado.
- Papéis do banco: modelo `deploy/db-runtime-role.sql` + `npm run db:role-split-check` (banco e papel temporários): DDL negado ao papel sem posse, RLS intacta, a suíte de integração **completa (116 suítes / 1614 testes) passa com a aplicação conectada como esse papel**.
- Aplicação: deadlock de convênio corrigido; `RESTRICT` → 409; `Idempotency-Key` expira e é expurgada; detector de cartão sem falso positivo; flakiness de teste explicada e corrigida (§5).

## 3. Arquivos criados e alterados

**Banco:** `packages/database/prisma/schema.prisma` (relações compostas, `@@unique([companyId, id])` em 26 pais, relações de empresa/filial, índices); **14 migrations novas** (`20261014155900` … `20261015170000`, lista em [DECISIONS](DECISIONS.md)); `deploy/db-runtime-role.sql`.

**API:** `services/refresh-token-hash.ts` (novo), `auth.service.ts`, `routes/auth.routes.ts` (hash); `services/db-errors.ts` + teste (novo), `middleware/errorHandler.ts`, `branch.service.ts` (RESTRICT → 409); `employee-agreement.service.ts`, `agreement-company.service.ts`, `payment.service.ts` (`lockForPayment`); `commerce/order.service.ts`, `supplier-return.service.ts` (itens aninhados sem `companyId`: vem do pai); `product.service.ts`, `employee-agreement.service.ts` (tipos *Unchecked*); `middleware/idempotency.ts` (+ teste) e `config/scheduler.ts` (+ teste): expiração e expurgo; `services/support-sensitive.ts` (+ teste): detector de cartão.

**Scripts:** `db-docs.ts`, `db-replay-check.ts` (4 cenários), `db-role-split-check.ts` (novo), `prepare-test-db.ts` (varre órfãs sintéticas só no banco de teste); `package.json` (`db:role-split-check`).

**Testes novos (integração, Postgres/Redis reais):** `company-branch-fk-restrict` (9), `append-only-ledgers` (6), `database-schema-invariants` (8), `same-company-ref-triggers` (5), `refresh-token-isolation` (7); ajustados: `idempotency-key` (+1), `mfa-company-admin`, `device-authorization`, vários teardowns; helpers `purge-company.ts` (novo), `fixture.ts`, `tenant-world.ts`.

**Documentação:** os cinco exigidos (`BANCO_DE_DADOS`, `DECISIONS`, `RELATORIO_MIGRATIONS`, `MAPA_RELACIONAMENTOS`, `REVISAO_BANCO_PENDENCIAS`), este relatório, `revisao-banco/` (pacote, resultados), `SECURITY`, `PRODUCAO`, `CHANGELOG`, `CURRENT_STATE`, `CODE_MAP`.

## 4. Comandos executados e resultado

| Comando | Ambiente | Resultado |
|---|---|---|
| `prisma validate` / `generate` | schema | válido |
| `prisma migrate deploy` (cada migration) + `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …` | dev e teste | **55** aplicadas; diff **vazio** depois de cada uma |
| `npm run db:replay-check` | 4 bancos temporários | 55 migrations do zero = catálogo do dev (3 593 itens iguais, 0 só no dev, 0 só no reaplicado), diff vazio, `db:check-rls` OK; **cenários com dado:** (1) produto/código de barras entre empresas, (2) sessões legadas com empresa divergente, (3) filial de outra empresa + cliente de empresa inexistente — em todos a guarda aborta, nada fica pela metade, a recuperação conclui e o legado não é apagado nem associado |
| `npm run db:docs -- --write --orphans` | dev (papel de leitura) | documentos regenerados; 264 FKs conferidas: violação só nas 3 FKs `NOT VALID` do recebível órfão |
| `npm run db:role-split-check -- --all` | banco e papel temporários | **aprovado**: o papel sem posse tem 8 tipos de DDL e a leitura de `_prisma_migrations` negados, a RLS segue valendo, o livro de estoque segue append-only e a suíte de integração **completa (116 / 1614) passa com a aplicação conectada como esse papel** |
| `npx tsc --noEmit` (database, shared, API, Admin Web, Super Admin, Balcão, PDV) | — | limpo |
| `npx eslint . --ext .ts` (API) | — | 0 erros, 8 avisos (preexistentes) |
| `npm test` (API) | unitário | **114 suítes / 1135 testes** aprovados (inclui 6 de coerência da documentação com o repositório) |
| `npm run test:integration` (API), 4 rodadas seguidas | banco de teste | **116 suítes em todas**: **1614 testes** nas rodadas A, B e C e **1615** na rodada final D (código final); com `PG_ENV_DEBUG=1` nas rodadas B e D: **0 conexão sobrando em cada um dos 116 arquivos** |
| `npm run db:check-rls` | dev e banco reaplicado | todas as invariantes OK |
| `npm run backup:verify` | dev → banco temporário | **18/18** verificações (agora também compara as 3 FKs `NOT VALID` da origem com as do banco restaurado) |
| builds (`npm run build`) | API, Admin Web, Super Admin, Balcão, renderer do PDV | API e Balcão compilam; Admin Web, Super Admin e PDV: `tsc --noEmit` limpo e testes unitários verdes (Admin Web 549, Balcão 9, PDV 37); **builds do Next/Electron não repetidos** (nenhum código de frontend mudou nesta missão) |
| Playwright (`admin-web-flow`, `catalog-and-help`, `support-contextual-buttons`, `mfa-privacy-image`) | dev (API + Admin Web) | **28/28** (`admin-web-flow` + `catalog-and-help` + `support-contextual-buttons` = 22; `mfa-privacy-image` com `REQUIRE_MFA_COMPANY_ADMIN=true` = 6); servidores encerrados |
| `git diff --check` | repositório | sem erro (0 linhas de problema) |

## 5. Falhas encontradas e como foram resolvidas (falha → investigação → correção → teste)

| # | Falha | Causa | Correção e prova |
|---|---|---|---|
| 1 | Teste de concorrência `agreements` (`40P01`, "impasse detectado") depois das FKs compostas | `INSERT` em `payments` toma `FOR KEY SHARE` no convênio e o serviço travava o convênio `FOR UPDATE` **depois** — duas transações seguram o `KEY SHARE` e esperam o `UPDATE` uma da outra | `lockForPayment` trava o convênio **antes** do `INSERT`; `agreements` (30) verde, concorrência 200+200 com limite 300 → 201 + 409 (decisão 138) |
| 2 | Compra com convênio de **outra empresa** virava erro interno de FK | a FK passou a recusar o `INSERT`, antes da mensagem humana | o mesmo `lockForPayment` devolve `AGREEMENT_NOT_FOUND` (404) com texto humano |
| 3 | 84 testes de integração falhando depois da migration de FKs compostas | (a) itens aninhados com `companyId` (`order.service`, `supplier-return.service`) — o Prisma o tira do pai; (b) tipos `*Input` × `*UncheckedInput`; (c) limpeza dos testes em ordem fixa × RESTRICT | itens sem `companyId`; tipos *Unchecked*; **limpeza guiada pelo catálogo** (`purge-company.ts`) — 116 suítes verdes |
| 4 | Excluir filial com registros → erro interno (500) | `ON DELETE RESTRICT` responde `23001`; o Prisma 5 devolve erro **sem código** (não é `P2003`), então `branch.service.delete` nunca devolvia `BRANCH_IN_USE` | `isRestrictViolation` + `errorHandler` 409 `RECORD_IN_USE`; testes unitário (4) e de integração (decisão 137) |
| 5 | `destroyFixture` falhando: `audit_logs → companies` (RESTRICT) | a auditoria é gravada de forma **assíncrona** e uma linha chegava depois do expurgo | expurgo + exclusão repetidos (≤ 5×) só nesse caso; nenhuma falha em 3 rodadas completas |
| 6 | FKs de empresa `NOT VALID` no banco de teste (`categories`, `import_batches`, `idempotency_keys`) | linhas órfãs de empresas sintéticas apagadas por suítes antigas (sem FK nada impedia) | só no **banco de teste**: `prepare-test-db` remove as órfãs (26 + 9 + 173) e valida as FKs; no dev a única órfã (recebível) foi **preservada** |
| 7 | `Idempotency-Key` devolvendo a resposta antiga para sempre | `expiresAt` nunca era aplicado nem expurgado | middleware trata a chave vencida como livre; `cleanup-old-logs` expurga; 4 unitários + 1 integração (decisão 139) |
| 8 | **`support.integration` falhando 14 testes** (também visto na revisão anterior como "causa não determinada") | o carimbo de 13 dígitos (`Date.now()`) no texto do chamado passa no Luhn em ~10% das execuções e o detector o recusava como "cartão" — **o mesmo vale para chave de NF-e (44 dígitos), boleto e telefone com DDI** | detector exige 13–19 dígitos em bloco ou grupos, primeiro dígito de emissor (2–6) e ignora blocos colados > 19 dígitos; unitários provam 2 000 carimbos sem falso positivo e chave de NF-e aprovada no Luhn não recusada; `support` 19/19 em 3 rodadas |
| 9 | `mfa-company-admin` (2 testes) falhando uma vez | (a) virada do passo TOTP de 30 s entre ativar e repetir o código → o código era novo (200 em vez de 400); (b) leitura da auditoria logo depois da resposta, mas a rota grava sem esperar | (a) o teste só começa com ≥ 14 s de folga no passo; (b) leitura com tentativas curtas; 14/14 em 3 rodadas |
| 10 | `append-only` quebrou testes que apagavam o livro de estoque no `beforeAll` | DELETE agora exige expurgo sinalizado | `purgeStockMovements` (Super Admin + `app.audit_purge` na mesma transação) |
| 11 | Dado de teste de venda recusado por `sales_physical_origin_check` | venda sem caixa nem canal | o teste informa `cashRegisterId` |
| 12 | Codemod das FKs compostas: relação 1:1 exigiu `@@unique([companyId, col])` (P1012); constraint com `\r` do `psql` no Windows; a primeira migration abortou **atomicamente** | — | `@@unique` adicionado; `trim()`; `migrate resolve --rolled-back` + novo deploy (documentado) |

## 6. Pendências que exigem decisão humana ou infraestrutura

Ver [DECISIONS 132, 141, 142](DECISIONS.md) e [REVISAO_BANCO_PENDENCIAS §1](REVISAO_BANCO_PENDENCIAS.md): **adotar** o papel de execução sem posse em staging/produção (modelo e prova prontos); destino do **recebível órfão** legado do dev (registro financeiro: arquivar/excluir só com autorização; hoje preservado com FK `NOT VALID`); **prazos de retenção** (LGPD, jurídico + dono); os 34 índices-prefixo restantes (medir `pg_stat_user_indexes` em staging); regra de filial de 9 tabelas (`devices`, `partners`, `users`…); staging com PostgreSQL 18 em **Linux**, restauração de backup em **outro host**, RPO/RTO; conversão para `timestamptz` (mudança de tipo, não feita).

## 7. Garantias de segurança desta missão

- Nenhum commit, push, deploy ou migration em staging/produção; **Super Admin não criado** (nenhum `admin:bootstrap --apply`).
- Nenhum registro de banco compartilhado apagado, truncado, anonimizado ou reescrito; o recebível órfão de teste e as 4 vendas do sandbox foram mantidos. As únicas remoções foram linhas órfãs **sintéticas do banco de teste** (impossível fora de um banco cujo nome contenha "test").
- Nenhum teste de carga ou stress; bancos e papéis temporários criados e removidos pelos scripts (recusam se já existirem); servidores iniciados para o E2E foram encerrados.
- Nenhuma credencial ou URL com senha nos documentos nem no pacote (varredura de padrões de segredo no pacote); só estrutura e números.

## 8. Reconciliação documental (segunda passada, 2026-10-15)

A primeira entrega declarou as correções concluídas, mas uma cópia do `BANCO_DE_DADOS.md` ainda mostrava a contagem antiga (40) de migrations e as pendências já corrigidas. Conferência feita **contra o código e o banco** (não só contra os documentos): migrations (50 em `prisma/migrations`, 50 concluídas em dev e em teste; o dev tem 1 linha a mais por uma tentativa abortada e revertida de `20261014180000` — §4.5 de RELATORIO_MIGRATIONS), catálogo (106 tabelas, 106 com RLS forçada, 152 FKs compostas = 95 de relação + 57 de filial, 77 FKs simples `companyId → companies`, 22 `CASCADE`, 3 triggers de mesma empresa, fuso UTC, 3 FKs `NOT VALID` só no dev), contagem de testes por arquivo.

Encontrado e corrigido: (1) dois ZIPs das rodadas anteriores (contagem antiga: 36 e 40) ainda ao lado do pacote vigente — movidos para `docs/CORTEX/historico/pacotes-superados/` com aviso; (2) afirmações superadas em `CURRENT_STATE`, `README`, `SECURITY` (dois blocos), `contracts/tenant-branch-scope`, `HML_HOMOLOGACAO`, `DECISIONS` (itens 51 e 55), `MAPA_DE_ESTADO`, `ROADMAP`, `CHANGELOG` e `BANCO_DE_DADOS` — atualizadas ou marcadas como histórico; (3) o total real de FKs compostas (152) não estava escrito; (4) um comentário do `schema.prisma` ainda dizia "sem FK" (só comentário; `migrate diff` segue vazio); (5) contagem do teste de invariantes (7 → 8). **Para não voltar a divergir**, `apps/api/src/docs-consistency.test.ts` (6 testes, rodam no `npm test`) confere: 50 migrations e todas listadas no relatório, contagem nos documentos vigentes, ausência das afirmações superadas, decisões 128–140 sem "AGUARDANDO", links internos que resolvem e o SHA-256 do ZIP igual ao do manifesto; e `database-schema-invariants` confere os totais do catálogo.

**Não executado e, portanto, não declarado como concluído:** staging, PostgreSQL em Linux, restauração de backup em outro host, ensaio contra cópia de dados reais anonimizados, adoção do papel de execução em staging/produção.
