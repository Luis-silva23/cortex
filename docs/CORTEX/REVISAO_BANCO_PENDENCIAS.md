# Revisão do banco de dados — achados, correções, testes e pendências

> Escrito em 2026-10-14 e **atualizado em 2026-10-15** (correção completa dos achados confirmados e seguros de corrigir). Fonte: catálogo do PostgreSQL de **desenvolvimento** (18.6, dados sintéticos), `schema.prisma`, as **52 migrations**, o código da API, os testes unitários e de integração, e bancos temporários criados e removidos pelos próprios scripts. Nada foi lido de cliente real; nada foi apagado ou reescrito em banco compartilhado (as únicas remoções de linha foram **órfãs sintéticas do banco de TESTE** — achado E-04); staging e produção **não existem/não foram tocados**. O bloco "Achados automáticos" (§5) é regerado por `cd apps/api && npm run db:docs -- --write --orphans`; o restante é análise escrita.
>
> **Classes:** **Confirmado** (evidência direta no schema, SQL, catálogo ou teste que falhava) · **Provável** · **Não confirmado** · **Falso positivo** (a estrutura atual ou uma proteção comprovada elimina o risco). **Estados:** **CORRIGIDO** = *implementado* (migration/schema/código) **e** *testado* (teste que falhava antes ou prova em banco temporário) · **PENDENTE-DECISÃO** (regra de negócio/jurídica, não técnica) · **PENDENTE-INFRA** (precisa de ambiente que não existe aqui). Em cada linha fica explícito o que foi **implementado**, o que foi **testado** e o que **precisa de validação externa**.
> Documentos irmãos: [BANCO_DE_DADOS](BANCO_DE_DADOS.md) (por tabela) · [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md) · [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md) · [RELATORIO_EXECUCAO_REVISAO_BANCO](RELATORIO_EXECUCAO_REVISAO_BANCO.md) (testes, falhas e correções) · [DECISIONS](DECISIONS.md) (decisões 124 a 150) · pacote com schema, migrations e provas em [revisao-banco/](revisao-banco/LEIA-ME.md).

## 0. Resumo executivo

| Pergunta | Resposta | Evidência |
|---|---|---|
| Os três achados iniciais procedem? | **A (numeração dos chamados) e B (índice da busca): o SQL apresentado nunca foi uma migration — é a saída do `prisma migrate diff` banco → schema.prisma (arquivo `drift-dev.txt` da rodada anterior).** O banco real está certo; o risco era do `schema.prisma` não descrever esses objetos. **Corrigido só no schema** (nenhuma mudança de banco); o diff agora é **vazio**. **C (referência cruzada entre empresas) é real, foi reproduzido (teste vermelho) e corrigido** com FK composta — e a mesma classe foi **eliminada em todo o banco** (§1, C-02). | §2 |
| Quantas tabelas / migrations? | **113** tabelas = 113 modelos · **57** migrations (36 anteriores + **14** desta revisão + **2** da finalização de produção de 2026-10-16: escopo por filial e travas de privilégio + **3** da missão de segurança e da missão mestra de 2026-10-17/18: contexto assinado, filiais do usuário e senha temporária, e **2** da Central de Monitoramento de 2026-10-18/19 (+ índice por empresa no histórico de alertas): alertas com ciclo de tratamento, amostras de saúde, funil comercial, entregas externas e ajustes), todas aplicadas em dev e teste, checksums conferem | `db:docs`, `_prisma_migrations` |
| As migrations reproduzem o banco? | **Sim**: aplicadas do zero num banco vazio dão exatamente o catálogo do dev (**3 565** itens iguais) e `prisma migrate diff` **vazio** | `npm run db:replay-check` |
| Migration segura com dado existente? | **Sim, com guarda.** Provado em **três** bancos temporários com dado inconsistente (produto/código de barras entre empresas; sessões legadas com empresa divergente; filial de outra empresa + cliente de empresa inexistente): a guarda aborta, nada fica pela metade, e o roteiro de recuperação conclui; o dado legado **não é apagado nem associado a empresa por suposição** | `db:replay-check`, 3 cenários com dados |
| Isolamento entre empresas (RLS + FK) | **106/106** com RLS habilitada e forçada; **todas** as lacunas encontradas foram corrigidas (logs, perfis globais, `refresh_tokens`, livros mutáveis); referência cruzada entre empresas **impossível no banco** em 94 relações por FK composta + 3 por trigger | §1, testes `company-branch-fk-restrict`, `same-company-ref-triggers`, `product-children-same-company`, `rls-logs-roles-tighten`, `refresh-token-isolation`, `append-only-ledgers` |
| Integridade e histórico | `ON DELETE CASCADE` sobre histórico → `RESTRICT` (21 FKs + 8 `SET NULL`); `companyId` com FK em 65 tabelas; filial com FK composta em 55; 6 índices duplicados e 13 redundantes removidos, 16 índices ausentes criados; fuso do banco = UTC | `database-schema-invariants`, `company-branch-fk-restrict` |
| O que mudou na aplicação | (1) **deadlock real** de pagamento por convênio, achado pela FK composta e corrigido (travar o pai antes do filho); (2) `RESTRICT` chegava como **500** → agora **409 `RECORD_IN_USE`** / `BRANCH_IN_USE`; (3) `Idempotency-Key` **nunca expirava** → agora expira e é expurgada | decisões 137, 138, 139 |
| Pronto para produção? | **Não.** Faltam: staging com PostgreSQL 18 em Linux; backup restaurado em **outro host**; **executar** com Docker o compose que agora cria e usa o papel de execução sem posse (pipeline provado fora do Docker); destino externo do backup e aprovação de RPO/RTO/retenção; tratar o recebível órfão legado do dev (`NOT VALID`) | §3 (D-08, D-10, D-11), decisões 141, 142, 149 e 150 |
| O que mudou na finalização de 2026-10-16? | **Escopo por filial** nas 9 tabelas que só isolavam por empresa (+ `audit_logs`, `transfers`), **travas de privilégio** (gerente não se promove, não liga módulo, não mexe em filiais, nem por SQL direto), contrato de erro dos dashboards (403 ao pedir outra filial), compose sem superusuário na API, backup cifrado com verificação sem novo dump e ensaio de restauração (21 verificações). Recebível órfão **preservado** (3 FKs `NOT VALID`) | decisões 143–150; [RELATORIO_FINALIZACAO_PRODUCAO](RELATORIO_FINALIZACAO_PRODUCAO.md); [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md) |

> **Totais conferidos no catálogo do dev e do teste em 2026-10-15:** 152 FKs compostas (95 de relação + 57 de filial — as 94 da migração `…180000` (2 delas já são de filial) + as 55 de filial de `…100000` + 2 de `product_barcodes`/`product_images` + 1 de `refresh_tokens` = 152), 77 FKs simples `companyId → companies` (65 novas + 12 que já existiam), 22 FKs `CASCADE` restantes (derivadas/configuração), 3 triggers de mesma empresa e 3 FKs `NOT VALID` só no dev (o recebível órfão); `database-schema-invariants` trava esses limites.

## 1. Registro de achados

