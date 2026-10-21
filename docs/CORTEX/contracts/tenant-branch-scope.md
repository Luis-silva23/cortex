# Contrato de escopo — empresa (tenant) × filial

Derivado **só do código** em 2026-09-24. Estado final das migrações (`0_init` + `20260914154543_*_rls` +
`20260915110105_*_rls` + `20260921120000_branch_rls_for_derived_financial`, que sobrescreve 4 policies).
Complementa `docs/CORTEX/DATABASE.md` (como aplicar/verificar) e `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md` (E6, E8, F1, F2 — decisões já
registradas são **referenciadas**, não repetidas). Marcas: **[INCONSISTÊNCIA]** = código contradiz a si mesmo ou à RLS;
**[DECISÃO NECESSÁRIA]** = regra de negócio não definida no código.

> **Atualização de 2026-10-05 (o restante deste contrato é de 2026-09-24 e foi mantido).** Tabelas novas desde então, todas com `ENABLE` + `FORCE ROW LEVEL SECURITY`
> e a regra **F** (`rls_company_branch_match("companyId","branchId")`, com `branchId` nulo = todas as filiais): `sales_channels`, `channel_events`, `external_orders`,
> `channel_inbound_events` (migração `20261004200000_sales_channels`) e, desde a Commerce API, `channel_api_credentials`, `channel_product_links`, `external_order_items`,
> `external_payments` (migração `20261005100000_commerce_api_foundation`, mesma regra **F**), e `stock_reservations` e `fulfillments` (migração `20261005200000_stock_reservations_and_channel_sales`, mesma regra **F**), e `channel_outbox` (migração `20261006100000_integration_gateway`, mesma regra **F**). O webhook de provedor usa `userType = 'CHANNEL'` com a empresa e a filial **do canal no banco** (única consulta sem RLS: o canal por id exato). O contexto de canal da Commerce API usa `userType = 'CHANNEL'` com a empresa e a filial **da credencial**
> (nunca da requisição): a função `rls_company_branch_match` o trata como limitado à filial (não é `SUPER_ADMIN` nem empresa inteira). `Sale.channelId` é coluna nova de `sales` (tabela que já era **F**). Os contratos de tabelas
> acima não listam as tabelas criadas depois de 2026-09-24 (políticas, convênios, suporte, devolução ao fornecedor, canais…): a lista completa e atual está nas migrações e em
> `npm run db:check-rls`. A conferência no banco real (2026-10-04: 91 tabelas, 105 policies) **não foi refeita** depois das tabelas de canais.

> **Atualização de 2026-10-16 (finalização — escopo por filial).** Duas migrações novas (`20261016100000_branch_scope_rls`, `20261016110000_privilege_escalation_guards`) e mudanças nas rotas
> fecharam o que o contrato listava como **[DECISÃO NECESSÁRIA]** nas nove tabelas que só isolavam por empresa (`users`, `user_roles`, `partners`, `installment_policies`, `devices`,
> `monitoring_thresholds`, `monitoring_threshold_changes`, `request_logs`, `system_logs`) mais `audit_logs`, `transfers`, `roles`, `permissions`, `role_permissions`, `company_module_settings` e `branches`.
> A regra definida pelo negócio e a matriz por perfil estão na **§9** abaixo; onde uma linha das tabelas da §2 diz o contrário do que a §9 diz, **vale a §9** (as linhas afetadas já foram reescritas).

> **Atualização de 2026-10-15 (missão de segurança e liberação).** Um gerente deixa de ser "de uma filial só": o acesso passa a ser por **conjunto de filiais autorizadas** (nova tabela `user_branches`, migração `20261017110000_user_branches`) e o contexto da RLS passa a ser **assinado** (migração `20261017100000_rls_signed_context`, decisão 151). A regra, a matriz por perfil/empresa/filial e as provas estão na **§10**; onde as §2 e §9 falam em "a própria filial", leia "as filiais autorizadas do usuário" (uma só, no caso comum).

## 1. Mecanismo

### 1.1 Postgres (RLS)
- 60 tabelas, todas com `ENABLE` + `FORCE ROW LEVEL SECURITY`, uma policy `<tabela>_isolation` cada (`USING` + `WITH CHECK`).
  Role `lnsystem` sem SUPERUSER/BYPASSRLS (ver `docs/CORTEX/DATABASE.md` §2).
- GUCs de sessão lidas pelas funções (`0_init/migration.sql:1960-2013`):
  `app.current_company_id` → `get_current_company_id()`, `app.current_branch_id` → `get_current_branch_id()`,
  `app.user_type` → `get_current_user_type()`; string vazia = NULL.
- `is_super_admin()` = `user_type = 'SUPER_ADMIN'`; `is_company_wide_role()` = `user_type IN ('SUPER_ADMIN','COMPANY_ADMIN')`
  (**MANAGER não é empresa inteira**).
- `rls_company_match(c)` = `is_super_admin() OR c = company_atual`.
- `rls_company_branch_match(c, b)` = `rls_company_match(c) AND (is_super_admin() OR is_company_wide_role() OR b IS NULL OR b = filial_atual)`.
- Sem contexto (script/worker fora de `runWithRLSContext`) → GUCs vazias → toda policy de tenant nega (fail-closed).

**Legenda usada nas tabelas abaixo**

