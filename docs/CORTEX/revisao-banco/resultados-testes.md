# Resultados de teste — correção completa do banco (2026-10-14/15)

Tudo foi executado em desenvolvimento/teste locais (PostgreSQL 18.6, Redis), com dados sintéticos, **sem teste de carga ou stress**. Sem credencial nem URL com senha. Narrativa e causas: [RELATORIO_EXECUCAO_REVISAO_BANCO](../RELATORIO_EXECUCAO_REVISAO_BANCO.md).

## 1. Resultado final (código final)

| Verificação | Comando | Resultado |
|---|---|---|
| Tipos (todos os workspaces) | `npx tsc --noEmit` em `packages/database`, `packages/shared`, `apps/api`, `admin-web`, `super-admin`, `balcao`, `pdv-desktop` | limpo |
| Lint (API) | `npx eslint . --ext .ts` | 0 erros, 8 avisos preexistentes |
| Unitários da API | `npx jest --runInBand` | **114 suítes / 1135 testes — todos aprovados** (inclui `docs-consistency.test.ts`, 6 testes que impedem a documentação de divergir do repositório) |
| Outros unitários | Admin Web `npm test`; Balcão e PDV `npm run test:logic` | 549 · 9 · 37 — todos aprovados |
| Integração completa — rodada A | `npm run test:integration:prepare` + `jest --config test/integration/jest.integration.config.js --runInBand` | **116 suítes / 1614 testes aprovados** (497 s) |
| Integração completa — rodada B | idem com `PG_ENV_DEBUG=1` | **116 / 1614 aprovados** (518 s); **0 conexão sobrando depois de cada um dos 116 arquivos** |
| Integração completa — rodada C | idem | **116 / 1614 aprovados** (452 s) |
| Integração completa — rodada D (código final, com o teste de totais do catálogo) | idem com `PG_ENV_DEBUG=1` | **116 / 1615 aprovados** (452 s); **0 conexão sobrando em cada um dos 116 arquivos** |
| Integração completa como papel **sem posse** | `npm run db:role-split-check -- --all` (banco e papel temporários) | **116 / 1614 aprovados** com a aplicação conectada a um papel que não é dono, super nem BYPASSRLS; 8 tipos de DDL e a leitura de `_prisma_migrations` **negados**; RLS e livro append-only intactos |
| Reaplicação das migrations do zero | `npm run db:replay-check` | 50 migrations; catálogo idêntico ao do dev (3 535 itens; 0 só no dev, 0 só no reaplicado); `migrate diff` **vazio**; `db:check-rls` OK; **4 cenários com dado inconsistente** (guarda aborta, atomicidade, recuperação, legado preservado) |
| RLS | `npm run db:check-rls` | todas as invariantes OK (dev e banco reaplicado) |
| Backup/restauração | `npm run backup:verify` | **18/18** verificações (restaura em banco temporário e confere linhas, estrutura, RLS, segredos de MFA; as 3 FKs `NOT VALID` da origem voltam iguais) |
| Build | `npm run build` (API) e `npm run build` (Balcão) | ok (Next/Electron não repetidos: nenhum código de frontend mudou) |
| Navegador (Chrome real, servidores de dev) | Playwright: `admin-web-flow`, `catalog-and-help`, `support-contextual-buttons`, `mfa-privacy-image` (esta com `REQUIRE_MFA_COMPANY_ADMIN=true`) | **22/22 + 6/6**; servidores encerrados depois |
| Espaços em branco | `git diff --check` | sem erro |

Testes novos desta missão (todos verdes nas três rodadas): `refresh-token-isolation` (7), `company-branch-fk-restrict` (9), `append-only-ledgers` (6), `database-schema-invariants` (8), `same-company-ref-triggers` (5), `product-children-same-company` (8), `support-schema-objects` (5), `rls-logs-roles-tighten` (6); unitários `db-errors` (4) + `idempotency` (+3) + `scheduler.cleanup` (+1) + `support-sensitive` (+3); `idempotency-key` integração (+1).

## 2. Histórico das execuções (inclui as que falharam)