| ID | Classe | Gravidade | Objeto | Estado | Resumo |
|---|---|---|---|---|---|
| A-01 | Falso positivo como migration · **Confirmado como risco de deriva** | Alta (se o diff fosse aplicado) | `support_tickets.ticketNumber`, `support_ticket_number_seq` | **CORRIGIDO** (schema) | o diff propunha `SET DEFAULT` + `DROP DEFAULT` + `DROP SEQUENCE`; novos chamados ficariam sem número |
| B-01 | Falso positivo como migration · **Confirmado como risco de deriva** | Média | `support_kb_articles.search` / `support_kb_articles_search_idx` | **CORRIGIDO** (schema) | o diff propunha `DROP INDEX` do GIN e tirar defaults |
| B-02 | **Confirmado** | Baixa | índice GIN da busca | PENDENTE-DECISÃO (monitorar) | com o papel da aplicação a RLS impede o planejador de usar o GIN; irrelevante no volume atual |
| C-01 | **Confirmado** (teste vermelho antes) | Média | `product_barcodes`, `product_images` | **CORRIGIDO** | linha da empresa A apontava para produto da empresa B |
| C-02 | **Confirmado** (estrutura) · 0 linhas cruzadas (dados) | Média | 66 FKs simples com `companyId` nos dois lados + colunas soltas | **CORRIGIDO** | **94** relações com FK composta `(companyId, X) → pai(companyId, id)` (`20261014180000`), **55** FKs compostas de filial (`20261015100000`), **3** triggers para as que não admitem FK composta (`20261015160000`); guarda em cada migration |
| C-03 | **Confirmado** (experimento revertido) | Média (processo) | `ADD CONSTRAINT` sobre tabela FORCE RLS | **CORRIGIDO** (guarda) | a validação da FK feita pelo dono sem contexto "passa em branco"; guarda + regra (decisão 127) |
| D-01 | **Confirmado** | **Alta** | `refresh_tokens` | **CORRIGIDO** | 136/136 linhas com `companyId` nulo, visíveis a qualquer empresa; token em texto → `companyId` preenchido, RLS estrita, **SHA-256**, sessões preservadas (`20261014170000`) |
| D-02 | **Confirmado** (teste vermelho antes) | Média | `request_logs`, `system_logs`, `roles`, `permissions` | **CORRIGIDO** | logs de plataforma legíveis por empresa; `WITH CHECK true`; globais apagáveis por empresa |
| D-03 | Confirmado | Média | `stock_movements`, `cash_movements`, `policy_changes`, `service_order_status_history` (+ `sale_items`, `revisions`) | **CORRIGIDO** (4 livros) · exceções documentadas | imutabilidade só na aplicação → append-only por RLS (`20261015120000`); `sale_items.returnedQuantity` e `revisions.notes` seguem atualizáveis por regra de negócio |
| D-04 | Confirmado | Média | 41 FKs `ON DELETE CASCADE` | **CORRIGIDO** | 21 viraram `RESTRICT` (+ 8 `SET NULL` sem caminho de exclusão); as demais ficam em CASCADE por serem derivadas/configuração (`20261015110000`) |
| D-05 | Confirmado | Média | 65 `companyId` e 55 `branchId` sem FK; 1 recebível órfão | **CORRIGIDO** · 1 linha legada preservada | FKs criadas (`20261015100000`); o recebível órfão de empresa inexistente **não foi apagado nem associado**: 3 FKs ficam `NOT VALID` só nele |
| D-06 | Confirmado | Baixa | 6 índices idênticos a um UNIQUE + 34 que são início de outro | **CORRIGIDO** (6 + 13) · demais PENDENTE-DECISÃO | os 6 idênticos e 13 `companyId` redundantes com o alvo das FKs compostas removidos (`…130000`, `…170000`); os demais prefixos dependem de `pg_stat_user_indexes` em staging |
| D-07 | Confirmado | Média | colunas `timestamp` sem fuso (273) com default do banco (110) | **CORRIGIDO** (fuso) · `timestamptz` não feito | banco em UTC (`20261015150000`); conversão de tipo é mudança planejada, sem ganho que a justifique agora |
| D-08 | Confirmado | Média | papel da aplicação = dono das tabelas | **CORRIGIDO** tecnicamente · PENDENTE-INFRA (adoção) | modelo `deploy/db-runtime-role.sql` e prova `db:role-split-check` (DDL negado; suíte de integração completa passa como esse papel) |
| D-09 | Confirmado | Baixa | 10 tabelas filhas sem índice começando por `companyId`; 9 tabelas com `branchId` fora da policy | **CORRIGIDO** (índices) · PENDENTE-DECISÃO (policy de filial) | 9 índices de `companyId` + 7 de FK (`20261015140000`); regra "o gerente da filial A vê a filial B?" é de negócio |
| D-10 | Confirmado (parcialmente **refutado**) | Média | retenção de `audit_logs`, `request_logs`, `system_logs`, `idempotency_keys` | **CORRIGIDO** (idempotência) · PENDENTE-DECISÃO (prazos) | o expurgo de audit/system/request/telemetria **já existia** (a análise anterior estava errada); faltava o de `idempotency_keys` — acrescentado; prazos dependem de jurídico + dono |
| D-11 | Confirmado | — | staging/produção, PostgreSQL 18 em Linux, backup em outro host | PENDENTE-INFRA | nada aplicado fora de dev/teste |
| E-01 | **Confirmado** (teste de concorrência vermelho) | **Alta** | `payments` × `employee_agreements` | **CORRIGIDO** | a FK composta fez o `INSERT` do pagamento tomar `FOR KEY SHARE` no convênio; travá-lo `FOR UPDATE` depois deu **impasse** (`40P01`) com duas compras simultâneas — travar antes de inserir (decisão 138) |
| E-02 | **Confirmado** | Média | `ON DELETE RESTRICT` × Prisma | **CORRIGIDO** | `23001` chega sem código: a API respondia 500 e `branch.service.delete` nunca devolvia `BRANCH_IN_USE` — 409 `RECORD_IN_USE` (decisão 137) |
| E-03 | **Confirmado** | Média | `idempotency_keys.expiresAt` | **CORRIGIDO** | a janela de 24 h nunca era aplicada: a mesma chave devolvia a resposta antiga para sempre (decisão 139) |
| E-04 | **Confirmado** | Baixa | banco de TESTE | **CORRIGIDO** | 26 `categories`, 9 `import_batches`, 173 `idempotency_keys` órfãos de empresas sintéticas apagadas (a falta de FK permitia); removidos só no banco de teste e as FKs validadas |
| E-05 | **Confirmado** | Baixa | `destroyFixture` × auditoria assíncrona | **CORRIGIDO** | uma linha de `audit_logs` chegava depois do expurgo e travava a exclusão da empresa (RESTRICT) — repetição limitada (decisão 140) |

## 2. Os três achados iniciais — investigação

### Achado A — `ticketNumber` e a sequência