| Sigla | Predicado | Quem vê/grava |
| --- | --- | --- |
| **E** | `rls_company_match("companyId")` | qualquer usuário da empresa; SA todas as empresas |
| **F** | `rls_company_branch_match("companyId","branchId")` | SA/COMPANY_ADMIN: todas as filiais da empresa; MANAGER/OPERATOR/MECHANIC/VIEWER: própria filial **+ linhas `branchId NULL`** |
| **H(pai)** | `"fk" IN (SELECT id FROM pai)` | herda a visibilidade do pai (a RLS do pai filtra a subconsulta) |
| **P** | `is_super_admin() OR "companyId" = company_atual [OR "companyId" IS NULL]` | plataforma / linhas globais |

WITH CHECK de **F** também aceita `branchId NULL` → um papel de filial pode **gravar** linha "da empresa toda" em
tabelas com `branchId` anulável (ver §5).

### 1.2 Aplicação
| Peça | Arquivo | Regra |
| --- | --- | --- |
| Contexto RLS por requisição | `apps/api/src/middleware/tenant.ts:75-105` | `companyId`/`branchId`/`userType` vêm **só do JWT** (`req.user`), nunca do corpo/query. Não-SA sem `companyId` → 403. |
| Aplicação das GUCs | `packages/database/src/index.ts:48-73` | cada operação de modelo roda num `$transaction([set_config×3, query])` na mesma conexão. |
| Transações | `packages/database/src/index.ts:102-125` (`runInTransaction`) | `set_config(..., true)` uma vez no início; vale para `tx.$queryRaw/$executeRaw`. `prisma.$transaction` omitido do tipo. |
| Bypass | `prismaUnsafeBypassRLS` (`index.ts:174`) | só `transfer.service.ts:59-63` (valida filiais origem/destino com `set_config` de SA explícito). |
| Filial de gravação | `apps/api/src/utils/branch-context.ts:17-41` (`resolveWriteBranchId`) | usado só por revisions/follow-ups/appointments. |
| Empresa de listagem | `apps/api/src/utils/tenant-scope.ts:16-28` (`resolveListCompanyId`) | usado em products/sales/payments/cash-register (listas). |
| Escopo de cache | `apps/api/src/utils/cache-scope.ts:15-32` | `all` (SA/COMPANY_ADMIN) \| `b:<filial>` \| `b:none` \| `noctx`. |
| SA em rota de empresa | `routes/index.ts:77-112` (`companyScoped()`) + `tenant.ts:32-60` | ver §3. |
| Serviços | `apps/api/src/services/*.service.ts` | padrão `where: { id, companyId }` com `companyId` do token; filial **não** é filtrada no app na maioria dos casos — depende da RLS. |

**FKs de filial:** só `users.branchId` referencia `branches` (`0_init/migration.sql:1466-1468`). Todos os outros
`branchId` são texto solto → a validação "filial pertence à empresa" é **só da aplicação** (e a RLS **F** só a garante
para papéis de filial).

## 2. Matriz por tabela

OWNER = coluna que define o dono. READ/WRITE = escopo efetivo (RLS). "Cache" = chave Redis que contém dados da tabela.

### 2.1 Documentos de filial (RLS por filial)
| Tabela | OWNER | READ / WRITE | RLS | App-layer | Cache | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| `sales` | BRANCH (NOT NULL) | F / F | `sales_isolation` F | `sale.service.ts:55-74` caixa da empresa **e** da mesma filial da venda; `branchId` vem do corpo (`sales.routes.ts:89-94`) | — | Filial validada indiretamente pelo caixa. |
| `sale_items` | herda | H(sales) | `sale_items_isolation` | via venda | — | |
| `payments` | herda da venda | E ∧ H(sales) | `payments_isolation` (migr. 20260921) | lista: `resolveListCompanyId` (`payments.routes.ts:32`) | — | Sem coluna `branchId`. |
| `service_orders` | BRANCH (NOT NULL) | F / F | `service_orders_isolation` F | `service-order.service.ts:28-50` valida cliente/moto da empresa; **não valida `branchId`** | — | ver §6-1 |
| `service_order_items`, `service_order_status_history`, `vehicle_entry_checklists` | herda | H(service_orders) | `*_isolation` | via OS | — | `vehicle_entry_checklists.companyId` existe mas a policy ignora. |
| `vehicle_entry_checklist_items` | herda | H(vehicle_entry_checklists) | idem | — | — | |
| `mechanic_commissions` | herda da OS | E ∧ H(service_orders) | `mechanic_commissions_isolation` (migr. 20260921) | `mechanic.service.ts` | — | Sem `branchId`. E6 (MECHANIC). |
| `quotes` | BRANCH (NOT NULL) | F / F | `quotes_isolation` F | `quote.service.ts:120,415` valida filial na empresa | — | D/E6 do tech-debt. |
| `quote_versions` → `quote_items` | herda | H(quotes) → H(quote_versions) | idem | — | — | |
| `purchase_orders` | BRANCH (NOT NULL) | F / F | `purchase_orders_isolation` F | `purchase-order.service.ts:11-40` valida fornecedor/produtos; **não valida `branchId`**; recebimento/devolução usam `po.branchId` (`:256-262,400-401`) | — | ver §6-1 |
| `purchase_order_items` | herda | H(purchase_orders) | idem | — | — | |
| `cash_registers` | BRANCH (NOT NULL) | F / F | `cash_registers_isolation` F | abrir: `branchId` do corpo (`cash-register.routes.ts:128-137`), **sem validação** em `cash-register.service.ts:13`; leitura/fechamento conferem `requester.branchId` (`cash-register.service.ts:252,334,489`) | `CacheKeys.cashRegister`/`currentCashRegister` **não usados** | F2 "dono do caixa". |
| `cash_movements` | herda | H(cash_registers) | `cash_movements_isolation` | — | — | |
| `inventories` | BRANCH (NOT NULL) | F / F | `inventories_isolation` F | `inventory.service.ts:26-31` valida filial na empresa | — | |
| `inventory_counts` | herda | H(inventories) | idem | — | — | |
| `damage_records` | BRANCH (NOT NULL) | F / F | `damage_records_isolation` F | `damage.service.ts:37-42` valida | invalida `product:<id>:stock*` | |
| `fiscal_configs` | BRANCH (NOT NULL) | F / F | `fiscal_configs_isolation` F | `fiscal.service.ts:118` valida | — | |
| `fiscal_documents` | BRANCH (NOT NULL) | F / F | `fiscal_documents_isolation` F | `emitDocument` exige venda da mesma empresa+filial (`fiscal.service.ts:178-179`) | — | |
| `device_sessions` | BRANCH (NULL = empresa) | F / F | `device_sessions_isolation` F | — | — | |