| Quando | O que rodou | Resultado | O que se fez |
|---|---|---|---|
| Depois da migration de FKs compostas | integração completa | **84 testes / 10 suítes reprovados** (de 1584 / 112) | itens aninhados com `companyId`; tipos *Unchecked*; deadlock de convênio; limpeza de teste em ordem fixa × RESTRICT → corrigidos; limpeza passou a ser guiada pelo catálogo |
| Depois de B2–B5 (FK de empresa/filial, RESTRICT, append-only) | integração completa | **13 testes / 9 suítes reprovados** (de 1566 / 112) | teardowns de 7 arquivos; `audit_logs` assíncrono × exclusão da empresa (retry); `MFA`: virada de passo TOTP e leitura de auditoria assíncrona |
| Rodada 1 do código quase final | integração completa | **116 / 1614 aprovados** | — |
| Rodada 2 (`PG_ENV_DEBUG=1`) | integração completa | **1 suíte reprovada** (`support.integration`, 14 testes) | **causa:** o carimbo de 13 dígitos do texto do chamado passou no Luhn (~10%) e o detector de cartão o recusou. Corrigido o detector (produto) e provado por unitário; era a falha "não explicada" da revisão anterior |
| Rodadas A, B e C | integração completa | **116 / 1614 aprovados nas três** | — |
| Rodada D (depois da conferência documento × repositório; +1 teste de totais do catálogo) | integração completa, `PG_ENV_DEBUG=1` | **116 / 1615 aprovados** | — |
| `backup:verify` | restauração | 1 falha: "constraints todas validadas" | a verificação supunha 0 FKs `NOT VALID`; agora compara com as da origem (3, o legado documentado) → **18/18** |

## 3. O que cada teste novo prova (resumo)

- `refresh-token-isolation`: empresa B não enxerga a sessão da A; login/refresh/logout pelo hash; rotação; sessão de plataforma; nenhum segredo em texto.
- `company-branch-fk-restrict`: `companyId` inexistente e filial de outra empresa recusados (`P2003`); filial opcional continua opcional; filial/empresa/produto/venda/caixa/OS com histórico **não** são apagados; a API traduz `RESTRICT` em 409 (`BRANCH_IN_USE`, `RECORD_IN_USE`); FKs de filial existem e estão validadas.
- `append-only-ledgers`: INSERT/SELECT normais; UPDATE e DELETE afetam 0 linhas (valor intacto) para empresa e Super Admin sem flag; flag sem Super Admin não apaga; Super Admin com flag na mesma transação apaga; a flag é local à transação.
- `same-company-ref-triggers`: convênio, mecânico e filial de outra empresa recusados; próprio e nulo passam; exclusão do pai continua anulando a coluna; nenhum dado existente viola.
- `database-schema-invariants`: sem índice duplicado; todo `companyId` tem índice que o começa; todo `companyId` de negócio tem FK para `companies` (exceções = tabelas de retenção); nenhuma FK em cascata sobre histórico; fuso UTC; única FK `NOT VALID` permitida é a do recebível órfão legado; papel da aplicação não é super nem BYPASSRLS.
- Cenários do `db:replay-check`: produto/código de barras entre empresas; sessões legadas (hash em SQL = hash da aplicação; empresa só pelo usuário; revogação preservada; segredo em texto ausente); filial de outra empresa + cliente de empresa inexistente (legado preservado, linha nova recusada).

## 4. Finalização de produção (2026-10-15/16) — 52 migrations

Saídas completas em [evidencias-finalizacao-2026-10-16.md](evidencias-finalizacao-2026-10-16.md). Resumo: tipos 7/7 limpos; lint 0 erros (api, admin-web, super-admin); build da API limpo; unitários API **1 145 / 114 suítes**, Admin Web **549 / 32**, PDV 37, Balcão 9; integração completa **117 suítes / 1 643 testes** em dois ciclos limpos (o segundo com `PG_ENV_DEBUG=1`); a mesma suíte completa com a aplicação conectada como **papel sem posse** (`db:role-split-check -- --all`): 117 / 1 643; `db:check-rls` OK; `db:replay-check` 52 migrations do zero = dev (3 565 itens); `backup:verify` 18/18; `backup:drill` 21/21; Playwright (`admin-web-flow` + `catalog-and-help`) 16/16. Falhas encontradas e corrigidas: [RELATORIO_FINALIZACAO_PRODUCAO §4](../RELATORIO_FINALIZACAO_PRODUCAO.md).