- **Origem do SQL (Confirmado):** não está em nenhuma migration. `support_ticket_number_seq` aparece só em `20260928200000_support_center` (criação da sequência `START WITH 1000`, `DEFAULT nextval(...)` da coluna `NOT NULL` e `OWNED BY`). As linhas `SET DEFAULT … DROP DEFAULT … DROP SEQUENCE` são a saída de `prisma migrate diff --from-schema-datasource` da rodada anterior (`drift-dev.txt` antigo). Causa: o schema descrevia o default como `dbgenerated("nextval('support_ticket_number_seq'::regclass)")`; o motor do Prisma trata `nextval(...)` como *autoincrement* e, com `dbgenerated`, "corrige" para nenhum default.
- **Estado real do banco:** coluna `NOT NULL`, `DEFAULT nextval('support_ticket_number_seq'::regclass)`, índice único, sequência pertencente à coluna. Dev: sequência em 1012, 0 chamados; teste: sequência em 1704, 0 chamados (nenhum número a preservar nesses bancos, e nenhum dado foi tocado).
- **Decisão:** a numeração **continua automática pela mesma sequência** (global, não depende de enxergar linhas de outras empresas sob RLS). `schema.prisma` passa a `@default(autoincrement())` — exatamente o que o `db pull` devolve.
- **Preservação e colisão:** nenhuma mudança de banco → números existentes intactos; a sequência não é recriada nem reiniciada. Teste `support-schema-objects` (5): estrutura (NOT NULL, default, sequência existe e pertence à coluna), **12 chamados em paralelo recebem 12 números distintos, acima de qualquer existente**, `last_value ≥ max(ticketNumber)`, e repetir um número é recusado pelo índice único.
- **Se o diff antigo tivesse sido aplicado:** `INSERT` sem número → violação de `NOT NULL` em todo chamado novo.

### Achado B — índice e coluna `search` da base de conhecimento

- **Origem do SQL (Confirmado):** idem — o `DROP INDEX` e os `DROP DEFAULT` são do diff, não de migration. `20260928200000_support_center` cria `search tsvector GENERATED ALWAYS AS (setweight(to_tsvector('portuguese', title), 'A') || … resumo+palavras-chave 'B' || … corpo 'C') STORED` e `CREATE INDEX support_kb_articles_search_idx … USING GIN (search)`.
- **Natureza (Confirmado):** coluna **gerada e armazenada** (`attgenerated = 's'`), mantida pelo banco — não por trigger nem pela aplicação. Consultas: `support-kb.service.ts` usa `search @@ websearch_to_tsquery('portuguese', …)` e `ts_rank(search, …)`; é o único uso.
- **Correção (schema, sem mudança de banco):** `search Unsupported("tsvector")? @default(dbgenerated("<expressão de geração como o PostgreSQL a guarda>"))`, `@@index([search], type: Gin)` e `updatedAt @default(now()) @updatedAt` nas duas tabelas da base de conhecimento. `prisma migrate diff` banco → schema: **vazio**. Pesquisa, índice e defaults **preservados**.
- **Plano de consulta (Observado, `EXPLAIN (ANALYZE, BUFFERS)` no banco de teste, somente leitura):** com `enable_seqscan = off` a consulta de texto puro usa `Bitmap Index Scan on support_kb_articles_search_idx` (índice utilizável); com 10 artigos o planejador escolhe varredura sequencial por custo. A consulta **real** do serviço combina `OR title ILIKE … OR keywords ILIKE …` e por isso não usa o índice de qualquer forma.
- **B-02 (Confirmado, Baixa):** sob o papel da aplicação, a RLS acrescenta ao filtro a condição `is_super_admin()` (função **não** *leakproof*), e o operador `@@` também não é — o planejador **não usa o GIN para esse papel** nem com `enable_seqscan = off`. Com a base de conhecimento global pequena é irrelevante; o teste fixa um limite (< 2 000 artigos) e a recomendação, se crescer, é busca por função `SECURITY DEFINER` ou policy sem função. O índice foi **mantido** (usado por papéis que ignoram RLS e se a policy mudar).

### Achado C — `product_barcodes` e `product_images`

- **Estrutura anterior (Confirmado):** FK `(productId) → products(id)` e FK `(companyId) → companies(id)`; policy `rls_company_match("companyId")` só olha o `companyId` **da própria linha**; a checagem de FK do PostgreSQL **não passa pela RLS**. Teste de integração (sessão da empresa A, papel da aplicação): `INSERT (companyId = A, productId = produto da B)` **era aceito** (6 de 8 casos vermelhos), e o mesmo no `UPDATE`.
- **Dados existentes (Observado):** dev 0 e teste 1 linha de código de barras, 0 imagens; **0 linhas cruzadas**; `(companyId, id)` sem duplicidade em `products` (`companyId` é `NOT NULL`).
- **Correção:** `20261014155900_guard_product_children_same_company` (guarda: lê como plataforma e aborta se houver linha cruzada) → `20261014160000_product_children_same_company` (índice único `products(companyId, id)` como alvo; FKs compostas `(companyId, productId) → products(companyId, id)` com as **mesmas** regras de antes — código de barras `RESTRICT`, imagem `CASCADE`; FKs simples antigas saem) → `20261014161000_product_images_company_product_unique` (índice `(companyId, productId)` exigido pelo Prisma para a relação 1:1). `schema.prisma`: relações compostas e `@@unique([companyId, id])` em `Product`. O código da API não mudou (usa `companyId` e `productId` escalares).
- **Teste `product-children-same-company` (8, verde):** estrutura; INSERT cruzado recusado nas duas tabelas (`P2003`); INSERT legítimo funciona; UPDATE cruzado recusado e linha inalterada; leitura da empresa B não vê linhas da A; DELETE do produto com código de barras segue `RESTRICT` e com imagem segue `CASCADE`; nenhum dado cruzado.
- **Achado derivado (C-03) — a validação de FK é cega sob FORCE RLS:** o `ADD CONSTRAINT` feito pelo dono, sem contexto, enxerga **zero linhas** e é criado mesmo com linha violando (experimento revertido: com uma linha cruzada ele **passou**; com `app.user_type = SUPER_ADMIN` **falhou**). A primeira versão do cabeçalho prometia "a migration falha"; **estava errada** e foi corrigida (reconciliação de checksum documentada em [RELATORIO_MIGRATIONS §4.4](RELATORIO_MIGRATIONS.md)). A guarda faz a checagem explícita. Provado em banco temporário **com dado cruzado**: o `migrate deploy` falha na guarda, nada fica pela metade, e `migrate resolve --rolled-back` + novo deploy conclui. Além disso, as **109 FKs existentes foram conferidas com o papel que ignora RLS: 0 violações**.
- **C-02 (CORRIGIDO em 2026-10-15):** a mesma classe existia nas outras 66 FKs simples (filho e pai com `companyId`) e em 33 colunas que eram só ids soltos; dados: **0 linhas cruzadas**. Aplicado em duas migrations com guarda: `20261014180000_composite_company_fks` (**94** FKs compostas: 61 convertidas, 33 criadas; `@@unique([companyId, id])` em 26 pais; 8 relações `SET NULL` sem caminho de exclusão na aplicação viraram `RESTRICT`) e `20261015100000_company_and_branch_fks` (65 `companyId → companies` e 55 `(companyId, branchId) → branches`). `sales.partnerId`, `service_orders.mechanicId` e `users.branchId` não admitem FK composta (o Prisma não modela `SET NULL` parcial e a exclusão tem de anular só a coluna) e ganharam **trigger** de mesma empresa (`20261015160000`). Residual: `quote_items.productId` (a tabela não tem `companyId`) e `audit_logs.userId` (retenção) — documentado.

## 3. Demais achados — observação, correção aplicada e prova