### 2.2 Tabelas com `branchId` anulável e RLS por filial
| Tabela | OWNER | READ / WRITE | RLS | App-layer | Cache | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| `products` | COMPANY ou BRANCH (NULL = catálogo da empresa) | F / F | `products_isolation` F | `product.service.ts:17-23,38,237` valida filial/categoria; update/delete conferem `companyId` antes | lista `products:<co>:<scope>:…` (`:90`); detalhe `product:<id>` **sem escopo**, conferido por `cachedProductIsVisible` (`:176-180`); saldo `product:<id>:stock:<co>:<scope>:<filial>` (`:292`) | Preço de venda = `products.salePrice` (não há tabela de preço). E6 (costPrice p/ MECHANIC). |
| `combo_items` | herda | H(products) via `comboId` | `combo_items_isolation` | — | — | Só o combo é checado, não o `productId` componente. |
| `stock_movements` | BRANCH (NULL permitido pelo schema) | F / F | `stock_movements_isolation` F | `stock.routes.ts:20-30` exige filial (token ou corpo; papel de filial só a sua); `stock.service.ts:42-50` valida na empresa | `dashboard:stock:<co>:<scope>:<filtro>:<dias>` (`dashboard.service.ts:229`) | Não existe tabela de saldo: saldo = soma dos movimentos. Linhas NULL antigas não entram em saldo por filial. |
| `accounts_payable`, `accounts_receivable` | BRANCH (NULL = empresa) | F / F | `*_isolation` (migr. 20260921) | criação manual: `branchId` opcional do corpo (`financial.routes.ts:59-64,125-130`), **sem validação** (`financial.service.ts:12-36,184-208`) | — | ver §6-1 e §5. |
| `revisions`, `follow_ups`, `appointments` | BRANCH (NULL = empresa) | F / F | `*_isolation` (migr. 20260914154543) | `resolveWriteBranchId` (`revisions.routes.ts:62`, `follow-ups.routes.ts:77`, `appointments.routes.ts:69`) | — | F1/8221692, F2 (NULL antigos). |
| `follow_up_events`, `appointment_events` | herda | H(follow_ups) / H(appointments) | idem | — | — | |
| `company_module_settings` | COMPANY (NULL) ou override BRANCH | leitura F / escrita **só SA/COMPANY_ADMIN (também no banco, desde 2026-10-16)** | `company_module_settings_select` F + `_insert/_update/_delete` empresariais | `module-settings.service.ts:134-197` valida empresa e filial | `company:<co>:module-settings` (+ `:gen`), **sem filial**, mas lido sob contexto COMPANY_ADMIN (`:48`) → conjunto completo | Antes, um gerente com SQL direto ligava um módulo desativado gravando um override da própria filial; agora o banco recusa (migração `20261016110000`, teste `branch-scope-access` §9). |
| `branches` | COMPANY | leitura: papel de filial só a própria linha; escrita **só SA/COMPANY_ADMIN** | `branches_select` + `branches_insert/_update/_delete` empresariais | `branch.routes.ts` (rota de plataforma) | — | Criar/renomear/apagar filial por SQL direto deixou de ser possível a gerente (migração `20261016110000`). |

