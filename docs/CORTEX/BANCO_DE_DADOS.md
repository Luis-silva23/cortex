# Banco de dados — inventário, auditoria e fechamento (2026-10-14/15)

> Complementa [DATABASE](DATABASE.md) (migrações, RLS, livro de estoque, backup). Aqui: **o que existe** (106 tabelas), **para que serve**, **o que foi conferido** e **o que falta por decisão** — sem tabela especulativa. O **Anexo A** (no fim) traz, **tabela por tabela**, domínio, finalidade (comentário do modelo), colunas, chave primária, chaves estrangeiras (com a regra ao apagar), únicos e CHECK, índices, políticas RLS e triggers, gerado do catálogo do PostgreSQL de desenvolvimento por `cd apps/api && npm run db:docs -- --write` (somente leitura; `npm run db:inventory` imprime só o resumo).
>
> **Pacote de revisão externa** (todos gerados desta fonte, sem segredo nem dado de cliente): [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md) (FKs, relações sem FK, diagramas por domínio) · [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md) (50 migrations: ordem, finalidade, estruturas, aplicação por ambiente, divergências) · [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md) (problemas, riscos e pendências) · [DECISIONS](DECISIONS.md) (quadro "Decisões e pendências que tocam o banco de dados") · cópia do schema Prisma e das migrations com SHA-256 em [revisao-banco/](revisao-banco/LEIA-ME.md).

## 1. Estado verificado (2026-10-15)

| Verificação | Comando | Resultado |
|---|---|---|
| **Reaplicação do zero** | `npm run db:replay-check` (banco temporário vazio, removido ao fim) | as **57** migrations aplicadas do zero produzem **exatamente** o catálogo do dev: 3 712 itens (colunas, índices, constraints, policies, RLS, triggers, funções, sequências, enums, fuso), 0 só no dev, 0 só no reaplicado; `migrate diff` banco → schema **vazio**; `db:check-rls` OK no banco reaplicado → **nenhuma alteração manual invisível** no banco de desenvolvimento ([RELATORIO_MIGRATIONS §4.2](RELATORIO_MIGRATIONS.md)) |
| Migration com dado inconsistente | `npm run db:replay-check` (3 bancos temporários com dado sintético) | **(1)** código de barras da empresa A apontando para produto da B; **(2)** sessões legadas (token em texto) com empresa divergente; **(3)** produto da A com filial da B + cliente de empresa inexistente: em cada caso o `migrate deploy` **aborta na guarda**, nada fica pela metade e `migrate resolve --rolled-back` + novo deploy conclui; no (2) o hash calculado em SQL é **igual** ao da aplicação (sessões preservadas) e no (3) o dado legado **não é apagado nem associado a empresa** (FK `NOT VALID`) ([RELATORIO_MIGRATIONS §4.2](RELATORIO_MIGRATIONS.md)) |
| Checksums | `_prisma_migrations` × arquivos | os 50 conferem; única reconciliação: o checksum de `20261014160000` em dev/teste depois de corrigir um comentário ([RELATORIO_MIGRATIONS §4.4](RELATORIO_MIGRATIONS.md)); nenhuma aplicada que não esteja no repositório |
| PostgreSQL | `SELECT version()` | 18.6 (Windows); CI e `docker-compose.yml` usam `postgres:18-alpine` — Linux **não** exercitado |
| Migrações aplicadas (dev) | `prisma migrate status` | 57 migrações, **"Database schema is up to date"** |
| Migrações aplicadas (teste) | `npm run test:integration` (aplica antes) | 50 aplicadas em `lnsystem_test` |
| RLS | `npm run db:check-rls` | **todas as invariantes OK**: 106 tabelas com RLS habilitado **e forçado**, toda tabela com `companyId` tem policy, a role de conexão não ignora RLS |
| Schema Prisma × banco | `prisma migrate diff --from-url <banco> --to-schema-datamodel schema.prisma` | **vazio** (0 instruções): o `schema.prisma` descreve exatamente o banco (§4); nenhuma tabela/coluna faltando ou sobrando |
| Inventário | `npm run db:inventory` | 106 tabelas = 106 modelos do schema |
| Produção / staging | — | **não aplicado, não verificado** (não há ambiente; ver §6) |

## 2. Inventário por domínio

Convenção do projeto: dado de empresa leva `companyId` (e `branchId` quando é por filial). **Desde 2026-10-15 o banco impõe o escopo, além da RLS (`rls_company_match` / `rls_company_branch_match`):** `companyId → companies` com FK em 65 tabelas de negócio, FK composta `(companyId, X) → pai(companyId, id)` em 94 relações e `(companyId, branchId) → branches(companyId, id)` em 55 tabelas, e trigger de mesma empresa em 3 referências que não admitem FK composta (decisões 124, 129, 136). Ficam sem FK de propósito apenas logs/telemetria/idempotência (retenção). Totais conferidos no catálogo em 2026-10-15 (dev e teste): 152 FKs compostas (95 de relação + 57 de filial), 77 FKs simples `companyId → companies`, 22 FKs `CASCADE` restantes e 3 triggers de mesma empresa. A regra ao apagar o pai (`RESTRICT` no histórico, `CASCADE` só em dado derivado/configuração) aparece na coluna "Relacionamentos" do inventário gerado.

### Plataforma, identidade e acesso
| Tabela | Finalidade | Usada por |
|---|---|---|
| `companies`, `branches` | empresa cliente e suas filiais (a filial `isHeadquarter` é a matriz) | tudo; cadastro da empresa, Super Admin |
| `users` | usuários (login por e-mail e por `numericId`), hash de senha, MFA (segredo cifrado, códigos de recuperação em hash, `mfaLastStep` anti-reuso), bloqueio por tentativas | login, usuários e perfis, bootstrap do Super Admin |
| `roles`, `permissions`, `role_permissions`, `user_roles` | RBAC granular (perfil → permissões, usuário → perfis, por empresa ou filial) | Usuários e Perfis, `requirePermission` |
| `refresh_tokens` | renovação de sessão com rotação e detecção de reuso; vínculo com a sessão de equipamento | `/auth/refresh`, logout |
| `access_revocations` **(nova, decisão 107)** | revogação durável de access token (por token, usuário ou empresa); fonte quando o Redis cai | middleware de autenticação |
| `licenses`, `invoices` | licença e faturamento da plataforma por empresa | Super Admin, licenças |
| `activations`, `devices`, `device_sessions`, `device_telemetry` | equipamento (PDV): registro, autorização, uma sessão ativa por equipamento/usuário, telemetria | autorização de equipamento, monitoramento |
| `company_module_settings` | módulos liga/desliga por empresa/filial | `requireModuleEnabled` |

### Auditoria, observabilidade e operação
| Tabela | Finalidade | Usada por |
|---|---|---|
| `audit_logs` | trilha append-only (quem, o quê, quando; sem segredo) | auditoria, `PERMISSION_CHANGED`, pedidos de titular |
| `system_logs`, `request_logs` | log técnico e de requisições (sem dado sensível) | observabilidade |
| `idempotency_keys` | repetição segura de operações (vendas, pagamentos) | PDV, Commerce API |
| `health_incidents`, `monitoring_alerts`, `monitoring_thresholds`, `monitoring_threshold_changes` | saúde, alertas e limites do monitoramento (histórico imutável das mudanças) | Super Admin › Monitoramento |
| `import_batches` | lote de importação (produtos, clientes, estoque) com resultado por linha | importação por planilha |

### Políticas e calendário
`policy_settings` (valor por empresa/filial), `policy_changes` (histórico imutável), `payment_settings`, `installment_policies` (parcelamento, **sem juros**), `business_hours`, `business_calendar_exceptions`, `agenda_unavailabilities` — configuram regras de desconto, caixa, fiscal, agenda e parcelamento ([POLICIES](POLICIES.md)).

### Catálogo e estoque
| Tabela | Finalidade |
|---|---|
| `products` | produto (SKU por empresa, código de barras "principal" `products.barcode`) |
| `product_barcodes` **(2026-10-14)** | vários códigos de barras por produto, texto (zeros preservados), único por empresa, desativável; **FK composta** `(companyId, productId) → products(companyId, id)`: o produto é sempre da mesma empresa da linha (decisão 124) |
| `product_images` **(nova, decisão 122)** | imagem opcional (uma por produto), saneada, sob RLS; **FK composta** `(companyId, productId) → products(companyId, id)` (decisão 124) |
| `categories`, `combo_items` | categorias e composição de combos |
| `stock_movements` | **livro** de estoque (o saldo é calculado dele) |
| `inventories`, `inventory_counts` | inventário (contagem e fechamento por filial) |
| `transfers`, `transfer_items` | transferência entre filiais |
| `damage_records` | avarias/perdas |
| `stock_reservations` | reserva temporária de estoque de pedidos externos |
| `suppliers`, `purchase_orders`, `purchase_order_items` | fornecedores e compras (recebimento, custo) |
| `supplier_returns`, `supplier_return_items`, `supplier_return_events` | devolução ao fornecedor |

### Clientes, veículos e pós-venda
`customers` (cadastro; `anonymizedAt` **novo**, decisão 120), `motorcycles`, `revisions` (histórico imutável do que foi feito), `follow_ups` + `follow_up_events`, `appointments` + `appointment_events`, `privacy_requests` **(nova, decisão 120)** — registro durável dos pedidos de titular (exportação/anonimização): quem, quando, por quê, o que foi feito e retido; o arquivo de exportação fica cifrado e expira.

### Vendas, caixa e pagamento
`sales`, `sale_items`, `payments` (pagamento manual/maquininha), `payment_exceptions` (conflito com o provedor), `tef_payments`, `cash_registers`, `cash_movements`, `discount_rules`, `discount_events` (append-only), `partners` — PDV, balcão e fechamento de caixa.

### Financeiro e convênios
`accounts_payable`, `accounts_receivable`, `collection_attempts` (cobrança manual; **append-only**), `agreement_companies`, `employee_agreements`, `employee_agreement_charges`, `employee_payroll_deductions`, `commission_rules`, `mechanic_commissions`.

### Oficina
`service_orders`, `service_order_items`, `service_order_status_history`, `service_order_warranties`, `warranty_claims`, `quotes`, `quote_versions`, `quote_items`, `quote_events`, `vehicle_entry_checklists`, `vehicle_entry_checklist_items`.

### Fiscal
`fiscal_configs` (configuração e segredos cifrados), `fiscal_documents` (documento; **sem** tabela tributária de IBS/CBS — não existe e nada foi inventado; a tabela fiscal legada **não foi fornecida**).

### Canais e integração
`sales_channels`, `channel_api_credentials`, `channel_product_links`, `channel_events`, `channel_inbound_events`, `channel_outbox`, `external_orders`, `external_order_items`, `external_payments`, `fulfillments` — Commerce API e Integration Gateway (só provedor simulado).

### Ajuda e Suporte
`support_tickets`, `support_ticket_messages`, `support_ticket_attachments`, `support_ticket_events`, `support_kb_articles`, `support_kb_categories` ([SUPPORT](SUPPORT.md)).

## 3. Migrações de 2026-10-14 e 2026-10-15 (as 5 de 14/10 são **aditivas**; a revisão do banco tem 14 migrations, cada uma com problema, guarda e reversão no cabeçalho)

| Migração | O que faz | Dev (`lnsystem_db`) | Teste (`lnsystem_test`) | Staging / produção |
|---|---|---|---|---|
| `20261014100000_product_barcodes` | tabela `product_barcodes` + preenchimento a partir de `products.barcode` | aplicada | aplicada | **a aplicar** |
| `20261014120000_access_revocations` | tabela `access_revocations` (RLS só plataforma) | aplicada | aplicada | **a aplicar** |
| `20261014130000_mfa_replay_guard` | coluna `users."mfaLastStep"` (anti-reuso de código TOTP) | aplicada | aplicada | **a aplicar** |
| `20261014140000_privacy_requests` | tabela `privacy_requests` + coluna `customers."anonymizedAt"` | aplicada | aplicada | **a aplicar** |
| `20261014150000_product_images` | tabela `product_images` (cascata do produto) | aplicada | aplicada | **a aplicar** |
| `20261014155900_guard_product_children_same_company` | **guarda**: lê como plataforma e aborta se houver código de barras/imagem apontando para produto de outra empresa (a validação da FK sob FORCE RLS passa em branco) | aplicada | aplicada | **a aplicar** (roda antes da seguinte) |
| `20261014160000_product_children_same_company` | índice único `products(companyId, id)`; FKs compostas `(companyId, productId) → products(companyId, id)` em `product_barcodes` e `product_images`; saem as FKs simples | aplicada | aplicada | **a aplicar** |
| `20261014161000_product_images_company_product_unique` | índice único `product_images(companyId, productId)` (exigido pelo Prisma para a relação 1:1) | aplicada | aplicada | **a aplicar** |
| `20261014162000_rls_logs_roles_tighten` | RLS: logs só da empresa (ou plataforma); `roles`/`permissions` globais legíveis, escrita só da própria empresa ou do Super Admin | aplicada | aplicada | **a aplicar** |
| `20261014170000_refresh_tokens_hash_and_company` | `refresh_tokens`: `tokenHash` (SHA-256, igual em SQL e na aplicação), `companyId` só pelo usuário, sem ramo `IS NULL`; remove a coluna `token`; **aborta** se uma sessão tiver empresa divergente | aplicada | aplicada | **a aplicar** (reiniciar a API depois) |
| `20261014180000_composite_company_fks` | **94** FKs compostas `(companyId, X) → pai(companyId, id)` (61 convertidas, 33 criadas), `@@unique([companyId, id])` em 26 pais, 8 `SET NULL` → `RESTRICT`; guarda de dados (aborta com dado cruzado) | aplicada | aplicada | **a aplicar** |
| `20261015100000_company_and_branch_fks` | `companyId → companies` em 65 tabelas e `(companyId, branchId) → branches` em 55; guarda; linha de empresa inexistente fica com a FK `NOT VALID` | aplicada | aplicada | **a aplicar** |
| `20261015110000_cascade_to_restrict_history` | 21 FKs `CASCADE` → `RESTRICT` (venda, pagamento, estoque, caixa, OS, orçamento, auditoria, LGPD…) | aplicada | aplicada | **a aplicar** |
| `20261015120000_append_only_ledgers` | `stock_movements`, `cash_movements`, `policy_changes`, `service_order_status_history`: policy por comando (UPDATE negado; DELETE só com expurgo sinalizado) | aplicada | aplicada | **a aplicar** |
| `20261015130000_drop_duplicate_indexes` | remove 5 índices idênticos a um UNIQUE | aplicada | aplicada | **a aplicar** |
| `20261015140000_missing_fk_and_rls_indexes` | 16 índices ausentes (9 tabelas sem índice por `companyId` + 7 FKs) | aplicada | aplicada | **a aplicar** |
| `20261015150000_database_timezone_utc` | `ALTER DATABASE … SET timezone TO 'UTC'` (só novas sessões; nenhum dado alterado) | aplicada | aplicada | **a aplicar** (o papel que migra precisa ser dono do banco) |
| `20261015160000_same_company_ref_triggers` | trigger de mesma empresa em `sales.partnerId`, `service_orders.mechanicId`, `users.branchId`; guarda | aplicada | aplicada | **a aplicar** |
| `20261015170000_drop_redundant_company_indexes` | remove 13 `<tabela>_companyId_idx` redundantes com o alvo único `(companyId, id)` | aplicada | aplicada | **a aplicar** |

Verificado: nenhuma remove, renomeia ou altera coluna de dado de negócio; as colunas novas são anuláveis; as tabelas novas têm RLS **forçada** e policy. A **única** que altera linha é `20261014170000` (sessões: hash e `companyId`, **preservadas** e provadas); as de FK/trigger têm **guarda** que lê como plataforma e aborta com dado inconsistente (nunca "adivinha"); linhas de empresa que não existe mais ficam intactas com a FK `NOT VALID`. **Em produção:** `prisma migrate deploy` com o usuário **dono** das tabelas **depois de um backup restaurável**, seguido de `npm run db:check-rls` ([PRODUCAO §4](PRODUCAO.md)); a API deve usar o papel de execução sem posse (`deploy/db-runtime-role.sql`). Nada foi aplicado em produção.

## 4. Diferenças entre o schema Prisma e o banco — hoje: nenhuma

`prisma migrate diff` banco → `schema.prisma` é **vazio** (verificado no dev e num banco reaplicado do zero). Até 2026-10-14 (tarde) o diff trazia 7 instruções porque o schema **não descrevia** objetos que existem no banco por SQL das migrações — e **nunca foram migrations**: era a saída do diff, que um `migrate dev`/`db push` teria aplicado (`DROP SEQUENCE support_ticket_number_seq`, `DROP INDEX support_kb_articles_search_idx`, tirar defaults). Corrigido **só no schema** (decisão 126): `support_tickets.ticketNumber @default(autoincrement())` (default `nextval` da sequência própria), `support_kb_articles.search` (coluna `tsvector` gerada em português, `@default(dbgenerated(...))`) com `@@index([search], type: Gin)`, e `@default(now()) @updatedAt` nas duas tabelas da base de conhecimento. Detalhe e prova em [REVISAO_BANCO_PENDENCIAS §2](REVISAO_BANCO_PENDENCIAS.md).

Continuam existindo só no banco, **e o diff não os enxerga como diferença**: índices parciais únicos e restrições `CHECK` (ex.: uma sessão ativa por equipamento, `sales_physical_origin_check`) — ver as notas nos modelos. Antes (rodada anterior) já tinham sido alinhados: índice `accounts_receivable(agreementCompanyId)`, índice `appointments(mechanicId)` e os nomes dos índices de `employee_payroll_deductions`.

## 5. Lacunas por decisão (registradas, **não** criadas)

Estruturas que dependem de decisão do dono, regulamentação ou dado não fornecido — **nenhuma tabela especulativa foi criada**:

| Pendência | Depende de | Registro |
|---|---|---|
| Tabela fiscal legada e campos tributários (IBS, CBS, Split Payment) | tabela fornecida pelo dono/contador; regulamentação | [DECISIONS 113](DECISIONS.md) |
| Cronograma de recebimento do cartão parcelado (parcelas, taxa, antecipação) | decisão comercial e provedor | DECISIONS 114 |
| Juros do parcelamento | decisão comercial | DECISIONS 119 |
| Fulfillment: endereço, frete, responsável | decisão comercial | DECISIONS 101 |
| Importação direta Balcão → PDV (entidade "venda em atendimento") | decisão de produto | DECISIONS 115 |
| Dados do comprador em pedido externo (`external_orders.payload`) sem vínculo com `customers` | LGPD e decisão de produto | DECISIONS 93 |
| Prazos de retenção de `audit_logs`, `request_logs`, `system_logs`, telemetria e evidências (o expurgo **existe** e é configurável por env — 90/90/30/30/365 dias; `Idempotency-Key` expira em 24 h) | aprovação do dono e do jurídico (dado pessoal) | docs/privacidade, [DECISIONS 141](DECISIONS.md) |

## 6. O que falta para dar o banco como finalizado em homologação/produção

1. Aplicar as 19 migrações de 2026-10-14/15 (5 + 14 da revisão) em **staging** (não existe), com o papel dono, e rodar `db:check-rls`, `db:replay-check` e a suíte de integração contra ele; adotar o papel de execução sem posse (`deploy/db-runtime-role.sql`, provado por `db:role-split-check`).
2. Backup **restaurável testado** antes de qualquer `migrate deploy` em produção ([PRODUCAO §7](PRODUCAO.md)): a restauração foi provada só em desenvolvimento (`backup:verify`).
3. Decisão do dono sobre as lacunas da §5 (cada uma gera a sua migração quando decidida).
4. **Revisão técnica externa e decisões de segurança do banco**, em [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md): **corrigidos e provados** A-01/B-01 (schema descreve sequência, coluna gerada e GIN), C-01/C-02/C-03 (referência cruzada entre empresas: FK composta em 94 relações, FK de filial, trigger, guardas), D-01 (`refresh_tokens`: hash e isolamento), D-02 (RLS de logs e perfis globais), D-03 (livros append-only), D-04 (`CASCADE` → `RESTRICT`), D-05 (FKs de empresa/filial; 1 recebível órfão legado preservado, `NOT VALID`), D-06 (índices duplicados/redundantes), D-07 (fuso UTC), D-09 (índices), D-10 (expurgo de `Idempotency-Key`) e os achados E-01 a E-05 (deadlock de convênio, `RESTRICT` sem código, expiração da idempotência, órfãos e auditoria assíncrona nos testes); **pendentes**: D-08 adoção do papel de execução (infra), decisão sobre o recebível órfão (financeiro), prazos de retenção (jurídico), os 34 índices-prefixo (medição em staging) e a regra de filial de 9 tabelas (negócio).

## 7. Conexões na suíte de integração — causa e correção (2026-10-14)

Sintoma: `Too many database connections opened` **intermitente**, num teste diferente a cada rodada (rbac, cash-movement-race, concurrency, purchase-order-integrity, dashboard-management…), sempre verde isolado.

**Medição** (`scripts/pg-sample.ts`, amostra a cada 2 s, somente leitura): a contagem de conexões do banco de teste **subia sem parar** durante a rodada — 1 → 13 → 33 → 53 → 75 → **91 de 97 permitidas** (`max_connections=100`, 3 reservadas) — e só estourava quando a quantidade de arquivos empurrava o pico acima do teto. Não era "pouca conexão no banco", era **vazamento**.

**Causa raiz** (provada por medição por arquivo: `PG_ENV_DEBUG=1` mostrava 4, 4, 5, 6, 9… conexões sobrando depois de cada arquivo):
1. `config/queue.ts` cria 6 workers do BullMQ **na importação**. Todo arquivo de teste que importa a API deixava esses workers vivos depois de terminar; eles passavam a consumir os jobs (`request-metrics`, `system-log`, `audit-log`) dos arquivos **seguintes** usando o cliente do banco do arquivo antigo — já fechado — que **reconectava sozinho** e nunca mais era fechado;
2. o `disconnectDb.ts` fechava o pool num `afterAll`, mas o `afterAll` do próprio teste (destroyFixture) rodava depois e reabria.

**Correção** (sem aumentar `max_connections`, sem cliente por operação): ambiente de teste próprio (`test/integration/pgSafeEnvironment.js`) cujo `teardown` — que roda depois de TODOS os hooks do arquivo — fecha primeiro os workers/filas (`closeQueueInfra`, exposto só sob Jest em `config/queue.ts`) e depois o pool do arquivo.

**Resultado medido** (3 rodadas completas depois da correção, todas **107/107 suítes e 1553/1553 testes**): conexões sobrando depois de **cada** um dos 107 arquivos = **0** (duas rodadas com a medição por arquivo ligada); pico observado pelo amostrador **20, 30 e 21** (antes da correção: 91 de 97). Estabilidade: 3 execuções completas seguidas sem falha de infraestrutura nem funcional. Reproduzir: `PG_ENV_DEBUG=1 npm run test:integration` (imprime as conexões restantes por arquivo) e `npx tsx scripts/pg-sample.ts <arquivo.log> 2000` em paralelo.

Para Linux/staging: o mesmo procedimento vale; dimensione `connection_limit` (padrão do Prisma = 2 × núcleos + 1 por cliente) × número de instâncias da API ≤ `max_connections` (PRODUCAO §4).

<!-- db-docs:begin -->
## Anexo A — inventário técnico detalhado (gerado em 2026-10-19; `npm run db:docs -- --write`)

Fonte: catálogo do PostgreSQL do banco de **desenvolvimento** (dados sintéticos; nenhuma linha de dado foi lida) — PostgreSQL 18.6 on x86_64-windows. **113 tabelas**, 113 modelos no schema Prisma. Cada tabela traz domínio, finalidade (comentário do modelo no schema, quando existe), escopo, RLS, colunas, chaves, índices, constraints e políticas. Não há segredo nem dado de cliente neste arquivo (só estrutura).