**D-01 — `refresh_tokens` sem isolamento por empresa e com token em texto. Gravidade: Alta. Estado: CORRIGIDO** (`20261014170000_refresh_tokens_hash_and_company`).
- *Observado (antes):* as 136 linhas do dev tinham `companyId` **nulo** e a policy aceitava `"companyId" IS NULL` para qualquer sessão — uma sessão de empresa enxergava as 136; a coluna `token` guardava o refresh token **em texto**.
- *Implementado:* (1) `companyId` preenchido na criação **e** no backfill, **só a partir do usuário** (usuário de plataforma continua nulo — nada é associado por suposição); (2) a policy de empresa não aceita mais o ramo `IS NULL` (plataforma usa o contexto de Super Admin); (3) a coluna `token` foi substituída por `tokenHash` = **SHA-256 hex**, calculado **igualmente em SQL e na aplicação** (`services/refresh-token-hash.ts`) — por isso **as sessões existentes continuam valendo**, as revogadas continuam revogadas e nenhuma sessão legítima caiu; (4) FK composta `(companyId, userId) → users`; (5) o índice duplicado do token saiu. A migration **aborta sem alterar nada** se uma sessão já tiver empresa diferente da do usuário.
- *Testado:* `refresh-token-isolation` (7: empresa B não vê a sessão da A; login/refresh/logout pelo hash; rotação; plataforma; nenhum segredo em texto) e o **cenário de sessões do `db:replay-check`** (banco temporário com sessões legadas: hash em SQL **igual** ao da aplicação nas 3 sessões; aborto com dado divergente; atomicidade; recuperação; coluna `token` removida e nenhum valor legado restante).
- *Precisa de validação externa:* nenhuma para o banco; a API precisa ser **reiniciada** após a migration (código novo lê `tokenHash`).

**D-02 — Logs de plataforma e perfis/permissões globais alcançáveis por uma empresa. Gravidade: Média. Estado: CORRIGIDO** (`20261014162000_rls_logs_roles_tighten`, teste `rls-logs-roles-tighten`, 6, vermelho antes). *Observado no dev:* uma sessão de empresa lia **371** `system_logs` e **3 540** `request_logs` de plataforma, gravava log com o `companyId` de **outra** empresa (`WITH CHECK true`) e alcançava `UPDATE`/`DELETE` de perfis e permissões globais. *Correção:* logs com `rls_company_match("companyId")`; `roles`/`permissions` com `SELECT` incluindo os globais e escrita só da própria empresa ou do Super Admin. *Dados:* nenhuma linha tocada.

**D-03 — Imutabilidade de livros e históricos só na aplicação. Gravidade: Média. Estado: CORRIGIDO** (`20261015120000_append_only_ledgers`, teste `append-only-ledgers`, 6).
- *Implementado:* `stock_movements`, `cash_movements`, `policy_changes` e `service_order_status_history` passam a ter **policy por comando**: `SELECT`/`INSERT` com o mesmo critério de antes, **sem policy de `UPDATE`** (negado, também para o dono sob `FORCE RLS` e para o Super Admin) e `DELETE` só de Super Admin com `app.audit_purge = 'on'` **na mesma transação** (mesmo padrão de `audit_logs`, `collection_attempts`, `discount_events`). Varredura do código: nenhuma rota atualiza ou apaga essas tabelas; estoque e caixa se corrigem com **novo** movimento (estorno), nunca editando o antigo.
- *Exceções mantidas (regra de negócio):* `sale_items.returnedQuantity` (contador de devolução) e `revisions.notes` (anonimização LGPD, decisão 120) continuam atualizáveis pela aplicação — registradas como imutabilidade **só na aplicação**.
- *Testado:* a empresa dona lê e insere; outra empresa não vê; UPDATE e DELETE afetam **0 linhas** (valor lido depois, intacto) para empresa e para Super Admin sem a flag; a flag **sem** ser Super Admin também não apaga; Super Admin **com** a flag na mesma transação apaga; a flag é local à transação.
- *Financeiro mutável por desenho:* `payments`, `sales`, `cash_registers`, `accounts_*` mudam de estado legitimamente (aprovado → estornado, aberto → fechado); a trilha imutável deles são `cash_movements`, `stock_movements`, `audit_logs` e `payment_exceptions`.

**D-04 — `ON DELETE CASCADE` sobre histórico. Gravidade: Média. Estado: CORRIGIDO** (`20261015110000_cascade_to_restrict_history`).
- *Implementado:* 21 FKs passam a `RESTRICT`: `audit_logs`, `branches`, `users`, `licenses`, `privacy_requests` → `companies`; `cash_movements` → `cash_registers`; `payments`, `sale_items` → `sales`; `stock_movements` → `products`; `purchase_order_items`; `quote_events`/`quote_versions`/`quote_items`; `service_order_items`, `service_order_status_history`, `vehicle_entry_checklists(+items)`; `transfer_items`; `appointment_events`, `follow_up_events`; `inventory_counts`. Além disso, 8 relações `SET NULL` **sem caminho de exclusão na aplicação** viraram `RESTRICT` (migration `…180000`).
- *Mantidos em CASCADE de propósito:* sessões e dispositivos (`refresh_tokens`, `device_sessions`, `devices`, `activations`), papéis e permissões, `combo_items`, imagens e códigos de barras de produto, políticas de parcelamento e parceiros — dados derivados ou de configuração.
- *Varredura:* a aplicação **nunca** exclui venda, pagamento, caixa, inventário, ordem de compra, orçamento, OS, transferência, produto, agendamento, retorno ou checklist; o único `delete` de entidade-pai é `company.delete`, só de empresa **sem filiais e sem usuários**. Nada muda para o usuário final.
- *Testado:* `company-branch-fk-restrict` (produto com livro de estoque, venda com pagamento, caixa com movimento e OS com histórico **não** são apagados; filial com registros vira 409 `BRANCH_IN_USE`) e `database-schema-invariants` (nenhuma FK em cascata sobre as tabelas de histórico). A limpeza de teste passou a ser guiada pelo catálogo (decisão 140).

**D-05 — Escopo e relações sem FK. Gravidade: Média. Estado: CORRIGIDO**, com **uma linha legada preservada** (`20261015100000_company_and_branch_fks`).
- *Implementado:* `companyId → companies(id) ON DELETE RESTRICT` em **65** tabelas de negócio; `(companyId, branchId) → branches(companyId, id) ON DELETE RESTRICT` em **55** (filial opcional continua opcional: `MATCH SIMPLE` não checa com `branchId` nulo). **Sem FK de propósito** (retenção/telemetria, sem dado de negócio): `request_logs`, `system_logs`, `idempotency_keys` (`companyId` pode ser `'PLATFORM'`), `device_telemetry`, `health_incidents`, `monitoring_*`; `devices`/`user_roles` (sem `companyId` obrigatório); `users.branchId` (já tinha FK; mesma empresa por trigger).
- *Dado existente:* medido antes (papel que ignora RLS, só contagem): **0** linhas com filial inexistente/de outra empresa; **1** `accounts_receivable` (`ServiceOrder`, `PAID`, 14/09/2026) cuja empresa, filial e cliente **não existem mais** (sobra de teste antigo). **Não foi apagado nem associado a empresa alguma** (regra: não adivinhar, preservar rastreabilidade): as 3 FKs dessa tabela ficam `NOT VALID` (valem para toda linha nova/alterada; `convalidated = false` é o sinal do legado). Nada mais fica `NOT VALID` no dev; no banco de teste as órfãs eram sintéticas e foram removidas (E-04).
- *Testado:* `company-branch-fk-restrict`; cenário de filial/empresa do `db:replay-check` (produto da A com filial da B → aborta, atomicidade, recuperação; cliente de empresa inexistente preservado e **linha nova** com empresa inexistente recusada).
- *Precisa de decisão humana:* destino do recebível órfão (arquivar/excluir/deixar) — é registro financeiro.