### 2.3 Cadastros/configurações da empresa (RLS só por empresa — F2)
| Tabela | OWNER | READ / WRITE | RLS | App-layer | Cache | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| `customers` | COMPANY | E / E | `customers_isolation` E | `customer.service.ts` `where {companyId}` | `CacheKeys.customer(s)` **não usados** | B/E6 do tech-debt. |
| `motorcycles` | COMPANY | E / E | `motorcycles_isolation` E | `motorcycle.service.ts:20,93,102` | — | |
| `suppliers` | COMPANY | E / E | `suppliers_isolation` E | `supplier.service.ts` | — | |
| `categories` | COMPANY | E / E | `categories_isolation` E | `category.service.ts`; produto valida categoria (`product.service.ts:28-34`) | — | |
| `partners` (convênios) | COMPANY; `branchId` NULL = vale p/ todas, senão só p/ a filial | **F** (lê o da filial + os da empresa toda) / escrita **só da própria filial** (`rls_company_branch_write`) | `partners_select` F, `partners_insert/_update/_delete` por filial | criação/edição valida filial na empresa; rota nega gerente em convênio da empresa toda ou de outra filial (`branchWriteDenied`, 403 `BRANCH_FORBIDDEN`/`BRANCH_REQUIRED`); venda confere aplicabilidade | — | **Resolvido em 2026-10-16** (decisão 146): o gerente da filial A não vê nem altera convênio da filial B; convênio da empresa toda ele só lê. |
| `installment_policies` | COMPANY; `branchId` = aplicabilidade | **F** / escrita **só SA/COMPANY_ADMIN** | `installment_policies_select` F, `_insert/_update/_delete` empresariais | valida filial; escrita só SA/COMPANY_ADMIN (rota **e** banco) | — | Gerente lê a política da própria filial e as da empresa toda; não vê a de outra filial. |
| `discount_rules` | COMPANY | E / E | `discount_rules_isolation` E | `discount.service.ts` | — | F2 (sem regra = livre). |
| `commission_rules` | COMPANY | E / E | `commission_rules_isolation` E | — | — | |
| `transfers` | COMPANY (origem/destino = filiais) | papel de filial: só as em que a própria filial é **origem ou destino**; SA/COMPANY_ADMIN: todas | `transfers_isolation` (origem/destino, 2026-10-16) | `transfer.service.ts:59-70` valida as 2 filiais na empresa | invalida `product:<id>:stock*` | Gerente de uma terceira filial não vê a transferência entre A1 e A2 (teste `branch-scope-access` §7). |
| `transfer_items` | herda | H(transfers) | `transfer_items_isolation` | — | — | |
| `invoices` | COMPANY | E / E | `invoices_isolation` E | só `purchase-order.service.ts:236,348` (NF de entrada no recebimento) | — | Sem `branchId`, mas nasce de pedido de filial (F2). |
| `tef_payments` | COMPANY | E / E | `tef_payments_isolation` E | **nenhum uso** em `apps/api/src` | — | F2. |
| `idempotency_keys` | COMPANY | E / E | `idempotency_keys_isolation` E | `middleware/idempotency.ts:34-83`: chave `(companyId, endpoint, key)`, `'PLATFORM'` sem empresa | — | **[DECISÃO NECESSÁRIA]** o replay devolve a resposta gravada sem conferir `userId`/filial (mesma chave + mesmo corpo). |

### 2.4 Plataforma, identidade e logs
| Tabela | OWNER | READ / WRITE | RLS | App-layer | Cache | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| `companies` | PLATAFORMA | SA ou a própria / só SA | `companies_isolation` | `company.routes.ts` | `CacheKeys.company(ies)` não usados | |
| `licenses` | COMPANY | P / só SA | `licenses_isolation` | — | `CacheKeys.license` não usado | |
| `activations`, `devices` | COMPANY (via licença); `devices.branchId` = filial autorizada | `activations`: SA ou licença da empresa; `devices`: empresa pela licença **e** (empresarial, `branchId` NULO ou a própria filial) | `activations_isolation`; `devices_isolation` (2026-10-16) | `GET /activation/devices/:licenseId` só SA/COMPANY_ADMIN/MANAGER; encerrar sessão: gerente só de equipamento da própria filial (403 `BRANCH_FORBIDDEN`) | — | Antes: qualquer papel listava os equipamentos de todas as filiais e o gerente encerrava a sessão de outra filial. |
| `users` | COMPANY (`companyId NULL` = SA) | leitura: SA/empresarial vê a empresa; papel de filial vê a **própria filial**, os usuários **sem filial** e os **COMPANY_ADMIN** / escrita: só a própria filial | `users_select/_insert/_update/_delete` (2026-10-16) + trigger `users_guard_privileged_columns` | não-SA filtrado por `companyId` (`user.routes.ts:77,103,177…`) | `user:<id>` (não usado), `user:<id>:permissions` | Linhas de SA (`companyId NULL`) **não** são legíveis por tenant (migração `20260926130000`). Gerente não muda `userType`, `companyId`, `branchId` nem `isActive` nem por SQL direto (o trigger recusa com `42501`). |
| `user_roles` | herda | leitura herda de `users`; escrita **só SA/COMPANY_ADMIN** | `user_roles_select` + `_insert/_update/_delete` empresariais | `role.service.ts:160-183` | `user:<id>:permissions` | ver §8-1 (`branchId` do vínculo ignorado). Gerente não concede perfil a si nem a outro (migração `20261016110000`). |
| `roles`, `permissions` | COMPANY ou global (NULL) | leitura: SA ou própria empresa (+ globais) / escrita **só SA/COMPANY_ADMIN** | `roles_*`, `permissions_*` (2026-10-16) | `roles.routes.ts:46`, `permissions.routes.ts` | — | |
| `role_permissions` | herda | leitura herda de `roles`; escrita **só SA/COMPANY_ADMIN** | `role_permissions_select` + `_insert/_update/_delete` | — | invalidação por padrão | |
| `refresh_tokens` | COMPANY (nulo só para usuário de plataforma) | **P: só a própria empresa** (sem ramo `IS NULL` desde 2026-10-15) / idem | `refresh_tokens_isolation` | `auth.service.ts` (busca por `tokenHash` SHA-256; contexto SA) | `session:<userId>` | FK composta `(companyId, userId) → users`. Token em texto não existe mais. |
| `audit_logs` | COMPANY (NULL permitido) | SA ou própria empresa; **papel de filial só a auditoria de usuários da própria filial**; NULL só SA / aceita NULL | `audit_logs_select` (2026-10-16) | `audit-logs.routes.ts:12,25` (SA/COMPANY_ADMIN/MANAGER) | — | **Resolvido em 2026-10-16** (decisão 147): a auditoria não tem `branchId`; a filial vem do **autor** da ação. Ação de usuário sem filial (administrador) só o administrador lê. |
| `request_logs`, `system_logs` | COMPANY/NULL (+`branchId`) | **leitura só SA/COMPANY_ADMIN**; gravação F; UPDATE/DELETE só SA | `request_logs_*`, `system_logs_*` (2026-10-16) | observabilidade só SA (`observability.routes.ts:19`); quem grava é o worker em contexto de plataforma | `observability:metrics:*` global (só SA) | Gerente não lê log de requisição/sistema (traz IP, caminho, usuário de outras filiais). Uma empresa não lê log de plataforma nem grava log em nome de outra (teste `rls-logs-roles-tighten`). |

