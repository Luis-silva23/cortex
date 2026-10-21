# CODE_MAP — CÓRTEX (Lógica de Negócios)

## Como usar este mapa
1. Procure a área pelo título (Ctrl+F); cada bloco tem 5 campos: RESP | LOC | DEPS | SEG | TESTES.
2. Caminhos relativos à raiz do monorepo; pacotes internos ainda se chamam `@ln-system/*`.
3. API: rota em `apps/api/src/routes/<x>.routes.ts` → regra em `apps/api/src/services/<x>.service.ts`.
4. Toda leitura/escrita de dados de empresa passa por RLS (Postgres) — nunca use `prismaUnsafeBypassRLS` sem motivo.
5. Testes unitários ficam ao lado do código (`*.test.ts`); integração em `apps/api/test/integration/`.
6. Decisões pendentes: `docs/CORTEX/DECISIONS.md`; o que falta: `docs/CORTEX/ROADMAP.md`. Este mapa não substitui o código — confira antes de mudar.
7. Atualizado em 2026-09-28 (políticas por empresa/filial, desconto, caixa por forma de pagamento e forçado, conciliação, garantia, convênios por filial, cobrança manual, capacidade da agenda, devolução ao fornecedor, estados de pagamento e MFA do PDV).

## Mapa de portas
Super Admin 3000 · API 3001 · Admin Web 3002 · PDV web 5173 · Expo 8081. Fonte única e regra "uma porta por frontend":
`docs/CORTEX/VISUAL_REFERENCES.md` (guardada por teste), com o comando de cada app.

---

## Apps

### apps/api — entrada, montagem de rotas, middleware
- RESP: API REST única (`/api/*`) de todos os frontends; Swagger em `/api/docs`.
- LOC: `apps/api/src/index.ts` (helmet, cors, compression, json 5mb, `clampPaginationLimit`, `rateLimitGeneral`, `errorHandler`; importa `config/queue`, `config/redis`, `config/scheduler`) · `apps/api/src/routes/index.ts` (monta rotas; `requestContext` primeiro; `companyScoped()` nas rotas de uma empresa) · `apps/api/src/middleware/` (auth, tenant, permission, module, audit, idempotency, paginationLimit — `limit` ≤ 100 e `page` ≥ 1 —, errorHandler — banco inacessível → 503 —, requestContext, translate-errors — saída de erro em PT-BR, texto do Prisma/Zod nunca sai —, dateQuery) · `apps/api/src/middlewares/advancedRateLimit.ts` (Redis com contagem em memória se ele cair) · `apps/api/src/config/` (cors, redis, queue, scheduler, swagger) · `apps/api/src/utils/` (tenant-scope, branch-context, cache-scope, route-error).
- DEPS: express, zod, jsonwebtoken, bcrypt, ioredis, bullmq, rate-limiter-flexible, winston, `@ln-system/database`, `@ln-system/shared`.
- SEG: `authMiddleware` + `tenantIsolation` por arquivo de rota; `companyScoped()` exige `?companyId=`/`X-Company-Id` do SUPER_ADMIN; `rateLimitGeneral` global, chaveado pelo usuário do Bearer verificado (sem token: IP).
- TESTES: `cd apps/api && npx jest` — `src/config/cors.test.ts`, `src/middleware/*.test.ts`, `src/utils/route-error.test.ts`.

### Admin Web — apps/admin-web
- RESP: ERP da empresa (cadastros, estoque, vendas, OS, orçamentos, financeiro, fiscal, pós-venda, usuários, módulos).
- LOC: `apps/admin-web/app/dashboard/<área>/page.tsx` · `apps/admin-web/lib/api.ts` (cliente axios único) · `apps/admin-web/lib/navigation.ts` (`MODULE_ROUTES`, `ROLE_ROUTES`) · `apps/admin-web/components/layout/DashboardShell.tsx` (`RoleGate`, `ModuleGate`: URL digitada de tela proibida/desligada) · `apps/admin-web/lib/role-gates.ts` · `apps/admin-web/components/{layout,ui,quotes,service-orders,sales,import,settings,providers}/`.
- DEPS: Next 14, React 18, @tanstack/react-query, recharts, xlsx, tailwind, `@ln-system/shared`.
- SEG: gates de UI (`role-gates.ts`, módulos no `components/layout/Sidebar.tsx`) são só UX — a autorização real é da API.
- TESTES: `cd apps/admin-web && npx jest` (`lib/**/*.test.ts`): `navigation`, `role-gates`, `quotes`, `service-orders`, `sales`, `financial`, `fiscal`, `transfers`, `cadastros`, `errors`, `excel-parser`, `list-pagination`, `design-*` (inclui `design-currency`: dinheiro só via `formatCurrency`).

### Super Admin — apps/super-admin
- RESP: operação da plataforma: empresas, licenças, usuários, dispositivos, backup, auditoria, observabilidade.
- LOC: `apps/super-admin/app/dashboard/{companies,licenses,users,devices,backup,audit-logs,observability}/` · `apps/super-admin/app/login/page.tsx` · `apps/super-admin/lib/api.ts`.
- DEPS: Next 14, Radix UI, recharts, zod, axios.
- SEG: API `requireSuperAdmin` em `/companies`, `/observability`, `/backup`; login com MFA (`/auth/verify-mfa`).
- TESTES: nenhum teste automatizado no app (evidência visual em `docs/evidencias/2026-09-24/08-*`, `09-*`).

### PDV desktop — apps/pdv-desktop (Electron + Vite)
- RESP: frente de caixa: login, abrir/fechar caixa, venda, pagamento, cancelamento/devolução, sangria, impressão, offline.
- LOC: `apps/pdv-desktop/electron/{main.ts,preload.ts}` · `apps/pdv-desktop/src/pages/{POSPage,CashRegisterPage,SalesPage,LoginPage,SettingsPage}.tsx` · `apps/pdv-desktop/src/components/{PaymentModal,CancelSaleModal,ReturnSaleModal,WithdrawalModal,AuthorizerCredentialsForm}.tsx` · `apps/pdv-desktop/src/store/{auth,cart,cashRegister}.store.ts` · `apps/pdv-desktop/src/services/{api,money,sale-status,offline.service,printer.service}.ts` · configs `vite.config.ts`, `vite.web.config.ts`.
- DEPS: Electron, Vite, React 18, zustand, axios, react-router-dom; IndexedDB (offline); `VITE_API_URL` (`.env.example`).
- SEG: cancelamento/devolução/sangria exigem credencial de autorizador (API `rateLimitAuthorizer` + `dual-authorization.service.ts`); `idempotency()` nas escritas de venda/caixa; OPERATOR só opera o próprio caixa (`assertCanOperateRegister`).
- LOC (2026-09-27): `src/services/{payment-flow,mfa-login,cash-summary}.ts` (regras puras: estados de pagamento, chave por tentativa, classificação de erro; MFA; resumo do caixa) · `src/store/{checkout,discountAuthorization}.store.ts` · `src/components/{AgreementPaymentPanel,DiscountAuthorizationDialog,CashCloseModal}.tsx`. Docs: `docs/CORTEX/policies/{PDV,SEGURANCA-PDV}.md`.
- TESTES: `cd apps/pdv-desktop && npm run smoke:electron` (`scripts/electron-smoke.cjs`); `npm run test:logic` (`scripts/payment-flow.test.ts`); `npx tsx --test scripts/cash-summary.test.ts`; cálculo/regras no backend (`sale.service*.test.ts`, `cash-register.service*.test.ts`).

### Balcão — apps/balcao (aplicativo de atendimento, Vite + React + TS, :5174)
- RESP: **aplicativo próprio de atendimento**, separado do PDV (caixa) e do Web/Admin (administração): identificar cliente, veículo, consultar produto e disponível, orçamento → OS, histórico e encaminhamento ao caixa. **Não cobra**, não cria venda/pagamento/caixa, não tem campo tributário. Ver [APLICATIVOS](APLICATIVOS.md).
- LOC: `apps/balcao/src/{config.ts,api/{http,endpoints,types}.ts,store/auth.store.ts,components/*,pages/*,lib/{quote-preview,quote-lines,handoff,permissions,money,search,errors,labels}.ts}` · `apps/balcao/{Dockerfile,nginx.conf,.env.example}` · `packages/shared/utils/server-url.ts` (mesma regra de endereço do PDV) e `utils/installments.ts` (centavos).
- DEPS: API `/auth/*`, `/customers`, `/motorcycles`, `/products`, `/stock/availability`, `/quotes*`, `/service-orders*`, `/sales` (só leitura), `/branches`; CORS `BALCAO_URL`.
- SEG: o servidor decide (RBAC/RLS/auditoria); `costPrice` removido da resposta de produtos para OPERATOR/MECHANIC/VIEWER (`products.routes.ts`); VIEWER só lê; MECHANIC não lê vendas; filial obrigatória na escrita (`requireWriteBranchId`).
- TESTES: `apps/api/test/integration/balcao-api.integration.test.ts` (10), `apps/api/src/architecture/domain-separation.test.ts` (Balcão ≠ PDV), `apps/balcao/scripts/lib.test.ts` (`npm run test:logic`).