**D-06 — Índices duplicados. Gravidade: Baixa. Estado: CORRIGIDO (6) / PENDENTE-DECISÃO (34).** Removidos os 6 índices comuns **idênticos** a um UNIQUE (`refresh_tokens_token_idx` em `…170000`; `device_telemetry_deviceId_collectedAt_idx`, `fiscal_documents_accessKey_idx`, `invoices_accessKey_idx`, `payments_transactionId_idx`, `users_email_idx` em `20261015130000`), junto com o `@@index` correspondente do `schema.prisma`. Mais 13 índices `companyId` comuns que as FKs compostas tornaram redundantes com o alvo único `(companyId, id)` saíram em `20261015170000_drop_redundant_company_indexes`. Os demais prefixos (34 antes desta revisão) **não** foram removidos: sem `pg_stat_user_indexes` de produção não há prova de que não sirvam a alguma consulta (§5-H). Teste de regressão: `database-schema-invariants` (nenhum índice duplicado).

**D-07 — Fuso horário. Gravidade: Média/Baixa. Estado: CORRIGIDO (fuso do banco) / não feito (`timestamptz`).** `ALTER DATABASE … SET timezone TO 'UTC'` (`20261015150000`, só novas sessões; **nenhum dado alterado**). Varredura: a aplicação não faz `INSERT` cru e todo SQL cru com data converte com `AT TIME ZONE 'UTC'` (dashboard, observabilidade, outbox), então a mudança não altera resultado; o fuso de negócio continua em `company.timezone`. Os 110 `DEFAULT CURRENT_TIMESTAMP` deixam de divergir 3 h do que o Prisma grava. Converter 273 colunas para `timestamptz` é migração de tipo de alto risco sem ganho funcional hoje — fica registrada, não feita. *Validação externa:* em staging/produção o papel que migra precisa ser dono do banco (senão a migration só avisa e o DBA aplica o comando de `PRODUCAO.md`). Dinheiro: nenhuma coluna `numeric` sem precisão; nenhuma de ponto flutuante em tabela financeira.

**D-08 — Papel da aplicação é o dono das tabelas. Gravidade: Média. Estado: CORRIGIDO tecnicamente · PENDENTE-INFRA (adoção).** Modelo de papéis em `deploy/db-runtime-role.sql` (dono só migra; execução só DML) e prova em `npm run db:role-split-check` (banco e papel temporários): o papel de execução **não** é superusuário/BYPASSRLS/dono; `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL SECURITY`, `DROP/ALTER POLICY`, `DROP TABLE`, `TRUNCATE`, `CREATE TABLE`, `DROP CONSTRAINT` e leitura de `_prisma_migrations` são **negados**; a RLS segue valendo; **a suíte de integração **completa (116 suítes / 1614 testes) passa** com a aplicação conectada como esse papel**. *Limite honesto:* o papel de execução ainda escolhe o contexto da RLS (`set_config('app.user_type', …)`) — decisão de arquitetura; os papéis fecham o DDL, não uma falha de lógica da aplicação. *Falta (infra):* apontar a API de staging/produção para o papel de execução e rodar `migrate deploy` com o dono.

**D-09 — Índices e filial. Estado: CORRIGIDO (índices) / PENDENTE-DECISÃO (policy de filial).** `20261015140000_missing_fk_and_rls_indexes`: 9 tabelas sem índice iniciando por `companyId` (`employee_payroll_deductions`, `external_order_items`, `monitoring_thresholds`, `quote_events`, `supplier_return_events`, `supplier_return_items`, `support_ticket_attachments`, `support_ticket_events`, `warranty_claims`) e 7 colunas de FK (`stock_movements.userId`, `payments.employeeAgreementId/agreementCompanyId`, `accounts_receivable.employeeAgreementId`, `payment_exceptions.saleId`, `stock_reservations.productId`, `sales.channelId`). Regressão: `database-schema-invariants` (toda tabela com `companyId` tem índice que o começa). Continuam pendentes de regra de negócio as 9 tabelas com `branchId` cuja policy não usa filial (`devices`, `installment_policies`, `monitoring_*`, `partners`, `request_logs`, `system_logs`, `user_roles`, `users`) — "o gerente da filial A vê o usuário da filial B?".

**D-10 — Retenção. Estado: CORRIGIDO (idempotência) / PENDENTE-DECISÃO (prazos).** *Correção da análise anterior:* o job `cleanup-old-logs` **já** expurgava `audit_logs` (90 d), `system_logs` (90 d), `request_logs` (30 d), telemetria (30 d) e incidentes (365 d), por variável de ambiente. O que **não** existia era o expurgo de `idempotency_keys` — e a janela de 24 h nem era aplicada (E-03). Agora: o middleware trata a chave vencida como livre e o job expurga as vencidas; testes unitários (3 + 1) e `idempotency-key` (chave vencida executa de novo). Falta o **dono/jurídico aprovar os prazos** (dado pessoal: IP e usuário).

**D-11 — Infraestrutura. Estado: PENDENTE-INFRA.** As 57 migrations estão aplicadas só em dev e teste (e, fora do Docker, num banco de simulação com papéis separados — [BACKUP_RECUPERACAO §6](BACKUP_RECUPERACAO.md)). Roteiro: backup restaurável → `prisma migrate deploy` (com o papel dono) → `npm run db:check-rls` → `npm run db:replay-check` contra o staging ([PRODUCAO §4, §13–15](PRODUCAO.md)). O dev roda PostgreSQL 18.6 no Windows; a CI e o compose usam `postgres:18-alpine`; **a cadeia de migrations nunca rodou em Linux nesta máquina**. Backup restaurável só provado em dev (`backup:verify`); restauração em **outro host** e RPO/RTO pendentes (decisão 106).

**Achados novos desta rodada (E-01 a E-05).** *E-01 (Alta):* a FK composta `payments → employee_agreements` fez o `INSERT` do pagamento tomar `FOR KEY SHARE` no convênio; o serviço travava o convênio `FOR UPDATE` **depois** — com duas compras simultâneas, cada transação segurava o `KEY SHARE` e esperava o `UPDATE` da outra (`40P01`, "impasse detectado"; o teste de concorrência `agreements` falhou). Correção: `lockForPayment` trava o convênio **antes** do `INSERT` (e devolve erro humano para convênio de outra empresa em vez de deixar a FK recusar). *E-02:* ver decisão 137. *E-03:* ver decisão 139. *E-04/E-05:* ver decisão 140.

## 4. Dados existentes — como foram protegidos