> **Atualização 2026-10-15 (revisão do banco):** além da RLS, o banco agora **impõe** o escopo por empresa e filial — `companyId → companies` com FK em 65 tabelas de negócio, FK composta `(companyId, X) → pai(companyId, id)` em 94 relações, FK composta de filial em 55 tabelas, trigger de mesma empresa em `sales.partnerId`, `service_orders.mechanicId` e `users.branchId`; `ON DELETE RESTRICT` no histórico; livros de estoque/caixa/política/status de OS append-only. Ficam só com RLS as tabelas de retenção (logs, telemetria, idempotência). Detalhe: [REVISAO_BANCO_PENDENCIAS](../REVISAO_BANCO_PENDENCIAS.md), decisões 124–142.

## 3. SUPER_ADMIN

- JWT do SA não tem empresa. Rotas com `companyScoped()` (`routes/index.ts:77-112`): exige `X-Company-Id` **ou**
  `?companyId=` (`tenant.ts:34`, cabeçalho tem precedência) → sem alvo `400 COMPANY_CONTEXT_REQUIRED`; não-UUID
  `400 INVALID_COMPANY_CONTEXT`; empresa inexistente `404 COMPANY_NOT_FOUND`. Válido: `user.companyId = alvo` só neste
  request e contexto RLS `{companyId: alvo, userType: SUPER_ADMIN, branchId: null}` (`tenant.ts:55-56`).
- Rotas **sem** `companyScoped` (plataforma): `/companies`, `/branches`, `/licenses`, `/activations`, `/backup`,
  `/users`, `/roles`, `/permissions`, `/observability`, `/audit-logs`, `/module-settings`, `/dashboard/super-admin`.
  Nelas o SA roda com `companyId NULL` e cada rota escolhe o alvo (`?companyId`/corpo: `branch.routes.ts:26-31`,
  `module-settings.routes.ts:19-26`, `audit-logs.routes.ts:25`, `roles.routes.ts:46`, `user.routes.ts:137-149`).
- **[INCONSISTÊNCIA] A RLS não prende o SA à empresa-alvo.** Com `app.user_type = SUPER_ADMIN`, `is_super_admin()` é
  verdadeiro e **E/F/P liberam todas as empresas**; o `X-Company-Id` só vale porque os serviços usam
  `where: { companyId }`. Qualquer consulta de serviço sem `companyId` no `where` fica cross-tenant para o SA.
- **[INCONSISTÊNCIA] Precedência cabeçalho × query.** `tenant.ts:34` escolhe `X-Company-Id` antes de `?companyId`;
  `resolveListCompanyId` (`tenant-scope.ts:24-25`) usa `?companyId` antes de `user.companyId`. Com
  `X-Company-Id: A` + `?companyId=B`, as listas de products/sales/payments/cash-register
  (`products.routes.ts:30`, `sales.routes.ts:32`, `payments.routes.ts:32`, `cash-register.routes.ts:66`) consultam **B**
  (sem validação de UUID/existência) enquanto o resto do request opera em A.
- SA no Admin Web sem seletor de empresa: F2.

## 4. Usuários sem `branchId`

| Papel | RLS (**F**) | Cache (`visibilityScope`) | App |
| --- | --- | --- | --- |
| SA / COMPANY_ADMIN sem filial | todas as filiais | `all` | normal; `resolveWriteBranchId` aceita filial da empresa (validada) ou NULL |
| MANAGER/OPERATOR/MECHANIC/VIEWER sem filial | só linhas `branchId NULL`; não grava em tabelas com `branchId NOT NULL` | `b:none` | `resolveWriteBranchId` (`branch-context.ts:21-28`) trata "sem filial no token" como empresa inteira e aceita qualquer filial da empresa → a RLS recusa depois; `stock.routes.ts:25-26` idem |

- **[INCONSISTÊNCIA]** A aplicação decide "empresa inteira" por **ausência de `branchId`** (`branch-context.ts:21`,
  `permission.ts:228-231` "branchId null = todas as filiais"), a RLS e o cache por **`userType`**. Além disso um
  COMPANY_ADMIN **com** `branchId` no token é forçado à própria filial por `resolveWriteBranchId`, embora a RLS o deixe
  gravar em qualquer filial. (`requireBranchAccess`/`checkBranchAccess` em `permission.ts:151-235` não são usados por rota.)
- **[DECISÃO NECESSÁRIA]** Papel não-admin sem filial deve existir? `user.service.ts:117-127` cria sem exigir `branchId`.