### Oficina no Admin Web (gestão de orçamento/OS)
- RESP: a gerência também opera orçamento → OS → venda pelo Admin Web (+ PDV para cobrança, mobile para mecânico, TV para painel); o atendimento de balcão tem aplicativo próprio (**Balcão**, acima).
- LOC: `apps/admin-web/app/dashboard/{quotes,service-orders,motorcycles,customers,mechanics}/` · `apps/admin-web/components/quotes/*` (QuoteStepper, QuoteItemsEditor, CustomerPicker, MotorcyclePicker, QuoteTotals) · `apps/admin-web/components/service-orders/ProductPicker.tsx` · `apps/admin-web/lib/{quotes,service-orders}.ts`.
- DEPS: API `/quotes`, `/service-orders`, `/motorcycles`, `/customers`, `/mechanics`.
- SEG: módulo `OFICINA`; balcão/oficina cadastram cliente e moto (editar: gerência); receber a OS exige `finance:pay` (COMPANY_ADMIN por padrão, demais por perfil).
- TESTES: `lib/quotes.test.ts`, `lib/service-orders.test.ts`; API `workshop-authorization`, `motorcycle-roles`, `service-order-payment-states` (integração).

### Mobile — apps/mobile (Expo)
- RESP: app do mecânico/equipe: login+MFA, agenda, lista e detalhe de OS.
- LOC: `apps/mobile/App.tsx` · `apps/mobile/src/navigation/RootNavigator.tsx` · `apps/mobile/src/screens/{Login,Mfa,Home,Agenda,ServiceOrders,ServiceOrderDetail}Screen.tsx` · `apps/mobile/src/api/client.ts` · `apps/mobile/src/store/auth.store.ts`.
- DEPS: Expo 57, React Native 0.86, react-navigation, expo-secure-store, zustand, axios (`EXPO_PUBLIC_API_URL`, default `10.0.2.2:3001`).
- SEG: tokens em expo-secure-store; autorização da API (`/appointments`, `/service-orders`).
- TESTES: nenhum; só `npm run type-check`.

### TV — apps/tv (Expo Android TV)
- RESP: painel de oficina (agenda do dia + OS em andamento) para TV.
- LOC: `apps/tv/App.tsx` · `apps/tv/src/screens/{Login,Mfa,Painel}Screen.tsx` · `apps/tv/src/api/client.ts` · `apps/tv/src/store/auth.store.ts`.
- DEPS: `react-native-tvos`, `@react-native-tvos/config-tv`, Expo 57, expo-secure-store.
- SEG: mesmo login/MFA da API; somente leitura (`/appointments`, `/service-orders`).
- TESTES: nenhum; só `npm run type-check`.

## Pacotes

### packages/database
- RESP: Prisma schema, migrações, cliente estendido com RLS, `runInTransaction`.
- LOC: `packages/database/prisma/schema.prisma` · `packages/database/prisma/migrations/` (`0_init` define policies; `*_rls` separadas; crítica `20260921120000_branch_rls_for_derived_financial`) · `packages/database/src/index.ts` (`prisma` sem `$transaction`, `runInTransaction`, `prismaUnsafeBypassRLS`) · `packages/database/src/rls-context.ts` (`runWithRLSContext`, `getCurrentRLSContext`, AsyncLocalStorage).
- DEPS: `@prisma/client`/`prisma` 5.7, Postgres.
- SEG: cada query roda com `set_config('app.current_company_id' | 'app.current_branch_id' | 'app.user_type', …, true)`; RLS FORCE. Regras: `docs/CORTEX/DATABASE.md` §4.
- TESTES: `rls-invariants.integration.test.ts`, `transaction-atomicity.integration.test.ts`; `npm run db:check-rls` (em `apps/api`, `scripts/check-rls.ts`).

### packages/shared
- RESP: tipos, erros (`AppError`, `AuthorizationError`, `ConflictError`), formatadores, validadores e utilitários comuns.
- LOC: `packages/shared/index.ts` · `packages/shared/types.ts` · `packages/shared/validators.ts` · `packages/shared/src/validators/{pdv,revision}.validators.ts` · `packages/shared/utils/{email,password,token,validation}.ts`.
- DEPS: zod.
- SEG: `utils/token.ts` (JWT), `utils/password.ts` (hash); normalização de e-mail em `utils/email.ts`.
- TESTES: sem suíte própria; coberto via API (`customer.schema.test.ts`, `update-schemas.test.ts`, `email-case-insensitivity.integration.test.ts`).

## Transversais (backend)

### RLS / isolamento de tenant
- RESP: garantir que empresa/filial só veja o próprio dado, mesmo com bug na aplicação.
- LOC: `apps/api/src/utils/company-wide-read.ts` (`withCompanyWideRead`: ÚNICA leitura ampliada filial→empresa da API — mesma empresa, só leitura, contexto restaurado; usada na numeração da devolução ao fornecedor e no conflito de mecânico da agenda; teste `company-wide-read.test.ts`) · `packages/database/src/{index,rls-context}.ts` · `apps/api/src/middleware/tenant.ts` (`companyScoped`, `tenantIsolation`, `validateTenantAccess`) · `apps/api/src/utils/tenant-scope.ts` (`resolveListCompanyId`) · `apps/api/src/utils/branch-context.ts` (`resolveWriteBranchId`) · `apps/api/scripts/check-rls.ts`.
- DEPS: Postgres policies (migrações), AsyncLocalStorage.
- SEG: `tenantIsolation` abre `runWithRLSContext`; jobs/scheduler também abrem contexto explícito.
- ESCOPO POR FILIAL (2026-10-16): `apps/api/src/routes/dashboard.routes.ts` (`scopedBranchId`: gerente só a filial do token, 403 `BRANCH_FORBIDDEN`; administrador só filial da própria empresa, 404) · `routes/partners.routes.ts` (`branchWriteDenied`) · `routes/activation.routes.ts` (equipamentos por filial) · migrações `20261016100000_branch_scope_rls` (`rls_company_branch_write`, policies de `users`, `user_roles`, `partners`, `installment_policies`, `devices`, `monitoring_*`, logs, `audit_logs`, `transfers`) e `20261016110000_privilege_escalation_guards` (trigger `users_guard_privileged_columns`; escrita empresarial em perfis/módulos/filiais). Contrato: [tenant-branch-scope §9](contracts/tenant-branch-scope.md).
- BACKUP/RESTAURAÇÃO (2026-10-16): `deploy/backup/{backup.sh,entrypoint.sh,Dockerfile}` · `deploy/postgres-init/{10-roles.sh,after-migrate.sql}` · `apps/api/scripts/restore-drill.ts` (`npm run backup:drill`) · documento [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md).
- TESTES: `middleware/tenant.test.ts`, `utils/tenant-scope.test.ts`, `*.service.tenant-isolation.test.ts`; integração `tenant-branch-matrix`, `list-company-scope`, `super-admin-company-context`, `branch-create-scope`, `branch-on-create`, `rls-invariants`, **`branch-scope-access`** (28), `dashboard-management`.

### Redis / cache
- RESP: cache de leitura, permissões, sessões, contadores de rate limit, conexão das filas.
- LOC: `apps/api/src/config/redis.ts` · `apps/api/src/services/cache.service.ts` (`CacheTTL`, `CacheKeys`) · `apps/api/src/utils/cache-scope.ts` (`visibilityScope`: `all` | `b:<filial>` | `noctx`) · mock `apps/api/src/config/__mocks__/redis.ts`.
- DEPS: ioredis. Usado por product, stock, sale, service-order, purchase-order, inventory, damage, transfer, dashboard, observability, module-settings services e `middleware/permission.ts`.
- SEG: Redis não passa por RLS → toda chave de dado de empresa DEVE incluir empresa + `visibilityScope()`.
- TESTES: `module-settings.cache.test.ts`; integração `cache-branch-scope.integration.test.ts`.

### Filas (BullMQ) e scheduler
- RESP: e-mail, relatórios, notificações, auditoria assíncrona, métricas de request, logs de sistema; jobs recorrentes.
- LOC: `apps/api/src/config/queue.ts` (filas `email`, `report`, `notification`, `audit-log`, `request-metrics`, `system-log` + workers) · `apps/api/src/config/scheduler.ts` (repeatable jobs: licenças expirando, estoque baixo, autobackup, limpeza) · `apps/api/src/jobs/{audit,email,notification,observability,report}.job.ts`.
- DEPS: bullmq, ioredis.
- SEG: workers rodam fora da request → abrem `runWithRLSContext` próprio; jobId determinístico evita duplicata.
- TESTES: `jobs/audit.job.test.ts`, `jobs/notification.job.jobid.test.ts`, `config/scheduler.autobackup-jobid.test.ts`, `config/scheduler.cleanup.test.ts`.