- Nenhum registro de banco compartilhado foi apagado, truncado, anonimizado ou reescrito. A **única** migration que altera dado é `20261014170000` (hash e `companyId` das sessões, **preservando-as**; abortável; provada com dado legado). As demais mudam estrutura, RLS, índices ou configuração; as guardas só leem.
- Antes de cada FK/trigger: contagem de linhas cruzadas (0), de duplicidade de `(companyId, id)` (0) e das FKs existentes (0 violações); a migration **repete** a checagem (como Super Admin) e aborta se achar dado inconsistente. Linhas de empresas que **não existem mais** não são associadas a nenhuma empresa por suposição: ficam intactas e a FK correspondente fica `NOT VALID`.
- Os testes criam dados sintéticos em empresas de teste (a fixture recusa empresas que não sejam "Integration Test Co …") e os removem por um expurgo guiado pelo catálogo; experimentos que exigiam dado inconsistente rodaram em **banco temporário** criado e removido pelo script.
- **Única remoção de linhas desta revisão (banco de TESTE, dado sintético):** `test:integration:prepare` removeu 26 `categories`, 9 `import_batches` e 173 `idempotency_keys` de empresas sintéticas já apagadas — impossível no dev/produção (o nome do banco precisa conter "test").
- Exceção documentada: o **checksum** de `20261014160000…` no `_prisma_migrations` de dev e teste foi atualizado depois de corrigir um comentário do cabeçalho (nenhuma instrução SQL mudou) — [RELATORIO_MIGRATIONS §4.4](RELATORIO_MIGRATIONS.md). Nenhum outro checksum foi alterado.
- O recebível órfão de teste e as 4 vendas do sandbox foram **mantidos**.

## 5. Achados automáticos (catálogo do PostgreSQL)

<!-- db-docs:findings:begin -->
### A. Estrutura e RLS (consulta ao catálogo em 2026-10-19)

| Verificação | Resultado |
|---|---|
| Tabelas (banco) / modelos (schema) | 113 / 113 — coincidem |
| Tabelas sem RLS habilitada **e** forçada | 0 |
| Tabelas com RLS e **nenhuma** policy | 0 |
| Tabelas sem chave primária | 0 |
| Policies sem condição ou `true` | `support_kb_categories.support_kb_categories_read (SELECT: true)` |
| `companyId` anulável (linha sem dono de empresa) | `audit_logs`, `commercial_leads`, `monitoring_alert_events`, `monitoring_alerts`, `monitoring_threshold_changes`, `monitoring_thresholds`, `permissions`, `refresh_tokens`, `request_logs`, `roles`, `system_logs`, `users` |
| Tabelas com `branchId` cuja policy **não** menciona filial | 4: `monitoring_threshold_changes`, `monitoring_thresholds`, `user_branches`, `user_roles` |
| Tabelas com `companyId` sem índice que comece por `companyId` | 0 |
| Papel de conexão desta consulta | `lnsystem` — superusuário: não; ignora RLS: não |

### B. Tabelas sem `companyId` (25) e como são isoladas

| Tabela | Domínio | Policies (condição resumida) |
|---|---|---|
| `access_revocations` | Plataforma, identidade e acesso | access_revocations_platform: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `activations` | Plataforma, identidade e acesso | activations_isolation: `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("licenseId" IN ( SELECT licenses.id FROM licenses WHERE (licenses."companyId" = ( ` |
| `appointment_events` | Clientes, veículos e pós-venda | appointment_events_isolation: `("appointmentId" IN ( SELECT appointments.id FROM appointments))` |
| `cash_movements` | Vendas, caixa e pagamento | cash_movements_insert: `—`; cash_movements_purge: `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`; cash_movements_select: `("cashRegisterId" IN ( SELECT cash_registers.id FROM cash_registers))` |
| `combo_items` | Catálogo e estoque | combo_items_isolation: `("comboId" IN ( SELECT products.id FROM products))` |
| `commercial_lead_events` | Não classificada | commercial_lead_events_insert: `—`; commercial_lead_events_purge: `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`; commercial_lead_events_select: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `companies` | Plataforma, identidade e acesso | companies_isolation: `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (id = ( SELECT app_ctx.company_id() AS company_id)))` |
| `devices` | Plataforma, identidade e acesso | devices_isolation: `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("licenseId" IN ( SELECT licenses.id FROM licenses WHERE (licenses."companyId" = (` |
| `external_deliveries` | Não classificada | external_deliveries_platform: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `follow_up_events` | Clientes, veículos e pós-venda | follow_up_events_isolation: `("followUpId" IN ( SELECT follow_ups.id FROM follow_ups))` |
| `inventory_counts` | Catálogo e estoque | inventory_counts_isolation: `("inventoryId" IN ( SELECT inventories.id FROM inventories))` |
| `monitoring_settings` | Não classificada | monitoring_settings_platform: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `purchase_order_items` | Catálogo e estoque | purchase_order_items_isolation: `("purchaseOrderId" IN ( SELECT purchase_orders.id FROM purchase_orders))` |
| `quote_items` | Oficina | quote_items_isolation: `("quoteVersionId" IN ( SELECT quote_versions.id FROM quote_versions))` |
| `quote_versions` | Oficina | quote_versions_isolation: `("quoteId" IN ( SELECT quotes.id FROM quotes))` |
| `role_permissions` | Plataforma, identidade e acesso | role_permissions_delete: `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("roleId" IN ( SELECT `; role_permissions_insert: `—`; role_permissions_select: `("roleId" IN ( SELECT roles.id FROM roles))`; role_permissions_update: `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("roleId" IN ( SELECT ` |
| `sale_items` | Vendas, caixa e pagamento | sale_items_isolation: `("saleId" IN ( SELECT sales.id FROM sales))` |
| `service_health_samples` | Não classificada | service_health_samples_platform: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `service_order_items` | Oficina | service_order_items_isolation: `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))` |
| `service_order_status_history` | Oficina | service_order_status_history_insert: `—`; service_order_status_history_purge: `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`; service_order_status_history_select: `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))` |
| `support_kb_articles` | Ajuda e Suporte | support_kb_articles_read: `((status = 'PUBLISHED'::text) OR ( SELECT app_ctx.is_super_admin() AS is_super_admin))`; support_kb_articles_write: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `support_kb_categories` | Ajuda e Suporte | support_kb_categories_read: `true`; support_kb_categories_write: `( SELECT app_ctx.is_super_admin() AS is_super_admin)` |
| `transfer_items` | Catálogo e estoque | transfer_items_isolation: `("transferId" IN ( SELECT transfers.id FROM transfers))` |
| `user_roles` | Plataforma, identidade e acesso | user_roles_delete: `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("userId" IN ( SELECT `; user_roles_insert: `—`; user_roles_select: `("userId" IN ( SELECT users.id FROM users))`; user_roles_update: `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("userId" IN ( SELECT ` |
| `vehicle_entry_checklist_items` | Oficina | vehicle_entry_checklist_items_isolation: `("checklistId" IN ( SELECT vehicle_entry_checklists.id FROM vehicle_entry_checklists))` |

### C. Tabelas sem FK de empresa/filial (retenção) e relações lógicas

- **9** tabelas com `companyId` sem FK para `companies`; **9** com `branchId` sem FK para `branches`; **83** relações `…Id` entre entidades sem FK (inferidas; ver [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md) §5).
- Efeito: as tabelas **com** FK de empresa/filial (a regra desde 2026-10-15) recusam referência órfã e registro apontando para outra empresa (`P2003`); as listadas acima como sem FK são de retenção/telemetria/idempotência (sem dado de negócio a preservar) e continuam protegidas só pela RLS (`WITH CHECK`) e pelos serviços. A conferência de órfãos por contagem usa o papel que ignora RLS (somente leitura; ver D2b).