## 5. Registros com `branchId NULL`

- Semântica única no banco (`rls_company_branch_match`): NULL = "da empresa toda", visível a todas as filiais.
- Onde é permitido: `products`, `stock_movements`, `accounts_payable`, `accounts_receivable`, `revisions`,
  `follow_ups`, `appointments`, `company_module_settings`, `device_sessions`, `partners`/`installment_policies`
  (aplicabilidade), `users`, `user_roles`, `request_logs`, `system_logs`.
- **[DECISÃO NECESSÁRIA]** O WITH CHECK aceita NULL de qualquer papel: um MANAGER da filial A1 com `finance:manage`
  cria conta a pagar/receber sem `branchId` (`financial.routes.ts:59-64`) e ela passa a ser vista pelas outras filiais;
  idem produto sem filial. Nenhuma regra no app restringe quem pode criar registro "da empresa toda".
- Pós-venda com NULL antigos e TV/mobile filtrando por igualdade: F2. `stock_movements` NULL antigos: não entram no
  saldo por filial (novos são bloqueados em `stock.routes.ts:20-30`).

## 6. `companyId`/`branchId` forjados pelo cliente

- **`companyId`**: não-SA → sempre o do token. Rotas sobrescrevem depois do spread (`sales.routes.ts:89-94`,
  `purchase-orders.routes.ts:54-58`, `financial.routes.ts:60-64`, `cash-register.routes.ts:128-132`) e listas usam
  `resolveListCompanyId`; `updateUserSchema` não aceita `companyId` (E7). WITH CHECK **E/F** recusa linha de outra
  empresa. Provado em `tenant-branch-matrix.integration.test.ts:233-250` (cliente com `companyId` forjado grava na empresa do token).
- **`branchId` em query de leitura**: é só filtro adicional; a RLS limita (papel de filial pedindo outra filial → vazio).
  Chaves de cache incluem o escopo do requisitante (F1/c83b9d0).
- **`branchId` no corpo de escrita**:

| Caminho | Papel de filial | COMPANY_ADMIN / SA |
| --- | --- | --- |
| revisions / follow-ups / appointments (`resolveWriteBranchId`) | outra filial → 403 | filial validada na empresa |
| stock movement/ajuste (`stock.routes.ts:20-30` + `stock.service.ts:42-50`) | outra filial → 403 | validada |
| products, quotes, inventories, damage, fiscal, partners, installment policies, transfers, module settings, user **update** | RLS (onde **F**) | validada na empresa |
| sales | RLS | validada indiretamente (caixa da mesma filial/empresa) |
| **service_orders, purchase_orders, cash_registers (abrir), accounts_payable/receivable, user create** | RLS **F** recusa outra filial (exceto NULL, §5) | **[INCONSISTÊNCIA] não validada**: aceita filial de outra empresa ou texto arbitrário (sem FK) |

## 7. Cache (`apps/api/src/services/cache.service.ts:290-331`)

| Chave | Escopo | Uso |
| --- | --- | --- |
| `products:<co>:<scope>:…filtros` | empresa + visibilidade | `product.service.ts:90`; invalidação `products:<co>:*` |
| `product:<id>` | **nenhum** | detalhe; protegido por `cachedProductIsVisible` (`product.service.ts:176-191`) |
| `product:<id>:stock:<co>:<scope>:<filial>` | empresa + visibilidade + filtro | `product.service.ts:292`; invalidação `product:<id>:stock*` |
| `dashboard:stock:<co>:<scope>:<filial\|all>:<dias>` | empresa + visibilidade | `dashboard.service.ts:229` (só TTL, sem invalidação) |
| `company:<co>:module-settings` (+`:gen`) | empresa (conjunto completo) | `module-settings.service.ts:40-63` |
| `user:<id>:permissions` | usuário | `permission.ts:194` |
| `observability:metrics:*` | global | só SA |
| `sales:<co>:page`, `sales:stats:<co>[:<filial>]`, `customers:<co>:page`, `customer:<id>`, `sale:<id>`, `cash-register:current:<filial>`, `company:*`, `companies:*`, `license:*`, `user:<id>` | **sem escopo de visibilidade** | **não usadas** hoje (`CacheKeys` morto). **[INCONSISTÊNCIA] latente**: `sales:<co>` / `sales:stats:<co>` sem `visibilityScope()` repetiriam o vazamento corrigido em F1/c83b9d0 se forem adotadas. |

## 8. Outras inconsistências de escopo

1. **[INCONSISTÊNCIA]** `getUserPermissions` (`permission.ts:195-196`) lê `user_roles` só por `userId`: o `branchId` do
   vínculo (`user_roles.branchId`, gravado por `role.service.ts:160-183`) é ignorado, então um perfil dado "para a filial X"
   concede a permissão em qualquer filial.
2. ~~comentário `transfer.service.ts:38-41` diz que MANAGER enxerga todas as filiais~~ — **superado em 2026-10-16**: a RLS agora limita o gerente às transferências da própria filial (origem ou destino); o comentário do serviço deve ser lido assim.
   `is_company_wide_role()` só SA/COMPANY_ADMIN enxergam.
3. `validateTenantAccess` (`tenant.ts:110-133`) e `requireSameCompany` (`permission.ts:120`) não são usados por rota.
4. Tabelas F2 (`customers`, `motorcycles`, `suppliers`, `categories`, `partners`, `installment_policies`,
   `discount_rules`, `commission_rules`, `transfers`, `invoices`, `tef_payments`): a aplicação também não filtra por filial —
   RLS e app estão **coerentes** (empresa inteira); a decisão de produto continua pendente em F2.