### Índice por domínio

**Plataforma, identidade e acesso** (16): [access_revocations](#access_revocations) · [activations](#activations) · [branches](#branches) · [companies](#companies) · [company_module_settings](#company_module_settings) · [device_sessions](#device_sessions) · [device_telemetry](#device_telemetry) · [devices](#devices) · [invoices](#invoices) · [licenses](#licenses) · [permissions](#permissions) · [refresh_tokens](#refresh_tokens) · [role_permissions](#role_permissions) · [roles](#roles) · [user_roles](#user_roles) · [users](#users)

**Auditoria, observabilidade e operação** (10): [audit_logs](#audit_logs) · [health_incidents](#health_incidents) · [idempotency_keys](#idempotency_keys) · [import_batches](#import_batches) · [monitoring_alerts](#monitoring_alerts) · [monitoring_threshold_changes](#monitoring_threshold_changes) · [monitoring_thresholds](#monitoring_thresholds) · [privacy_requests](#privacy_requests) · [request_logs](#request_logs) · [system_logs](#system_logs)

**Políticas e calendário** (7): [agenda_unavailabilities](#agenda_unavailabilities) · [business_calendar_exceptions](#business_calendar_exceptions) · [business_hours](#business_hours) · [installment_policies](#installment_policies) · [payment_settings](#payment_settings) · [policy_changes](#policy_changes) · [policy_settings](#policy_settings)

**Catálogo e estoque** (18): [categories](#categories) · [combo_items](#combo_items) · [damage_records](#damage_records) · [inventories](#inventories) · [inventory_counts](#inventory_counts) · [product_barcodes](#product_barcodes) · [product_images](#product_images) · [products](#products) · [purchase_order_items](#purchase_order_items) · [purchase_orders](#purchase_orders) · [stock_movements](#stock_movements) · [stock_reservations](#stock_reservations) · [supplier_return_events](#supplier_return_events) · [supplier_return_items](#supplier_return_items) · [supplier_returns](#supplier_returns) · [suppliers](#suppliers) · [transfer_items](#transfer_items) · [transfers](#transfers)

**Clientes, veículos e pós-venda** (7): [appointment_events](#appointment_events) · [appointments](#appointments) · [customers](#customers) · [follow_up_events](#follow_up_events) · [follow_ups](#follow_ups) · [motorcycles](#motorcycles) · [revisions](#revisions)

**Vendas, caixa e pagamento** (10): [cash_movements](#cash_movements) · [cash_registers](#cash_registers) · [discount_events](#discount_events) · [discount_rules](#discount_rules) · [partners](#partners) · [payment_exceptions](#payment_exceptions) · [payments](#payments) · [sale_items](#sale_items) · [sales](#sales) · [tef_payments](#tef_payments)

**Financeiro e convênios** (9): [accounts_payable](#accounts_payable) · [accounts_receivable](#accounts_receivable) · [agreement_companies](#agreement_companies) · [collection_attempts](#collection_attempts) · [commission_rules](#commission_rules) · [employee_agreement_charges](#employee_agreement_charges) · [employee_agreements](#employee_agreements) · [employee_payroll_deductions](#employee_payroll_deductions) · [mechanic_commissions](#mechanic_commissions)

**Oficina** (11): [quote_events](#quote_events) · [quote_items](#quote_items) · [quote_versions](#quote_versions) · [quotes](#quotes) · [service_order_items](#service_order_items) · [service_order_status_history](#service_order_status_history) · [service_order_warranties](#service_order_warranties) · [service_orders](#service_orders) · [vehicle_entry_checklist_items](#vehicle_entry_checklist_items) · [vehicle_entry_checklists](#vehicle_entry_checklists) · [warranty_claims](#warranty_claims)

**Fiscal** (2): [fiscal_configs](#fiscal_configs) · [fiscal_documents](#fiscal_documents)

**Canais e integração** (10): [channel_api_credentials](#channel_api_credentials) · [channel_events](#channel_events) · [channel_inbound_events](#channel_inbound_events) · [channel_outbox](#channel_outbox) · [channel_product_links](#channel_product_links) · [external_order_items](#external_order_items) · [external_orders](#external_orders) · [external_payments](#external_payments) · [fulfillments](#fulfillments) · [sales_channels](#sales_channels)

**Ajuda e Suporte** (6): [support_kb_articles](#support_kb_articles) · [support_kb_categories](#support_kb_categories) · [support_ticket_attachments](#support_ticket_attachments) · [support_ticket_events](#support_ticket_events) · [support_ticket_messages](#support_ticket_messages) · [support_tickets](#support_tickets)

**Não classificada** (7): [commercial_lead_events](#commercial_lead_events) · [commercial_leads](#commercial_leads) · [external_deliveries](#external_deliveries) · [monitoring_alert_events](#monitoring_alert_events) · [monitoring_settings](#monitoring_settings) · [service_health_samples](#service_health_samples) · [user_branches](#user_branches)

### Plataforma, identidade e acesso

#### `access_revocations`

- **Modelo Prisma:** `AccessRevocation` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Revogação DURÁVEL de access token (decisão 107, 2026-10-14). O Redis continua sendo o caminho rápido; esta tabela é a fonte de verdade quando o Redis está fora do ar (o middleware consulta aqui em vez de aceitar o token revogado) e a origem da ressincronização do Redis quando ele volta. kind: TOKEN (subject = sha256 do token), USER ou COMPANY (subject = id; revokedAt = "tudo emitido até este instante está revogado").…

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `kind` | text | não |  |
| `subject` | text | não |  |
| `revokedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `expiresAt` | timestamp(3) without time zone | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** 
  - check `access_revocations_kind_valid`: `CHECK ((kind = ANY (ARRAY['TOKEN'::text, 'USER'::text, 'COMPANY'::text])))`
- **Índices (3):**
  - `access_revocations_expiresAt_idx` — `INDEX "access_revocations_expiresAt_idx" USING btree ("expiresAt")`
  - `access_revocations_kind_subject_key` — `UNIQUE INDEX access_revocations_kind_subject_key USING btree (kind, subject)`
  - `access_revocations_pkey` — `UNIQUE INDEX access_revocations_pkey USING btree (id)`
- **Políticas RLS:** 
  - `access_revocations_platform` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `activations`

- **Modelo Prisma:** `Activation` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `licenseId` | text | não |  |
| `deviceId` | text | não |  |
| `userId` | text | não |  |
| `activationCode` | text | não |  |
| `status` | "ActivationStatus" | não | `'PENDING'::"ActivationStatus"` |
| `approvedBy` | text | sim |  |
| `approvedAt` | timestamp(3) without time zone | sim |  |
| `activatedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `expiresAt` | timestamp(3) without time zone | sim |  |
| `ipAddress` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `deviceId` → `devices(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `licenseId` → `licenses(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `userId` → `users(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `activations_activationCode_key` — `UNIQUE INDEX "activations_activationCode_key" USING btree ("activationCode")`
  - `activations_deviceId_idx` — `INDEX "activations_deviceId_idx" USING btree ("deviceId")`
  - `activations_licenseId_idx` — `INDEX "activations_licenseId_idx" USING btree ("licenseId")`
  - `activations_pkey` — `UNIQUE INDEX activations_pkey USING btree (id)`
  - `activations_status_idx` — `INDEX activations_status_idx USING btree (status)`
  - `activations_userId_idx` — `INDEX "activations_userId_idx" USING btree ("userId")`
- **Políticas RLS:** 
  - `activations_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("licenseId" IN ( SELECT licenses.id FROM licenses WHERE (licenses."companyId" = ( SELECT app_ctx.company_id() AS company_id)))))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("licenseId" IN ( SELECT licenses.id FROM licenses WHERE (licenses."companyId" = ( SELECT app_ctx.company_id() AS company_id)))))`

#### `branches`

- **Modelo Prisma:** `Branch` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `name` | text | não |  |
| `document` | text | sim |  |
| `address` | text | sim |  |
| `city` | text | sim |  |
| `state` | text | sim |  |
| `zipCode` | text | sim |  |
| `phone` | text | sim |  |
| `isActive` | boolean | não | `true` |
| `isHeadquarter` | boolean | não | `false` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `stateRegistration` | text | sim |  |
| `email` | text | sim |  |
| `whatsapp` | text | sim |  |
| `street` | text | sim |  |
| `number` | text | sim |  |
| `complement` | text | sim |  |
| `district` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `branches_companyId_id_key` — `UNIQUE INDEX "branches_companyId_id_key" USING btree ("companyId", id)`
  - `branches_pkey` — `UNIQUE INDEX branches_pkey USING btree (id)`
- **Políticas RLS:** 
  - `branches_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (id IS NULL) OR (id = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `branches_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `branches_select` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (id IS NULL) OR (id = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `branches_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (id IS NULL) OR (id = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`

#### `companies`

- **Modelo Prisma:** `Company` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `name` | text | não |  |
| `document` | text | não |  |
| `email` | text | não |  |
| `phone` | text | sim |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `legalName` | text | sim |  |
| `stateRegistration` | text | sim |  |
| `municipalRegistration` | text | sim |  |
| `taxRegime` | text | sim |  |
| `whatsapp` | text | sim |  |
| `contactName` | text | sim |  |
| `zipCode` | text | sim |  |
| `street` | text | sim |  |
| `number` | text | sim |  |
| `complement` | text | sim |  |
| `district` | text | sim |  |
| `city` | text | sim |  |
| `state` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `companies_document_key` — `UNIQUE INDEX companies_document_key USING btree (document)`
  - `companies_isActive_createdAt_idx` — `INDEX "companies_isActive_createdAt_idx" USING btree ("isActive", "createdAt")`
  - `companies_pkey` — `UNIQUE INDEX companies_pkey USING btree (id)`
- **Políticas RLS:** 
  - `companies_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (id = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `company_module_settings`

- **Modelo Prisma:** `CompanyModuleSetting` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Ativação/desativação de módulos por empresa (branchId null) ou por filial específica (override). Ausência de linha = módulo HABILITADO (opt-out, não opt-in — uma empresa existente sem nenhuma configuração aqui continua funcionando exatamente como hoje; o oposto quebraria todo tenant já em produção no dia em que esta tabela fosse criada). NUNCA apaga dado de negócio — é só um gate checado no middleware (requireModuleE…

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `module` | "SystemModule" | não |  |
| `isEnabled` | boolean | não | `true` |
| `disabledBy` | text | sim |  |
| `disabledAt` | timestamp(3) without time zone | sim |  |
| `disabledReason` | text | sim |  |
| `reenabledBy` | text | sim |  |
| `reenabledAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (5):**
  - `company_module_settings_companyId_branchId_idx` — `INDEX "company_module_settings_companyId_branchId_idx" USING btree ("companyId", "branchId")`
  - `company_module_settings_companyId_idx` — `INDEX "company_module_settings_companyId_idx" USING btree ("companyId")`
  - `company_module_settings_one_branch_override_per_module` — `UNIQUE INDEX company_module_settings_one_branch_override_per_module USING btree ("companyId", "branchId", module) WHERE ("branchId" IS NOT NULL)`
  - `company_module_settings_one_company_wide_per_module` — `UNIQUE INDEX company_module_settings_one_company_wide_per_module USING btree ("companyId", module) WHERE ("branchId" IS NULL)`
  - `company_module_settings_pkey` — `UNIQUE INDEX company_module_settings_pkey USING btree (id)`
- **Políticas RLS:** 
  - `company_module_settings_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `company_module_settings_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `company_module_settings_select` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `company_module_settings_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`

#### `device_sessions`

- **Modelo Prisma:** `DeviceSession` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Partial UNIQUE indexes for "one active session per device" / "per user" exist only at the database level (WHERE status = 'ACTIVE') and are not representable as a Prisma @@unique — see migration.sql.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `deviceId` | text | não |  |
| `userId` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `status` | "DeviceSessionStatus" | não | `'ACTIVE'::"DeviceSessionStatus"` |
| `startedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `endedAt` | timestamp(3) without time zone | sim |  |
| `endedBy` | text | sim |  |
| `endReason` | text | sim |  |
| `ipAddress` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `deviceId` → `devices(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `device_sessions_companyId_idx` — `INDEX "device_sessions_companyId_idx" USING btree ("companyId")`
  - `device_sessions_deviceId_idx` — `INDEX "device_sessions_deviceId_idx" USING btree ("deviceId")`
  - `device_sessions_one_active_per_device` — `UNIQUE INDEX device_sessions_one_active_per_device USING btree ("deviceId") WHERE (status = 'ACTIVE'::"DeviceSessionStatus")`
  - `device_sessions_one_active_per_user` — `UNIQUE INDEX device_sessions_one_active_per_user USING btree ("userId") WHERE (status = 'ACTIVE'::"DeviceSessionStatus")`
  - `device_sessions_pkey` — `UNIQUE INDEX device_sessions_pkey USING btree (id)`
  - `device_sessions_status_idx` — `INDEX device_sessions_status_idx USING btree (status)`
  - `device_sessions_userId_idx` — `INDEX "device_sessions_userId_idx" USING btree ("userId")`
- **Políticas RLS:** 
  - `device_sessions_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `device_telemetry`

- **Modelo Prisma:** `DeviceTelemetry` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Telemetria real enviada pelo equipamento (PDV Electron): host (CPU/RAM/disco) e rede até a API. Empresa, filial e equipamento vêm da sessão de equipamento do usuário autenticado, nunca do corpo. Retenção: 30 dias (agendador).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `deviceId` | text | não |  |
| `userId` | text | não |  |
| `collectedAt` | timestamp(3) without time zone | não |  |
| `receivedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `cpuLoadPct` | double precision | sim |  |
| `memUsedPct` | double precision | sim |  |
| `diskUsedPct` | double precision | sim |  |
| `apiRttMs` | integer | sim |  |
| `packetLossPct` | double precision | sim |  |
| `appVersion` | text | sim |  |
| `uptimeSec` | integer | sim |  |
| `runtimeVersion` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `device_telemetry_companyId_branchId_collectedAt_idx` — `INDEX "device_telemetry_companyId_branchId_collectedAt_idx" USING btree ("companyId", "branchId", "collectedAt")`
  - `device_telemetry_deviceId_collectedAt_key` — `UNIQUE INDEX "device_telemetry_deviceId_collectedAt_key" USING btree ("deviceId", "collectedAt")`
  - `device_telemetry_pkey` — `UNIQUE INDEX device_telemetry_pkey USING btree (id)`
- **Políticas RLS:** 
  - `device_telemetry_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `devices`

- **Modelo Prisma:** `Device` · **Escopo:** filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `licenseId` | text | sim |  |
| `deviceName` | text | não |  |
| `deviceType` | "DeviceType" | não |  |
| `status` | "DeviceStatus" | não | `'PENDING'::"DeviceStatus"` |
| `macAddress` | text | sim |  |
| `ipAddress` | text | sim |  |
| `lastSeenAt` | timestamp(3) without time zone | sim |  |
| `activatedBy` | text | sim |  |
| `activatedAt` | timestamp(3) without time zone | sim |  |
| `revokedBy` | text | sim |  |
| `revokedAt` | timestamp(3) without time zone | sim |  |
| `revocationReason` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `branchId` | text | sim |  |
| `secretHash` | text | sim |  |
| `enrollmentCode` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `licenseId` → `licenses(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `devices_active_needs_license_check`: `CHECK (((status <> 'ACTIVE'::"DeviceStatus") OR ("licenseId" IS NOT NULL)))`
- **Índices (5):**
  - `devices_enrollmentCode_key` — `UNIQUE INDEX "devices_enrollmentCode_key" USING btree ("enrollmentCode")`
  - `devices_lastSeenAt_idx` — `INDEX "devices_lastSeenAt_idx" USING btree ("lastSeenAt")`
  - `devices_licenseId_idx` — `INDEX "devices_licenseId_idx" USING btree ("licenseId")`
  - `devices_pkey` — `UNIQUE INDEX devices_pkey USING btree (id)`
  - `devices_status_idx` — `INDEX devices_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `devices_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("licenseId" IN ( SELECT licenses.id FROM licenses WHERE (licenses."companyId" = ( SELECT app_ctx.company_id() AS company_id)))) AND (( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])))))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("licenseId" IN ( SELECT licenses.id FROM licenses WHERE (licenses."companyId" = ( SELECT app_ctx.company_id() AS company_id)))) AND (( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])))))`

#### `invoices`

- **Modelo Prisma:** `Invoice` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId is a plain scalar — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `supplierId` | text | não |  |
| `purchaseOrderId` | text | sim |  |
| `invoiceNumber` | text | não |  |
| `series` | text | não |  |
| `accessKey` | text | não |  |
| `issueDate` | timestamp(3) without time zone | não |  |
| `totalAmount` | numeric(10,2) | não |  |
| `xmlUrl` | text | sim |  |
| `isReceived` | boolean | não | `false` |
| `receivedAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, purchaseOrderId` → `purchase_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, supplierId` → `suppliers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `invoices_accessKey_key` — `UNIQUE INDEX "invoices_accessKey_key" USING btree ("accessKey")`
  - `invoices_companyId_idx` — `INDEX "invoices_companyId_idx" USING btree ("companyId")`
  - `invoices_companyId_supplierId_invoiceNumber_series_key` — `UNIQUE INDEX "invoices_companyId_supplierId_invoiceNumber_series_key" USING btree ("companyId", "supplierId", "invoiceNumber", series)`
  - `invoices_issueDate_idx` — `INDEX "invoices_issueDate_idx" USING btree ("issueDate")`
  - `invoices_pkey` — `UNIQUE INDEX invoices_pkey USING btree (id)`
  - `invoices_purchaseOrderId_idx` — `INDEX "invoices_purchaseOrderId_idx" USING btree ("purchaseOrderId")`
  - `invoices_supplierId_idx` — `INDEX "invoices_supplierId_idx" USING btree ("supplierId")`
- **Políticas RLS:** 
  - `invoices_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `licenses`

- **Modelo Prisma:** `License` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `licenseType` | "LicenseType" | não |  |
| `status` | "LicenseStatus" | não | `'PENDING_APPROVAL'::"LicenseStatus"` |
| `maxDevices` | integer | não | `1` |
| `maxUsers` | integer | não | `10` |
| `maxBranches` | integer | não | `1` |
| `startDate` | timestamp(3) without time zone | sim |  |
| `expiryDate` | timestamp(3) without time zone | sim |  |
| `approvedBy` | text | sim |  |
| `approvedAt` | timestamp(3) without time zone | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `licenses_companyId_idx` — `INDEX "licenses_companyId_idx" USING btree ("companyId")`
  - `licenses_companyId_status_idx` — `INDEX "licenses_companyId_status_idx" USING btree ("companyId", status)`
  - `licenses_expiryDate_idx` — `INDEX "licenses_expiryDate_idx" USING btree ("expiryDate")`
  - `licenses_pkey` — `UNIQUE INDEX licenses_pkey USING btree (id)`
  - `licenses_status_expiryDate_idx` — `INDEX "licenses_status_expiryDate_idx" USING btree (status, "expiryDate")`
  - `licenses_status_idx` — `INDEX licenses_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `licenses_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `permissions`

- **Modelo Prisma:** `Permission` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | sim |  |
| `name` | text | não |  |
| `description` | text | sim |  |
| `scope` | "PermissionScope" | não | `'BRANCH'::"PermissionScope"` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `permissions_companyId_name_key` — `UNIQUE INDEX "permissions_companyId_name_key" USING btree ("companyId", name)`
  - `permissions_pkey` — `UNIQUE INDEX permissions_pkey USING btree (id)`
- **Políticas RLS:** 
  - `permissions_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `permissions_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `permissions_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)) OR ("companyId" IS NULL))`
  - `permissions_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`

#### `refresh_tokens`

- **Modelo Prisma:** `RefreshToken` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId is a plain scalar — no FK. Sessão de login (refresh token). O banco guarda SÓ o hash (SHA-256 hex) do token — nunca o token (migração 20261014170000). `companyId` = empresa do usuário (nulo = conta de plataforma): é ele que faz a RLS isolar a sessão por empresa, e a FK composta (companyId, userId) → users(companyId, id) impede gravar a sessão de um usuário numa empresa que não é a dele.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `userId` | text | não |  |
| `companyId` | text | sim |  |
| `expiresAt` | timestamp(3) without time zone | não |  |
| `isRevoked` | boolean | não | `false` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `ipAddress` | text | sim |  |
| `userAgent` | text | sim |  |
| `deviceSessionId` | text | sim |  |
| `tokenHash` | text | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `userId` → `users(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (5):**
  - `refresh_tokens_companyId_userId_idx` — `INDEX "refresh_tokens_companyId_userId_idx" USING btree ("companyId", "userId")`
  - `refresh_tokens_deviceSessionId_idx` — `INDEX "refresh_tokens_deviceSessionId_idx" USING btree ("deviceSessionId")`
  - `refresh_tokens_pkey` — `UNIQUE INDEX refresh_tokens_pkey USING btree (id)`
  - `refresh_tokens_tokenHash_key` — `UNIQUE INDEX "refresh_tokens_tokenHash_key" USING btree ("tokenHash")`
  - `refresh_tokens_userId_idx` — `INDEX "refresh_tokens_userId_idx" USING btree ("userId")`
- **Políticas RLS:** 
  - `refresh_tokens_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `role_permissions`

- **Modelo Prisma:** `RolePermission` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `roleId` | text | não |  |
| `permissionId` | text | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `permissionId` → `permissions(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `roleId` → `roles(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `role_permissions_pkey` — `UNIQUE INDEX role_permissions_pkey USING btree (id)`
  - `role_permissions_roleId_permissionId_key` — `UNIQUE INDEX "role_permissions_roleId_permissionId_key" USING btree ("roleId", "permissionId")`
- **Políticas RLS:** 
  - `role_permissions_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("roleId" IN ( SELECT roles.id FROM roles)))`
  - `role_permissions_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("roleId" IN ( SELECT roles.id FROM roles)))`
  - `role_permissions_select` (SELECT, permissive, roles {public}): USING `("roleId" IN ( SELECT roles.id FROM roles))`
  - `role_permissions_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("roleId" IN ( SELECT roles.id FROM roles)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("roleId" IN ( SELECT roles.id FROM roles)))`

#### `roles`

- **Modelo Prisma:** `Role` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | sim |  |
| `name` | text | não |  |
| `description` | text | sim |  |
| `isSystem` | boolean | não | `false` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `roles_companyId_name_key` — `UNIQUE INDEX "roles_companyId_name_key" USING btree ("companyId", name)`
  - `roles_pkey` — `UNIQUE INDEX roles_pkey USING btree (id)`
- **Políticas RLS:** 
  - `roles_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `roles_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `roles_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)) OR ("companyId" IS NULL))`
  - `roles_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`

#### `user_roles`

- **Modelo Prisma:** `UserRole` · **Escopo:** filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `userId` | text | não |  |
| `roleId` | text | não |  |
| `branchId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `roleId` → `roles(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `userId` → `users(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `user_roles_pkey` — `UNIQUE INDEX user_roles_pkey USING btree (id)`
  - `user_roles_userId_roleId_branchId_key` — `UNIQUE INDEX "user_roles_userId_roleId_branchId_key" USING btree ("userId", "roleId", "branchId")`
- **Políticas RLS:** 
  - `user_roles_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("userId" IN ( SELECT users.id FROM users)))`
  - `user_roles_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("userId" IN ( SELECT users.id FROM users)))`
  - `user_roles_select` (SELECT, permissive, roles {public}): USING `("userId" IN ( SELECT users.id FROM users))`
  - `user_roles_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("userId" IN ( SELECT users.id FROM users)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)) AND ("userId" IN ( SELECT users.id FROM users)))`

#### `users`

- **Modelo Prisma:** `User` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `numericId` | integer | não | `nextval('"users_numericId_seq"'::regclass)` |
| `companyId` | text | sim |  |
| `branchId` | text | sim |  |
| `name` | text | não |  |
| `email` | text | não |  |
| `phone` | text | sim |  |
| `password` | text | não |  |
| `userType` | "UserType" | não |  |
| `isActive` | boolean | não | `true` |
| `emailVerified` | boolean | não | `false` |
| `mfaEnabled` | boolean | não | `false` |
| `mfaSecret` | text | sim |  |
| `mfaBackupCodes` | text[] | sim | `ARRAY[]::text[]` |
| `loginAttempts` | integer | não | `0` |
| `lockedUntil` | timestamp(3) without time zone | sim |  |
| `lastLoginAt` | timestamp(3) without time zone | sim |  |
| `lastLoginIp` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `mfaLastStep` | integer | sim |  |
| `mustChangePassword` | boolean | não | `false` |
| `passwordChangedAt` | timestamp(3) without time zone | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `branchId` → `branches(id)` · ao apagar: **SET NULL** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `users_branchId_idx` — `INDEX "users_branchId_idx" USING btree ("branchId")`
  - `users_companyId_id_key` — `UNIQUE INDEX "users_companyId_id_key" USING btree ("companyId", id)`
  - `users_companyId_isActive_idx` — `INDEX "users_companyId_isActive_idx" USING btree ("companyId", "isActive")`
  - `users_email_key` — `UNIQUE INDEX users_email_key USING btree (email)`
  - `users_isActive_idx` — `INDEX "users_isActive_idx" USING btree ("isActive")`
  - `users_numericId_key` — `UNIQUE INDEX "users_numericId_key" USING btree ("numericId")`
  - `users_pkey` — `UNIQUE INDEX users_pkey USING btree (id)`
- **Políticas RLS:** 
  - `users_delete` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (("branchId" IS NOT NULL) AND ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))))`
  - `users_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (("branchId" IS NOT NULL) AND ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))))`
  - `users_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND (( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])) OR ("userType" = 'COMPANY_ADMIN'::"UserType"))))`
  - `users_update` (UPDATE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND (( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])) OR ("userType" = 'COMPANY_ADMIN'::"UserType"))))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (("branchId" IS NOT NULL) AND ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))))`
- **Triggers:**
  - `users_branch_same_company`: `BEFORE INSERT OR UPDATE OF "branchId", "companyId" FOR EACH ROW EXECUTE FUNCTION enforce_same_company_ref('branches', 'branchId')`
  - `users_guard_privileged_columns`: `BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION users_guard_privileged_columns()`

### Auditoria, observabilidade e operação

#### `audit_logs`

- **Modelo Prisma:** `AuditLog` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | sim |  |
| `userId` | text | sim |  |
| `action` | "AuditAction" | não |  |
| `entity` | text | não |  |
| `entityId` | text | sim |  |
| `oldValue` | text | sim |  |
| `newValue` | text | sim |  |
| `ipAddress` | text | sim |  |
| `userAgent` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `userId` → `users(id)` · ao apagar: **SET NULL** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (8):**
  - `audit_logs_action_idx` — `INDEX audit_logs_action_idx USING btree (action)`
  - `audit_logs_companyId_createdAt_idx` — `INDEX "audit_logs_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `audit_logs_companyId_idx` — `INDEX "audit_logs_companyId_idx" USING btree ("companyId")`
  - `audit_logs_createdAt_idx` — `INDEX "audit_logs_createdAt_idx" USING btree ("createdAt")`
  - `audit_logs_entity_entityId_idx` — `INDEX "audit_logs_entity_entityId_idx" USING btree (entity, "entityId")`
  - `audit_logs_pkey` — `UNIQUE INDEX audit_logs_pkey USING btree (id)`
  - `audit_logs_userId_action_idx` — `INDEX "audit_logs_userId_action_idx" USING btree ("userId", action)`
  - `audit_logs_userId_idx` — `INDEX "audit_logs_userId_idx" USING btree ("userId")`
- **Políticas RLS:** 
  - `audit_logs_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)) OR ("companyId" IS NULL))`
  - `audit_logs_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `audit_logs_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND (( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("userId" IN ( SELECT u.id FROM users u WHERE (u."branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])))))))`

#### `health_incidents`

- **Modelo Prisma:** `HealthIncident` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico de saúde: um incidente por componente enquanto o estado não é NORMAL (endedAt nulo = em aberto).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `component` | text | não |  |
| `status` | text | não |  |
| `detail` | text | sim |  |
| `startedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `endedAt` | timestamp(3) without time zone | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `health_incidents_companyId_branchId_startedAt_idx` — `INDEX "health_incidents_companyId_branchId_startedAt_idx" USING btree ("companyId", "branchId", "startedAt")`
  - `health_incidents_endedAt_idx` — `INDEX "health_incidents_endedAt_idx" USING btree ("endedAt")`
  - `health_incidents_one_open` — `UNIQUE INDEX health_incidents_one_open USING btree ("companyId", COALESCE("branchId", ''::text), component) WHERE ("endedAt" IS NULL)`
  - `health_incidents_pkey` — `UNIQUE INDEX health_incidents_pkey USING btree (id)`
- **Políticas RLS:** 
  - `health_incidents_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `idempotency_keys`

- **Modelo Prisma:** `IdempotencyKey` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `key` | text | não |  |
| `companyId` | text | não |  |
| `userId` | text | sim |  |
| `endpoint` | text | não |  |
| `requestHash` | text | não |  |
| `status` | "IdempotencyStatus" | não | `'PENDING'::"IdempotencyStatus"` |
| `responseStatus` | integer | sim |  |
| `responseBody` | jsonb | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `completedAt` | timestamp(3) without time zone | sim |  |
| `expiresAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `idempotency_keys_companyId_endpoint_key_key` — `UNIQUE INDEX "idempotency_keys_companyId_endpoint_key_key" USING btree ("companyId", endpoint, key)`
  - `idempotency_keys_expiresAt_idx` — `INDEX "idempotency_keys_expiresAt_idx" USING btree ("expiresAt")`
  - `idempotency_keys_pkey` — `UNIQUE INDEX idempotency_keys_pkey USING btree (id)`
- **Políticas RLS:** 
  - `idempotency_keys_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `import_batches`

- **Modelo Prisma:** `ImportBatch` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Lote de importação (produtos, clientes, estoque): resultado de cada linha em `results` ([{ row, key, action: CREATED\|UPDATED\|UNCHANGED\|ERROR, id?, error? }]). Movimentos de estoque da importação apontam para o lote (referenceType 'ImportBatch').

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `type` | text | não |  |
| `userId` | text | não |  |
| `fileName` | text | sim |  |
| `totalRows` | integer | não |  |
| `importedRows` | integer | não | `0` |
| `unchangedRows` | integer | não | `0` |
| `failedRows` | integer | não | `0` |
| `results` | jsonb | não | `'[]'::jsonb` |
| `startedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `finishedAt` | timestamp(3) without time zone | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `import_batches_companyId_startedAt_idx` — `INDEX "import_batches_companyId_startedAt_idx" USING btree ("companyId", "startedAt")`
  - `import_batches_pkey` — `UNIQUE INDEX import_batches_pkey USING btree (id)`
- **Políticas RLS:** 
  - `import_batches_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `monitoring_alerts`

- **Modelo Prisma:** `MonitoringAlert` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Alerta do monitoramento: condição fora do limite num alvo (central, filial ou equipamento). No máximo um aberto por tipo+alvo (`monitoring_alerts_one_open`); reincidência logo após encerrar reabre o mesmo (occurrences) em vez de criar outro.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `source` | text | não |  |
| `companyId` | text | sim |  |
| `branchId` | text | sim |  |
| `deviceId` | text | sim |  |
| `type` | text | não |  |
| `metric` | text | não |  |
| `severity` | text | não |  |
| `value` | double precision | sim |  |
| `threshold` | double precision | sim |  |
| `detail` | text | sim |  |
| `occurrences` | integer | não | `1` |
| `startedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `lastSeenAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `endedAt` | timestamp(3) without time zone | sim |  |
| `handling` | text | não | `'OPEN'::text` |
| `assignedTo` | text | sim |  |
| `acknowledgedAt` | timestamp(3) without time zone | sim |  |
| `acknowledgedBy` | text | sim |  |
| `resolvedBy` | text | sim |  |
| `resolutionNote` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `monitoring_alerts_companyId_startedAt_idx` — `INDEX "monitoring_alerts_companyId_startedAt_idx" USING btree ("companyId", "startedAt")`
  - `monitoring_alerts_endedAt_idx` — `INDEX "monitoring_alerts_endedAt_idx" USING btree ("endedAt")`
  - `monitoring_alerts_one_open` — `UNIQUE INDEX monitoring_alerts_one_open USING btree (COALESCE("companyId", ''::text), COALESCE("branchId", ''::text), COALESCE("deviceId", ''::text), type) WHERE ("endedAt" IS NULL)`
  - `monitoring_alerts_pkey` — `UNIQUE INDEX monitoring_alerts_pkey USING btree (id)`
- **Políticas RLS:** 
  - `monitoring_alerts_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `monitoring_threshold_changes`

- **Modelo Prisma:** `MonitoringThresholdChange` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 2 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico imutável das alterações de limites (quem, quando, de/para, motivo).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | sim |  |
| `branchId` | text | sim |  |
| `metric` | text | não |  |
| `oldAttention` | double precision | sim |  |
| `oldCritical` | double precision | sim |  |
| `newAttention` | double precision | sim |  |
| `newCritical` | double precision | sim |  |
| `reason` | text | não |  |
| `changedBy` | text | não |  |
| `changedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `monitoring_threshold_changes_companyId_changedAt_idx` — `INDEX "monitoring_threshold_changes_companyId_changedAt_idx" USING btree ("companyId", "changedAt")`
  - `monitoring_threshold_changes_pkey` — `UNIQUE INDEX monitoring_threshold_changes_pkey USING btree (id)`
- **Políticas RLS:** 
  - `monitoring_threshold_changes_read` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (( SELECT app_ctx.is_company_wide() AS is_company_wide) AND (("companyId" IS NULL) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))))`
  - `monitoring_threshold_changes_write` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `monitoring_thresholds`

- **Modelo Prisma:** `MonitoringThreshold` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 2 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Limite de uma métrica do monitoramento. Escopo: global (empresa e filial nulas), empresa ou filial; o mais específico vence. Único por escopo+métrica (índice `monitoring_thresholds_scope_metric`, na migração). Só SUPER_ADMIN grava (RLS).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | sim |  |
| `branchId` | text | sim |  |
| `metric` | text | não |  |
| `attention` | double precision | não |  |
| `critical` | double precision | não |  |
| `updatedBy` | text | não |  |
| `updatedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `monitoring_thresholds_companyId_idx` — `INDEX "monitoring_thresholds_companyId_idx" USING btree ("companyId")`
  - `monitoring_thresholds_pkey` — `UNIQUE INDEX monitoring_thresholds_pkey USING btree (id)`
  - `monitoring_thresholds_scope_metric` — `UNIQUE INDEX monitoring_thresholds_scope_metric USING btree (COALESCE("companyId", ''::text), COALESCE("branchId", ''::text), metric)`
- **Políticas RLS:** 
  - `monitoring_thresholds_read` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (( SELECT app_ctx.is_company_wide() AS is_company_wide) AND (("companyId" IS NULL) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))))`
  - `monitoring_thresholds_write` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `privacy_requests`

- **Modelo Prisma:** `PrivacyRequest` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Pedido de titular (LGPD, decisão 120): exportação dos dados ou anonimização de UM cliente, sempre pelo administrador da empresa. A linha é o registro durável do pedido (quem, quando, por quê, o que foi feito e o que foi RETIDO e por quê). Nunca guarda o dado anonimizado. O arquivo de exportação, quando existe, fica cifrado (enc:v1) só até exportExpiresAt e é apagado por rotina.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `requestType` | text | não |  |
| `subjectType` | text | não | `'CUSTOMER'::text` |
| `subjectId` | text | não |  |
| `status` | text | não |  |
| `justification` | text | não |  |
| `requestedBy` | text | não |  |
| `requestedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `executedBy` | text | sim |  |
| `executedAt` | timestamp(3) without time zone | sim |  |
| `plan` | jsonb | sim |  |
| `result` | jsonb | sim |  |
| `retainedUntil` | timestamp(3) without time zone | sim |  |
| `exportPayload` | text | sim |  |
| `exportSha256` | text | sim |  |
| `exportExpiresAt` | timestamp(3) without time zone | sim |  |
| `exportDownloads` | integer | não | `0` |
| `exportPurgedAt` | timestamp(3) without time zone | sim |  |
| `failureCode` | text | sim |  |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `privacy_requests_justification_not_blank`: `CHECK ((btrim(justification) <> ''::text))`
  - check `privacy_requests_status_valid`: `CHECK ((status = ANY (ARRAY['PLANNED'::text, 'COMPLETED'::text, 'PARTIAL'::text, 'BLOCKED'::text, 'FAILED'::text])))`
  - check `privacy_requests_type_valid`: `CHECK (("requestType" = ANY (ARRAY['EXPORT'::text, 'ANONYMIZE'::text])))`
- **Índices (4):**
  - `privacy_requests_companyId_requestedAt_idx` — `INDEX "privacy_requests_companyId_requestedAt_idx" USING btree ("companyId", "requestedAt")`
  - `privacy_requests_companyId_subjectId_idx` — `INDEX "privacy_requests_companyId_subjectId_idx" USING btree ("companyId", "subjectId")`
  - `privacy_requests_exportExpiresAt_idx` — `INDEX "privacy_requests_exportExpiresAt_idx" USING btree ("exportExpiresAt")`
  - `privacy_requests_pkey` — `UNIQUE INDEX privacy_requests_pkey USING btree (id)`
- **Políticas RLS:** 
  - `privacy_requests_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `request_logs`

- **Modelo Prisma:** `RequestLog` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/userId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `requestId` | text | não |  |
| `method` | text | não |  |
| `route` | text | não |  |
| `statusCode` | integer | não |  |
| `durationMs` | integer | não |  |
| `companyId` | text | sim |  |
| `branchId` | text | sim |  |
| `userId` | text | sim |  |
| `device` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `request_logs_companyId_createdAt_idx` — `INDEX "request_logs_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `request_logs_createdAt_idx` — `INDEX "request_logs_createdAt_idx" USING btree ("createdAt")`
  - `request_logs_pkey` — `UNIQUE INDEX request_logs_pkey USING btree (id)`
  - `request_logs_requestId_key` — `UNIQUE INDEX "request_logs_requestId_key" USING btree ("requestId")`
  - `request_logs_route_createdAt_idx` — `INDEX "request_logs_route_createdAt_idx" USING btree (route, "createdAt")`
  - `request_logs_statusCode_createdAt_idx` — `INDEX "request_logs_statusCode_createdAt_idx" USING btree ("statusCode", "createdAt")`
- **Políticas RLS:** 
  - `request_logs_delete` (DELETE, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)`
  - `request_logs_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `request_logs_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (( SELECT app_ctx.is_company_wide() AS is_company_wide) AND ("companyId" = ( SELECT app_ctx.company_id() AS company_id))))`
  - `request_logs_update` (UPDATE, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `system_logs`

- **Modelo Prisma:** `SystemLog` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/userId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `level` | text | não |  |
| `category` | text | não |  |
| `service` | text | não |  |
| `event` | text | não |  |
| `message` | text | não |  |
| `requestId` | text | sim |  |
| `companyId` | text | sim |  |
| `branchId` | text | sim |  |
| `userId` | text | sim |  |
| `device` | text | sim |  |
| `durationMs` | integer | sim |  |
| `errorMessage` | text | sim |  |
| `stackTrace` | text | sim |  |
| `metadata` | jsonb | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `system_logs_category_createdAt_idx` — `INDEX "system_logs_category_createdAt_idx" USING btree (category, "createdAt")`
  - `system_logs_companyId_createdAt_idx` — `INDEX "system_logs_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `system_logs_createdAt_idx` — `INDEX "system_logs_createdAt_idx" USING btree ("createdAt")`
  - `system_logs_level_createdAt_idx` — `INDEX "system_logs_level_createdAt_idx" USING btree (level, "createdAt")`
  - `system_logs_pkey` — `UNIQUE INDEX system_logs_pkey USING btree (id)`
  - `system_logs_requestId_idx` — `INDEX "system_logs_requestId_idx" USING btree ("requestId")`
- **Políticas RLS:** 
  - `system_logs_delete` (DELETE, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)`
  - `system_logs_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `system_logs_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (( SELECT app_ctx.is_company_wide() AS is_company_wide) AND ("companyId" = ( SELECT app_ctx.company_id() AS company_id))))`
  - `system_logs_update` (UPDATE, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

### Políticas e calendário

#### `agenda_unavailabilities`

- **Modelo Prisma:** `AgendaUnavailability` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Indisponibilidade da agenda numa janela (mecânico específico ou a filial inteira) — 2026-09-28

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `mechanicId` | text | sim |  |
| `startsAt` | timestamp(3) without time zone | não |  |
| `endsAt` | timestamp(3) without time zone | não |  |
| `reason` | text | não |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `agenda_unavailabilities_window_check`: `CHECK (("endsAt" > "startsAt"))`
- **Índices (2):**
  - `agenda_unavailabilities_companyId_branchId_startsAt_idx` — `INDEX "agenda_unavailabilities_companyId_branchId_startsAt_idx" USING btree ("companyId", "branchId", "startsAt")`
  - `agenda_unavailabilities_pkey` — `UNIQUE INDEX agenda_unavailabilities_pkey USING btree (id)`
- **Políticas RLS:** 
  - `agenda_unavailabilities_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `business_calendar_exceptions`

- **Modelo Prisma:** `BusinessCalendarException` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Feriado, data especial ou fechamento excepcional. kind: HOLIDAY \| CLOSED \| SPECIAL_HOURS

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `date` | date | não |  |
| `kind` | text | não |  |
| `opensAt` | text | sim |  |
| `closesAt` | text | sim |  |
| `description` | text | sim |  |
| `createdBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `business_calendar_exceptions_pkey` — `UNIQUE INDEX business_calendar_exceptions_pkey USING btree (id)`
  - `business_calendar_exceptions_scope_date` — `UNIQUE INDEX business_calendar_exceptions_scope_date USING btree ("companyId", COALESCE("branchId", ''::text), date)`
- **Políticas RLS:** 
  - `business_calendar_exceptions_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `business_hours`

- **Modelo Prisma:** `BusinessHours` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Horário de funcionamento por dia da semana (0 = domingo). Linhas da filial substituem as da empresa.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `weekday` | integer | não |  |
| `isClosed` | boolean | não | `false` |
| `opensAt` | text | sim |  |
| `closesAt` | text | sim |  |
| `breakStart` | text | sim |  |
| `breakEnd` | text | sim |  |
| `updatedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `business_hours_weekday_check`: `CHECK (((weekday >= 0) AND (weekday <= 6)))`
- **Índices (2):**
  - `business_hours_pkey` — `UNIQUE INDEX business_hours_pkey USING btree (id)`
  - `business_hours_scope_weekday` — `UNIQUE INDEX business_hours_scope_weekday USING btree ("companyId", COALESCE("branchId", ''::text), weekday)`
- **Políticas RLS:** 
  - `business_hours_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `installment_policies`

- **Modelo Prisma:** `InstallmentPolicy` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `paymentMethod` | "PaymentMethod" | não |  |
| `maxInstallments` | integer | não | `1` |
| `interestFreeInstallments` | integer | não | `1` |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `installment_policies_companyId_branchId_paymentMethod_key` — `UNIQUE INDEX "installment_policies_companyId_branchId_paymentMethod_key" USING btree ("companyId", "branchId", "paymentMethod")`
  - `installment_policies_companyId_idx` — `INDEX "installment_policies_companyId_idx" USING btree ("companyId")`
  - `installment_policies_pkey` — `UNIQUE INDEX installment_policies_pkey USING btree (id)`
- **Políticas RLS:** 
  - `installment_policies_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `installment_policies_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `installment_policies_select` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `installment_policies_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`

#### `payment_settings`

- **Modelo Prisma:** `PaymentSetting` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Configuração de pagamento por empresa (branchId null) com override por filial, campo a campo. Ausência de valor = padrão (controle de cédulas desligado, provedores MANUAL). Unicidade parcial no banco, como CompanyModuleSetting.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `cashDenominationControl` | boolean | sim |  |
| `updatedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `cardProvider` | text | sim |  |
| `pixProvider` | text | sim |  |
| `terminalId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `payment_settings_companyId_idx` — `INDEX "payment_settings_companyId_idx" USING btree ("companyId")`
  - `payment_settings_one_company_wide` — `UNIQUE INDEX payment_settings_one_company_wide USING btree ("companyId") WHERE ("branchId" IS NULL)`
  - `payment_settings_one_per_branch` — `UNIQUE INDEX payment_settings_one_per_branch USING btree ("companyId", "branchId") WHERE ("branchId" IS NOT NULL)`
  - `payment_settings_pkey` — `UNIQUE INDEX payment_settings_pkey USING btree (id)`
- **Políticas RLS:** 
  - `payment_settings_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `policy_changes`

- **Modelo Prisma:** `PolicyChange` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico de toda alteração de política (valor anterior, novo, motivo, quem, quando).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `key` | text | não |  |
| `oldValue` | jsonb | sim |  |
| `newValue` | jsonb | sim |  |
| `reason` | text | não |  |
| `changedBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `policy_changes_companyId_createdAt_idx` — `INDEX "policy_changes_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `policy_changes_pkey` — `UNIQUE INDEX policy_changes_pkey USING btree (id)`
- **Políticas RLS:** 
  - `policy_changes_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `policy_changes_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `policy_changes_select` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `policy_settings`

- **Modelo Prisma:** `PolicySetting` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Valor de uma política: linha da empresa (branchId nulo) é o padrão; linha da filial é override (só nas chaves que o catálogo permite). Catálogo, validação e resolução em apps/api/src/services/policy.service.ts.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `key` | text | não |  |
| `value` | jsonb | não |  |
| `updatedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `policy_settings_companyId_idx` — `INDEX "policy_settings_companyId_idx" USING btree ("companyId")`
  - `policy_settings_pkey` — `UNIQUE INDEX policy_settings_pkey USING btree (id)`
  - `policy_settings_scope_key` — `UNIQUE INDEX policy_settings_scope_key USING btree ("companyId", COALESCE("branchId", ''::text), key)`
- **Políticas RLS:** 
  - `policy_settings_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Catálogo e estoque

#### `categories`

- **Modelo Prisma:** `Category` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `name` | text | não |  |
| `description` | text | sim |  |
| `parentId` | text | sim |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, parentId` → `categories(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `categories_companyId_id_key` — `UNIQUE INDEX "categories_companyId_id_key" USING btree ("companyId", id)`
  - `categories_parentId_idx` — `INDEX "categories_parentId_idx" USING btree ("parentId")`
  - `categories_pkey` — `UNIQUE INDEX categories_pkey USING btree (id)`
- **Políticas RLS:** 
  - `categories_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `combo_items`

- **Modelo Prisma:** `ComboItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** comboId and productId both reference Product, hence the two named relations to disambiguate which side of the combo each is.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `comboId` | text | não |  |
| `productId` | text | não |  |
| `quantity` | numeric(10,3) | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `comboId` → `products(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `productId` → `products(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `combo_items_comboId_productId_key` — `UNIQUE INDEX "combo_items_comboId_productId_key" USING btree ("comboId", "productId")`
  - `combo_items_pkey` — `UNIQUE INDEX combo_items_pkey USING btree (id)`
- **Políticas RLS:** 
  - `combo_items_isolation` (ALL, permissive, roles {public}): USING `("comboId" IN ( SELECT products.id FROM products))` · WITH CHECK `("comboId" IN ( SELECT products.id FROM products))`

#### `damage_records`

- **Modelo Prisma:** `DamageRecord` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `productId` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `reason` | "DamageReason" | não |  |
| `description` | text | sim |  |
| `photoUrls` | text | sim |  |
| `approvedBy` | text | não |  |
| `recordedBy` | text | não |  |
| `recordedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `isReversed` | boolean | não | `false` |
| `reversedAt` | timestamp(3) without time zone | sim |  |
| `reversedBy` | text | sim |  |
| `reverseReason` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `damage_records_branchId_idx` — `INDEX "damage_records_branchId_idx" USING btree ("branchId")`
  - `damage_records_companyId_id_key` — `UNIQUE INDEX "damage_records_companyId_id_key" USING btree ("companyId", id)`
  - `damage_records_isReversed_idx` — `INDEX "damage_records_isReversed_idx" USING btree ("isReversed")`
  - `damage_records_pkey` — `UNIQUE INDEX damage_records_pkey USING btree (id)`
  - `damage_records_productId_idx` — `INDEX "damage_records_productId_idx" USING btree ("productId")`
  - `damage_records_recordedAt_idx` — `INDEX "damage_records_recordedAt_idx" USING btree ("recordedAt")`
- **Políticas RLS:** 
  - `damage_records_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `inventories`

- **Modelo Prisma:** `Inventory` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** ACHADO DE AUDITORIA DE INTEGRAÇÃO: nada impedia dois inventários IN_PROGRESS simultâneos na mesma filial — cada um capturaria um `systemQuantity` desatualizado e, no fechamento, o segundo sobrescreveria silenciosamente a correção do primeiro. Mesmo padrão já usado em CashRegister (ver comentário lá): uma UNIQUE parcial no banco, que o Prisma Schema não consegue expressar (sem suporte a `@@unique` com WHERE) — ver mig…

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `inventoryNumber` | integer | não |  |
| `status` | "InventoryStatus" | não | `'DRAFT'::"InventoryStatus"` |
| `startedBy` | text | não |  |
| `startedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `completedAt` | timestamp(3) without time zone | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `inventories_branchId_idx` — `INDEX "inventories_branchId_idx" USING btree ("branchId")`
  - `inventories_branchId_inventoryNumber_key` — `UNIQUE INDEX "inventories_branchId_inventoryNumber_key" USING btree ("branchId", "inventoryNumber")`
  - `inventories_companyId_idx` — `INDEX "inventories_companyId_idx" USING btree ("companyId")`
  - `inventories_one_in_progress_per_branch` — `UNIQUE INDEX inventories_one_in_progress_per_branch USING btree ("branchId") WHERE (status = 'IN_PROGRESS'::"InventoryStatus")`
  - `inventories_pkey` — `UNIQUE INDEX inventories_pkey USING btree (id)`
  - `inventories_startedAt_idx` — `INDEX "inventories_startedAt_idx" USING btree ("startedAt")`
  - `inventories_status_idx` — `INDEX inventories_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `inventories_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `inventory_counts`

- **Modelo Prisma:** `InventoryCount` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `inventoryId` | text | não |  |
| `productId` | text | não |  |
| `systemQuantity` | numeric(10,3) | não |  |
| `countedQuantity` | numeric(10,3) | não |  |
| `difference` | numeric(10,3) | não |  |
| `countedBy` | text | não |  |
| `countedAt` | timestamp(3) without time zone | não |  |
| `notes` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `inventoryId` → `inventories(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `productId` → `products(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `inventory_counts_inventoryId_idx` — `INDEX "inventory_counts_inventoryId_idx" USING btree ("inventoryId")`
  - `inventory_counts_inventoryId_productId_key` — `UNIQUE INDEX "inventory_counts_inventoryId_productId_key" USING btree ("inventoryId", "productId")`
  - `inventory_counts_pkey` — `UNIQUE INDEX inventory_counts_pkey USING btree (id)`
  - `inventory_counts_productId_idx` — `INDEX "inventory_counts_productId_idx" USING btree ("productId")`
- **Políticas RLS:** 
  - `inventory_counts_isolation` (ALL, permissive, roles {public}): USING `("inventoryId" IN ( SELECT inventories.id FROM inventories))` · WITH CHECK `("inventoryId" IN ( SELECT inventories.id FROM inventories))`

#### `product_barcodes`

- **Modelo Prisma:** `ProductBarcode` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId are plain scalars — no FK. Vários códigos de barras por produto (2026-10-14). (companyId, code) é único: um código identifica UM produto na empresa. `products.barcode` segue como código principal (compatibilidade) e é sincronizado pela aplicação.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `productId` | text | não |  |
| `code` | text | não |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `product_barcodes_code_not_blank`: `CHECK ((btrim(code) <> ''::text))`
- **Índices (4):**
  - `product_barcodes_companyId_code_key` — `UNIQUE INDEX "product_barcodes_companyId_code_key" USING btree ("companyId", code)`
  - `product_barcodes_companyId_idx` — `INDEX "product_barcodes_companyId_idx" USING btree ("companyId")`
  - `product_barcodes_pkey` — `UNIQUE INDEX product_barcodes_pkey USING btree (id)`
  - `product_barcodes_productId_idx` — `INDEX "product_barcodes_productId_idx" USING btree ("productId")`
- **Políticas RLS:** 
  - `product_barcodes_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `product_images`

- **Modelo Prisma:** `ProductImage` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Imagem OPCIONAL do produto (decisão 122, 2026-10-14): no máximo uma por produto, guardada no banco sob RLS (mesma arquitetura dos anexos do Suporte — nenhum armazenamento de arquivo externo existe) e entregue só por rota autenticada da própria empresa. O conteúdo é VALIDADO e SANEADO antes de gravar (PNG/JPEG/WebP reais, sem metadados, sem bytes sobrando, dimensões e tamanho limitados).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `productId` | text | não |  |
| `mimeType` | text | não |  |
| `byteSize` | integer | não |  |
| `width` | integer | não |  |
| `height` | integer | não |  |
| `sha256` | text | não |  |
| `data` | bytea | não |  |
| `createdBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `product_images_dimensions_valid`: `CHECK ((((width >= 1) AND (width <= 4096)) AND ((height >= 1) AND (height <= 4096))))`
  - check `product_images_mime_valid`: `CHECK (("mimeType" = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])))`
  - check `product_images_size_valid`: `CHECK ((("byteSize" > 0) AND ("byteSize" <= 1048576)))`
- **Índices (4):**
  - `product_images_companyId_idx` — `INDEX "product_images_companyId_idx" USING btree ("companyId")`
  - `product_images_companyId_productId_key` — `UNIQUE INDEX "product_images_companyId_productId_key" USING btree ("companyId", "productId")`
  - `product_images_pkey` — `UNIQUE INDEX product_images_pkey USING btree (id)`
  - `product_images_productId_key` — `UNIQUE INDEX "product_images_productId_key" USING btree ("productId")`
- **Políticas RLS:** 
  - `product_images_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `products`

- **Modelo Prisma:** `Product` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `categoryId` | text | sim |  |
| `sku` | text | não |  |
| `barcode` | text | sim |  |
| `name` | text | não |  |
| `description` | text | sim |  |
| `brand` | text | sim |  |
| `application` | text | sim |  |
| `location` | text | sim |  |
| `productType` | "ProductType" | não | `'PRODUCT'::"ProductType"` |
| `costPrice` | numeric(10,2) | não |  |
| `salePrice` | numeric(10,2) | não |  |
| `minStock` | integer | não | `0` |
| `maxStock` | integer | sim |  |
| `unit` | text | não | `'UN'::text` |
| `isActive` | boolean | não | `true` |
| `allowNegativeStock` | boolean | não | `false` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, categoryId` → `categories(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (9):**
  - `products_barcode_idx` — `INDEX products_barcode_idx USING btree (barcode)`
  - `products_branchId_idx` — `INDEX "products_branchId_idx" USING btree ("branchId")`
  - `products_categoryId_idx` — `INDEX "products_categoryId_idx" USING btree ("categoryId")`
  - `products_companyId_id_key` — `UNIQUE INDEX "products_companyId_id_key" USING btree ("companyId", id)`
  - `products_companyId_isActive_idx` — `INDEX "products_companyId_isActive_idx" USING btree ("companyId", "isActive")`
  - `products_companyId_sku_key` — `UNIQUE INDEX "products_companyId_sku_key" USING btree ("companyId", sku)`
  - `products_isActive_idx` — `INDEX "products_isActive_idx" USING btree ("isActive")`
  - `products_pkey` — `UNIQUE INDEX products_pkey USING btree (id)`
  - `products_sku_idx` — `INDEX products_sku_idx USING btree (sku)`
- **Políticas RLS:** 
  - `products_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `purchase_order_items`

- **Modelo Prisma:** `PurchaseOrderItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `purchaseOrderId` | text | não |  |
| `productId` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `receivedQuantity` | numeric(10,3) | não | `0` |
| `unitCost` | numeric(10,2) | não |  |
| `totalCost` | numeric(10,2) | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `productId` → `products(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `purchaseOrderId` → `purchase_orders(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `purchase_order_items_pkey` — `UNIQUE INDEX purchase_order_items_pkey USING btree (id)`
  - `purchase_order_items_productId_idx` — `INDEX "purchase_order_items_productId_idx" USING btree ("productId")`
  - `purchase_order_items_purchaseOrderId_idx` — `INDEX "purchase_order_items_purchaseOrderId_idx" USING btree ("purchaseOrderId")`
- **Políticas RLS:** 
  - `purchase_order_items_isolation` (ALL, permissive, roles {public}): USING `("purchaseOrderId" IN ( SELECT purchase_orders.id FROM purchase_orders))` · WITH CHECK `("purchaseOrderId" IN ( SELECT purchase_orders.id FROM purchase_orders))`

#### `purchase_orders`

- **Modelo Prisma:** `PurchaseOrder` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `poNumber` | integer | não |  |
| `supplierId` | text | não |  |
| `status` | "PurchaseOrderStatus" | não | `'DRAFT'::"PurchaseOrderStatus"` |
| `orderDate` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `expectedDelivery` | timestamp(3) without time zone | sim |  |
| `receivedDate` | timestamp(3) without time zone | sim |  |
| `subtotal` | numeric(10,2) | não |  |
| `taxAmount` | numeric(10,2) | não | `0` |
| `totalAmount` | numeric(10,2) | não |  |
| `notes` | text | sim |  |
| `approvedBy` | text | sim |  |
| `approvedAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, supplierId` → `suppliers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (8):**
  - `purchase_orders_branchId_idx` — `INDEX "purchase_orders_branchId_idx" USING btree ("branchId")`
  - `purchase_orders_companyId_branchId_poNumber_key` — `UNIQUE INDEX "purchase_orders_companyId_branchId_poNumber_key" USING btree ("companyId", "branchId", "poNumber")`
  - `purchase_orders_companyId_id_key` — `UNIQUE INDEX "purchase_orders_companyId_id_key" USING btree ("companyId", id)`
  - `purchase_orders_companyId_idx` — `INDEX "purchase_orders_companyId_idx" USING btree ("companyId")`
  - `purchase_orders_orderDate_idx` — `INDEX "purchase_orders_orderDate_idx" USING btree ("orderDate")`
  - `purchase_orders_pkey` — `UNIQUE INDEX purchase_orders_pkey USING btree (id)`
  - `purchase_orders_status_idx` — `INDEX purchase_orders_status_idx USING btree (status)`
  - `purchase_orders_supplierId_idx` — `INDEX "purchase_orders_supplierId_idx" USING btree ("supplierId")`
- **Políticas RLS:** 
  - `purchase_orders_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `stock_movements`

- **Modelo Prisma:** `StockMovement` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/userId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `productId` | text | não |  |
| `movementType` | "MovementType" | não |  |
| `quantity` | numeric(10,3) | não |  |
| `unitCost` | numeric(10,2) | sim |  |
| `totalCost` | numeric(10,2) | sim |  |
| `referenceType` | text | sim |  |
| `referenceId` | text | sim |  |
| `notes` | text | sim |  |
| `userId` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (10):**
  - `stock_movements_branchId_idx` — `INDEX "stock_movements_branchId_idx" USING btree ("branchId")`
  - `stock_movements_branchId_productId_idx` — `INDEX "stock_movements_branchId_productId_idx" USING btree ("branchId", "productId")`
  - `stock_movements_companyId_idx` — `INDEX "stock_movements_companyId_idx" USING btree ("companyId")`
  - `stock_movements_createdAt_idx` — `INDEX "stock_movements_createdAt_idx" USING btree ("createdAt")`
  - `stock_movements_movementType_idx` — `INDEX "stock_movements_movementType_idx" USING btree ("movementType")`
  - `stock_movements_pkey` — `UNIQUE INDEX stock_movements_pkey USING btree (id)`
  - `stock_movements_productId_createdAt_idx` — `INDEX "stock_movements_productId_createdAt_idx" USING btree ("productId", "createdAt")`
  - `stock_movements_productId_idx` — `INDEX "stock_movements_productId_idx" USING btree ("productId")`
  - `stock_movements_referenceType_referenceId_idx` — `INDEX "stock_movements_referenceType_referenceId_idx" USING btree ("referenceType", "referenceId")`
  - `stock_movements_userId_idx` — `INDEX "stock_movements_userId_idx" USING btree ("userId")`
- **Políticas RLS:** 
  - `stock_movements_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `stock_movements_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `stock_movements_select` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `stock_reservations`

- **Modelo Prisma:** `StockReservation` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Reserva de estoque de um pedido externo. NÃO é movimento do livro (o inventário fixa o saldo absoluto e apagaria uma reserva): é uma promessa temporária. Disponível para venda = saldo do livro da filial − reservas ACTIVE ainda não vencidas. Uma linha por (pedido, produto); a reserva do pedido nasce e morre inteira.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `channelId` | text | não |  |
| `orderId` | text | não |  |
| `productId` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `status` | "StockReservationStatus" | não | `'ACTIVE'::"StockReservationStatus"` |
| `expiresAt` | timestamp(3) without time zone | não |  |
| `closedAt` | timestamp(3) without time zone | sim |  |
| `closedReason` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, orderId` → `external_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `stock_reservations_quantity_positive`: `CHECK ((quantity > (0)::numeric))`
- **Índices (6):**
  - `stock_reservations_branchId_productId_status_idx` — `INDEX "stock_reservations_branchId_productId_status_idx" USING btree ("branchId", "productId", status)`
  - `stock_reservations_companyId_idx` — `INDEX "stock_reservations_companyId_idx" USING btree ("companyId")`
  - `stock_reservations_orderId_productId_key` — `UNIQUE INDEX "stock_reservations_orderId_productId_key" USING btree ("orderId", "productId")`
  - `stock_reservations_pkey` — `UNIQUE INDEX stock_reservations_pkey USING btree (id)`
  - `stock_reservations_productId_idx` — `INDEX "stock_reservations_productId_idx" USING btree ("productId")`
  - `stock_reservations_status_expiresAt_idx` — `INDEX "stock_reservations_status_expiresAt_idx" USING btree (status, "expiresAt")`
- **Políticas RLS:** 
  - `stock_reservations_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `supplier_return_events`

- **Modelo Prisma:** `SupplierReturnEvent` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico da devolução (nunca apagado pela aplicação)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `returnId` | text | não |  |
| `type` | text | não |  |
| `fromStatus` | text | sim |  |
| `toStatus` | text | sim |  |
| `userId` | text | não |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, returnId` → `supplier_returns(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `supplier_return_events_companyId_idx` — `INDEX "supplier_return_events_companyId_idx" USING btree ("companyId")`
  - `supplier_return_events_pkey` — `UNIQUE INDEX supplier_return_events_pkey USING btree (id)`
  - `supplier_return_events_returnId_createdAt_idx` — `INDEX "supplier_return_events_returnId_createdAt_idx" USING btree ("returnId", "createdAt")`
- **Políticas RLS:** 
  - `supplier_return_events_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `supplier_return_items`

- **Modelo Prisma:** `SupplierReturnItem` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `returnId` | text | não |  |
| `productId` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `unitCost` | numeric(12,2) | sim |  |
| `notes` | text | sim |  |
| `damageRecordId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, damageRecordId` → `damage_records(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, returnId` → `supplier_returns(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `supplier_return_items_quantity_check`: `CHECK ((quantity > (0)::numeric))`
- **Índices (4):**
  - `supplier_return_items_companyId_idx` — `INDEX "supplier_return_items_companyId_idx" USING btree ("companyId")`
  - `supplier_return_items_pkey` — `UNIQUE INDEX supplier_return_items_pkey USING btree (id)`
  - `supplier_return_items_productId_idx` — `INDEX "supplier_return_items_productId_idx" USING btree ("productId")`
  - `supplier_return_items_returnId_idx` — `INDEX "supplier_return_items_returnId_idx" USING btree ("returnId")`
- **Políticas RLS:** 
  - `supplier_return_items_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `supplier_returns`

- **Modelo Prisma:** `SupplierReturn` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Devolução ao fornecedor (cadeia de suprimento — não é garantia ao cliente) — 2026-09-28 status: REQUESTED → APPROVED (estoque retirado) \| REJECTED → SENT → CLOSED; CANCELLED antes do envio reason: DAMAGED \| DEFECTIVE \| WRONG_ITEM \| NOT_ORDERED \| OTHER outcome: CREDIT \| REPLACEMENT \| REFUND \| REFUSED_BY_SUPPLIER

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `returnNumber` | integer | não |  |
| `supplierId` | text | não |  |
| `purchaseOrderId` | text | sim |  |
| `status` | text | não | `'REQUESTED'::text` |
| `reason` | text | não |  |
| `description` | text | sim |  |
| `requestedBy` | text | não |  |
| `approvedBy` | text | sim |  |
| `approvedAt` | timestamp(3) without time zone | sim |  |
| `decisionNotes` | text | sim |  |
| `stockWithdrawnAt` | timestamp(3) without time zone | sim |  |
| `sentAt` | timestamp(3) without time zone | sim |  |
| `sentBy` | text | sim |  |
| `shippingInfo` | text | sim |  |
| `outcome` | text | sim |  |
| `outcomeAmount` | numeric(12,2) | sim |  |
| `outcomeNotes` | text | sim |  |
| `closedAt` | timestamp(3) without time zone | sim |  |
| `closedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, purchaseOrderId` → `purchase_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, supplierId` → `suppliers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `supplier_returns_outcome_check`: `CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['CREDIT'::text, 'REPLACEMENT'::text, 'REFUND'::text, 'REFUSED_BY_SUPPLIER'::text]))))`
  - check `supplier_returns_reason_check`: `CHECK ((reason = ANY (ARRAY['DAMAGED'::text, 'DEFECTIVE'::text, 'WRONG_ITEM'::text, 'NOT_ORDERED'::text, 'OTHER'::text])))`
  - check `supplier_returns_status_check`: `CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'APPROVED'::text, 'REJECTED'::text, 'SENT'::text, 'CLOSED'::text, 'CANCELLED'::text])))`
- **Índices (5):**
  - `supplier_returns_companyId_branchId_status_idx` — `INDEX "supplier_returns_companyId_branchId_status_idx" USING btree ("companyId", "branchId", status)`
  - `supplier_returns_companyId_id_key` — `UNIQUE INDEX "supplier_returns_companyId_id_key" USING btree ("companyId", id)`
  - `supplier_returns_companyId_returnNumber_key` — `UNIQUE INDEX "supplier_returns_companyId_returnNumber_key" USING btree ("companyId", "returnNumber")`
  - `supplier_returns_pkey` — `UNIQUE INDEX supplier_returns_pkey USING btree (id)`
  - `supplier_returns_supplierId_idx` — `INDEX "supplier_returns_supplierId_idx" USING btree ("supplierId")`
- **Políticas RLS:** 
  - `supplier_returns_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `suppliers`

- **Modelo Prisma:** `Supplier` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `name` | text | não |  |
| `document` | text | não |  |
| `email` | text | sim |  |
| `phone` | text | sim |  |
| `address` | text | sim |  |
| `city` | text | sim |  |
| `state` | text | sim |  |
| `zipCode` | text | sim |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `addressComplement` | text | sim |  |
| `addressNumber` | text | sim |  |
| `mobile` | text | sim |  |
| `notes` | text | sim |  |
| `tradeName` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `suppliers_companyId_document_key` — `UNIQUE INDEX "suppliers_companyId_document_key" USING btree ("companyId", document)`
  - `suppliers_companyId_id_key` — `UNIQUE INDEX "suppliers_companyId_id_key" USING btree ("companyId", id)`
  - `suppliers_companyId_idx` — `INDEX "suppliers_companyId_idx" USING btree ("companyId")`
  - `suppliers_document_idx` — `INDEX suppliers_document_idx USING btree (document)`
  - `suppliers_isActive_idx` — `INDEX "suppliers_isActive_idx" USING btree ("isActive")`
  - `suppliers_pkey` — `UNIQUE INDEX suppliers_pkey USING btree (id)`
- **Políticas RLS:** 
  - `suppliers_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `transfer_items`

- **Modelo Prisma:** `TransferItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `transferId` | text | não |  |
| `productId` | text | não |  |
| `requestedQuantity` | numeric(10,3) | não |  |
| `sentQuantity` | numeric(10,3) | sim |  |
| `receivedQuantity` | numeric(10,3) | sim |  |
| `notes` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `productId` → `products(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `transferId` → `transfers(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `transfer_items_pkey` — `UNIQUE INDEX transfer_items_pkey USING btree (id)`
  - `transfer_items_productId_idx` — `INDEX "transfer_items_productId_idx" USING btree ("productId")`
  - `transfer_items_transferId_idx` — `INDEX "transfer_items_transferId_idx" USING btree ("transferId")`
- **Políticas RLS:** 
  - `transfer_items_isolation` (ALL, permissive, roles {public}): USING `("transferId" IN ( SELECT transfers.id FROM transfers))` · WITH CHECK `("transferId" IN ( SELECT transfers.id FROM transfers))`

#### `transfers`

- **Modelo Prisma:** `Transfer` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/fromBranchId/toBranchId/requestedBy are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `fromBranchId` | text | não |  |
| `toBranchId` | text | não |  |
| `transferNumber` | integer | não |  |
| `status` | "TransferStatus" | não | `'PENDING'::"TransferStatus"` |
| `requestedBy` | text | não |  |
| `approvedBy` | text | sim |  |
| `sentBy` | text | sim |  |
| `receivedBy` | text | sim |  |
| `requestedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `approvedAt` | timestamp(3) without time zone | sim |  |
| `sentAt` | timestamp(3) without time zone | sim |  |
| `receivedAt` | timestamp(3) without time zone | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, fromBranchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, toBranchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `transfers_companyId_idx` — `INDEX "transfers_companyId_idx" USING btree ("companyId")`
  - `transfers_companyId_transferNumber_key` — `UNIQUE INDEX "transfers_companyId_transferNumber_key" USING btree ("companyId", "transferNumber")`
  - `transfers_fromBranchId_idx` — `INDEX "transfers_fromBranchId_idx" USING btree ("fromBranchId")`
  - `transfers_pkey` — `UNIQUE INDEX transfers_pkey USING btree (id)`
  - `transfers_requestedAt_idx` — `INDEX "transfers_requestedAt_idx" USING btree ("requestedAt")`
  - `transfers_status_idx` — `INDEX transfers_status_idx USING btree (status)`
  - `transfers_toBranchId_idx` — `INDEX "transfers_toBranchId_idx" USING btree ("toBranchId")`
- **Políticas RLS:** 
  - `transfers_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("fromBranchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])) OR ("toBranchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("fromBranchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])) OR ("toBranchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Clientes, veículos e pós-venda

#### `appointment_events`

- **Modelo Prisma:** `AppointmentEvent` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Sem companyId próprio — isolamento via appointmentId, mesmo padrão de FollowUpEvent. Imutável.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `appointmentId` | text | não |  |
| `eventType` | "AppointmentEventType" | não |  |
| `previousScheduledAt` | timestamp(3) without time zone | sim |  |
| `newScheduledAt` | timestamp(3) without time zone | sim |  |
| `reason` | text | sim |  |
| `performedBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `appointmentId` → `appointments(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `appointment_events_appointmentId_idx` — `INDEX "appointment_events_appointmentId_idx" USING btree ("appointmentId")`
  - `appointment_events_createdAt_idx` — `INDEX "appointment_events_createdAt_idx" USING btree ("createdAt")`
  - `appointment_events_pkey` — `UNIQUE INDEX appointment_events_pkey USING btree (id)`
- **Políticas RLS:** 
  - `appointment_events_isolation` (ALL, permissive, roles {public}): USING `("appointmentId" IN ( SELECT appointments.id FROM appointments))` · WITH CHECK `("appointmentId" IN ( SELECT appointments.id FROM appointments))`

#### `appointments`

- **Modelo Prisma:** `Appointment` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/proposedBy plain scalars. `customerConfirmed` + `confirmedAt` existem separados de `status` de propósito: a equipe pode PROPOR um horário (status=PROPOSED) sem que isso signifique confirmação — só version um evento CONFIRMED (via customer) muda `customerConfirmed` para true. Nunca gravar confirmação sem essa distinção — é a regra central deste domínio.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `followUpId` | text | sim |  |
| `customerId` | text | não |  |
| `motorcycleId` | text | sim |  |
| `scheduledAt` | timestamp(3) without time zone | não |  |
| `status` | "AppointmentStatus" | não | `'PROPOSED'::"AppointmentStatus"` |
| `proposedBy` | text | não |  |
| `customerConfirmed` | boolean | não | `false` |
| `confirmedAt` | timestamp(3) without time zone | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `confirmationChannel` | "ContactChannel" | sim |  |
| `confirmedByName` | text | sim |  |
| `completedWithoutConfirmation` | boolean | não | `false` |
| `completionAuthorizedBy` | text | sim |  |
| `completionReason` | text | sim |  |
| `durationMinutes` | integer | sim |  |
| `mechanicId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, followUpId` → `follow_ups(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `appointments_durationMinutes_check`: `CHECK ((("durationMinutes" IS NULL) OR (("durationMinutes" >= 5) AND ("durationMinutes" <= 1440))))`
- **Índices (9):**
  - `appointments_branchId_idx` — `INDEX "appointments_branchId_idx" USING btree ("branchId")`
  - `appointments_companyId_followUpId_key` — `UNIQUE INDEX "appointments_companyId_followUpId_key" USING btree ("companyId", "followUpId")`
  - `appointments_companyId_idx` — `INDEX "appointments_companyId_idx" USING btree ("companyId")`
  - `appointments_customerId_idx` — `INDEX "appointments_customerId_idx" USING btree ("customerId")`
  - `appointments_followUpId_key` — `UNIQUE INDEX "appointments_followUpId_key" USING btree ("followUpId")`
  - `appointments_mechanicId_idx` — `INDEX "appointments_mechanicId_idx" USING btree ("mechanicId")`
  - `appointments_pkey` — `UNIQUE INDEX appointments_pkey USING btree (id)`
  - `appointments_scheduledAt_idx` — `INDEX "appointments_scheduledAt_idx" USING btree ("scheduledAt")`
  - `appointments_status_idx` — `INDEX appointments_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `appointments_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `customers`

- **Modelo Prisma:** `Customer` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `customerType` | "CustomerType" | não | `'INDIVIDUAL'::"CustomerType"` |
| `name` | text | não |  |
| `document` | text | sim |  |
| `email` | text | sim |  |
| `phone` | text | sim |  |
| `mobile` | text | sim |  |
| `birthDate` | timestamp(3) without time zone | sim |  |
| `address` | text | sim |  |
| `city` | text | sim |  |
| `state` | text | sim |  |
| `zipCode` | text | sim |  |
| `notes` | text | sim |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `whatsapp` | text | sim |  |
| `preferredContact` | "ContactChannel" | sim |  |
| `anonymizedAt` | timestamp(3) without time zone | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (9):**
  - `customers_companyId_document_key` — `UNIQUE INDEX "customers_companyId_document_key" USING btree ("companyId", document)`
  - `customers_companyId_id_key` — `UNIQUE INDEX "customers_companyId_id_key" USING btree ("companyId", id)`
  - `customers_companyId_idx` — `INDEX "customers_companyId_idx" USING btree ("companyId")`
  - `customers_document_idx` — `INDEX customers_document_idx USING btree (document)`
  - `customers_email_idx` — `INDEX customers_email_idx USING btree (email)`
  - `customers_isActive_idx` — `INDEX "customers_isActive_idx" USING btree ("isActive")`
  - `customers_mobile_idx` — `INDEX customers_mobile_idx USING btree (mobile)`
  - `customers_phone_idx` — `INDEX customers_phone_idx USING btree (phone)`
  - `customers_pkey` — `UNIQUE INDEX customers_pkey USING btree (id)`
- **Políticas RLS:** 
  - `customers_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `follow_up_events`

- **Modelo Prisma:** `FollowUpEvent` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Sem companyId próprio — isolamento via followUpId, mesmo padrão de ServiceOrderStatusHistory (RLS junta com a tabela pai, ver migration.sql). Imutável: histórico de contato e decisões do cliente, nunca atualizado ou apagado.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `followUpId` | text | não |  |
| `eventType` | "FollowUpEventType" | não |  |
| `channel` | "ContactChannel" | sim |  |
| `message` | text | sim |  |
| `performedBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `followUpId` → `follow_ups(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `follow_up_events_createdAt_idx` — `INDEX "follow_up_events_createdAt_idx" USING btree ("createdAt")`
  - `follow_up_events_followUpId_idx` — `INDEX "follow_up_events_followUpId_idx" USING btree ("followUpId")`
  - `follow_up_events_pkey` — `UNIQUE INDEX follow_up_events_pkey USING btree (id)`
- **Políticas RLS:** 
  - `follow_up_events_isolation` (ALL, permissive, roles {public}): USING `("followUpId" IN ( SELECT follow_ups.id FROM follow_ups))` · WITH CHECK `("followUpId" IN ( SELECT follow_ups.id FROM follow_ups))`

#### `follow_ups`

- **Modelo Prisma:** `FollowUp` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/createdBy plain scalars. `status` é exatamente os 3 baldes do dashboard de pós-venda — de propósito NÃO existe um status "Aguardando contato": tentativas de contato são eventos em FollowUpEvent (histórico), nunca um status próprio do FollowUp.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `revisionId` | text | sim |  |
| `customerId` | text | não |  |
| `motorcycleId` | text | não |  |
| `dueDate` | timestamp(3) without time zone | não |  |
| `status` | "FollowUpStatus" | não | `'PENDING'::"FollowUpStatus"` |
| `notes` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, revisionId` → `revisions(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `follow_ups_branchId_idx` — `INDEX "follow_ups_branchId_idx" USING btree ("branchId")`
  - `follow_ups_companyId_id_key` — `UNIQUE INDEX "follow_ups_companyId_id_key" USING btree ("companyId", id)`
  - `follow_ups_customerId_idx` — `INDEX "follow_ups_customerId_idx" USING btree ("customerId")`
  - `follow_ups_dueDate_idx` — `INDEX "follow_ups_dueDate_idx" USING btree ("dueDate")`
  - `follow_ups_motorcycleId_idx` — `INDEX "follow_ups_motorcycleId_idx" USING btree ("motorcycleId")`
  - `follow_ups_pkey` — `UNIQUE INDEX follow_ups_pkey USING btree (id)`
  - `follow_ups_status_idx` — `INDEX follow_ups_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `follow_ups_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `motorcycles`

- **Modelo Prisma:** `Motorcycle` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId is a plain scalar — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `customerId` | text | não |  |
| `licensePlate` | text | sim |  |
| `chassisNumber` | text | sim |  |
| `brand` | text | não |  |
| `model` | text | não |  |
| `year` | integer | sim |  |
| `color` | text | sim |  |
| `engineNumber` | text | sim |  |
| `kilometerReading` | numeric(10,1) | não |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `vehicleType` | "VehicleType" | não | `'MOTORCYCLE'::"VehicleType"` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `motorcycles_companyId_id_key` — `UNIQUE INDEX "motorcycles_companyId_id_key" USING btree ("companyId", id)`
  - `motorcycles_companyId_licensePlate_key` — `UNIQUE INDEX "motorcycles_companyId_licensePlate_key" USING btree ("companyId", "licensePlate")`
  - `motorcycles_customerId_idx` — `INDEX "motorcycles_customerId_idx" USING btree ("customerId")`
  - `motorcycles_isActive_idx` — `INDEX "motorcycles_isActive_idx" USING btree ("isActive")`
  - `motorcycles_licensePlate_idx` — `INDEX "motorcycles_licensePlate_idx" USING btree ("licensePlate")`
  - `motorcycles_pkey` — `UNIQUE INDEX motorcycles_pkey USING btree (id)`
  - `motorcycles_vehicleType_idx` — `INDEX "motorcycles_vehicleType_idx" USING btree ("vehicleType")`
- **Políticas RLS:** 
  - `motorcycles_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `revisions`

- **Modelo Prisma:** `Revision` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/serviceOrderId/recordedBy plain scalars (mesmo padrão do resto do schema — isolamento via RLS, não FK). Imutável por design: histórico do que já foi feito num veículo — o service nunca expõe update/delete, só create. `nextDueDate`/`nextDueKilometer` são calculados no momento da criação (performedAt + intervalMonths, e kilometerAtService + intervalKilometers quando informado) e persistidos — não rec…

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `customerId` | text | não |  |
| `motorcycleId` | text | não |  |
| `serviceOrderId` | text | sim |  |
| `performedAt` | timestamp(3) without time zone | não |  |
| `kilometerAtService` | numeric(10,1) | não |  |
| `servicesPerformed` | text | não |  |
| `partsReplaced` | text | sim |  |
| `notes` | text | sim |  |
| `intervalMonths` | integer | não | `3` |
| `intervalKilometers` | integer | sim |  |
| `nextDueDate` | timestamp(3) without time zone | não |  |
| `nextDueKilometer` | numeric(10,1) | sim |  |
| `recordedBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `recommendations` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `revisions_branchId_idx` — `INDEX "revisions_branchId_idx" USING btree ("branchId")`
  - `revisions_companyId_id_key` — `UNIQUE INDEX "revisions_companyId_id_key" USING btree ("companyId", id)`
  - `revisions_customerId_idx` — `INDEX "revisions_customerId_idx" USING btree ("customerId")`
  - `revisions_motorcycleId_idx` — `INDEX "revisions_motorcycleId_idx" USING btree ("motorcycleId")`
  - `revisions_nextDueDate_idx` — `INDEX "revisions_nextDueDate_idx" USING btree ("nextDueDate")`
  - `revisions_pkey` — `UNIQUE INDEX revisions_pkey USING btree (id)`
- **Políticas RLS:** 
  - `revisions_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Vendas, caixa e pagamento

#### `cash_movements`

- **Modelo Prisma:** `CashMovement` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `cashRegisterId` | text | não |  |
| `movementType` | "CashMovementType" | não |  |
| `amount` | numeric(10,2) | não |  |
| `paymentMethod` | "PaymentMethod" | sim |  |
| `referenceType` | text | sim |  |
| `referenceId` | text | sim |  |
| `notes` | text | sim |  |
| `userId` | text | não |  |
| `requestedBy` | text | sim |  |
| `authorizedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `cashRegisterId` → `cash_registers(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (5):**
  - `cash_movements_cashRegisterId_idx` — `INDEX "cash_movements_cashRegisterId_idx" USING btree ("cashRegisterId")`
  - `cash_movements_createdAt_idx` — `INDEX "cash_movements_createdAt_idx" USING btree ("createdAt")`
  - `cash_movements_movementType_idx` — `INDEX "cash_movements_movementType_idx" USING btree ("movementType")`
  - `cash_movements_pkey` — `UNIQUE INDEX cash_movements_pkey USING btree (id)`
  - `cash_movements_referenceType_referenceId_idx` — `INDEX "cash_movements_referenceType_referenceId_idx" USING btree ("referenceType", "referenceId")`
- **Políticas RLS:** 
  - `cash_movements_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `("cashRegisterId" IN ( SELECT cash_registers.id FROM cash_registers))`
  - `cash_movements_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `cash_movements_select` (SELECT, permissive, roles {public}): USING `("cashRegisterId" IN ( SELECT cash_registers.id FROM cash_registers))`

#### `cash_registers`

- **Modelo Prisma:** `CashRegister` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** `status` has no DB default (unlike every other enum-status column in this schema) — verified against the source DDL, not an omission. Two partial UNIQUE indexes exist only at the database level and cannot be expressed in the Prisma schema (Prisma has no WHERE-filtered @@unique): one open register per (branchId, registerNumber), and one open register per userId — see migration.sql for cash_registers_one_open_per_*.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `userId` | text | não |  |
| `registerNumber` | integer | não |  |
| `status` | "CashRegisterStatus" | não |  |
| `openingAmount` | numeric(10,2) | não |  |
| `expectedAmount` | numeric(10,2) | não | `0` |
| `actualAmount` | numeric(10,2) | sim |  |
| `difference` | numeric(10,2) | sim |  |
| `openedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `closedAt` | timestamp(3) without time zone | sim |  |
| `closedBy` | text | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `closeType` | text | não | `'NORMAL'::text` |
| `forcedReason` | text | sim |  |
| `pendingSnapshot` | jsonb | sim |  |
| `closingSummary` | jsonb | sim |  |
| `differenceReason` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (10):**
  - `cash_registers_branchId_idx` — `INDEX "cash_registers_branchId_idx" USING btree ("branchId")`
  - `cash_registers_branchId_status_idx` — `INDEX "cash_registers_branchId_status_idx" USING btree ("branchId", status)`
  - `cash_registers_companyId_id_key` — `UNIQUE INDEX "cash_registers_companyId_id_key" USING btree ("companyId", id)`
  - `cash_registers_one_open_per_branch_register_number` — `UNIQUE INDEX cash_registers_one_open_per_branch_register_number USING btree ("branchId", "registerNumber") WHERE (status = 'OPEN'::"CashRegisterStatus")`
  - `cash_registers_one_open_per_user` — `UNIQUE INDEX cash_registers_one_open_per_user USING btree ("userId") WHERE (status = 'OPEN'::"CashRegisterStatus")`
  - `cash_registers_openedAt_idx` — `INDEX "cash_registers_openedAt_idx" USING btree ("openedAt")`
  - `cash_registers_pkey` — `UNIQUE INDEX cash_registers_pkey USING btree (id)`
  - `cash_registers_status_idx` — `INDEX cash_registers_status_idx USING btree (status)`
  - `cash_registers_userId_idx` — `INDEX "cash_registers_userId_idx" USING btree ("userId")`
  - `cash_registers_userId_status_idx` — `INDEX "cash_registers_userId_status_idx" USING btree ("userId", status)`
- **Políticas RLS:** 
  - `cash_registers_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `discount_events`

- **Modelo Prisma:** `DiscountEvent` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Todo desconto (inclusive dentro do limite livre), item a item. Append-only.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `saleId` | text | sim |  |
| `serviceOrderId` | text | sim |  |
| `quoteId` | text | sim |  |
| `itemRef` | text | sim |  |
| `itemType` | text | não |  |
| `description` | text | sim |  |
| `originalAmount` | numeric(12,2) | não |  |
| `discountAmount` | numeric(12,2) | não |  |
| `discountPercent` | numeric(7,3) | não |  |
| `finalAmount` | numeric(12,2) | não |  |
| `freeLimitPercent` | numeric(7,3) | não |  |
| `requiredAuthorization` | boolean | não |  |
| `requestedBy` | text | não |  |
| `authorizedBy` | text | sim |  |
| `reason` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, quoteId` → `quotes(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `discount_events_companyId_createdAt_idx` — `INDEX "discount_events_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `discount_events_pkey` — `UNIQUE INDEX discount_events_pkey USING btree (id)`
  - `discount_events_saleId_idx` — `INDEX "discount_events_saleId_idx" USING btree ("saleId")`
  - `discount_events_serviceOrderId_idx` — `INDEX "discount_events_serviceOrderId_idx" USING btree ("serviceOrderId")`
- **Políticas RLS:** 
  - `discount_events_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `discount_events_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `discount_events_read` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `discount_rules`

- **Modelo Prisma:** `DiscountRule` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** roleId has no FK to Role (verified against the DDL) — plain scalar.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `name` | text | não |  |
| `description` | text | sim |  |
| `userType` | "UserType" | sim |  |
| `roleId` | text | sim |  |
| `discountType` | "DiscountType" | não |  |
| `maxDiscount` | numeric(5,2) | não |  |
| `requiresApproval` | boolean | não | `false` |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `discount_rules_companyId_idx` — `INDEX "discount_rules_companyId_idx" USING btree ("companyId")`
  - `discount_rules_pkey` — `UNIQUE INDEX discount_rules_pkey USING btree (id)`
  - `discount_rules_roleId_idx` — `INDEX "discount_rules_roleId_idx" USING btree ("roleId")`
  - `discount_rules_userType_idx` — `INDEX "discount_rules_userType_idx" USING btree ("userType")`
- **Políticas RLS:** 
  - `discount_rules_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `partners`

- **Modelo Prisma:** `Partner` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `name` | text | não |  |
| `description` | text | sim |  |
| `discountType` | "PartnerDiscountType" | não | `'PERCENTAGE'::"PartnerDiscountType"` |
| `discountValue` | numeric(10,2) | não |  |
| `maxDiscountAmount` | numeric(10,2) | sim |  |
| `stackable` | boolean | não | `false` |
| `requiresApproval` | boolean | não | `false` |
| `validFrom` | timestamp(3) without time zone | sim |  |
| `validUntil` | timestamp(3) without time zone | sim |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `partners_branchId_idx` — `INDEX "partners_branchId_idx" USING btree ("branchId")`
  - `partners_companyId_idx` — `INDEX "partners_companyId_idx" USING btree ("companyId")`
  - `partners_companyId_name_key` — `UNIQUE INDEX "partners_companyId_name_key" USING btree ("companyId", name)`
  - `partners_pkey` — `UNIQUE INDEX partners_pkey USING btree (id)`
- **Políticas RLS:** 
  - `partners_delete` (DELETE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (("branchId" IS NOT NULL) AND ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])))))`
  - `partners_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (("branchId" IS NOT NULL) AND ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])))))`
  - `partners_select` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `partners_update` (UPDATE, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR (("branchId" IS NOT NULL) AND ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[])))))`

#### `payment_exceptions`

- **Modelo Prisma:** `PaymentException` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Fato do provedor em conflito com a venda (ex.: aprovado depois do cancelamento/devolução). O pagamento guarda a verdade; a exceção fica aberta até ser tratada. Tratamento comercial: [DECISÃO NECESSÁRIA] (docs/CORTEX/BUSINESS_RULES.md). Máximo uma aberta por pagamento (índice parcial `payment_exceptions_one_open`, na migração).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `paymentId` | text | não |  |
| `saleId` | text | não |  |
| `type` | text | não |  |
| `saleStatus` | text | não |  |
| `amount` | numeric(10,2) | não |  |
| `provider` | text | sim |  |
| `providerStatus` | text | não |  |
| `detectedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `resolvedAt` | timestamp(3) without time zone | sim |  |
| `resolution` | text | sim |  |
| `resolvedBy` | text | sim |  |
| `notes` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, paymentId` → `payments(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `payment_exceptions_companyId_resolvedAt_idx` — `INDEX "payment_exceptions_companyId_resolvedAt_idx" USING btree ("companyId", "resolvedAt")`
  - `payment_exceptions_one_open` — `UNIQUE INDEX payment_exceptions_one_open USING btree ("paymentId") WHERE ("resolvedAt" IS NULL)`
  - `payment_exceptions_pkey` — `UNIQUE INDEX payment_exceptions_pkey USING btree (id)`
  - `payment_exceptions_saleId_idx` — `INDEX "payment_exceptions_saleId_idx" USING btree ("saleId")`
- **Políticas RLS:** 
  - `payment_exceptions_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `payments`

- **Modelo Prisma:** `Payment` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId is a plain scalar — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `saleId` | text | não |  |
| `paymentMethod` | "PaymentMethod" | não |  |
| `status` | "PaymentStatus" | não | `'PENDING'::"PaymentStatus"` |
| `amount` | numeric(10,2) | não |  |
| `installments` | integer | não | `1` |
| `transactionId` | text | sim |  |
| `authorizationCode` | text | sim |  |
| `cardBrand` | text | sim |  |
| `cardLastDigits` | text | sim |  |
| `nsuHost` | text | sim |  |
| `nsuTef` | text | sim |  |
| `paidAt` | timestamp(3) without time zone | sim |  |
| `cancelledAt` | timestamp(3) without time zone | sim |  |
| `refundedAt` | timestamp(3) without time zone | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `receivedAmount` | numeric(10,2) | sim |  |
| `changeAmount` | numeric(10,2) | não | `0` |
| `cashBreakdown` | jsonb | sim |  |
| `provider` | text | sim |  |
| `agreementCompanyId` | text | sim |  |
| `employeeAgreementId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, agreementCompanyId` → `agreement_companies(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, employeeAgreementId` → `employee_agreements(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (10):**
  - `payments_agreementCompanyId_idx` — `INDEX "payments_agreementCompanyId_idx" USING btree ("agreementCompanyId")`
  - `payments_companyId_id_key` — `UNIQUE INDEX "payments_companyId_id_key" USING btree ("companyId", id)`
  - `payments_employeeAgreementId_idx` — `INDEX "payments_employeeAgreementId_idx" USING btree ("employeeAgreementId")`
  - `payments_paidAt_idx` — `INDEX "payments_paidAt_idx" USING btree ("paidAt")`
  - `payments_paymentMethod_idx` — `INDEX "payments_paymentMethod_idx" USING btree ("paymentMethod")`
  - `payments_pkey` — `UNIQUE INDEX payments_pkey USING btree (id)`
  - `payments_saleId_idx` — `INDEX "payments_saleId_idx" USING btree ("saleId")`
  - `payments_saleId_status_idx` — `INDEX "payments_saleId_status_idx" USING btree ("saleId", status)`
  - `payments_status_idx` — `INDEX payments_status_idx USING btree (status)`
  - `payments_transactionId_key` — `UNIQUE INDEX "payments_transactionId_key" USING btree ("transactionId")`
- **Políticas RLS:** 
  - `payments_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND ("saleId" IN ( SELECT sales.id FROM sales)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND ("saleId" IN ( SELECT sales.id FROM sales)))`

#### `sale_items`

- **Modelo Prisma:** `SaleItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `saleId` | text | não |  |
| `productId` | text | não |  |
| `productName` | text | não |  |
| `productSku` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `unitPrice` | numeric(10,2) | não |  |
| `discountAmount` | numeric(10,2) | não | `0` |
| `discountPercent` | numeric(5,2) | não | `0` |
| `totalPrice` | numeric(10,2) | não |  |
| `notes` | text | sim |  |
| `returnedQuantity` | numeric(10,3) | não | `0` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `productId` → `products(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `saleId` → `sales(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `sale_items_pkey` — `UNIQUE INDEX sale_items_pkey USING btree (id)`
  - `sale_items_productId_idx` — `INDEX "sale_items_productId_idx" USING btree ("productId")`
  - `sale_items_saleId_idx` — `INDEX "sale_items_saleId_idx" USING btree ("saleId")`
- **Políticas RLS:** 
  - `sale_items_isolation` (ALL, permissive, roles {public}): USING `("saleId" IN ( SELECT sales.id FROM sales))` · WITH CHECK `("saleId" IN ( SELECT sales.id FROM sales))`

#### `sales`

- **Modelo Prisma:** `Sale` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/cashRegisterId are plain scalars — no FK (cashRegisterId notably has no FK despite the obvious relationship).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `saleNumber` | integer | não |  |
| `customerId` | text | sim |  |
| `userId` | text | sim |  |
| `cashRegisterId` | text | sim |  |
| `status` | "SaleStatus" | não | `'PENDING'::"SaleStatus"` |
| `subtotal` | numeric(10,2) | não |  |
| `discountAmount` | numeric(10,2) | não | `0` |
| `discountPercent` | numeric(5,2) | não | `0` |
| `totalAmount` | numeric(10,2) | não |  |
| `paidAmount` | numeric(10,2) | não | `0` |
| `changeAmount` | numeric(10,2) | não | `0` |
| `notes` | text | sim |  |
| `cancelReason` | text | sim |  |
| `cancelledAt` | timestamp(3) without time zone | sim |  |
| `cancelledBy` | text | sim |  |
| `saleDate` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `partnerDiscountAmount` | numeric(10,2) | não | `0` |
| `partnerId` | text | sim |  |
| `channelId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, cashRegisterId` → `cash_registers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `partnerId` → `partners(id)` · ao apagar: **SET NULL** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `sales_physical_origin_check`: `CHECK ((("channelId" IS NOT NULL) OR (("cashRegisterId" IS NOT NULL) AND ("userId" IS NOT NULL))))`
- **Índices (15):**
  - `sales_branchId_idx` — `INDEX "sales_branchId_idx" USING btree ("branchId")`
  - `sales_branchId_saleDate_idx` — `INDEX "sales_branchId_saleDate_idx" USING btree ("branchId", "saleDate")`
  - `sales_cashRegisterId_idx` — `INDEX "sales_cashRegisterId_idx" USING btree ("cashRegisterId")`
  - `sales_channelId_idx` — `INDEX "sales_channelId_idx" USING btree ("channelId")`
  - `sales_companyId_branchId_saleNumber_key` — `UNIQUE INDEX "sales_companyId_branchId_saleNumber_key" USING btree ("companyId", "branchId", "saleNumber")`
  - `sales_companyId_id_key` — `UNIQUE INDEX "sales_companyId_id_key" USING btree ("companyId", id)`
  - `sales_companyId_idx` — `INDEX "sales_companyId_idx" USING btree ("companyId")`
  - `sales_companyId_saleDate_idx` — `INDEX "sales_companyId_saleDate_idx" USING btree ("companyId", "saleDate")`
  - `sales_companyId_status_idx` — `INDEX "sales_companyId_status_idx" USING btree ("companyId", status)`
  - `sales_customerId_idx` — `INDEX "sales_customerId_idx" USING btree ("customerId")`
  - `sales_partnerId_idx` — `INDEX "sales_partnerId_idx" USING btree ("partnerId")`
  - `sales_pkey` — `UNIQUE INDEX sales_pkey USING btree (id)`
  - `sales_saleDate_idx` — `INDEX "sales_saleDate_idx" USING btree ("saleDate")`
  - `sales_status_idx` — `INDEX sales_status_idx USING btree (status)`
  - `sales_userId_idx` — `INDEX "sales_userId_idx" USING btree ("userId")`
- **Políticas RLS:** 
  - `sales_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
- **Triggers:**
  - `sales_partner_same_company`: `BEFORE INSERT OR UPDATE OF "partnerId", "companyId" FOR EACH ROW EXECUTE FUNCTION enforce_same_company_ref('partners', 'partnerId')`

#### `tef_payments`

- **Modelo Prisma:** `TefPayment` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Fully scalar — companyId/saleId/serviceOrderId/paymentId carry no FK at all in the database.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `saleId` | text | sim |  |
| `serviceOrderId` | text | sim |  |
| `paymentId` | text | não |  |
| `provider` | text | não |  |
| `transactionId` | text | não |  |
| `amount` | numeric(10,2) | não |  |
| `status` | "TEFPaymentStatus" | não | `'PENDING'::"TEFPaymentStatus"` |
| `cardBrand` | text | sim |  |
| `cardLastDigits` | text | sim |  |
| `authorizationCode` | text | sim |  |
| `nsuHost` | text | sim |  |
| `nsuTef` | text | sim |  |
| `requestedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `authorizedAt` | timestamp(3) without time zone | sim |  |
| `rejectedAt` | timestamp(3) without time zone | sim |  |
| `rejectionReason` | text | sim |  |
| `reconciliationStatus` | text | sim |  |
| `reconciledAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, paymentId` → `payments(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (9):**
  - `tef_payments_companyId_idx` — `INDEX "tef_payments_companyId_idx" USING btree ("companyId")`
  - `tef_payments_paymentId_idx` — `INDEX "tef_payments_paymentId_idx" USING btree ("paymentId")`
  - `tef_payments_pkey` — `UNIQUE INDEX tef_payments_pkey USING btree (id)`
  - `tef_payments_provider_transactionId_key` — `UNIQUE INDEX "tef_payments_provider_transactionId_key" USING btree (provider, "transactionId")`
  - `tef_payments_requestedAt_idx` — `INDEX "tef_payments_requestedAt_idx" USING btree ("requestedAt")`
  - `tef_payments_saleId_idx` — `INDEX "tef_payments_saleId_idx" USING btree ("saleId")`
  - `tef_payments_serviceOrderId_idx` — `INDEX "tef_payments_serviceOrderId_idx" USING btree ("serviceOrderId")`
  - `tef_payments_status_idx` — `INDEX tef_payments_status_idx USING btree (status)`
  - `tef_payments_transactionId_idx` — `INDEX "tef_payments_transactionId_idx" USING btree ("transactionId")`
- **Políticas RLS:** 
  - `tef_payments_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

### Financeiro e convênios

#### `accounts_payable`

- **Modelo Prisma:** `AccountsPayable` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/supplierId are plain scalars — no FK in the database, isolation is via RLS (rls_company_match) only. A partial UNIQUE index exists only at the database level and cannot be expressed in the Prisma schema (no WHERE-filtered @@unique): at most one row with referenceType='Reversal' per referenceId — see migration `add_accounts_reversal_unique_reference`. Backstops FinancialService.reversePayable's appl…

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `supplierId` | text | sim |  |
| `description` | text | não |  |
| `amount` | numeric(10,2) | não |  |
| `dueDate` | timestamp(3) without time zone | não |  |
| `paidDate` | timestamp(3) without time zone | sim |  |
| `status` | "AccountStatus" | não | `'PENDING'::"AccountStatus"` |
| `referenceType` | text | sim |  |
| `referenceId` | text | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, supplierId` → `suppliers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (8):**
  - `accounts_payable_branchId_idx` — `INDEX "accounts_payable_branchId_idx" USING btree ("branchId")`
  - `accounts_payable_companyId_idx` — `INDEX "accounts_payable_companyId_idx" USING btree ("companyId")`
  - `accounts_payable_companyId_status_idx` — `INDEX "accounts_payable_companyId_status_idx" USING btree ("companyId", status)`
  - `accounts_payable_dueDate_idx` — `INDEX "accounts_payable_dueDate_idx" USING btree ("dueDate")`
  - `accounts_payable_one_reversal_per_reference` — `UNIQUE INDEX accounts_payable_one_reversal_per_reference USING btree ("referenceId") WHERE ("referenceType" = 'Reversal'::text)`
  - `accounts_payable_pkey` — `UNIQUE INDEX accounts_payable_pkey USING btree (id)`
  - `accounts_payable_status_idx` — `INDEX accounts_payable_status_idx USING btree (status)`
  - `accounts_payable_supplierId_idx` — `INDEX "accounts_payable_supplierId_idx" USING btree ("supplierId")`
- **Políticas RLS:** 
  - `accounts_payable_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `accounts_receivable`

- **Modelo Prisma:** `AccountsReceivable` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/customerId are plain scalars — no FK, RLS-enforced. Same partial UNIQUE index note as AccountsPayable — see migration `add_accounts_reversal_unique_reference` (at most one referenceType='Reversal' row per referenceId), backstopping FinancialService.reverseReceivable's application-level guard.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `customerId` | text | sim |  |
| `description` | text | não |  |
| `amount` | numeric(10,2) | não |  |
| `dueDate` | timestamp(3) without time zone | não |  |
| `paidDate` | timestamp(3) without time zone | sim |  |
| `status` | "AccountStatus" | não | `'PENDING'::"AccountStatus"` |
| `referenceType` | text | sim |  |
| `referenceId` | text | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `agreementCompanyId` | text | sim |  |
| `employeeAgreementId` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, agreementCompanyId` → `agreement_companies(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, employeeAgreementId` → `employee_agreements(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (10):**
  - `accounts_receivable_agreementCompanyId_idx` — `INDEX "accounts_receivable_agreementCompanyId_idx" USING btree ("agreementCompanyId")`
  - `accounts_receivable_branchId_idx` — `INDEX "accounts_receivable_branchId_idx" USING btree ("branchId")`
  - `accounts_receivable_companyId_id_key` — `UNIQUE INDEX "accounts_receivable_companyId_id_key" USING btree ("companyId", id)`
  - `accounts_receivable_companyId_status_idx` — `INDEX "accounts_receivable_companyId_status_idx" USING btree ("companyId", status)`
  - `accounts_receivable_customerId_idx` — `INDEX "accounts_receivable_customerId_idx" USING btree ("customerId")`
  - `accounts_receivable_dueDate_idx` — `INDEX "accounts_receivable_dueDate_idx" USING btree ("dueDate")`
  - `accounts_receivable_employeeAgreementId_idx` — `INDEX "accounts_receivable_employeeAgreementId_idx" USING btree ("employeeAgreementId")`
  - `accounts_receivable_one_reversal_per_reference` — `UNIQUE INDEX accounts_receivable_one_reversal_per_reference USING btree ("referenceId") WHERE ("referenceType" = 'Reversal'::text)`
  - `accounts_receivable_pkey` — `UNIQUE INDEX accounts_receivable_pkey USING btree (id)`
  - `accounts_receivable_status_idx` — `INDEX accounts_receivable_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `accounts_receivable_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `agreement_companies`

- **Modelo Prisma:** `AgreementCompany` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Empresa conveniada (cliente corporativo com prazo). status: ACTIVE \| BLOCKED \| INACTIVE

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `legalName` | text | não |  |
| `tradeName` | text | sim |  |
| `cnpj` | text | não |  |
| `contactName` | text | sim |  |
| `phone` | text | sim |  |
| `whatsapp` | text | sim |  |
| `email` | text | sim |  |
| `zipCode` | text | sim |  |
| `street` | text | sim |  |
| `number` | text | sim |  |
| `complement` | text | sim |  |
| `district` | text | sim |  |
| `city` | text | sim |  |
| `state` | text | sim |  |
| `commercialTerms` | text | sim |  |
| `creditLimit` | numeric(12,2) | sim |  |
| `monthlyLimit` | numeric(12,2) | sim |  |
| `paymentTermDays` | integer | não | `30` |
| `interestPercentMonthly` | numeric(7,3) | sim |  |
| `finePercent` | numeric(7,3) | sim |  |
| `blockAfterDaysOverdue` | integer | sim |  |
| `status` | text | não | `'ACTIVE'::text` |
| `blockedAt` | timestamp(3) without time zone | sim |  |
| `blockedBy` | text | sim |  |
| `blockedReason` | text | sim |  |
| `notes` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `allowedBranchIds` | text[] | não | `ARRAY[]::text[]` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `agreement_companies_companyId_cnpj_key` — `UNIQUE INDEX "agreement_companies_companyId_cnpj_key" USING btree ("companyId", cnpj)`
  - `agreement_companies_companyId_id_key` — `UNIQUE INDEX "agreement_companies_companyId_id_key" USING btree ("companyId", id)`
  - `agreement_companies_pkey` — `UNIQUE INDEX agreement_companies_pkey USING btree (id)`
- **Políticas RLS:** 
  - `agreement_companies_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `collection_attempts`

- **Modelo Prisma:** `CollectionAttempt` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Cobrança enviada manualmente por pessoa autorizada (uma por ação; sem robô). Append-only. channel: WHATSAPP \| EMAIL; status: SENT \| LINK_GENERATED \| FAILED \| NOT_CONFIGURED

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `receivableId` | text | não |  |
| `agreementCompanyId` | text | sim |  |
| `channel` | text | não |  |
| `recipient` | text | sim |  |
| `amount` | numeric(12,2) | não |  |
| `dueDate` | timestamp(3) without time zone | não |  |
| `status` | text | não |  |
| `provider` | text | sim |  |
| `providerMessage` | text | sim |  |
| `sentBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, agreementCompanyId` → `agreement_companies(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, receivableId` → `accounts_receivable(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `collection_attempts_companyId_createdAt_idx` — `INDEX "collection_attempts_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `collection_attempts_pkey` — `UNIQUE INDEX collection_attempts_pkey USING btree (id)`
  - `collection_attempts_receivableId_idx` — `INDEX "collection_attempts_receivableId_idx" USING btree ("receivableId")`
- **Políticas RLS:** 
  - `collection_attempts_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `collection_attempts_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `collection_attempts_read` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `commission_rules`

- **Modelo Prisma:** `CommissionRule` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `name` | text | não |  |
| `serviceType` | text | sim |  |
| `percentage` | numeric(5,2) | não |  |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `commission_rules_companyId_idx` — `INDEX "commission_rules_companyId_idx" USING btree ("companyId")`
  - `commission_rules_isActive_idx` — `INDEX "commission_rules_isActive_idx" USING btree ("isActive")`
  - `commission_rules_pkey` — `UNIQUE INDEX commission_rules_pkey USING btree (id)`
- **Políticas RLS:** 
  - `commission_rules_isolation` (ALL, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id)))`

#### `employee_agreement_charges`

- **Modelo Prisma:** `EmployeeAgreementCharge` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Uso do convênio de funcionário (uma compra), com as parcelas previstas em folha.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `agreementId` | text | não |  |
| `saleId` | text | sim |  |
| `paymentId` | text | sim |  |
| `amount` | numeric(12,2) | não |  |
| `installments` | integer | não | `1` |
| `firstCompetence` | text | não |  |
| `authorizedBy` | text | sim |  |
| `createdBy` | text | não |  |
| `cancelledAt` | timestamp(3) without time zone | sim |  |
| `cancelledBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, agreementId` → `employee_agreements(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, paymentId` → `payments(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `employee_agreement_charges_agreementId_idx` — `INDEX "employee_agreement_charges_agreementId_idx" USING btree ("agreementId")`
  - `employee_agreement_charges_companyId_id_key` — `UNIQUE INDEX "employee_agreement_charges_companyId_id_key" USING btree ("companyId", id)`
  - `employee_agreement_charges_paymentId_key` — `UNIQUE INDEX "employee_agreement_charges_paymentId_key" USING btree ("paymentId")`
  - `employee_agreement_charges_pkey` — `UNIQUE INDEX employee_agreement_charges_pkey USING btree (id)`
- **Políticas RLS:** 
  - `employee_agreement_charges_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `employee_agreements`

- **Modelo Prisma:** `EmployeeAgreement` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Convênio de funcionário. limitType: FIXED \| SALARY_PERCENT (nulo = segue a política da empresa); status: ACTIVE \| SUSPENDED \| ENDED

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `userId` | text | sim |  |
| `customerId` | text | sim |  |
| `name` | text | não |  |
| `cpf` | text | não |  |
| `registration` | text | sim |  |
| `salary` | numeric(12,2) | sim |  |
| `limitType` | text | sim |  |
| `limitValue` | numeric(12,2) | sim |  |
| `status` | text | não | `'ACTIVE'::text` |
| `notes` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `allowedBranchIds` | text[] | não | `ARRAY[]::text[]` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `employee_agreements_companyId_cpf_key` — `UNIQUE INDEX "employee_agreements_companyId_cpf_key" USING btree ("companyId", cpf)`
  - `employee_agreements_companyId_id_key` — `UNIQUE INDEX "employee_agreements_companyId_id_key" USING btree ("companyId", id)`
  - `employee_agreements_pkey` — `UNIQUE INDEX employee_agreements_pkey USING btree (id)`
- **Políticas RLS:** 
  - `employee_agreements_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `employee_payroll_deductions`

- **Modelo Prisma:** `EmployeePayrollDeduction` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Parcela prevista em folha. status: SCHEDULED \| DEDUCTED \| CANCELLED

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `chargeId` | text | não |  |
| `agreementId` | text | não |  |
| `installmentNumber` | integer | não |  |
| `competence` | text | não |  |
| `amount` | numeric(12,2) | não |  |
| `status` | text | não | `'SCHEDULED'::text` |
| `processedAt` | timestamp(3) without time zone | sim |  |
| `processedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, chargeId` → `employee_agreement_charges(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `employee_payroll_deductions_agreement_competence_idx` — `INDEX employee_payroll_deductions_agreement_competence_idx USING btree ("agreementId", competence)`
  - `employee_payroll_deductions_charge_installment` — `UNIQUE INDEX employee_payroll_deductions_charge_installment USING btree ("chargeId", "installmentNumber")`
  - `employee_payroll_deductions_companyId_idx` — `INDEX "employee_payroll_deductions_companyId_idx" USING btree ("companyId")`
  - `employee_payroll_deductions_pkey` — `UNIQUE INDEX employee_payroll_deductions_pkey USING btree (id)`
- **Políticas RLS:** 
  - `employee_payroll_deductions_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `mechanic_commissions`

- **Modelo Prisma:** `MechanicCommission` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/mechanicId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `serviceOrderId` | text | não |  |
| `mechanicId` | text | não |  |
| `ruleSnapshot` | jsonb | não |  |
| `baseAmount` | numeric(10,2) | não |  |
| `percentage` | numeric(5,2) | não |  |
| `commissionAmount` | numeric(10,2) | não |  |
| `isPaid` | boolean | não | `false` |
| `paidAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (5):**
  - `mechanic_commissions_companyId_idx` — `INDEX "mechanic_commissions_companyId_idx" USING btree ("companyId")`
  - `mechanic_commissions_isPaid_idx` — `INDEX "mechanic_commissions_isPaid_idx" USING btree ("isPaid")`
  - `mechanic_commissions_mechanicId_idx` — `INDEX "mechanic_commissions_mechanicId_idx" USING btree ("mechanicId")`
  - `mechanic_commissions_pkey` — `UNIQUE INDEX mechanic_commissions_pkey USING btree (id)`
  - `mechanic_commissions_serviceOrderId_idx` — `INDEX "mechanic_commissions_serviceOrderId_idx" USING btree ("serviceOrderId")`
- **Políticas RLS:** 
  - `mechanic_commissions_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND ("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders)))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND ("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders)))`

### Oficina

#### `quote_events`

- **Modelo Prisma:** `QuoteEvent` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico do orçamento: CLOSED \| EXPIRED \| REOPENED.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `quoteId` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `eventType` | text | não |  |
| `fromStatus` | text | sim |  |
| `toStatus` | text | sim |  |
| `reason` | text | sim |  |
| `performedBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, quoteId` → `quotes(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `quote_events_companyId_idx` — `INDEX "quote_events_companyId_idx" USING btree ("companyId")`
  - `quote_events_pkey` — `UNIQUE INDEX quote_events_pkey USING btree (id)`
  - `quote_events_quoteId_idx` — `INDEX "quote_events_quoteId_idx" USING btree ("quoteId")`
- **Políticas RLS:** 
  - `quote_events_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `quote_items`

- **Modelo Prisma:** `QuoteItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** productId is a plain scalar — no FK (unlike most other *_items tables).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `quoteVersionId` | text | não |  |
| `itemType` | "ServiceOrderItemType" | não |  |
| `productId` | text | sim |  |
| `description` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `unitPrice` | numeric(10,2) | não |  |
| `totalPrice` | numeric(10,2) | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `quoteVersionId` → `quote_versions(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `quote_items_pkey` — `UNIQUE INDEX quote_items_pkey USING btree (id)`
  - `quote_items_quoteVersionId_idx` — `INDEX "quote_items_quoteVersionId_idx" USING btree ("quoteVersionId")`
- **Políticas RLS:** 
  - `quote_items_isolation` (ALL, permissive, roles {public}): USING `("quoteVersionId" IN ( SELECT quote_versions.id FROM quote_versions))` · WITH CHECK `("quoteVersionId" IN ( SELECT quote_versions.id FROM quote_versions))`

#### `quote_versions`

- **Modelo Prisma:** `QuoteVersion` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** createdBy is a plain scalar — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `quoteId` | text | não |  |
| `versionNumber` | integer | não |  |
| `laborTotal` | numeric(10,2) | não | `0` |
| `partsTotal` | numeric(10,2) | não | `0` |
| `discountAmount` | numeric(10,2) | não | `0` |
| `totalAmount` | numeric(10,2) | não | `0` |
| `sentAt` | timestamp(3) without time zone | sim |  |
| `isApproved` | boolean | não | `false` |
| `approvedAt` | timestamp(3) without time zone | sim |  |
| `decidedBy` | text | sim |  |
| `decisionNotes` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `quoteId` → `quotes(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `quote_versions_pkey` — `UNIQUE INDEX quote_versions_pkey USING btree (id)`
  - `quote_versions_quoteId_idx` — `INDEX "quote_versions_quoteId_idx" USING btree ("quoteId")`
  - `quote_versions_quoteId_versionNumber_key` — `UNIQUE INDEX "quote_versions_quoteId_versionNumber_key" USING btree ("quoteId", "versionNumber")`
- **Políticas RLS:** 
  - `quote_versions_isolation` (ALL, permissive, roles {public}): USING `("quoteId" IN ( SELECT quotes.id FROM quotes))` · WITH CHECK `("quoteId" IN ( SELECT quotes.id FROM quotes))`

#### `quotes`

- **Modelo Prisma:** `Quote` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId/createdBy are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `customerId` | text | não |  |
| `motorcycleId` | text | não |  |
| `quoteNumber` | integer | não |  |
| `status` | "QuoteStatus" | não | `'DRAFT'::"QuoteStatus"` |
| `validUntil` | timestamp(3) without time zone | sim |  |
| `notes` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `closedAt` | timestamp(3) without time zone | sim |  |
| `closedBy` | text | sim |  |
| `closeReason` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `quotes_branchId_idx` — `INDEX "quotes_branchId_idx" USING btree ("branchId")`
  - `quotes_companyId_id_key` — `UNIQUE INDEX "quotes_companyId_id_key" USING btree ("companyId", id)`
  - `quotes_companyId_quoteNumber_key` — `UNIQUE INDEX "quotes_companyId_quoteNumber_key" USING btree ("companyId", "quoteNumber")`
  - `quotes_customerId_idx` — `INDEX "quotes_customerId_idx" USING btree ("customerId")`
  - `quotes_motorcycleId_idx` — `INDEX "quotes_motorcycleId_idx" USING btree ("motorcycleId")`
  - `quotes_pkey` — `UNIQUE INDEX quotes_pkey USING btree (id)`
  - `quotes_status_idx` — `INDEX quotes_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `quotes_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `service_order_items`

- **Modelo Prisma:** `ServiceOrderItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `serviceOrderId` | text | não |  |
| `itemType` | "ServiceOrderItemType" | não |  |
| `productId` | text | sim |  |
| `description` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `unitPrice` | numeric(10,2) | não |  |
| `totalPrice` | numeric(10,2) | não |  |
| `isCompleted` | boolean | não | `false` |
| `completedAt` | timestamp(3) without time zone | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `productId` → `products(id)` · ao apagar: **SET NULL** · ao atualizar: CASCADE
  - `serviceOrderId` → `service_orders(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `service_order_items_pkey` — `UNIQUE INDEX service_order_items_pkey USING btree (id)`
  - `service_order_items_productId_idx` — `INDEX "service_order_items_productId_idx" USING btree ("productId")`
  - `service_order_items_serviceOrderId_idx` — `INDEX "service_order_items_serviceOrderId_idx" USING btree ("serviceOrderId")`
- **Políticas RLS:** 
  - `service_order_items_isolation` (ALL, permissive, roles {public}): USING `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))` · WITH CHECK `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))`

#### `service_order_status_history`

- **Modelo Prisma:** `ServiceOrderStatusHistory` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** changedBy is a plain scalar — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `serviceOrderId` | text | não |  |
| `fromStatus` | "ServiceOrderStatus" | sim |  |
| `toStatus` | "ServiceOrderStatus" | não |  |
| `changedBy` | text | não |  |
| `changedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `notes` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `serviceOrderId` → `service_orders(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `service_order_status_history_changedAt_idx` — `INDEX "service_order_status_history_changedAt_idx" USING btree ("changedAt")`
  - `service_order_status_history_pkey` — `UNIQUE INDEX service_order_status_history_pkey USING btree (id)`
  - `service_order_status_history_serviceOrderId_idx` — `INDEX "service_order_status_history_serviceOrderId_idx" USING btree ("serviceOrderId")`
- **Políticas RLS:** 
  - `service_order_status_history_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))`
  - `service_order_status_history_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `service_order_status_history_select` (SELECT, permissive, roles {public}): USING `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))`

#### `service_order_warranties`

- **Modelo Prisma:** `ServiceOrderWarranty` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Garantia dada no encerramento da OS. coverage: SERVICE \| PART \| SERVICE_AND_PART; durationUnit: DAYS \| MONTHS \| YEARS. Com prazo e km, vale o que ocorrer primeiro.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `serviceOrderId` | text | não |  |
| `customerId` | text | não |  |
| `motorcycleId` | text | não |  |
| `coverage` | text | não |  |
| `durationValue` | integer | não |  |
| `durationUnit` | text | não |  |
| `kmLimit` | integer | sim |  |
| `startDate` | timestamp(3) without time zone | não |  |
| `validUntil` | timestamp(3) without time zone | não |  |
| `startKm` | numeric(10,1) | sim |  |
| `kmUntil` | numeric(10,1) | sim |  |
| `coveredItems` | jsonb | sim |  |
| `conditions` | text | sim |  |
| `notes` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (7):**
  - `service_order_warranties_companyId_id_key` — `UNIQUE INDEX "service_order_warranties_companyId_id_key" USING btree ("companyId", id)`
  - `service_order_warranties_companyId_serviceOrderId_key` — `UNIQUE INDEX "service_order_warranties_companyId_serviceOrderId_key" USING btree ("companyId", "serviceOrderId")`
  - `service_order_warranties_companyId_validUntil_idx` — `INDEX "service_order_warranties_companyId_validUntil_idx" USING btree ("companyId", "validUntil")`
  - `service_order_warranties_customerId_idx` — `INDEX "service_order_warranties_customerId_idx" USING btree ("customerId")`
  - `service_order_warranties_motorcycleId_idx` — `INDEX "service_order_warranties_motorcycleId_idx" USING btree ("motorcycleId")`
  - `service_order_warranties_pkey` — `UNIQUE INDEX service_order_warranties_pkey USING btree (id)`
  - `service_order_warranties_serviceOrderId_key` — `UNIQUE INDEX "service_order_warranties_serviceOrderId_key" USING btree ("serviceOrderId")`
- **Políticas RLS:** 
  - `service_order_warranties_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `service_orders`

- **Modelo Prisma:** `ServiceOrder` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/branchId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `osNumber` | integer | não |  |
| `customerId` | text | não |  |
| `motorcycleId` | text | não |  |
| `status` | "ServiceOrderStatus" | não | `'ENTRADA'::"ServiceOrderStatus"` |
| `entryDate` | timestamp(3) without time zone | não |  |
| `entryKilometer` | numeric(10,1) | não |  |
| `estimatedDelivery` | timestamp(3) without time zone | sim |  |
| `deliveryDate` | timestamp(3) without time zone | sim |  |
| `exitKilometer` | numeric(10,1) | sim |  |
| `fuelLevel` | text | sim |  |
| `visibleDamages` | text | sim |  |
| `personalItems` | text | sim |  |
| `entryNotes` | text | sim |  |
| `diagnosticNotes` | text | sim |  |
| `mechanicId` | text | sim |  |
| `mechanicStartedAt` | timestamp(3) without time zone | sim |  |
| `mechanicCompletedAt` | timestamp(3) without time zone | sim |  |
| `laborTotal` | numeric(10,2) | não | `0` |
| `partsTotal` | numeric(10,2) | não | `0` |
| `discountAmount` | numeric(10,2) | não | `0` |
| `finalTotal` | numeric(10,2) | não |  |
| `isPaid` | boolean | não | `false` |
| `paidAt` | timestamp(3) without time zone | sim |  |
| `paymentMethod` | "PaymentMethod" | sim |  |
| `cancelReason` | text | sim |  |
| `cancelledAt` | timestamp(3) without time zone | sim |  |
| `cancelledBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `quoteVersionId` | text | sim |  |
| `warrantyDecision` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, customerId` → `customers(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `mechanicId` → `users(id)` · ao apagar: **SET NULL** · ao atualizar: CASCADE
  - `quoteVersionId` → `quote_versions(id)` · ao apagar: **SET NULL** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (10):**
  - `service_orders_branchId_idx` — `INDEX "service_orders_branchId_idx" USING btree ("branchId")`
  - `service_orders_branchId_osNumber_key` — `UNIQUE INDEX "service_orders_branchId_osNumber_key" USING btree ("branchId", "osNumber")`
  - `service_orders_companyId_id_key` — `UNIQUE INDEX "service_orders_companyId_id_key" USING btree ("companyId", id)`
  - `service_orders_customerId_idx` — `INDEX "service_orders_customerId_idx" USING btree ("customerId")`
  - `service_orders_entryDate_idx` — `INDEX "service_orders_entryDate_idx" USING btree ("entryDate")`
  - `service_orders_mechanicId_idx` — `INDEX "service_orders_mechanicId_idx" USING btree ("mechanicId")`
  - `service_orders_motorcycleId_idx` — `INDEX "service_orders_motorcycleId_idx" USING btree ("motorcycleId")`
  - `service_orders_pkey` — `UNIQUE INDEX service_orders_pkey USING btree (id)`
  - `service_orders_quoteVersionId_key` — `UNIQUE INDEX "service_orders_quoteVersionId_key" USING btree ("quoteVersionId")`
  - `service_orders_status_idx` — `INDEX service_orders_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `service_orders_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
- **Triggers:**
  - `service_orders_mechanic_same_company`: `BEFORE INSERT OR UPDATE OF "mechanicId", "companyId" FOR EACH ROW EXECUTE FUNCTION enforce_same_company_ref('users', 'mechanicId')`

#### `vehicle_entry_checklist_items`

- **Modelo Prisma:** `VehicleEntryChecklistItem` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `checklistId` | text | não |  |
| `itemName` | text | não |  |
| `status` | "ChecklistItemStatus" | não | `'NOT_CHECKED'::"ChecklistItemStatus"` |
| `description` | text | sim |  |
| `photoUrl` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `checklistId` → `vehicle_entry_checklists(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `vehicle_entry_checklist_items_checklistId_idx` — `INDEX "vehicle_entry_checklist_items_checklistId_idx" USING btree ("checklistId")`
  - `vehicle_entry_checklist_items_pkey` — `UNIQUE INDEX vehicle_entry_checklist_items_pkey USING btree (id)`
- **Políticas RLS:** 
  - `vehicle_entry_checklist_items_isolation` (ALL, permissive, roles {public}): USING `("checklistId" IN ( SELECT vehicle_entry_checklists.id FROM vehicle_entry_checklists))` · WITH CHECK `("checklistId" IN ( SELECT vehicle_entry_checklists.id FROM vehicle_entry_checklists))`

#### `vehicle_entry_checklists`

- **Modelo Prisma:** `VehicleEntryChecklist` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** companyId/checkedBy are plain scalars — no FK. serviceOrderId is unique, making this a 1:1 with ServiceOrder.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `serviceOrderId` | text | não |  |
| `motorcycleId` | text | não |  |
| `checkedBy` | text | não |  |
| `checkedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, motorcycleId` → `motorcycles(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (5):**
  - `vehicle_entry_checklists_companyId_idx` — `INDEX "vehicle_entry_checklists_companyId_idx" USING btree ("companyId")`
  - `vehicle_entry_checklists_companyId_serviceOrderId_key` — `UNIQUE INDEX "vehicle_entry_checklists_companyId_serviceOrderId_key" USING btree ("companyId", "serviceOrderId")`
  - `vehicle_entry_checklists_motorcycleId_idx` — `INDEX "vehicle_entry_checklists_motorcycleId_idx" USING btree ("motorcycleId")`
  - `vehicle_entry_checklists_pkey` — `UNIQUE INDEX vehicle_entry_checklists_pkey USING btree (id)`
  - `vehicle_entry_checklists_serviceOrderId_key` — `UNIQUE INDEX "vehicle_entry_checklists_serviceOrderId_key" USING btree ("serviceOrderId")`
- **Políticas RLS:** 
  - `vehicle_entry_checklists_isolation` (ALL, permissive, roles {public}): USING `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))` · WITH CHECK `("serviceOrderId" IN ( SELECT service_orders.id FROM service_orders))`

#### `warranty_claims`

- **Modelo Prisma:** `WarrantyClaim` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Ocorrência de garantia vinculada à OS original. status: OPEN \| ACCEPTED \| REJECTED \| RESOLVED

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `warrantyId` | text | não |  |
| `serviceOrderId` | text | não |  |
| `newServiceOrderId` | text | sim |  |
| `description` | text | não |  |
| `kmAtClaim` | numeric(10,1) | sim |  |
| `status` | text | não | `'OPEN'::text` |
| `decisionNotes` | text | sim |  |
| `openedBy` | text | não |  |
| `decidedBy` | text | sim |  |
| `decidedAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, newServiceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, warrantyId` → `service_order_warranties(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `warranty_claims_companyId_idx` — `INDEX "warranty_claims_companyId_idx" USING btree ("companyId")`
  - `warranty_claims_pkey` — `UNIQUE INDEX warranty_claims_pkey USING btree (id)`
  - `warranty_claims_warrantyId_idx` — `INDEX "warranty_claims_warrantyId_idx" USING btree ("warrantyId")`
- **Políticas RLS:** 
  - `warranty_claims_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Fiscal

#### `fiscal_configs`

- **Modelo Prisma:** `FiscalConfig` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `nfceEnabled` | boolean | não | `false` |
| `nfceSeriesNumber` | integer | não | `1` |
| `nfceNextNumber` | integer | não | `1` |
| `nfeEnabled` | boolean | não | `false` |
| `nfeSeriesNumber` | integer | não | `1` |
| `nfeNextNumber` | integer | não | `1` |
| `certificatePath` | text | sim |  |
| `certificatePassword` | text | sim |  |
| `cscId` | text | sim |  |
| `cscToken` | text | sim |  |
| `environment` | text | não | `'HOMOLOGACAO'::text` |
| `cancelTimeLimit` | integer | não | `24` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `fiscal_configs_branchId_idx` — `INDEX "fiscal_configs_branchId_idx" USING btree ("branchId")`
  - `fiscal_configs_companyId_branchId_key` — `UNIQUE INDEX "fiscal_configs_companyId_branchId_key" USING btree ("companyId", "branchId")`
  - `fiscal_configs_companyId_idx` — `INDEX "fiscal_configs_companyId_idx" USING btree ("companyId")`
  - `fiscal_configs_pkey` — `UNIQUE INDEX fiscal_configs_pkey USING btree (id)`
- **Políticas RLS:** 
  - `fiscal_configs_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `fiscal_documents`

- **Modelo Prisma:** `FiscalDocument` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** saleId/serviceOrderId are plain scalars — no FK.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `documentType` | "FiscalDocumentType" | não |  |
| `status` | "FiscalDocumentStatus" | não | `'DRAFT'::"FiscalDocumentStatus"` |
| `series` | text | não |  |
| `number` | integer | não |  |
| `accessKey` | text | sim |  |
| `authorizationProtocol` | text | sim |  |
| `saleId` | text | sim |  |
| `serviceOrderId` | text | sim |  |
| `totalAmount` | numeric(10,2) | não |  |
| `xmlUrl` | text | sim |  |
| `pdfUrl` | text | sim |  |
| `qrCode` | text | sim |  |
| `issuedAt` | timestamp(3) without time zone | sim |  |
| `authorizedAt` | timestamp(3) without time zone | sim |  |
| `cancelledAt` | timestamp(3) without time zone | sim |  |
| `cancelReason` | text | sim |  |
| `rejectionReason` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, serviceOrderId` → `service_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (9):**
  - `fiscal_documents_accessKey_key` — `UNIQUE INDEX "fiscal_documents_accessKey_key" USING btree ("accessKey")`
  - `fiscal_documents_branchId_idx` — `INDEX "fiscal_documents_branchId_idx" USING btree ("branchId")`
  - `fiscal_documents_companyId_branchId_documentType_series_num_key` — `UNIQUE INDEX "fiscal_documents_companyId_branchId_documentType_series_num_key" USING btree ("companyId", "branchId", "documentType", series, number)`
  - `fiscal_documents_companyId_idx` — `INDEX "fiscal_documents_companyId_idx" USING btree ("companyId")`
  - `fiscal_documents_issuedAt_idx` — `INDEX "fiscal_documents_issuedAt_idx" USING btree ("issuedAt")`
  - `fiscal_documents_pkey` — `UNIQUE INDEX fiscal_documents_pkey USING btree (id)`
  - `fiscal_documents_saleId_idx` — `INDEX "fiscal_documents_saleId_idx" USING btree ("saleId")`
  - `fiscal_documents_serviceOrderId_idx` — `INDEX "fiscal_documents_serviceOrderId_idx" USING btree ("serviceOrderId")`
  - `fiscal_documents_status_idx` — `INDEX fiscal_documents_status_idx USING btree (status)`
- **Políticas RLS:** 
  - `fiscal_documents_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Canais e integração

#### `channel_api_credentials`

- **Modelo Prisma:** `ChannelApiCredential` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Credencial que um CANAL usa para chamar o CÓRTEX (servidor → servidor, assinatura HMAC por requisição). NÃO é a credencial que o CÓRTEX usa num provedor (essa é `SalesChannel.credentialsEncrypted`). O segredo é cifrado (`enc:v1`) porque o HMAC precisa dele; aparece UMA vez, na criação, e nunca mais é devolvido. A empresa e a filial do canal vêm daqui, nunca da requisição.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `keyId` | text | não |  |
| `secretEncrypted` | text | não |  |
| `secretHint` | text | não |  |
| `label` | text | não |  |
| `scopes` | "ChannelCredentialScope"[] | sim |  |
| `expiresAt` | timestamp(3) without time zone | sim |  |
| `revokedAt` | timestamp(3) without time zone | sim |  |
| `revokedBy` | text | sim |  |
| `lastUsedAt` | timestamp(3) without time zone | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `channel_api_credentials_channelId_idx` — `INDEX "channel_api_credentials_channelId_idx" USING btree ("channelId")`
  - `channel_api_credentials_companyId_idx` — `INDEX "channel_api_credentials_companyId_idx" USING btree ("companyId")`
  - `channel_api_credentials_keyId_key` — `UNIQUE INDEX "channel_api_credentials_keyId_key" USING btree ("keyId")`
  - `channel_api_credentials_pkey` — `UNIQUE INDEX channel_api_credentials_pkey USING btree (id)`
- **Políticas RLS:** 
  - `channel_api_credentials_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `channel_events`

- **Modelo Prisma:** `ChannelEvent` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Registro de acontecimentos do canal (configuração, teste de conexão, webhook recusado, pedido recebido, erro). Sem segredo.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `type` | text | não |  |
| `level` | text | não | `'INFO'::text` |
| `message` | text | não |  |
| `correlationId` | text | sim |  |
| `actorId` | text | sim |  |
| `data` | jsonb | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `channel_events_channelId_createdAt_idx` — `INDEX "channel_events_channelId_createdAt_idx" USING btree ("channelId", "createdAt")`
  - `channel_events_companyId_createdAt_idx` — `INDEX "channel_events_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `channel_events_pkey` — `UNIQUE INDEX channel_events_pkey USING btree (id)`
- **Políticas RLS:** 
  - `channel_events_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `channel_inbound_events`

- **Modelo Prisma:** `ChannelInboundEvent` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Idempotência e anti-repetição de eventos/webhooks: (canal, evento externo, operação) é único.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `externalEventId` | text | não |  |
| `operation` | text | não |  |
| `outcome` | text | não |  |
| `receivedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `payload` | jsonb | sim |  |
| `occurredAt` | timestamp(3) without time zone | sim |  |
| `orderRef` | text | sim |  |
| `correlationId` | text | sim |  |
| `attempts` | integer | não | `0` |
| `processedAt` | timestamp(3) without time zone | sim |  |
| `lastError` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (5):**
  - `channel_inbound_events_channelId_externalEventId_operation_key` — `UNIQUE INDEX "channel_inbound_events_channelId_externalEventId_operation_key" USING btree ("channelId", "externalEventId", operation)`
  - `channel_inbound_events_channelId_orderRef_outcome_idx` — `INDEX "channel_inbound_events_channelId_orderRef_outcome_idx" USING btree ("channelId", "orderRef", outcome)`
  - `channel_inbound_events_companyId_receivedAt_idx` — `INDEX "channel_inbound_events_companyId_receivedAt_idx" USING btree ("companyId", "receivedAt")`
  - `channel_inbound_events_outcome_receivedAt_idx` — `INDEX "channel_inbound_events_outcome_receivedAt_idx" USING btree (outcome, "receivedAt")`
  - `channel_inbound_events_pkey` — `UNIQUE INDEX channel_inbound_events_pkey USING btree (id)`
- **Políticas RLS:** 
  - `channel_inbound_events_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `channel_outbox`

- **Modelo Prisma:** `ChannelOutbox` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `type` | text | não |  |
| `dedupeKey` | text | não |  |
| `payload` | jsonb | não |  |
| `status` | "ChannelOutboxStatus" | não | `'PENDING'::"ChannelOutboxStatus"` |
| `attempts` | integer | não | `0` |
| `maxAttempts` | integer | não | `8` |
| `nextAttemptAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `deadlineAt` | timestamp(3) without time zone | não |  |
| `lockedAt` | timestamp(3) without time zone | sim |  |
| `sentAt` | timestamp(3) without time zone | sim |  |
| `lastError` | text | sim |  |
| `lastErrorKind` | text | sim |  |
| `correlationId` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `channel_outbox_attempts_check`: `CHECK (((attempts >= 0) AND ("maxAttempts" >= 1)))`
- **Índices (4):**
  - `channel_outbox_channelId_dedupeKey_key` — `UNIQUE INDEX "channel_outbox_channelId_dedupeKey_key" USING btree ("channelId", "dedupeKey")`
  - `channel_outbox_companyId_channelId_status_idx` — `INDEX "channel_outbox_companyId_channelId_status_idx" USING btree ("companyId", "channelId", status)`
  - `channel_outbox_pkey` — `UNIQUE INDEX channel_outbox_pkey USING btree (id)`
  - `channel_outbox_status_nextAttemptAt_idx` — `INDEX "channel_outbox_status_nextAttemptAt_idx" USING btree (status, "nextAttemptAt")`
- **Políticas RLS:** 
  - `channel_outbox_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `channel_product_links`

- **Modelo Prisma:** `ChannelProductLink` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Publicação de um produto para um canal. O CÓRTEX continua sendo o mestre do catálogo: aqui só há o vínculo e o estado (nada é público até ser publicado). Não há cópia do produto.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `productId` | text | não |  |
| `published` | boolean | não | `false` |
| `externalId` | text | sim |  |
| `publishedAt` | timestamp(3) without time zone | sim |  |
| `publishedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `channel_product_links_channelId_productId_key` — `UNIQUE INDEX "channel_product_links_channelId_productId_key" USING btree ("channelId", "productId")`
  - `channel_product_links_channelId_published_idx` — `INDEX "channel_product_links_channelId_published_idx" USING btree ("channelId", published)`
  - `channel_product_links_companyId_idx` — `INDEX "channel_product_links_companyId_idx" USING btree ("companyId")`
  - `channel_product_links_pkey` — `UNIQUE INDEX channel_product_links_pkey USING btree (id)`
- **Políticas RLS:** 
  - `channel_product_links_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `external_order_items`

- **Modelo Prisma:** `ExternalOrderItem` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Linha de um pedido externo, já resolvida contra o catálogo do CÓRTEX (produto, preço oficial). Imutável depois de criada.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `orderId` | text | não |  |
| `productId` | text | não |  |
| `sku` | text | não |  |
| `name` | text | não |  |
| `quantity` | numeric(10,3) | não |  |
| `channelUnitPrice` | numeric(10,2) | não |  |
| `unitPrice` | numeric(10,2) | não |  |
| `lineTotal` | numeric(12,2) | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, orderId` → `external_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, productId` → `products(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `external_order_items_prices_nonnegative`: `CHECK ((("unitPrice" >= (0)::numeric) AND ("channelUnitPrice" >= (0)::numeric) AND ("lineTotal" >= (0)::numeric)))`
  - check `external_order_items_quantity_positive`: `CHECK ((quantity > (0)::numeric))`
- **Índices (4):**
  - `external_order_items_companyId_idx` — `INDEX "external_order_items_companyId_idx" USING btree ("companyId")`
  - `external_order_items_orderId_idx` — `INDEX "external_order_items_orderId_idx" USING btree ("orderId")`
  - `external_order_items_pkey` — `UNIQUE INDEX external_order_items_pkey USING btree (id)`
  - `external_order_items_productId_idx` — `INDEX "external_order_items_productId_idx" USING btree ("productId")`
- **Políticas RLS:** 
  - `external_order_items_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `external_orders`

- **Modelo Prisma:** `ExternalOrder` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Pedido recebido de um canal. A chave (canal, pedido externo) é única: o mesmo pedido recebido de novo não cria outro.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `externalOrderId` | text | não |  |
| `status` | "ExternalOrderStatus" | não | `'RECEIVED'::"ExternalOrderStatus"` |
| `paymentStatus` | "ExternalPaymentStatus" | não | `'UNKNOWN'::"ExternalPaymentStatus"` |
| `saleId` | text | sim |  |
| `payload` | jsonb | não |  |
| `receivedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `channelTotal` | numeric(12,2) | sim |  |
| `correlationId` | text | sim |  |
| `source` | text | não | `'WEBHOOK'::text` |
| `statusChangedAt` | timestamp(3) without time zone | sim |  |
| `statusReason` | text | sim |  |
| `totalAmount` | numeric(12,2) | sim |  |
| `acceptedAt` | timestamp(3) without time zone | sim |  |
| `acceptedBy` | text | sim |  |
| `convertedAt` | timestamp(3) without time zone | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `external_orders_channelId_externalOrderId_key` — `UNIQUE INDEX "external_orders_channelId_externalOrderId_key" USING btree ("channelId", "externalOrderId")`
  - `external_orders_companyId_id_key` — `UNIQUE INDEX "external_orders_companyId_id_key" USING btree ("companyId", id)`
  - `external_orders_companyId_receivedAt_idx` — `INDEX "external_orders_companyId_receivedAt_idx" USING btree ("companyId", "receivedAt")`
  - `external_orders_companyId_saleId_key` — `UNIQUE INDEX "external_orders_companyId_saleId_key" USING btree ("companyId", "saleId")`
  - `external_orders_pkey` — `UNIQUE INDEX external_orders_pkey USING btree (id)`
  - `external_orders_saleId_key` — `UNIQUE INDEX "external_orders_saleId_key" USING btree ("saleId")`
- **Políticas RLS:** 
  - `external_orders_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `external_payments`

- **Modelo Prisma:** `ExternalPayment` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Pagamento de um pedido externo — separado do pedido e da venda. `providerRef` único por canal impede o mesmo pagamento duas vezes. Hoje o CÓRTEX só RECEBE eventos de pagamento (informados pelo canal/provedor); não cobra.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `channelId` | text | não |  |
| `orderId` | text | não |  |
| `providerRef` | text | não |  |
| `status` | "ExternalPaymentStatus" | não | `'PENDING'::"ExternalPaymentStatus"` |
| `amount` | numeric(12,2) | não |  |
| `source` | text | não | `'CHANNEL_REPORTED'::text` |
| `lastEventAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `method` | "PaymentMethod" | não | `'OTHER'::"PaymentMethod"` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, channelId` → `sales_channels(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, orderId` → `external_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `external_payments_amount_nonnegative`: `CHECK ((amount >= (0)::numeric))`
- **Índices (4):**
  - `external_payments_channelId_providerRef_key` — `UNIQUE INDEX "external_payments_channelId_providerRef_key" USING btree ("channelId", "providerRef")`
  - `external_payments_companyId_status_idx` — `INDEX "external_payments_companyId_status_idx" USING btree ("companyId", status)`
  - `external_payments_orderId_idx` — `INDEX "external_payments_orderId_idx" USING btree ("orderId")`
  - `external_payments_pkey` — `UNIQUE INDEX external_payments_pkey USING btree (id)`
- **Políticas RLS:** 
  - `external_payments_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `fulfillments`

- **Modelo Prisma:** `Fulfillment` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Entrega física do que foi vendido — separada da venda (uma venda existe sem o fulfillment concluído). Nasce `PENDING` na conversão do pedido em venda. O tipo (retirada, entrega própria, entrega do canal) fica nulo até a regra de produto existir (DECISIONS 91).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | não |  |
| `orderId` | text | não |  |
| `saleId` | text | não |  |
| `type` | "FulfillmentType" | sim |  |
| `status` | "FulfillmentStatus" | não | `'PENDING'::"FulfillmentStatus"` |
| `statusChangedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `statusChangedBy` | text | sim |  |
| `notes` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, orderId` → `external_orders(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, saleId` → `sales(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (6):**
  - `fulfillments_companyId_orderId_key` — `UNIQUE INDEX "fulfillments_companyId_orderId_key" USING btree ("companyId", "orderId")`
  - `fulfillments_companyId_saleId_key` — `UNIQUE INDEX "fulfillments_companyId_saleId_key" USING btree ("companyId", "saleId")`
  - `fulfillments_companyId_status_idx` — `INDEX "fulfillments_companyId_status_idx" USING btree ("companyId", status)`
  - `fulfillments_orderId_key` — `UNIQUE INDEX "fulfillments_orderId_key" USING btree ("orderId")`
  - `fulfillments_pkey` — `UNIQUE INDEX fulfillments_pkey USING btree (id)`
  - `fulfillments_saleId_key` — `UNIQUE INDEX "fulfillments_saleId_key" USING btree ("saleId")`
- **Políticas RLS:** 
  - `fulfillments_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `sales_channels`

- **Modelo Prisma:** `SalesChannel` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Canal de venda configurado por empresa (`branchId` nulo = todas as filiais). Venda sem canal = loja física. Credencial só cifrada (`enc:v1`, mesma chave dos segredos fiscais) e nunca devolvida pela API; `type` não muda depois de criado.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `type` | "SalesChannelType" | não |  |
| `displayName` | text | não |  |
| `isActive` | boolean | não | `false` |
| `provider` | text | sim |  |
| `connectionStatus` | "ChannelConnectionStatus" | não | `'NOT_CONFIGURED'::"ChannelConnectionStatus"` |
| `lastSyncAt` | timestamp(3) without time zone | sim |  |
| `lastError` | text | sim |  |
| `externalAccountId` | text | sim |  |
| `config` | jsonb | sim |  |
| `credentialsEncrypted` | text | sim |  |
| `credentialsHint` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |
| `inboundCursor` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `sales_channels_companyId_branchId_idx` — `INDEX "sales_channels_companyId_branchId_idx" USING btree ("companyId", "branchId")`
  - `sales_channels_companyId_id_key` — `UNIQUE INDEX "sales_channels_companyId_id_key" USING btree ("companyId", id)`
  - `sales_channels_companyId_idx` — `INDEX "sales_channels_companyId_idx" USING btree ("companyId")`
  - `sales_channels_pkey` — `UNIQUE INDEX sales_channels_pkey USING btree (id)`
- **Políticas RLS:** 
  - `sales_channels_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Ajuda e Suporte

#### `support_kb_articles`

- **Modelo Prisma:** `SupportKbArticle` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 2 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** — (sem comentário no modelo; ver a seção do domínio em §2)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `categoryId` | text | não |  |
| `slug` | text | não |  |
| `title` | text | não |  |
| `summary` | text | sim |  |
| `body` | text | não |  |
| `keywords` | text | sim |  |
| `module` | text | sim |  |
| `status` | text | não | `'DRAFT'::text` |
| `authorId` | text | não |  |
| `authorName` | text | não |  |
| `publishedAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `search` | tsvector | sim | `((setweight(to_tsvector('portuguese'::regconfig, COALESCE(title, ''::text)), 'A'::"char") \|\| setweight(to_tsvector('portuguese'::regconfig, ((COALESCE(summary, ''::text) \|\| ' '::text) \|\| COALESCE(keywords, ''::text))), 'B'::"char")) \|\| setweight(to_tsvector('portuguese'::regconfig, COALESCE(body, ''::text)), 'C'::"char"))` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `categoryId` → `support_kb_categories(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `support_kb_articles_status_check`: `CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text])))`
- **Índices (4):**
  - `support_kb_articles_categoryId_status_idx` — `INDEX "support_kb_articles_categoryId_status_idx" USING btree ("categoryId", status)`
  - `support_kb_articles_pkey` — `UNIQUE INDEX support_kb_articles_pkey USING btree (id)`
  - `support_kb_articles_search_idx` — `INDEX support_kb_articles_search_idx USING gin (search)`
  - `support_kb_articles_slug_key` — `UNIQUE INDEX support_kb_articles_slug_key USING btree (slug)`
- **Políticas RLS:** 
  - `support_kb_articles_read` (SELECT, permissive, roles {public}): USING `((status = 'PUBLISHED'::text) OR ( SELECT app_ctx.is_super_admin() AS is_super_admin))`
  - `support_kb_articles_write` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `support_kb_categories`

- **Modelo Prisma:** `SupportKbCategory` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 2 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Base de conhecimento (global, do produto): leitura para todos os usuários logados, escrita só da plataforma.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `slug` | text | não |  |
| `name` | text | não |  |
| `sortOrder` | integer | não | `0` |
| `isActive` | boolean | não | `true` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (2):**
  - `support_kb_categories_pkey` — `UNIQUE INDEX support_kb_categories_pkey USING btree (id)`
  - `support_kb_categories_slug_key` — `UNIQUE INDEX support_kb_categories_slug_key USING btree (slug)`
- **Políticas RLS:** 
  - `support_kb_categories_read` (SELECT, permissive, roles {public}): USING `true`
  - `support_kb_categories_write` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `support_ticket_attachments`

- **Modelo Prisma:** `SupportTicketAttachment` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Anexo guardado no banco (sob RLS), baixado só por rota autorizada. Remoção é lógica.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `ticketId` | text | não |  |
| `messageId` | text | sim |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `fileName` | text | não |  |
| `mimeType` | text | não |  |
| `size` | integer | não |  |
| `sha256` | text | não |  |
| `data` | bytea | não |  |
| `uploadedBy` | text | não |  |
| `uploadedByName` | text | não |  |
| `removedAt` | timestamp(3) without time zone | sim |  |
| `removedBy` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, messageId` → `support_ticket_messages(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, ticketId` → `support_tickets(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `support_ticket_attachments_mime_check`: `CHECK (("mimeType" = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'application/pdf'::text, 'text/plain'::text])))`
  - check `support_ticket_attachments_size_check`: `CHECK (((size > 0) AND (size <= 2097152)))`
- **Índices (3):**
  - `support_ticket_attachments_companyId_idx` — `INDEX "support_ticket_attachments_companyId_idx" USING btree ("companyId")`
  - `support_ticket_attachments_pkey` — `UNIQUE INDEX support_ticket_attachments_pkey USING btree (id)`
  - `support_ticket_attachments_ticketId_idx` — `INDEX "support_ticket_attachments_ticketId_idx" USING btree ("ticketId")`
- **Políticas RLS:** 
  - `support_ticket_attachments_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `support_ticket_events`

- **Modelo Prisma:** `SupportTicketEvent` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico imutável do chamado (abertura, status, atribuição, prioridade, anexos, reabertura, encerramento).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `ticketId` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `type` | text | não |  |
| `fromValue` | text | sim |  |
| `toValue` | text | sim |  |
| `actorId` | text | não |  |
| `actorName` | text | não |  |
| `actorRole` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, ticketId` → `support_tickets(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `support_ticket_events_companyId_idx` — `INDEX "support_ticket_events_companyId_idx" USING btree ("companyId")`
  - `support_ticket_events_pkey` — `UNIQUE INDEX support_ticket_events_pkey USING btree (id)`
  - `support_ticket_events_ticketId_createdAt_idx` — `INDEX "support_ticket_events_ticketId_createdAt_idx" USING btree ("ticketId", "createdAt")`
- **Políticas RLS:** 
  - `support_ticket_events_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `support_ticket_events_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `support_ticket_events_read` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `support_ticket_messages`

- **Modelo Prisma:** `SupportTicketMessage` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Mensagem do chamado — só cresce (sem edição nem exclusão pela aplicação).

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `ticketId` | text | não |  |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `authorId` | text | não |  |
| `authorName` | text | não |  |
| `authorRole` | text | não |  |
| `body` | text | não |  |
| `statusFrom` | text | sim |  |
| `statusTo` | text | sim |  |
| `source` | text | não | `'ADMIN_WEB'::text` |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, ticketId` → `support_tickets(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `support_ticket_messages_role_check`: `CHECK (("authorRole" = ANY (ARRAY['REQUESTER'::text, 'COMPANY'::text, 'SUPPORT'::text])))`
- **Índices (3):**
  - `support_ticket_messages_companyId_id_key` — `UNIQUE INDEX "support_ticket_messages_companyId_id_key" USING btree ("companyId", id)`
  - `support_ticket_messages_pkey` — `UNIQUE INDEX support_ticket_messages_pkey USING btree (id)`
  - `support_ticket_messages_ticketId_createdAt_idx` — `INDEX "support_ticket_messages_ticketId_createdAt_idx" USING btree ("ticketId", "createdAt")`
- **Políticas RLS:** 
  - `support_ticket_messages_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`
  - `support_ticket_messages_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `support_ticket_messages_read` (SELECT, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

#### `support_tickets`

- **Modelo Prisma:** `SupportTicket` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Central de Ajuda e Suporte (2026-09-28). Chamado aberto por usuário de empresa; atendido pela equipe da plataforma. status: ABERTO \| EM_ANALISE \| AGUARDANDO_USUARIO \| AGUARDANDO_SUPORTE \| RESOLVIDO \| ENCERRADO type/module/priority/source: catálogos em apps/api/src/services/support-catalog.ts (texto validado, sem enum no banco)

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `ticketNumber` | integer | não | `nextval('support_ticket_number_seq'::regclass)` |
| `companyId` | text | não |  |
| `branchId` | text | sim |  |
| `requesterId` | text | não |  |
| `requesterName` | text | não |  |
| `requesterEmail` | text | sim |  |
| `requesterPhone` | text | sim |  |
| `requesterRole` | text | não |  |
| `companyName` | text | sim |  |
| `branchName` | text | sim |  |
| `subject` | text | não |  |
| `module` | text | não |  |
| `type` | text | não |  |
| `priority` | text | não | `'NORMAL'::text` |
| `status` | text | não | `'ABERTO'::text` |
| `description` | text | não |  |
| `source` | text | não | `'ADMIN_WEB'::text` |
| `appVersion` | text | sim |  |
| `context` | jsonb | sim |  |
| `assignedToId` | text | sim |  |
| `assignedToName` | text | sim |  |
| `assignedAt` | timestamp(3) without time zone | sim |  |
| `firstResponseAt` | timestamp(3) without time zone | sim |  |
| `resolvedAt` | timestamp(3) without time zone | sim |  |
| `closedAt` | timestamp(3) without time zone | sim |  |
| `lastMessageAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `lastMessageBy` | text | não | `'REQUESTER'::text` |
| `requesterLastReadAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `supportLastReadAt` | timestamp(3) without time zone | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** 
  - check `support_tickets_last_by_check`: `CHECK (("lastMessageBy" = ANY (ARRAY['REQUESTER'::text, 'COMPANY'::text, 'SUPPORT'::text])))`
  - check `support_tickets_priority_check`: `CHECK ((priority = ANY (ARRAY['BAIXA'::text, 'NORMAL'::text, 'ALTA'::text, 'CRITICA'::text])))`
  - check `support_tickets_status_check`: `CHECK ((status = ANY (ARRAY['ABERTO'::text, 'EM_ANALISE'::text, 'AGUARDANDO_USUARIO'::text, 'AGUARDANDO_SUPORTE'::text, 'RESOLVIDO'::text, 'ENCERRADO'::text])))`
- **Índices (9):**
  - `support_tickets_assignedToId_status_idx` — `INDEX "support_tickets_assignedToId_status_idx" USING btree ("assignedToId", status)`
  - `support_tickets_companyId_branchId_idx` — `INDEX "support_tickets_companyId_branchId_idx" USING btree ("companyId", "branchId")`
  - `support_tickets_companyId_id_key` — `UNIQUE INDEX "support_tickets_companyId_id_key" USING btree ("companyId", id)`
  - `support_tickets_companyId_status_createdAt_idx` — `INDEX "support_tickets_companyId_status_createdAt_idx" USING btree ("companyId", status, "createdAt")`
  - `support_tickets_module_idx` — `INDEX support_tickets_module_idx USING btree (module)`
  - `support_tickets_pkey` — `UNIQUE INDEX support_tickets_pkey USING btree (id)`
  - `support_tickets_requesterId_createdAt_idx` — `INDEX "support_tickets_requesterId_createdAt_idx" USING btree ("requesterId", "createdAt")`
  - `support_tickets_status_createdAt_idx` — `INDEX "support_tickets_status_createdAt_idx" USING btree (status, "createdAt")`
  - `support_tickets_ticketNumber_key` — `UNIQUE INDEX "support_tickets_ticketNumber_key" USING btree ("ticketNumber")`
- **Políticas RLS:** 
  - `support_tickets_isolation` (ALL, permissive, roles {public}): USING `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))` · WITH CHECK `((( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ("companyId" = ( SELECT app_ctx.company_id() AS company_id))) AND (( SELECT app_ctx.is_super_admin() AS is_super_admin) OR ( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("branchId" IS NULL) OR ("branchId" = ANY (( SELECT app_ctx.branch_ids() AS branch_ids)::text[]))))`

### Não classificada

#### `commercial_lead_events`

- **Modelo Prisma:** `CommercialLeadEvent` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Cada mudança de etapa do funil (de onde, para onde, quem, quando): base do tempo em cada etapa e da conversão. Imutável.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `leadId` | text | não |  |
| `fromStage` | text | sim |  |
| `toStage` | text | não |  |
| `actorId` | text | não |  |
| `note` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `leadId` → `commercial_leads(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `commercial_lead_events_leadId_createdAt_idx` — `INDEX "commercial_lead_events_leadId_createdAt_idx" USING btree ("leadId", "createdAt")`
  - `commercial_lead_events_pkey` — `UNIQUE INDEX commercial_lead_events_pkey USING btree (id)`
  - `commercial_lead_events_toStage_createdAt_idx` — `INDEX "commercial_lead_events_toStage_createdAt_idx" USING btree ("toStage", "createdAt")`
- **Políticas RLS:** 
  - `commercial_lead_events_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`
  - `commercial_lead_events_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `commercial_lead_events_select` (SELECT, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `commercial_leads`

- **Modelo Prisma:** `CommercialLead` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Funil comercial da PLATAFORMA (interessado → ... → cliente ativo): uma linha por oportunidade. `companyId` liga a oportunidade à empresa criada na implantação. Só SUPER_ADMIN. Nenhum dado de cliente final: só o nome comercial e uma anotação de contato.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `name` | text | não |  |
| `contact` | text | sim |  |
| `source` | text | sim |  |
| `stage` | text | não | `'INTERESTED'::text` |
| `stageEnteredAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `companyId` | text | sim |  |
| `closedReason` | text | sim |  |
| `createdBy` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `updatedAt` | timestamp(3) without time zone | não |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `commercial_leads_companyId_key` — `UNIQUE INDEX "commercial_leads_companyId_key" USING btree ("companyId")`
  - `commercial_leads_pkey` — `UNIQUE INDEX commercial_leads_pkey USING btree (id)`
  - `commercial_leads_stage_stageEnteredAt_idx` — `INDEX "commercial_leads_stage_stageEnteredAt_idx" USING btree (stage, "stageEnteredAt")`
- **Políticas RLS:** 
  - `commercial_leads_platform` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `external_deliveries`

- **Modelo Prisma:** `ExternalDelivery` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Entrega a um serviço externo (e-mail de alerta, evento de erro): base da deduplicação, dos limites de envio e do painel de consumo. Nunca guarda o conteúdo da mensagem nem segredo; `error` é a mensagem já mascarada. Telemetria com retenção. Só SUPER_ADMIN.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `channel` | text | não |  |
| `status` | text | não |  |
| `dedupeKey` | text | sim |  |
| `alertId` | text | sim |  |
| `error` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `external_deliveries_channel_createdAt_idx` — `INDEX "external_deliveries_channel_createdAt_idx" USING btree (channel, "createdAt")`
  - `external_deliveries_dedupeKey_createdAt_idx` — `INDEX "external_deliveries_dedupeKey_createdAt_idx" USING btree ("dedupeKey", "createdAt")`
  - `external_deliveries_pkey` — `UNIQUE INDEX external_deliveries_pkey USING btree (id)`
- **Políticas RLS:** 
  - `external_deliveries_platform` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `monitoring_alert_events`

- **Modelo Prisma:** `MonitoringAlertEvent` · **Escopo:** empresa · **RLS:** habilitada / forçada · **Policies:** 3 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Histórico de tratamento do alerta (quem, quando, o quê). Imutável: sem UPDATE; DELETE só com o expurgo sinalizado. Só SUPER_ADMIN lê e grava.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `alertId` | text | não |  |
| `companyId` | text | sim |  |
| `kind` | text | não |  |
| `actorId` | text | sim |  |
| `note` | text | sim |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (4):**
  - `monitoring_alert_events_alertId_createdAt_idx` — `INDEX "monitoring_alert_events_alertId_createdAt_idx" USING btree ("alertId", "createdAt")`
  - `monitoring_alert_events_companyId_createdAt_idx` — `INDEX "monitoring_alert_events_companyId_createdAt_idx" USING btree ("companyId", "createdAt")`
  - `monitoring_alert_events_createdAt_idx` — `INDEX "monitoring_alert_events_createdAt_idx" USING btree ("createdAt")`
  - `monitoring_alert_events_pkey` — `UNIQUE INDEX monitoring_alert_events_pkey USING btree (id)`
- **Políticas RLS:** 
  - `monitoring_alert_events_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`
  - `monitoring_alert_events_purge` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) AND (current_setting('app.audit_purge'::text, true) = 'on'::text))`
  - `monitoring_alert_events_select` (SELECT, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `monitoring_settings`

- **Modelo Prisma:** `MonitoringSetting` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Ajustes de runtime do monitoramento (ligar/desligar notificações e coleta não crítica, limites). O ambiente continua sendo o teto: o ajuste só restringe. Só SUPER_ADMIN lê e grava.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `key` | text | não |  |
| `value` | jsonb | não |  |
| `updatedBy` | text | não |  |
| `updatedAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |

- **Chave primária:** `(key)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (1):**
  - `monitoring_settings_pkey` — `UNIQUE INDEX monitoring_settings_pkey USING btree (key)`
- **Políticas RLS:** 
  - `monitoring_settings_platform` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `service_health_samples`

- **Modelo Prisma:** `ServiceHealthSample` · **Escopo:** plataforma/global · **RLS:** habilitada / forçada · **Policies:** 1 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** Amostra periódica da saúde de um serviço da plataforma (disponibilidade, latência, uso do servidor). Telemetria com retenção (MONITORING_SAMPLE_RETENTION_DAYS); coletada pelo job `evaluate-health` no intervalo MONITORING_SAMPLE_MINUTES. Só SUPER_ADMIN.

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `sampledAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `service` | text | não |  |
| `status` | text | não |  |
| `latencyMs` | double precision | sim |  |
| `valuePct` | double precision | sim |  |
| `detail` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** nenhuma (isolamento por RLS, não por FK)
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `service_health_samples_pkey` — `UNIQUE INDEX service_health_samples_pkey USING btree (id)`
  - `service_health_samples_sampledAt_idx` — `INDEX "service_health_samples_sampledAt_idx" USING btree ("sampledAt")`
  - `service_health_samples_service_sampledAt_idx` — `INDEX "service_health_samples_service_sampledAt_idx" USING btree (service, "sampledAt")`
- **Políticas RLS:** 
  - `service_health_samples_platform` (ALL, permissive, roles {public}): USING `( SELECT app_ctx.is_super_admin() AS is_super_admin)` · WITH CHECK `( SELECT app_ctx.is_super_admin() AS is_super_admin)`

#### `user_branches`

- **Modelo Prisma:** `UserBranch` · **Escopo:** empresa+filial · **RLS:** habilitada / forçada · **Policies:** 4 · **Dono:** lnsystem
- **Finalidade (comentário do schema):** branchId is a plain scalar — no FK (unlike User.branchId, which does have one). Filiais ADICIONAIS autorizadas a um usuário de filial (decisão 153). O conjunto autorizado de quem NÃO é de empresa inteira é `users.branchId` (principal) + as linhas desta tabela; é calculado no servidor a cada requisição (nunca vem do cliente) e viaja assinado no contexto da RLS. Só SUPER_ADMIN e COMPANY_ADMIN gravam (RLS); o usuário lê…

| Coluna | Tipo | Nulo | Padrão |
|---|---|---|---|
| `id` | text | não |  |
| `companyId` | text | não |  |
| `userId` | text | não |  |
| `branchId` | text | não |  |
| `createdAt` | timestamp(3) without time zone | não | `CURRENT_TIMESTAMP` |
| `createdBy` | text | sim |  |

- **Chave primária:** `(id)`
- **Chaves estrangeiras:** 
  - `companyId, branchId` → `branches(companyId, id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
  - `companyId` → `companies(id)` · ao apagar: **RESTRICT** · ao atualizar: CASCADE
  - `companyId, userId` → `users(companyId, id)` · ao apagar: **CASCADE** · ao atualizar: CASCADE
- **Únicos e CHECK (constraints):** nenhum
- **Índices (3):**
  - `user_branches_companyId_branchId_idx` — `INDEX "user_branches_companyId_branchId_idx" USING btree ("companyId", "branchId")`
  - `user_branches_pkey` — `UNIQUE INDEX user_branches_pkey USING btree (id)`
  - `user_branches_userId_branchId_key` — `UNIQUE INDEX "user_branches_userId_branchId_key" USING btree ("userId", "branchId")`
- **Políticas RLS:** 
  - `user_branches_delete` (DELETE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `user_branches_insert` (INSERT, permissive, roles {public}): USING `—` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
  - `user_branches_select` (SELECT, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND (( SELECT app_ctx.is_company_wide() AS is_company_wide) OR ("userId" = ( SELECT app_ctx.user_id() AS user_id)))))`
  - `user_branches_update` (UPDATE, permissive, roles {public}): USING `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND ( SELECT app_ctx.is_company_wide() AS is_company_wide)))` · WITH CHECK `(( SELECT app_ctx.is_super_admin() AS is_super_admin) OR (("companyId" = ( SELECT app_ctx.company_id() AS company_id)) AND ( SELECT app_ctx.is_company_wide() AS is_company_wide)))`
- **Triggers:**
  - `user_branches_guard`: `BEFORE INSERT OR UPDATE FOR EACH ROW EXECUTE FUNCTION user_branches_guard()`

<!-- db-docs:end -->