### D. FKs com `ON DELETE CASCADE` (24; apagar o pai apaga os filhos — as marcadas com ⚠ ficam em domínio financeiro, fiscal, de oficina ou de auditoria)

- `activations.deviceId` → `devices` (Plataforma, identidade e acesso)
- `activations.licenseId` → `licenses` (Plataforma, identidade e acesso)
- `activations.userId` → `users` (Plataforma, identidade e acesso)
- `combo_items.comboId` → `products` (Catálogo e estoque)
- `combo_items.productId` → `products` (Catálogo e estoque)
- `device_sessions.companyId, userId` → `users` (Plataforma, identidade e acesso)
- `device_sessions.deviceId` → `devices` (Plataforma, identidade e acesso)
- `devices.licenseId` → `licenses` (Plataforma, identidade e acesso)
- `installment_policies.companyId` → `companies` (Políticas e calendário)
- ⚠ `partners.companyId` → `companies` (Vendas, caixa e pagamento)
- `permissions.companyId` → `companies` (Plataforma, identidade e acesso)
- `product_barcodes.companyId` → `companies` (Catálogo e estoque)
- `product_images.companyId` → `companies` (Catálogo e estoque)
- `product_images.companyId, productId` → `products` (Catálogo e estoque)
- `refresh_tokens.companyId` → `companies` (Plataforma, identidade e acesso)
- `refresh_tokens.companyId, userId` → `users` (Plataforma, identidade e acesso)
- `refresh_tokens.userId` → `users` (Plataforma, identidade e acesso)
- `role_permissions.permissionId` → `permissions` (Plataforma, identidade e acesso)
- `role_permissions.roleId` → `roles` (Plataforma, identidade e acesso)
- `roles.companyId` → `companies` (Plataforma, identidade e acesso)
- `user_branches.companyId, branchId` → `branches` (Não classificada)
- `user_branches.companyId, userId` → `users` (Não classificada)
- `user_roles.roleId` → `roles` (Plataforma, identidade e acesso)
- `user_roles.userId` → `users` (Plataforma, identidade e acesso)

### D2. Órfãos nas relações sem FK — não executada (rode com `--orphans`; exige BACKUP_DATABASE_URL do banco de desenvolvimento)

Nenhuma relação conferida.

### D2b. FKs declaradas: linhas sem pai — não conferido (rode com `--orphans`)

Existir a FK não prova que os dados antigos a respeitam: o `ADD CONSTRAINT` feito pelo dono sob FORCE RLS, sem contexto, não enxerga as linhas (ver [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md) §4.3).

### D3. FKs simples restantes onde filho e pai têm `companyId` (5) e a proteção de cada uma

A checagem de FK não passa pela RLS e a policy do filho só olha o companyId do próprio filho; por isso a regra do projeto é a FK **composta** `(companyId, X) → pai(companyId, id)` (94 relações, migrações 20261014160000 e 20261014180000). Estas FKs simples sobraram **de propósito** e cada uma tem a proteção da última coluna: `SET NULL` não pode virar FK composta no Prisma (anularia também o companyId), então `sales.partnerId`, `service_orders.mechanicId` e `users.branchId` têm **trigger de mesma empresa** (20261015160000); `refresh_tokens.userId` também tem a FK composta `(companyId, userId)`; `audit_logs.userId` fica só com a FK simples (log com retenção). Dados atuais: não conferido (rode com `--orphans`). "SET NULL" não pode virar FK composta no Prisma (anularia também o companyId); "pai/filho anulável" exige tratamento próprio.

| Filho.coluna → Pai | Ao apagar o pai | companyId do pai | companyId do filho | Proteção de mesma empresa |
|---|---|---|---|---|
| `audit_logs.userId` → `users` | SET NULL | **anulável** | **anulável** | só a FK simples (log com retenção) |
| `refresh_tokens.userId` → `users` | CASCADE | **anulável** | **anulável** | FK composta `(companyId, userId)` |
| `sales.partnerId` → `partners` | SET NULL | obrigatório | obrigatório | trigger `sales_partner_same_company` |
| `service_orders.mechanicId` → `users` | SET NULL | **anulável** | obrigatório | trigger `service_orders_mechanic_same_company` |
| `users.branchId` → `branches` | SET NULL | obrigatório | **anulável** | trigger `users_branch_same_company` |

### E. Imutabilidade de histórico e livros: o que a RLS permite

A imutabilidade no banco é feita por **RLS** (comando sem policy = negado; `FORCE RLS` vale também para o dono), não por trigger. Para cada tabela de histórico/livro, os comandos que têm policy:

| Tabela | SELECT | INSERT | UPDATE | DELETE | Leitura |
|---|---|---|---|---|---|
| `audit_logs` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `collection_attempts` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `discount_events` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `policy_changes` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `monitoring_threshold_changes` | policy | policy | negado | negado | imutável pelo banco |
| `service_order_status_history` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `revisions` | policy | policy | policy | policy | **UPDATE/DELETE permitidos pela RLS — imutabilidade só na aplicação** |
| `stock_movements` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `cash_movements` | policy | policy | negado | policy | sem UPDATE; DELETE só pelas condições da policy |
| `sale_items` | policy | policy | policy | policy | **UPDATE/DELETE permitidos pela RLS — imutabilidade só na aplicação** |

Triggers não internos no banco (5): `sales.sales_partner_same_company`, `service_orders.service_orders_mechanic_same_company`, `user_branches.user_branches_guard`, `users.users_branch_same_company`, `users.users_guard_privileged_columns`.

### F. Colunas sensíveis a revisar (nome sugere segredo, hash, documento ou dado pessoal) — 50

Só nomes e tipos; nenhum valor foi lido. Confirmar, para cada uma, se o conteúdo é cifrado/hash ou dado pessoal sujeito à LGPD.

| Tabela | Coluna | Tipo |
|---|---|---|
| `activations` | `ipAddress` | text |
| `agreement_companies` | `cnpj` | text |
| `agreement_companies` | `phone` | text |
| `agreement_companies` | `email` | text |
| `audit_logs` | `ipAddress` | text |
| `branches` | `document` | text |
| `branches` | `address` | text |
| `branches` | `phone` | text |
| `branches` | `email` | text |
| `channel_api_credentials` | `secretEncrypted` | text |
| `channel_api_credentials` | `secretHint` | text |
| `companies` | `document` | text |
| `companies` | `email` | text |
| `companies` | `phone` | text |
| `customers` | `document` | text |
| `customers` | `email` | text |
| `customers` | `phone` | text |
| `customers` | `birthDate` | timestamp(3) without time zone |
| `customers` | `address` | text |
| `device_sessions` | `ipAddress` | text |
| `devices` | `macAddress` | text |
| `devices` | `ipAddress` | text |
| `devices` | `secretHash` | text |
| `employee_agreements` | `cpf` | text |
| `fiscal_configs` | `certificatePassword` | text |
| `fiscal_configs` | `cscToken` | text |
| `fiscal_documents` | `documentType` | "FiscalDocumentType" |
| `idempotency_keys` | `requestHash` | text |
| `motorcycles` | `licensePlate` | text |
| `motorcycles` | `chassisNumber` | text |
| `refresh_tokens` | `ipAddress` | text |
| `refresh_tokens` | `tokenHash` | text |
| `sales_channels` | `credentialsEncrypted` | text |
| `sales_channels` | `credentialsHint` | text |
| `suppliers` | `document` | text |
| `suppliers` | `email` | text |
| `suppliers` | `phone` | text |
| `suppliers` | `address` | text |
| `suppliers` | `addressComplement` | text |
| `suppliers` | `addressNumber` | text |
| `support_tickets` | `requesterEmail` | text |
| `support_tickets` | `requesterPhone` | text |
| `users` | `email` | text |
| `users` | `phone` | text |
| `users` | `password` | text |
| `users` | `emailVerified` | boolean |
| `users` | `mfaSecret` | text |
| `users` | `mfaBackupCodes` | text[] |
| `users` | `mustChangePassword` | boolean |
| `users` | `passwordChangedAt` | timestamp(3) without time zone |