## 9. Regra de acesso por filial (implementada em 2026-10-16)

**Regra de negócio.** (a) Acesso **empresarial** (COMPANY_ADMIN; SUPER_ADMIN na empresa-alvo): consulta todas as filiais da **própria** empresa, vê o dashboard consolidado, o faturamento e o detalhe por filial dentro do escopo; **nunca** outra empresa, ainda que conheça ids, URLs ou parâmetros. (b) **Gerente de filial** (MANAGER) e os demais papéis de filial (OPERATOR, MECHANIC, VIEWER): consultam **exclusivamente a filial a que estão vinculados**; não alcançam outra filial da mesma empresa por API, busca, exportação, relatório ou SQL direto; não ampliam o próprio acesso trocando id/parâmetro/dado. (c) Recebíveis, pedidos/OS e qualquer módulo desativado ou fora da autorização continuam **negados no backend** (gate de módulo + permissão), não só ocultos no menu.

**Camadas** (cada uma repete a regra; nenhuma depende da outra): 1) rota — `requireUserType`/`requirePermission`/`requireModuleEnabled`, e `scopedBranchId` nos dashboards; 2) serviço — `where { companyId, branchId }`; 3) **RLS** com o papel real da aplicação (não superusuário, sem BYPASSRLS): leitura pela regra **F** (`rls_company_branch_match`), escrita pela nova `rls_company_branch_write` (papel de filial só grava linha **da própria filial** — nem "da empresa toda", nem de outra filial); 4) trigger `users_guard_privileged_columns` (papel de filial não muda `userType`, `companyId`, `branchId`, `isActive`).

**Contrato de erro dos dashboards** (mudança de contrato, decisão 145): `branchId` malformado → 400 `INVALID_BRANCH`; administrador pedindo filial que não é da empresa dele (outra empresa ou inexistente) → 404 `BRANCH_NOT_FOUND`; papel de filial pedindo **outra** filial → **403 `BRANCH_FORBIDDEN`** (antes o servidor ignorava o pedido em silêncio e devolvia a própria filial com 200 — o cliente achava que via a outra); papel de filial sem filial no token → 403 `BRANCH_REQUIRED`. Sem `branchId`: administrador recebe a **empresa consolidada**, gerente recebe a **própria filial**.

### 9.1 Matriz de visibilidade e escrita por perfil (provada por `branch-scope-access.integration.test.ts`, 28 testes, e `dashboard-management.integration.test.ts`)

| Objeto | COMPANY_ADMIN (própria empresa) | MANAGER / papel de filial A1 | Outra empresa |
| --- | --- | --- | --- |
| Dashboard `/dashboard/management/*`, `/sales`, `/financial`, `/stock`, `/workshop`, `/pdv` | consolidado ou 1 filial da empresa | **só A1** (outra filial: 403) | nada (404 se pedir a filial) |
| `users` | lê/grava a empresa | lê A1 + sem filial + COMPANY_ADMIN; grava só A1; **não** muda `userType/companyId/branchId/isActive` | nada |
| `user_roles`, `roles`, `permissions`, `role_permissions` | lê/grava | lê (herda `users`/`roles`); **não grava** | nada |
| `partners` | lê/grava todos | lê A1 + os da empresa toda; grava **só** os de A1 | nada |
| `installment_policies` | lê/grava | lê A1 + empresa toda; **não grava** | nada |
| `devices` | lê/grava os da empresa | lê A1 + sem filial; encerra sessão **só** de A1 | nada |
| `monitoring_thresholds`, `monitoring_threshold_changes` | lê | **não lê** | nada |
| `request_logs`, `system_logs` | lê | **não lê** | nada |
| `audit_logs` | lê a empresa | lê só ações de usuários de A1 | nada |
| `transfers` | todas da empresa | só as com A1 como origem **ou** destino | nada |
| `company_module_settings` | lê/grava | lê A1 + empresa toda; **não grava** (não liga módulo) | nada |
| `branches` | lê/grava | lê só A1; **não grava** | nada |
| Recebíveis (`/financial`), OS/orçamentos (`/service-orders`, `/quotes`) com módulo desativado | 403 `MODULE_DISABLED` | 403 `MODULE_DISABLED` | — |
| `id` de outra empresa/filial na URL (IDOR) | 404 | 404 (invisível) | — |

**Pontos que continuam decisão do dono** (registrados, não presumidos): (i) se o gerente deve ver o COMPANY_ADMIN e os usuários sem filial (hoje vê, para poder escolher autorizador); (ii) se convênio da empresa toda pode ser criado por gerente (hoje não); (iii) retenção de logs (decisão 141).

## 10. Várias filiais por gerente e contexto assinado (implementado em 2026-10-15; decisões 151 e 153)

**Regra de negócio.** (a) **Administrador empresarial** (`COMPANY_ADMIN`; `SUPER_ADMIN` na empresa-alvo — usa-se o papel já existente, não um papel "CEO"): vê o dashboard consolidado, as vendas, o faturamento, os indicadores, os convênios e o detalhe de **todas as filiais da própria empresa**; **nunca** outra empresa (API, ids, parâmetros ou SQL). (b) **Gerente** e demais papéis de filial: só as filiais a que estão **vinculados** — A → só A; A e B → A e B e nenhuma outra; sem vínculo, nada além da principal. (c) O vínculo é **dado gravado no banco**; lista enviada pelo cliente, claim do token, cabeçalho ou parâmetro **não ampliam** acesso. (d) Módulos continuam dependendo de **permissão do papel + módulo ativo**: vincular uma filial **não habilita** módulo desativado nem poder administrativo.