### Autenticação / sessão / refresh
- RESP: login, `/auth/me`, refresh com rotação, logout, sessões por dispositivo, ativação.
- LOC: `apps/api/src/routes/auth.routes.ts` (`/login`, `/verify-mfa`, `/send-mfa-code`, `/me`, `/refresh`, `/logout`) · `apps/api/src/services/auth.service.ts` (par de tokens, tabela `refreshToken`, `session:<userId>` no Redis 15 min) · `apps/api/src/middleware/auth.ts` (`authMiddleware` — recusa token revogado —, `requireUserType`, `denyUserTypes`, `requireSuperAdmin`) · `apps/api/src/services/access-token-revocation.ts` (logout revoga o access token até o `exp`) · `apps/api/src/services/device-session.service.ts` · `apps/api/src/routes/activation.routes.ts`.
- DEPS: jsonwebtoken, bcrypt, `@ln-system/shared/utils/token.ts`.
- **Autorização de equipamento (2026-10-06):** `apps/api/src/services/device-enrollment.service.ts` (enroll/status/authorize/blockOrRevoke, chave só em hash) · `device-enrollment-limit.ts` (limites por IP das rotas públicas) · `routes/device-enrollment.routes.ts` (`/api/device/{enroll,status}`, **públicas**) · `routes/activation.routes.ts` (`/enrollments`, `/enrollments/:id/authorize`, block/revoke que derrubam a sessão) · `auth.service.ts::assertLoginDevice` (o portão do login) · `middleware/auth.ts` (confere `dsid`) · `middleware/https.ts` (426 em produção) · `middleware/device.ts` (guarda de caixa por equipamento: `devices.requiredUserTypes`, aplicada em `POST /sales`, `/payments`, `/cash-register/{open,close,movement,withdrawal}`) · `services/device-legacy.ts` (conjunto fechado + corte do legado sem chave) · `packages/shared/utils/installments.ts` (parcelamento em centavos, API e PDV; [PARCELAMENTO](policies/PARCELAMENTO.md)) · aplicativos (PDV = caixa, Balcão = atendimento, Web/Admin = administração; sem APK): [APLICATIVOS](APLICATIVOS.md) · cliente: `apps/pdv-desktop/src/{components/DeviceGate.tsx,services/{device-enrollment,device-state,server-url,server-config}.ts}` · Super Admin `app/dashboard/devices/page.tsx`. Fluxo e provas: [DISPOSITIVOS](DISPOSITIVOS.md).
- SEG: `rateLimitAuth` (conta só falhas), bloqueio de conta (`loginAttempts`/`lockedUntil`), reuso de refresh token detectado, desativar usuário/empresa derruba sessões; `LOGIN_FAILED`/`LOGIN` (MFA) auditados.
- TESTES: integração `refresh-token-reuse`, `user-deactivation-sessions`, `company-deactivation-sessions`, `email-case-insensitivity`, `logout-revokes-access`, `login-failed-audit`, `rate-limit-general-key`; `activation.service.test.ts`.