### G. Tipos, defaults e fuso horário

| Verificação | Resultado |
|---|---|
| Colunas `numeric` sem precisão/escala (valor monetário sem limite) | 0 |
| Colunas de ponto flutuante (`double precision`/`real`/`money`) | 14: `device_telemetry`, `monitoring_alerts`, `monitoring_threshold_changes`, `monitoring_thresholds`, `service_health_samples` — só métricas de monitoramento/telemetria (nenhuma financeira) |
| `timestamp` SEM fuso | 284 colunas (o Prisma grava em UTC); com fuso: 0 |
| Dessas, com `DEFAULT CURRENT_TIMESTAMP`/`now()` no BANCO | 118 — o default do banco usa o fuso da SESSÃO (`timezone` do servidor consultado: **UTC**); linhas criadas por SQL direto (migrations, scripts) podem ficar em hora local enquanto as criadas pelo Prisma ficam em UTC |

### H. Índices redundantes — 0 idênticos a outro e 31 que são só o início de outro

**Idênticos (mesmas colunas de um índice único ou de outro índice) — 0:**

nenhum

**Início de outro índice (btree comum, sem WHERE) — 31:**

- `accounts_payable_companyId_idx` ("companyId") ⊂ `accounts_payable_companyId_status_idx` ("companyId", status) em `accounts_payable`
- `appointments_companyId_idx` ("companyId") ⊂ `appointments_companyId_followUpId_key` ("companyId", "followUpId") em `appointments`
- `audit_logs_companyId_idx` ("companyId") ⊂ `audit_logs_companyId_createdAt_idx` ("companyId", "createdAt") em `audit_logs`
- `audit_logs_userId_idx` ("userId") ⊂ `audit_logs_userId_action_idx` ("userId", action) em `audit_logs`
- `cash_registers_branchId_idx` ("branchId") ⊂ `cash_registers_branchId_status_idx` ("branchId", status) em `cash_registers`
- `cash_registers_userId_idx` ("userId") ⊂ `cash_registers_userId_status_idx` ("userId", status) em `cash_registers`
- `company_module_settings_companyId_idx` ("companyId") ⊂ `company_module_settings_companyId_branchId_idx` ("companyId", "branchId") em `company_module_settings`
- `customers_companyId_idx` ("companyId") ⊂ `customers_companyId_document_key` ("companyId", document) em `customers`
- `fiscal_configs_companyId_idx` ("companyId") ⊂ `fiscal_configs_companyId_branchId_key` ("companyId", "branchId") em `fiscal_configs`
- `fiscal_documents_companyId_idx` ("companyId") ⊂ `fiscal_documents_companyId_branchId_documentType_series_num_key` ("companyId", "branchId", "documentType", series, number) em `fiscal_documents`
- `installment_policies_companyId_idx` ("companyId") ⊂ `installment_policies_companyId_branchId_paymentMethod_key` ("companyId", "branchId", "paymentMethod") em `installment_policies`
- `inventories_branchId_idx` ("branchId") ⊂ `inventories_branchId_inventoryNumber_key` ("branchId", "inventoryNumber") em `inventories`
- `inventory_counts_inventoryId_idx` ("inventoryId") ⊂ `inventory_counts_inventoryId_productId_key` ("inventoryId", "productId") em `inventory_counts`
- `invoices_companyId_idx` ("companyId") ⊂ `invoices_companyId_supplierId_invoiceNumber_series_key` ("companyId", "supplierId", "invoiceNumber", series) em `invoices`
- `licenses_companyId_idx` ("companyId") ⊂ `licenses_companyId_status_idx` ("companyId", status) em `licenses`
- `licenses_status_idx` (status) ⊂ `licenses_status_expiryDate_idx` (status, "expiryDate") em `licenses`
- `partners_companyId_idx` ("companyId") ⊂ `partners_companyId_name_key` ("companyId", name) em `partners`
- `payments_saleId_idx` ("saleId") ⊂ `payments_saleId_status_idx` ("saleId", status) em `payments`
- `product_barcodes_companyId_idx` ("companyId") ⊂ `product_barcodes_companyId_code_key` ("companyId", code) em `product_barcodes`
- `product_images_companyId_idx` ("companyId") ⊂ `product_images_companyId_productId_key` ("companyId", "productId") em `product_images`
- `purchase_orders_companyId_idx` ("companyId") ⊂ `purchase_orders_companyId_branchId_poNumber_key` ("companyId", "branchId", "poNumber") em `purchase_orders`
- `quote_versions_quoteId_idx` ("quoteId") ⊂ `quote_versions_quoteId_versionNumber_key` ("quoteId", "versionNumber") em `quote_versions`
- `sales_branchId_idx` ("branchId") ⊂ `sales_branchId_saleDate_idx` ("branchId", "saleDate") em `sales`
- `sales_companyId_idx` ("companyId") ⊂ `sales_companyId_branchId_saleNumber_key` ("companyId", "branchId", "saleNumber") em `sales`
- `sales_channels_companyId_idx` ("companyId") ⊂ `sales_channels_companyId_branchId_idx` ("companyId", "branchId") em `sales_channels`
- `service_orders_branchId_idx` ("branchId") ⊂ `service_orders_branchId_osNumber_key` ("branchId", "osNumber") em `service_orders`
- `stock_movements_branchId_idx` ("branchId") ⊂ `stock_movements_branchId_productId_idx` ("branchId", "productId") em `stock_movements`
- `stock_movements_productId_idx` ("productId") ⊂ `stock_movements_productId_createdAt_idx` ("productId", "createdAt") em `stock_movements`
- `suppliers_companyId_idx` ("companyId") ⊂ `suppliers_companyId_document_key` ("companyId", document) em `suppliers`
- `transfers_companyId_idx` ("companyId") ⊂ `transfers_companyId_transferNumber_key` ("companyId", "transferNumber") em `transfers`
- `vehicle_entry_checklists_companyId_idx` ("companyId") ⊂ `vehicle_entry_checklists_companyId_serviceOrderId_key` ("companyId", "serviceOrderId") em `vehicle_entry_checklists`

Remover índice redundante é ganho de escrita/espaço, não correção: nada foi removido (decisão com medição de uso — `pg_stat_user_indexes` — em staging).

<!-- db-docs:findings:end -->