**Modelo de dados.** `user_branches(companyId, userId, branchId)` — FK composta `(companyId,userId)→users` e `(companyId,branchId)→branches` (vínculo entre empresas é impossível), `ON DELETE CASCADE` (é configuração, não histórico), `ENABLE`+`FORCE RLS`, gatilho `user_branches_guard` (recusa vínculo para `SUPER_ADMIN`/`COMPANY_ADMIN`, que já veem a empresa inteira). Escrita só de administrador; o próprio usuário lê só os **seus** vínculos. Conjunto autorizado = `users.branchId` (principal) ∪ `user_branches`, **recalculado a cada requisição** (`resolveBranchScope`, falha ⇒ 503 `AUTH_UNAVAILABLE`, nunca "acesso total"). Filial ativa = a do token se ainda autorizada, senão a principal, senão a primeira. O conjunto vai **assinado** ao banco (`app.current_branch_ids`); a RLS usa `= ANY (conjunto)`.

**Rotas.** `GET /users/:id/branches` (administrador lê qualquer um da empresa; demais, só o próprio); `PUT /users/:id/branches` — **só `SUPER_ADMIN`/`COMPANY_ADMIN`**, idempotente, no máximo 50, auditado (`describe` com quem, quem recebeu e quais filiais). Erros: 404 `USER_NOT_FOUND`; 400 `BRANCH_NOT_FOUND` (filial de outra empresa), `USER_COMPANY_WIDE`, `INVALID_BRANCH_IDS`, `TOO_MANY_BRANCHES`; 403 para quem não administra.

### 10.1 Matriz (provada por `multi-branch-access.integration.test.ts`, 28 testes, com o papel real de execução)

| Objeto | Administrador empresarial | Gerente só da A | Gerente de A + B | Gerente de A + C (sem B) | Outra empresa |
| --- | --- | --- | --- | --- | --- |
| Dashboards (`/dashboard/management/*`, vendas, faturamento, indicadores) sem filial pedida | consolidado da empresa | só A | **A + B** (soma) | **A + C** (B fora) | nada |
| Dashboard com `?branchId=` | qualquer filial **da empresa**; de outra empresa: **404** | A; outra da mesma empresa: **403 `BRANCH_FORBIDDEN`** | A ou B; C: 403 | A ou C; B: 403 | 404 (admin) / 403 (papel de filial) |
| Convênios — lista | todos da empresa (+ empresa toda) | A + empresa toda | A, B + empresa toda (**não** C) | A, C + empresa toda (**não** B) | nada |
| Convênios — filtro `?branchId=` alheio | qualquer da empresa | 403 | A/B ok; outra 403 (não "lista vazia") | idem | — |
| Convênio por id | qualquer da empresa | A; de B: **404** (invisível) | A ou B; de C: 404 | A ou C; de B: 404 | 404 |
| Convênio — criar/editar/mover | qualquer | só A | A ou B; mover/criar em C: 403; "empresa toda": 403 | idem | corpo com `companyId`/`branchIds` alheio **não grava** |
| Usuários / auditoria | toda a empresa | A + sem filial + administradores | A, B + sem filial + administradores | A, C + … (não B) | nada |
| Promover, conceder perfil, ligar módulo, alterar vínculo | sim | **não** (RLS + gatilho + rota) | **não** | **não** | — |
| **Remover o vínculo** (mesmo token) | — | — | B vira 403 no dashboard, some dos convênios, consolidado volta a só A | — | — |
| **Trocar a filial principal** (token antigo) | — | token da antiga deixa de valer; ativa passa a ser a nova | — | — | — |
| `branchIds` no token, `X-Branch-Id(s)`, `X-Company-Id`, `companyId` em query/corpo | ignorados | ignorados | ignorados | ignorados | ignorados |
| SQL cru com `SUPER_ADMIN` forjado (sem assinatura) | — | 0 linhas | 0 linhas | 0 linhas | 0 linhas |

**Contratos HTTP preservados:** filial **da mesma empresa sem acesso** → `403 BRANCH_FORBIDDEN`; filial/registro **de outra empresa** → `404` (não revela existência). Recebíveis, ordens e demais módulos **não** foram desativados: seguem a regra de módulo ativo + permissão do papel (§9.1); nenhum registro financeiro, ordem ou histórico foi apagado.

**Por que o conjunto é do banco e não do token.** Um token pode durar minutos e ser antigo: com o conjunto no token, remover um vínculo só valeria no próximo login. Lendo `user_branches` a cada requisição, a revogação é imediata (provado em "depois de remover o vínculo (o MESMO token)"). Custo: uma leitura por requisição de papel de filial (coberta por índice `(companyId,userId)`); administradores empresariais não consultam.

**Decisões do dono ainda abertas (não presumidas):** (i) se o gerente deve enxergar os administradores e os usuários sem filial (hoje enxerga, para escolher autorizador); (ii) se convênio "da empresa toda" pode ser criado por gerente (hoje não); (iii) limite de 50 filiais por usuário (valor técnico, ajustável).