### MFA
- RESP: TOTP, backup codes, código por SMS/e-mail; desafio no login.
- LOC: `apps/api/src/services/MFAService.ts` · `apps/api/src/routes/mfa.routes.ts` (`/setup`, `/verify`, `/verify-backup`, `/send-sms`, `/send-email`, `/disable`) · login: `auth.service.ts` (`mfaRequired`) → `/auth/verify-mfa` · telas `apps/{mobile,tv}/src/screens/MfaScreen.tsx`, `apps/super-admin/app/login/page.tsx` · cofre `packages/shared/utils/secret-box.ts` (enc:v1) · doc `docs/CORTEX/SECURITY.md` (MFA).
- **Super Admin de TI e MFA obrigatório (2026-10-14):** `apps/api/src/services/super-admin-bootstrap.service.ts` (`planSuperAdminBootstrap`, `applySuperAdminBootstrap`, `beginMfaEnrollment`, `confirmMfaEnrollment`, `passwordProblem`) · CLI `apps/api/scripts/bootstrap-super-admin.ts` (`npm run admin:bootstrap`) · `auth.service.ts::mfaRequiredForPrivileged` + `MfaEnrollmentRequiredError` (403 em `auth.routes.ts`) · TESTES: integração `super-admin-bootstrap`, `permission-audit` (auditoria `PERMISSION_CHANGED` em `user.routes.ts`/`roles.routes.ts`). Procedimento: [PRODUCAO §13](PRODUCAO.md#13-primeiro-super-admin-bootstrap-e-mfa).
- **MFA de administradores, hash de senha e sessão sem Redis (2026-10-14, decisões 107/121/123):** `services/mfa-policy.ts` (quem exige MFA: `REQUIRE_MFA_*`) · `services/mfa-factor.service.ts` (`consumeTotp` anti-reuso, `beginEnrollment`/`confirmEnrollment`, `regenerateBackupCodes`, `resetFactor`) · `services/MFAService.ts` (TOTP em tempo constante, devolve o passo) · `auth.service.ts` (`beginMfaEnrollment`/`completeMfaEnrollment`, guarda de MFA no login e na renovação, tentativa de código que conta, `upgradePasswordHashIfNeeded`) · rotas `auth.routes.ts` (`/auth/mfa-enrollment/{begin,confirm}`), `mfa.routes.ts` (`/mfa/backup-codes/regenerate`, `/mfa/disable` recusado para perfil obrigado), `user.routes.ts` (`POST /users/:id/mfa/reset`, sem mudar o próprio perfil) · `packages/shared/utils/password.ts` (Argon2id + bcrypt legado, `passwordNeedsRehash`, `burnOtherAlgorithmCost`) · `packages/shared/utils/token.ts` (credencial de configuração) · `services/access-token-revocation.ts` (Redis + `access_revocations`, `AuthDependencyUnavailableError`) · `middleware/auth.ts` (401 × 503) · Admin Web `components/auth/MfaEnrollment.tsx`, `app/login/page.tsx` · TESTES: integração `mfa-company-admin`, `password-hash-migration`, `session-revocation-redis-outage`; unitário `password-hash.test`.
- **Pedidos de titular — LGPD (2026-10-14, decisão 120):** `services/privacy/privacy.service.ts` (`requestExport`, `downloadExport`, `purgeExpiredExports`, `computePlan`, `requestAnonymization`, `executeAnonymization`) · `routes/privacy.routes.ts` (`/api/privacy`, só COMPANY_ADMIN, reautenticação por senha) · job `purge-privacy-exports` (`config/scheduler.ts`) · schema `PrivacyRequest`, `Customer.anonymizedAt` · Admin Web `app/dashboard/privacy/page.tsx` · TESTE: integração `privacy-subject-requests`.
- **Imagem opcional do produto (2026-10-14, decisão 122):** `services/product-image-sanitizer.ts` (valida e remonta PNG/JPEG/WebP) · `services/product-image.service.ts` · rotas `GET/PUT/DELETE /products/:id/image`, `GET …/image/meta` em `products.routes.ts` · schema `ProductImage` · Admin Web `components/products/ImageCard.tsx` · TESTES: unitário `product-image-sanitizer.test`, integração `product-images`.
- **Segundo fator de uso único (rodada final, 2026-10-14):** `services/mfa-consume.ts` — `consumeTotp` (passo em `users.mfaLastStep`, atualização condicional), `consumeBackupCode` (compare-and-swap da lista), `consumeStoredOtp` (script Lua no Redis); usado por `auth.service.ts` (login), `routes/mfa.routes.ts` (`/verify`, `/verify-backup`), `mfa-factor.service.ts` (ativação, novos códigos; reexporta) e `dual-authorization.service.ts` (**dupla autorização**: retirada/fechamento forçado do caixa, cancelamento/devolução de venda, desconto, agenda). Teste: integração `dual-authorization-mfa-once` (7) + unitários `cash-register.service.withdrawal` e `sale.service.cancellation`.
- **Revisão do banco (2026-10-14/15, correção completa — 14 migrations novas):** `20261014155900…`/`160000…`/`161000…` (FK composta de `product_barcodes`/`product_images` + guarda), `20261014162000_rls_logs_roles_tighten`, `20261014170000_refresh_tokens_hash_and_company` (`services/refresh-token-hash.ts`: SHA-256 igual em SQL e na aplicação; usado por `auth.service`, `auth.routes`), `20261014180000_composite_company_fks` (94 FKs compostas), `20261015100000_company_and_branch_fks` (65 `companyId` + 55 filial), `20261015110000_cascade_to_restrict_history` (21 FKs), `20261015120000_append_only_ledgers`, `20261015130000_drop_duplicate_indexes`, `20261015140000_missing_fk_and_rls_indexes`, `20261015150000_database_timezone_utc`, `20261015160000_same_company_ref_triggers` (`enforce_same_company_ref`), `20261015170000_drop_redundant_company_indexes`. API: `services/db-errors.ts` (`isRestrictViolation`, `RECORD_IN_USE_MESSAGE`; usado por `middleware/errorHandler.ts` e `branch.service.delete`), `employee-agreement.service.lockForPayment` / `agreement-company.service.lockForPayment` (travar o pai antes do `INSERT` do pagamento), `middleware/idempotency.ts` (chave vencida = livre) e `config/scheduler.ts` (`cleanupOldLogs` exportada; expurga `idempotency_keys` vencidas), `services/support-sensitive.ts` (detector de cartão sem falso positivo em chave de NF-e/carimbo). Scripts: `db-replay-check.ts` (4 cenários com dado), `db-role-split-check.ts` (`npm run db:role-split-check [-- --suites | --all]`), `prepare-test-db.ts` (varre órfãs sintéticas só no banco de teste), `deploy/db-runtime-role.sql`. Testes de integração: `company-branch-fk-restrict`, `append-only-ledgers`, `database-schema-invariants`, `same-company-ref-triggers`, `refresh-token-isolation`; helpers `test/integration/helpers/purge-company.ts` (limpeza guiada pelo catálogo), `fixture.ts` (`destroyFixture`, `purgeNewDomainData`, `purgeStockMovements`, `deleteAppointmentsOf`).
- **Banco:** inventário e auditoria em [BANCO_DE_DADOS](BANCO_DE_DADOS.md); `scripts/db-inventory.ts` (`npm run db:inventory`, resumo), `scripts/db-docs.ts` (`npm run db:docs -- --write [--orphans]`: gera o Anexo A de BANCO_DE_DADOS, [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md), [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md), o bloco automático de [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md) e o pacote `revisao-banco/`), `scripts/db-replay-check.ts` (`npm run db:replay-check`: aplica as migrations do zero num banco temporário e compara com o dev), `scripts/password-bench.ts` (`npm run password:bench`: tempo/memória do Argon2id × bcrypt), `scripts/pg-sample.ts` (amostrador de conexões).
- DEPS: Redis (usado em `mfa.routes.ts` para códigos SMS/e-mail), `demo-tools.ts totp` para E2E.
- SEG: `rateLimitMFA` (só falhas); setup/disable auditados.
- TESTES: `services/MFAService.test.ts`, `routes/mfa.routes.setup.test.ts`; integração `mfa-secret-at-rest`, `secret-migration`.

### RBAC (permissões e papéis)
- RESP: tipos de usuário (SUPER_ADMIN, COMPANY_ADMIN, MANAGER, OPERATOR, MECHANIC) + permissões por papel (`finance:pay`, `stock:adjust`, `purchases:approve`…).
- LOC: `apps/api/src/middleware/permission.ts` (`requirePermission`, `requireAllPermissions`, `requireBranchAccess`, cache de permissões) · `apps/api/src/middleware/auth.ts` (gates por tipo) · `apps/api/src/routes/{roles,permissions,user}.routes.ts` · `apps/api/src/services/{role,user}.service.ts` · UI `apps/admin-web/lib/role-gates.ts`.
- DEPS: Redis (cache de permissões, invalidação em `invalidateUser/RolePermissionsCache`).
- SEG: SUPER_ADMIN passa em `requirePermission`; COMPANY_ADMIN tem a lista enumerada `COMPANY_ADMIN_PERMISSIONS`; VIEWER nunca passa; perfil com filial só vale nela. Matriz: `docs/CORTEX/contracts/permission-matrix.md`.
- TESTES: `middleware/permission.test.ts`, `user.routes.privilege-escalation.test.ts`, `user.routes.list-filters.test.ts`; integração `rbac`, `default-profiles`, `permission-role-scope`, `user-update-fields`, `users-list-filters`, `mechanic-read-scope`; admin `lib/role-gates.test.ts`.

### Auditoria
- RESP: trilha de ações (CREATE/UPDATE/DELETE…) com redação de campos sensíveis.
- LOC: `apps/api/src/middleware/audit.ts` (`auditLog(action, entity)`, `redactSensitive`, `createAuditLog`) → fila `audit-log` → `apps/api/src/jobs/audit.job.ts` · `apps/api/src/services/audit-log.service.ts` · `apps/api/src/routes/audit-logs.routes.ts` · UI `apps/super-admin/app/dashboard/audit-logs/`.
- DEPS: BullMQ, Prisma (`AuditAction`).
- SEG: leitura só SUPER_ADMIN/COMPANY_ADMIN/MANAGER; `audit_logs` append-only no Postgres (migração `20260925100000_audit_logs_append_only`; expurgo só pelo agendador com `app.audit_purge`). Eventos: `docs/CORTEX/contracts/audit-event-matrix.md`.
- TESTES: `middleware/audit{,.payload}.test.ts`, `jobs/audit.job.test.ts`, `routes/audit-logs.routes.test.ts`; integração `audit-log-append-only`, `audit-content`.

### Módulos (liga/desliga por empresa/filial)
- RESP: `SystemModule` = ESTOQUE, COMPRAS, VENDAS, FINANCEIRO, FISCAL, OFICINA, POS_VENDA e **CANAIS** (2026-10-05; o único que nasce desligado — `DEFAULT_DISABLED_MODULES` em `module-settings.service.ts`).
- LOC: `apps/api/src/middleware/module.ts` (`requireModuleEnabled`) · `apps/api/src/services/module-settings.service.ts` · `apps/api/src/routes/module-settings.routes.ts` · migrações `20260915110038_add_company_module_settings` (+`_rls`) · UI `apps/admin-web/lib/navigation.ts`, `apps/admin-web/app/dashboard/settings/page.tsx`, `components/layout/Sidebar.tsx`.
- DEPS: Redis (cache do estado), Prisma.
- SEG: gate aplicado no `router.use` do arquivo de rota; SUPER_ADMIN nunca bloqueado; `/module-settings` só SUPER_ADMIN/COMPANY_ADMIN e auditado.
- TESTES: `middleware/module.test.ts`, `module-settings.service.test.ts`, `module-settings.cache.test.ts`; integração `module-settings`, `module-settings-scope`; admin `lib/navigation.test.ts`.

### Políticas por empresa/filial, horário de funcionamento, cadastro da empresa
- RESP: regras que variam por empresa/filial (desconto, caixa, orçamento, agenda, garantia, convênios, cobrança, fiscal) com padrão, origem, motivo e histórico; horário semanal + exceções; cadastro da empresa.
- LOC: `apps/api/src/services/policy.service.ts` (`POLICY_CATALOG`, `policyService.get/resolve/set/reset/history`) · `business-hours.service.ts` (`isOpenAt`) · `company-profile.service.ts` · routes `policies`, `business-hours`, `company-profile` · migrações `20260927100000_policies_and_new_domains`, `20260927100500_evidence_purge_policy` · UI `apps/admin-web/components/settings/{PolicySettings,BusinessHoursSettings,CompanyProfileSettings}.tsx`, `lib/policies.ts`, `lib/api/policies.ts`.
- DEPS: Prisma (`policy_settings`, `policy_changes`, `business_hours`, `business_calendar_exceptions`).
- SEG: escrita só SUPER_ADMIN/COMPANY_ADMIN, motivo obrigatório, auditada; chaves de autorizador não aceitam sobreposição por filial; CNPJ/CPF só Super Admin; filial do pedido conferida contra a empresa do token. Doc: `docs/CORTEX/POLICIES.md`.
- TESTES: integração `policies-foundation` (19); admin `lib/policies.test.ts`.

## Domínios de negócio

### Estoque (módulo ESTOQUE)
- RESP: produtos, categorias, movimentação, inventário, avarias, transferências, importação Excel.
- LOC: routes `products`, `categories`, `stock`, `inventory`, `damage`, `transfers`, `import` (`apps/api/src/routes/`) · services `product`, `category`, `stock`, `stock-ledger` (saldo calculado no banco, um ou vários produtos), `inventory`, `damage`, `transfer`, `import` (lote `import_batches`, simulação, linha a linha), `import-normalizers` · UI `apps/admin-web/app/dashboard/{products,inventory,inventory/sessions,inventory/transfers,damage}/`, `components/import/ExcelImportDialog.tsx`, `lib/excel-parser.ts`.
- DEPS: Redis cache, xlsx (front).
- SEG: `stock:adjust`, `stock:transfer`, `idempotency()` em stock; guarda de estoque negativo; 1 inventário em andamento por filial (migração `20260914233256_…`).
- **Códigos de barras múltiplos (2026-10-14):** `apps/api/src/services/product-barcode.service.ts` (`normalizeBarcode`, `syncPrimary`, `add`, `setActive`, `list`) · rotas `GET/POST /products/:id/barcodes` e `PATCH …/barcodes/:barcodeId` em `routes/products.routes.ts` (`BARCODE_IN_USE` 409) · `product.service.ts`/`import.service.ts` sincronizam o principal na transação · schema `ProductBarcode` (`20261014100000_product_barcodes`) · Admin Web `components/products/BarcodesCard.tsx` · TESTES: integração `product-barcodes`, `product-code-resolution`; E2E `catalog-and-help`.
- TESTES: `stock.service.test.ts`, `product.service.*.test.ts`, `category.service.test.ts`, `damage.service.*.test.ts`, `transfer.service.stock-guard.test.ts`, `import-normalizers.test.ts`, routes `products/categories/inventory/transfers.routes.test.ts`; integração `stock-adjustment-branch`, `stock-workshop-write-gates`, `products-filters`, `import-routes`, `import-batches`, `stock-ledger` (SQL = regra em memória); mock `services/__mocks__/stock-ledger.ts`.

### Vendas (módulo VENDAS)
- RESP: venda, cancelamento, devolução, descontos, parceiros, políticas de parcelamento, estatísticas.
- LOC: routes `sales`, `discount-rules`, `partners`, `installment-policies` · services `sale`, `sale-refund` (rateio do estorno), `discount`, `partner`, `installment-policy`, `dual-authorization` · UI `apps/admin-web/app/dashboard/{sales,discounts}/`, `components/sales/CancelSaleDialog.tsx`, `lib/sales.ts`; PDV `src/pages/POSPage.tsx`.
- DEPS: pagamentos, estoque, caixa.
- SEG: `denyUserTypes('MECHANIC')`, `idempotency()`, `rateLimitAuthorizer` (autorizador em cancel/devolução), auditado.
- TESTES: `sale.service{,.cancellation,.return,.stats}.test.ts`, `sale-refund.test.ts`, integração `sale-reversal-integrity`, `sales.routes{,.return}.test.ts`, `discount-rules.routes.test.ts`, `partners.routes.test.ts`; integração `sale-input-validation`, `sales-search`, `concurrency`.

### Financeiro / caixa / pagamentos (FINANCEIRO, VENDAS)
- RESP: contas a pagar/receber, estorno, caixa (abrir/fechar/sangria), pagamentos com adapters.
- LOC: routes `financial`, `cash-register`, `payments` (inclui `/payments/exceptions`), `payment-settings` · services `financial`, `cash-register`, `payment` (liquidação, reconciliação, exceções), `payment-settings`, `cash-breakdown` · `apps/api/src/services/payment-adapters/` (`index` = registro de provedores; `cash`, `manual-card`, `pending-manual`) · UI `apps/admin-web/app/dashboard/financial/page.tsx`, `lib/financial.ts`; PDV `CashRegisterPage.tsx`, `WithdrawalModal.tsx`, `PaymentModal.tsx`.
- DEPS: Prisma transações (`runInTransaction`), migração `20260915130221_add_accounts_reversal_unique_reference`.
- CAIXA (2026-09-28): `cash-register.service.ts::expectedByMethod` (esperado por forma; estornos atribuídos/rateados), `closingSummary`, `CashDifferenceReasonRequiredError`; PDV `components/CashCloseModal.tsx` + `services/cash-close.ts`; teste `cash-close-by-method` (8), `scripts/cash-close.test.ts` (5). Doc: `policies/CAIXA.md`.
- SEG: `finance:manage`/`finance:pay`/`finance:reverse`; RLS por filial em derivados financeiros (`20260921120000_…`); `idempotency()` + autorizador na sangria; caixa operado só pelo dono/gerência da filial/admin.
- TESTES: `financial.service.reversal-race.test.ts`, `cash-register.service{.close-race,.tenant-isolation,.withdrawal}.test.ts`, `payment.service.test.ts`, `cash-register.routes.test.ts`, `payments.routes.test.ts`; integração `financial-write-gates`, `cash-register-owner`, `payment-exceptions`, `payment-terminal-reconciliation`, `payment-cancel-race`, `cash-payment-change`, `payment-settings-cash-breakdown`, `cash-movement-race`; admin `lib/financial.test.ts`.

### Devolução ao fornecedor (módulo COMPRAS)
- RESP: devolução de produto/peça à cadeia de fornecimento (não é garantia ao cliente): solicitação → aprovação (retira estoque) → envio → resultado → histórico.
- LOC: `apps/api/src/services/supplier-return.service.ts` · `routes/supplier-returns.routes.ts` · livro de estoque `stock-ledger.ts` (`SUPPLIER_RETURN` é saída) · UI `apps/admin-web/app/dashboard/purchases/returns/{,new,[id]}/`, `lib/supplier-returns.ts`, `lib/api/supplier-returns.ts`.
- DEPS: `supplier_returns`, `supplier_return_items`, `supplier_return_events`; política `supplierReturn.approverRoles`; numeração com trava 4220 + `withCompanyWideRead`.
- SEG: MECHANIC negado; aprovador ≠ solicitante; guarda de status; saldo conferido com trava; idempotência e auditoria. Doc: `docs/CORTEX/policies/DEVOLUCAO-FORNECEDOR.md`.
- TESTES: integração `supplier-returns` (16), `stock-ledger`; admin `lib/supplier-returns.test.ts`.

### Compras (módulo COMPRAS)
- RESP: fornecedores, pedidos de compra (aprovação, recebimento → estoque).
- LOC: routes `suppliers`, `purchase-orders` · services `supplier`, `purchase-order` · UI `apps/admin-web/app/dashboard/{purchases,suppliers}/`.
- DEPS: estoque, financeiro.
- SEG: `purchases:manage`/`approve`/`receive`, `idempotency()`, MECHANIC negado.
- TESTES: `purchase-order.service{,.integrity}.test.ts`, `supplier.service.tenant-isolation.test.ts`, `suppliers.routes.test.ts`; integração `purchase-order-integrity`, `purchase-orders-list`.

### Oficina / OS (módulo OFICINA)
- RESP: ordens de serviço, mecânicos, comissões, motos, checklist de entrada.
- LOC: routes `service-orders`, `mechanics`, `commission-rules`, `motorcycles` · services `service-order`, `mechanic`, `motorcycle`, `vehicle-entry-checklist` · UI `apps/admin-web/app/dashboard/{service-orders,mechanics,motorcycles}/`; mobile `ServiceOrders*Screen.tsx`; TV `PainelScreen.tsx`.
- DEPS: estoque (peças), financeiro (`finance:pay` no faturamento da OS).
- SEG: tipos até MECHANIC em leitura/escrita limitada; OS só é paga em PRONTO/ENTREGA (`PAYABLE_STATUSES`); auditado.
- TESTES: `service-order.service.test.ts`, `service-orders.routes.test.ts`, `motorcycle.service.tenant-isolation.test.ts`, `motorcycles.routes.test.ts`; integração `workshop-authorization`, `mechanic-read-scope`, `stock-workshop-write-gates`; admin `lib/service-orders.test.ts`.

### Orçamentos (módulo OFICINA)
- RESP: orçamento com itens, aprovação e conversão em OS/venda.
- LOC: `apps/api/src/routes/quotes.routes.ts` · `apps/api/src/services/quote.service.ts` · UI `apps/admin-web/app/dashboard/quotes/{,new,[id]}/`, `components/quotes/*`, `lib/quotes.ts`.
- DEPS: clientes, motos, produtos, OS.
- SEG: módulo OFICINA; conversão protegida contra corrida; vencido/encerrar/reabrir por política (`quote.*`), histórico em `quote_events`, rotina `expire-overdue-quotes` (só com `quote.autoExpire`). Doc: `docs/CORTEX/policies/ORCAMENTO.md`; pendências: DECISIONS 13.
- TESTES: `quote.service.convert-race.test.ts`, `quote.service.validation.test.ts`, `quotes.routes.test.ts`; integração `quote-lifecycle`; admin `lib/quotes.test.ts`.

### Agenda / revisões / pós-venda (módulo POS_VENDA)
- RESP: revisões programadas, follow-ups pós-venda, agendamentos.
- LOC: routes `revisions`, `follow-ups`, `appointments` · services `revision`, `follow-up`, `appointment` · `packages/shared/src/validators/revision.validators.ts` · migrações `20260914154506_add_revisions_postsale_agenda` (+`_rls`) · UI `apps/admin-web/app/dashboard/post-sale/page.tsx`; mobile `AgendaScreen.tsx`; TV `PainelScreen.tsx`.
- DEPS: clientes, motos, OS.
- SEG: `requireModuleEnabled('POS_VENDA')`; tipos até MECHANIC; auditado.
- TESTES: `revision.service.test.ts`, `follow-up.service.test.ts`, `appointment.service.test.ts`, routes `revisions/follow-ups/appointments.routes.test.ts`; integração `revisions-agenda`, `agenda-rules` (confirmação com evidência, transições com guarda), `agenda-capacity-completion`, `agenda-capacity-resources` (20). Capacidade (2026-09-28): `services/agenda-capacity.service.ts` (duração, boxes, dia/mês, mecânico, indisponibilidades, trava 4210 por filial + 4211 por mecânico), `GET /appointments/availability`, `/appointments/unavailabilities`, UI `components/agenda/AgendaCapacity.tsx`. Regras: `docs/CORTEX/policies/AGENDA.md`.

### Desconto por política e Conciliação (VENDAS, OFICINA, FINANCEIRO)
- RESP: limite livre por tipo de item (peça/produto 5%, serviço 0%), autorização acima dele, evento de desconto imutável; desconto da OS; tela de inconsistências de integração (pagamento aprovado com venda encerrada).
- LOC: services `discount-policy` (`evaluateDiscount`, `authorizeDiscount`, `recordDiscountEvents`, `DiscountAuthorizationRequiredError`), `service-order-discount`, `sale` (parte de desconto) · routes `discount-events`, `service-order-discount` (`/service-orders/:id/discount`) · UI `apps/admin-web/components/service-orders/ServiceOrderDiscountPanel.tsx`, `app/dashboard/financial/reconciliation/page.tsx`; PDV `src/components/DiscountAuthorizationDialog.tsx`, `src/store/discountAuthorization.store.ts`.
- DEPS: `policy.service`, `dual-authorization.service`, `DiscountRule` (só restringe mais), tabela `discount_events` (só SELECT/INSERT).
- SEG: solicitante ≠ autorizador, motivo obrigatório, `rateLimitAuthorizer`. Doc: `docs/CORTEX/policies/DESCONTO.md`.
- TESTES: `discount-policy.service.test.ts`; integração `discount-cash-fiscal-policies`, `sale-input-validation`, `payment-exceptions`.

### Garantia (módulo OFICINA)
- RESP: decisão de garantia no encerramento da OS, vigência "o que ocorrer primeiro" (prazo × km), ocorrências ligadas à OS original.
- LOC: `apps/api/src/services/warranty.service.ts` · `routes/warranties.routes.ts` · gancho em `service-order.service.ts::transitionStatus` · UI `components/service-orders/{CloseServiceOrderDialog,WarrantyCard}.tsx`, `components/post-sale/WarrantyPanel.tsx`, `lib/warranty.ts`, `lib/api/warranties.ts`.
- DEPS: `service_order_warranties`, `warranty_claims`, política `warranty.*`.
- SEG: decidir ocorrência só gerência+; VIEWER não registra; garantia é evidência (sem edição). Doc: `docs/CORTEX/policies/GARANTIA.md`.
- TESTES: `warranty.service.test.ts`, `service-order.service.test.ts`; integração `warranty`; admin `lib/warranty.test.ts`.

### Convênios, recebíveis e cobrança manual (FINANCEIRO)
- RESP: convênio de funcionário (limite fixo/% do salário, parcelas por competência, folha, espelho) e empresa conveniada (prazo, limite, vencimento, bloqueio); cobrança manual por WhatsApp/e-mail com histórico.
- LOC: services `employee-agreement`, `agreement-company`, `agreement-common`, `agreement-effects` (reverte no cancelamento/devolução), `collection`, `channels/{index,types,whatsapp-link.provider,email.provider}` · routes `employee-agreements`, `agreement-companies`, `receivables` · pagamento em `payment.service.ts::processAgreementPayment` · job `auto-block-agreement-companies` (`config/scheduler.ts`) · UI `apps/admin-web/app/dashboard/agreements/**`, `app/dashboard/financial/receivables/[id]/page.tsx`, `lib/api/agreements.ts`; PDV `src/components/AgreementPaymentPanel.tsx`.
- DEPS: `employee_agreements`, `employee_agreement_charges`, `employee_payroll_deductions`, `agreement_companies`, `collection_attempts` (só SELECT/INSERT); política `employeeAgreement.*`, `companyAgreement.*`, `collection.*`.
- SEG: cadastrar/alterar/desbloquear só administração (`ADMIN_ROLES`); uso por filial (`allowedBranchIds`, filial da venda, 409 `AGREEMENT_NOT_ENABLED_FOR_BRANCH`); convênio com `branchId` nulo (limite vale para a empresa toda); `FOR UPDATE` no convênio; cobrança só Gerente/Admin, uma tentativa por canal, **sem envio automático**. Docs: `docs/CORTEX/policies/{CONVENIOS,FINANCEIRO,COBRANCA}.md`.
- TESTES: integração `agreements` (27); admin `lib/agreements-nav.test.ts`.

### Fiscal (módulo FISCAL)
- RESP: configuração fiscal e documentos (NF); provedor real ainda não integrado.
- LOC: `apps/api/src/routes/fiscal.routes.ts` · `apps/api/src/services/fiscal.service.ts` · `apps/api/src/services/fiscal-adapters/{types,unconfigured-adapter}.ts` · UI `apps/admin-web/app/dashboard/fiscal/page.tsx`, `lib/fiscal.ts`.
- DEPS: adapter plugável (hoje só `unconfigured-adapter`).
- SEG: escrita `FISCAL_WRITER_ROLES`; config só SUPER_ADMIN/COMPANY_ADMIN; segredos não retornam na leitura; venda cancelada/pendente/parcial não é emitida e `fiscal.enabledOperations` é respeitada (`docs/CORTEX/policies/FISCAL.md`).
- TESTES: `fiscal.service.test.ts`, `fiscal.service.config.test.ts`; integração `fiscal-config-secrets`; admin `lib/fiscal.test.ts`.

### Outros endpoints de plataforma
- RESP: empresas, filiais, licenças, backup, dashboard (painéis antigos `/ceo`, `/workshop`, `/pdv`, `/financial`; o gerencial está em "Dashboard gerencial"), observabilidade, saúde, clientes.
- LOC: routes `company`, `branch`, `license`, `backup`, `dashboard`, `observability`, `health`, `customers` · services `company`, `branch`, `license`, `BackupService`, `dashboard`, `observability`, `customer`.
- DEPS: Prisma, Redis, filas.
- SEG: `requireSuperAdmin` (company, observability, backup `backup:*`); dashboard com `requireModuleEnabled` por bloco e `companyScoped({ except: ['/super-admin'] })`.
- TESTES: `branch.service.test.ts`, `dashboard.service.test.ts`, `observability.service.test.ts`, `observability.routes.tenant-isolation.test.ts`, `customers.routes.test.ts`, `customer.service.tenant-isolation.test.ts`, `document-validation.test.ts`; integração `customer-reactivation`.

### Dashboard gerencial (módulo VENDAS; contas e OS seguem FINANCEIRO e OFICINA) — IMPLEMENTADO E HOMOLOGADO (2026-10-05)
- RESP: painel do Administrador e do Gerente com período único em Brasília, comparação, KPIs, evolução, origem das vendas, formas de pagamento, caixa e operação. Doc: `docs/CORTEX/DASHBOARD_GERENCIAL.md`.
- LOC: API — `utils/dashboard-period.ts` (`resolveDashboardPeriod`, `granularityFor`; regra única), `utils/time-zone.ts` (`startOfLocalDate`), `services/dashboard-management.service.ts` (resumo e séries; `comparison`, `DEFINITIONS`), `routes/dashboard.routes.ts` (`MANAGEMENT_ROLES`, `managementScope`, `periodRange`; rotas `/management/summary` e `/management/timeseries`). Admin Web — `lib/dashboard-management.ts`, `components/dashboard/{ManagementDashboard,PeriodPicker,ManagementKpis,PaymentMethodsPanel,ManagementCharts}.tsx`, `components/charts/{TimeSeriesChart,ChartTooltip,DonutChart}.tsx`, `app/dashboard/page.tsx`.
- DEPS: `sales`, `sale_items`, `payments`, `cash_movements`, `service_orders`, contas, `sales_channels`; módulos VENDAS, FINANCEIRO, OFICINA e CANAIS.
- SEG: `requireUserType(SUPER_ADMIN, COMPANY_ADMIN, MANAGER)`; o MANAGER é forçado à própria filial; RLS; uma transação de leitura por endpoint (20 s); sem cache e sem índice novo. `/sales`, `/stock` e `/ceo` ganharam o mesmo gate (OPERATOR, VIEWER e MECHANIC: 403).
- TESTES: `utils/dashboard-period.test.ts` (21); integração `dashboard-management` (26: períodos, virada de dia/mês/ano, RLS, perfis, operações); Admin Web `lib/dashboard-management.test.ts` (8); HML `ui-evidence.js` fase `gerencial`.
- RESÍDUO: SUPER_ADMIN (contexto de empresa), MECHANIC, OPERATOR e VIEWER seguem no painel antigo em `app/dashboard/page.tsx` (`/ceo`, `/workshop`, `/pdv`), com a janela de 30 dias calculada no navegador (`resolvePeriodRange`).

### Canais de venda (módulo CANAIS, desligado por padrão) — PREPARADO / BASE (2026-10-05)
- RESP: origem da venda, canal com credencial cifrada e estado de conexão, pedido externo idempotente, camada genérica de integração. **Não é e-commerce e não há integração real.** Doc: `docs/CORTEX/CANAIS.md`.
- LOC: API — `services/sales-channels/{gateway,sales-channel.service,external-order.service}.ts`, `routes/sales-channels.routes.ts` (só COMPANY_ADMIN e SUPER_ADMIN), `services/module-settings.service.ts` (opt-in), schema `SalesChannel`, `ChannelEvent`, `ExternalOrder`, `ChannelInboundEvent`, `Sale.channelId` (migração `20261004200000_sales_channels`). Admin Web — `app/dashboard/channels/page.tsx`, `lib/sales-channels.ts`.
- DEPS: `secret-box` (`enc:v1`), `audit` (`auditLog`), `module.ts`.
- SEG: RLS `FORCE` por empresa e filial; credencial nunca devolvida; sem rota pública de webhook; entrada com esquema fechado, idempotência (canal, evento, operação) e assinatura HMAC com janela de tempo (função do gateway, sem rota que a use).
- TESTES: `sales-channels/gateway.test.ts` (14); integração `sales-channels` (21).
- NÃO EXISTE: provedor REAL (o registro só tem o simulado, fora de produção) e sincronização automática por gatilho. Webhook de entrada, caixa de saída e sincronização sob demanda existem desde a Fase 3 (ver abaixo).

### Commerce API (módulo CANAIS) — Fase 1 IMPLEMENTADA (2026-10-05)
- RESP: porta pública (`/commerce/v1`) para um site/e-commerce: catálogo publicado, pedido externo (não é venda), pagamento externo recebido; mais a administração (credenciais, publicação, pedidos). Doc e contrato: `docs/CORTEX/COMMERCE_API.md`, `docs/CORTEX/commerce-api.openapi.yaml`.
- LOC: API — `routes/commerce.routes.ts` (montada em `index.ts` antes do CORS global), `middleware/channel-auth.ts` (`channelAuth(escopo)`, `commerceJson`), `middleware/idempotency.ts` (modo `required`, empresa do canal), `services/commerce/{signature,credentials.service,rate-limit,catalog.service,order.service,payment-events.service,publication.service,errors}.ts`, administração em `routes/sales-channels.routes.ts` (`/:id/api-credentials`, `/products`, `/orders`); schema `ChannelApiCredential`, `ChannelProductLink`, `ExternalOrderItem`, `ExternalPayment` (migração `20261005100000_commerce_api_foundation`). Admin Web — `components/channels/CommerceApiPanel.tsx`, `lib/sales-channels.ts`, `lib/api.ts`.
- DEPS: `secret-box` (segredo `enc:v1`), `stock-ledger` (só leitura, projeção), `module-settings`, Redis (só contadores de limite), `idempotency_keys`.
- SEG: ver [SECURITY](SECURITY.md#commerce-api-2026-10-05); RLS `FORCE` empresa+filial nas 4 tabelas; contexto `CHANNEL`.
- TESTES: unitário `services/commerce/commerce.test.ts` (17); integração `commerce.integration.test.ts` (43); Admin Web `lib/sales-channels.test.ts` (5).
- NÃO EXISTE: chave publicável/CORS, webhook de saída, sincronização para terceiros.

### Reserva de estoque e pedido → venda (módulo CANAIS) — Fase 2 IMPLEMENTADA (2026-10-05)
- RESP: aceitar pedido = reservar estoque; converter pedido pago em venda de canal (sem caixa físico); entrega mínima; disponível = saldo − reservas vivas, conferido por toda saída comercial.
- LOC: API — `services/stock-reservations.ts` (`lockProductsInOrder`, `reservedFor`, `reservedByProduct`, `availabilityOf`, `releaseReservations`, `reservationShortfalls`), `services/commerce/{reservation,convert}.service.ts` (`acceptOrder`, `expireDue`, `convertOrder`, `fulfillmentService`), rotas `accept`/`convert`/`fulfillment` em `routes/sales-channels.routes.ts`, job `expire-stock-reservations` em `config/scheduler.ts` e `config/scheduled-jobs.ts`; saídas que conferem reservas: `sale.service.ts`, `service-order.service.ts`, `transfer.service.ts`, `stock.service.ts`, `supplier-return.service.ts`; schema `StockReservation`, `Fulfillment`. Admin Web — `components/channels/CommerceApiPanel.tsx`.
- DEPS: livro `stock_movements`, `external_orders`/`external_payments`, BullMQ (só o agendamento da expiração; a verdade é o PostgreSQL).
- SEG: RLS `FORCE` empresa+filial; ordem de trava pedido → advisory 4202 → produtos por id; `CHECK sales_physical_origin_check`.
- TESTES: integração `commerce-reservations.integration.test.ts` (25), unitários em `services/commerce/commerce.test.ts` e `lib/sales-channels.test.ts`.

### Integration Gateway (módulo CANAIS) — Fase 3 IMPLEMENTADA (2026-10-06, só provedor simulado)
- RESP: camada genérica de provedores externos: webhook de entrada assinado e idempotente, consulta periódica, caixa de saída com retentativa e disjuntor, sincronização sob demanda. Doc: `docs/CORTEX/INTEGRATION_GATEWAY.md`.
- LOC: API — `services/integrations/{contract,inbound.service,outbox.service,poller,sandbox.provider}.ts`, `routes/integrations.routes.ts` (montada em `index.ts`), `middleware/{webhook-auth,commerce-error-handler}.ts`, contrato `ChannelProvider` em `services/sales-channels/gateway.ts`, rotas `/:id/outbox` e `/:id/sync/:kind` em `routes/sales-channels.routes.ts`, jobs `process-channel-outbox` e `poll-channel-events` (`config/scheduler.ts`, `config/scheduled-jobs.ts`); ganchos da caixa de saída em `commerce/{order,reservation,convert}.service.ts`; schema `ChannelOutbox`, colunas de `ChannelInboundEvent`, `SalesChannel.inboundCursor`. Admin Web — `components/channels/IntegrationPanel.tsx`.
- DEPS: serviços da Commerce API (pedido, pagamento, cancelamento, catálogo), `secret-box`, `rate-limit` (Redis só como contador), BullMQ (só dispara os jobs; a fila é o PostgreSQL).
- SEG: assinatura HMAC com janela, mesmo 401, empresa/filial do canal no banco, RLS `CHANNEL`; ver [SECURITY](SECURITY.md#integration-gateway-2026-10-06).
- TESTES: integração `integration-gateway.integration.test.ts` (36); unitários `services/integrations/integrations.test.ts` (14); Admin Web `lib/sales-channels.test.ts`.
- NÃO EXISTE: provedor real, sincronização automática, devolução/estorno de canal.

### Operação e produção (Fase 4, 2026-10-06)
- RESP: validação da configuração na partida, desligamento ordenado, sondas de saúde, auditoria durável, endurecimento de autenticação. Docs: `docs/CORTEX/PRODUCAO.md`, `DIAGNOSTICO_PRODUCAO.md`.
- LOC: API — `config/env.ts` (`validateEnv`, `assertEnv`, `parseTrustProxy`), `config/shutdown.ts` (`shutdown`, `registerGracefulShutdown`, `isShuttingDown`), `config/queue.ts` (`closeQueueInfra`, `workersRunning`), `routes/health.routes.ts`, `middleware/audit.ts` (`recordAudit`) e `jobs/audit.job.ts` (`persistAuditLog`, idempotente por id), `services/auth.service.ts` (login sem enumeração), `packages/shared/utils/token.ts` (`verifyAccessToken` só aceita sessão de usuário), `index.ts` (liga tudo); `scripts/check-doc-links.js`; `docker-compose.yml`, `.github/workflows/ci.yml`.
- TESTES: unitários `config/{env,shutdown}.test.ts`, `routes/health.routes.test.ts`, `middleware/audit.durable.test.ts`; integração `auth-coverage`, `token-confusion`, `audit-durable`, `login-enumeration`.
- NÃO EXISTE: infraestrutura de produção, backup contínuo, CSP, cookie `HttpOnly`, rotação da `DATA_ENCRYPTION_KEY`.

### Comissão — PARCIAL
- RESP: comissão de mecânico sobre a mão de obra da OS, com a política `commission.enabled`. Doc: `docs/CORTEX/policies/COMISSAO.md`.
- LOC: `services/policy.service.ts` (`commission.enabled`), `services/service-order.service.ts` (`registerPayment`), `services/mechanic.service.ts`, routes `mechanics` e `commission-rules`, schema `CommissionRule` e `MechanicCommission` (`ruleSnapshot`). UI `apps/admin-web/app/dashboard/mechanics/`.
- TESTES: `service-order.service.test.ts` (inclui o caso com a política desligada).
- NÃO EXISTE: comissão sobre venda (`sale.service.ts` não tem referência a comissão), fechamento, liquidação, estados completos, dashboard de comissão.

### Central de Ajuda e Suporte (todos os módulos)
- RESP: a empresa busca artigos e abre/acompanha chamados com contexto; a plataforma atende; base de conhecimento por texto (sem IA). Regras, contratos e limites: `docs/CORTEX/SUPPORT.md`.
- LOC: API — routes `support.routes.ts` (`/support`, `/support-kb`, `/support-admin`) · services `support.service.ts` (chamados, mensagens, situação, contexto, anexos, painel), `support-kb.service.ts`, `support-catalog.ts` (módulos, tipos, prioridades, situações — fonte única), `support-attachment.ts` (validação por bytes), `support-sensitive.ts` (recusa cartão) · schema `SupportTicket*`/`SupportKb*` (migração `20260928200000_support_center`). Admin Web — `app/dashboard/help/**`, `components/support/{ReportProblemButton,HelpTabs}.tsx`, `lib/support.ts`, `lib/api/support.ts`, contador no `components/layout/Sidebar.tsx`. Super Admin — `app/dashboard/support/**` (`_components`, `_lib`), `supportAdminApi` em `lib/api.ts`. PDV — `src/components/ReportProblemModal.tsx`, `src/services/support-report.ts`, `createSupportTicket` em `services/api.ts`.
- DEPS: Postgres (FTS em português), `idempotency()`, `auditLog`, `runInTransaction`; permissão `support:view_company`.
- SEG: RLS FORCE; mensagens/eventos append-only; ids só da autenticação (`.strict()`); leitura do SUPER_ADMIN auditada; anexo sem URL pública (`attachment` + `nosniff` + `no-store`); cartão completo recusado.
- TESTES: integração `support.integration.test.ts`; unitários `support-attachment.test.ts`, `support-sensitive.test.ts`; Admin Web `lib/support.test.ts`; PDV `scripts/support-report.test.ts` (`npm run test:logic`); navegador real em 2026-10-04.

### Monitoramento e telemetria (Super Admin)
- RESP: saúde por Empresas → Empresa → Filiais → Filial a partir de dados reais; alertas; limites configuráveis; telemetria dos equipamentos.
- LOC: routes `monitoring`, `telemetry`, `observability` · services `monitoring` (saúde, séries, `evaluateIncidents`, alertas com deduplicação), `monitoring-thresholds` (catálogo de métricas, padrões, tetos, histórico), `health-status`, `telemetry`, `observability` (banco, Redis, filas, jobs atrasados) · job `evaluate-health-1min` (`config/scheduler.ts`) · UI `apps/super-admin/app/dashboard/companies/` (empresa, filial, `[id]/thresholds`, `_components/alert-list.tsx`) · PDV `electron/main.ts` (coleta: CPU/RAM/disco, latência, versão do app e do runtime).
- DEPS: `request_logs` (fila request-metrics), `device_telemetry`, `health_incidents`, `monitoring_thresholds`, `monitoring_threshold_changes`, `monitoring_alerts`.
- SEG: leitura e limites só SUPER_ADMIN (limites auditados, com motivo e teto por métrica); telemetria autenticada pela sessão do equipamento. "Sem dados" nunca vira "normal".
- TESTES: `monitoring.service.test.ts`; integração `monitoring-thresholds-alerts`; PDV `smoke:electron` (versão do app).

### Segredos e backup
- RESP: cifrar segredos em repouso; migrar segredos legados; backup e conferência de restauração.
- LOC: `packages/shared/utils/secret-box.ts` (AES-256-GCM, `enc:v1`, `DATA_ENCRYPTION_KEY` obrigatória na partida) · `apps/api/src/services/secret-migration.service.ts` + `scripts/encrypt-secrets.ts` (`npm run secrets:encrypt`) · `apps/api/src/services/BackupService.ts` (role `BACKUP_DATABASE_URL`) · `apps/api/scripts/verify-backup-restore.ts` (`npm run backup:verify`, 18 verificações).
- SEG: chave nunca no repositório nem em log (CI gera a cada execução); segredos fiscais nunca devolvidos na leitura. Doc: `docs/CORTEX/SECURITY.md`.
- TESTES: `utils/secret-box.test.ts`; integração `mfa-secret-at-rest`, `fiscal-config-secrets`, `secret-migration`, `rls-platform-users`.

## Design system (Admin Web)
- RESP: identidade CÓRTEX (Montserrat, paleta oficial, claro/escuro) e guardas automáticas contra desvios.
- LOC: `apps/admin-web/app/globals.css` (tokens CSS) · `apps/admin-web/tailwind.config.js` · `apps/admin-web/lib/theme.ts` · `apps/admin-web/lib/chart-theme.ts` (cores de gráficos) · `apps/admin-web/lib/design-guard.ts` (varredura AST/CSS) · `apps/admin-web/components/ui/*` (incl. `brand.tsx`) · `apps/admin-web/components/providers/ThemeProvider.tsx` · `apps/admin-web/app/not-found.tsx`.
- DEPS: tailwind, class-variance-authority, recharts, TypeScript compiler API (guard).
- SEG: n/a. Referência: `docs/CORTEX/VISUAL_REFERENCES.md` (quadro de marca).
- TESTES: `lib/design-tokens.test.ts`, `lib/design-forbidden.test.ts`, `lib/design-identity.test.ts`, `lib/design-kpi.test.ts`, `lib/design-theme-selector.test.ts`.

## Testes (como rodar)
| Suíte | Comando | Onde / observações |
|---|---|---|
| API unit | `cd apps/api && npx jest` (`npm test` = `--runInBand`) | `apps/api/jest.config.js` → `src/**/*.test.ts`; setup `test/setupEnv.ts`; mocks `src/config/__mocks__/{redis,queue}.ts` |
| API integração | `cd apps/api && npm run test:integration` | `pretest:integration` roda `scripts/prepare-test-db.ts`; banco dedicado `lnsystem_test`; config `test/integration/jest.integration.config.js`; guarda destrutiva `test/integration/dbSafetyGuard.ts` + `helpers/destructive-guard.ts` (recusa se URL == `DATABASE_URL` de dev); helpers `helpers/{fixture,tenant-world,test-database}.ts` |
| RLS (qualquer banco) | `cd apps/api && npm run db:check-rls` | somente leitura, sai 1 se invariante falhar |
| Backup (restauração real) | `cd apps/api && npm run backup:verify` | restaura num banco temporário e confere 18 itens; apaga só o temporário |
| Segredos em texto puro | `cd apps/api && npm run secrets:encrypt -- --check` | só conta |
| Admin Web | `cd apps/admin-web && npx jest` | `lib/**/*.test.ts` |
| PDV smoke | `cd apps/pdv-desktop && npm run smoke:electron` | `scripts/electron-smoke.cjs` |
| Mobile / TV / Super Admin | `npm run type-check` | sem testes automatizados |
| E2E de navegador (Central de Ajuda) | ver `apps/e2e/README.md` | Chrome real contra o ambiente de desenvolvimento; não roda no CI |
| Homologação por perfil (`apps/hml`) | `node apps/hml/infra.js start`, `node apps/hml/run.js …`, `node apps/hml/tests/<suíte>.js` | ambiente **isolado** (Postgres 5433, Redis 6390, API 3101); processos filhos só por `apps/hml/lib/proc.js`; `load.js` e `sampler.js` ficam travados por `apps/hml/LOAD_DISABLED` neste computador; guarda estática `apps/api/src/hml-tooling.guard.test.ts`; ver [HML_HOMOLOGACAO](HML_HOMOLOGACAO.md) |

## Ferramentas do tenant demo (banco de DEV)
- RESP: popular e operar o tenant de demonstração (usuários `@demo.local`).
- LOC: `apps/api/scripts/seed-demo.ts` (`npm run demo:seed`; reutiliza `test/integration/helpers/tenant-world.ts`) · `apps/api/scripts/demo-tools.ts` (`npm run demo:tools -- mint|totp|clear-ratelimit|unlock|list`).
- DEPS: Prisma, Redis; credenciais em `apps/api/.demo/credentials.json` (gitignored).
- SEG: seed recusa `NODE_ENV=production` e bancos com "test" no nome; tools só atuam em `@demo.local`.
- TESTES: n/a (uso manual; evidências em `docs/evidencias/`).

## Índice de docs
Todos os documentos: `docs/CORTEX/README.md` (inclui o mapa de caminhos antigos). Evidências: `docs/evidencias/README.md`.
App: `apps/pdv-desktop/README.md`. Ambiente local completo: `docker-compose.yml` (só desenvolvimento — ver `docs/CORTEX/SECURITY.md`).

## Integração Figma
- Estado: **sem arquivo Figma no projeto.** Não há arquivo, link ou token Figma no repositório; a referência visual é o quadro de marca oficial
  (paleta e tipografia em `docs/CORTEX/VISUAL_REFERENCES.md`). O conector do Figma existe no ambiente do assistente (autenticado, assento de visualização),
  mas precisa do link do arquivo do CÓRTEX, ainda não informado. Pendente: informar o link e conferir os tokens contra ele.
