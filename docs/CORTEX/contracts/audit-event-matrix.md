# Contrato: Matriz de eventos de auditoria

> Fonte: **somente código** (leitura em 2026-09-24). **[LACUNA]** = evento sem registro em `audit_logs` ou registro sem
> conteúdo útil. Caminhos: `api/` = `apps/api/src/`, `schema` = `packages/database/prisma/schema.prisma`.

> **Atualização de 2026-10-05 (o restante é de 2026-09-24).** Eventos novos: `SalesChannel` — `CREATE` (criar canal), `UPDATE` (editar nome/ativação, salvar credencial, remover
> credencial), gravados pelo `auditLog` das rotas de `/sales-channels` sem nenhum valor de credencial (só os **nomes** dos campos). O teste de conexão e a ingestão de pedido externo
> gravam em `channel_events` (com correlação por requisição), não em `audit_logs`. Integration Gateway (2026-10-06): `ChannelOutbox` (`UPDATE` ao reenviar/cancelar uma linha), `SalesChannel` (`UPDATE` ao enfileirar sincronização); o que o provedor entrega e o que o CÓRTEX envia fica em `channel_events` (tipos `INBOUND_EVENT_*`, `OUTBOX_*`, `PROVIDER_AUTH_FAILED`, `ORDER_NEEDS_REVIEW`) e em `channel_inbound_events`/`channel_outbox`, com a correlação da requisição, **sem segredo**. Reserva e pedido → venda (2026-10-05): `ExternalOrder` (`UPDATE` ao aceitar/recusar/cancelar), `Sale` (`CREATE` ao converter, com o número do pedido), `Fulfillment` (`UPDATE`); a trilha por pedido (aceite, expiração, conversão, falhas) está em `channel_events` com correlação. Commerce API (2026-10-05): `ChannelApiCredential` (`CREATE`, `UPDATE` na troca e na revogação; **sem segredo**), `ChannelProductLink` (`UPDATE`, publicar/despublicar) e `ExternalOrder` (`UPDATE`, recusar/cancelar com motivo) em `audit_logs`;
> em `channel_events`: `API_CREDENTIAL_CREATED/REVOKED`, `CONNECTION_VALIDATED`, `PRODUCTS_PUBLISHED/UNPUBLISHED`, `ORDER_RECEIVED/CANCELLED/REJECTED`, `PAYMENT_UPDATED`, `PAYMENT_EVENT_STALE/IGNORED`, `PAYMENT_AMOUNT_MISMATCH/CHANGED`, `PAYMENT_ON_CLOSED_ORDER`. Política `commission.enabled` segue o evento `Policy` existente. Nada do restante deste contrato foi reverificado nesta data.

## 1. Mecânica

| Item | O que o código faz | Onde |
|---|---|---|
| Modelo | `AuditLog { companyId?, userId?, action, entity, entityId?, oldValue?, newValue?, ipAddress?, userAgent?, createdAt }`. **Não há coluna `branchId`** | `schema:455-478` |
| Ações possíveis | `CREATE, READ, UPDATE, DELETE, LOGIN, LOGOUT, LOGIN_FAILED, PASSWORD_RESET, PERMISSION_CHANGED, LICENSE_APPROVED, LICENSE_SUSPENDED, DEVICE_ACTIVATED, DEVICE_BLOCKED`. Nunca usadas: `READ, LOGIN_FAILED, PASSWORD_RESET, PERMISSION_CHANGED, DEVICE_ACTIVATED, DEVICE_BLOCKED` | `schema:62-76` |
| Middleware `auditLog(action, entity, {describe?})` | Intercepta `res.json`; só grava se status **2xx**; enfileira na fila `audit-log` | `api/middleware/audit.ts:49-92` |
| `companyId` gravado | `req.user.companyId` ou, para SUPER_ADMIN, `describe.companyId` / `body.data.companyId` / `body.data.id` (Company) | `audit.ts:67-70` |
| `entityId` gravado | `describe.entityId` ‖ `body.data.id` ‖ `req.params.id` ‖ null | `audit.ts:74` |
| `oldValue` ("antes") | **Sempre `null`** no middleware (`// TODO`) **[LACUNA]** | `audit.ts:75` |
| `newValue` ("depois") | `JSON.stringify(redactSensitive(describe.newValue ?? body.data))`. Se a rota responde o objeto **cru** (sem `{ data }`) e não tem `describe`, grava a string `"null"` **[LACUNA]** (ver §3) | `audit.ts:76` |
| IP / User-Agent | `req.ip` / `user-agent` | `audit.ts:77-78` |
| Escrita direta | `createAuditLog(...)` — só usada em login e logout; grava sob bypass RLS; erro é engolido (`console.error`) | `audit.ts:97-133`; `api/routes/auth.routes.ts:57, 268` |
| Fila / worker | `audit-log`: 5 tentativas, backoff exponencial, `removeOnFail: false`; worker grava sob bypass RLS e troca `userId` por null se o usuário já foi apagado | `api/config/queue.ts:81-96, 192-205`; `api/jobs/audit.job.ts:24-72` |
| Falha ao enfileirar | Só `console.error` — o registro é perdido; não é transacional com a escrita de negócio **[LACUNA]** | `audit.ts:82-84` |
| Falha no worker | Log de erro `AUDIT JOB FAILED` com `job.data` (já redigido) | `queue.ts:284-291` |
| Tentativas negadas (401/403/4xx) | **Não auditadas** (só 2xx) | `audit.ts:55` |
| Replay idempotente | Não gera nova linha (o `idempotency()` responde antes do `auditLog`) | ex.: `sales.routes.ts:89` |
| Log paralelo | `Logger.security(...)` grava em **SystemLog** (tabela separada, só SUPER_ADMIN lê via `/observability`) — não é `audit_logs` | `api/services/logger.service.ts:231-234`; `api/routes/observability.routes.ts:19` |

## 2. Redação de segredos

| Regra | Código | Onde |
|---|---|---|
| Chaves redigidas (regex, case-insensitive, qualquer profundidade) | `pass`, `password`, `secret`, `token`, `credential`, `authorization`, `cookie`, `backup_codes`, `qr_code`, `mfa_code`, `otpauth`, `otp`, `api_key`, `private_key`, `cvv` → `[REDACTED]` | `audit.ts:12-29` |
| Exceções | Booleanos e `null` passam (`mfaEnabled`, `hasCertificatePassword`) | `audit.ts:20` |
| Escopo | Aplica-se ao `newValue` do middleware. `createAuditLog` **não** redige (hoje recebe `newValue: null`) | `audit.ts:76, 97-133` |
| Critério | Por **nome de chave**; um valor sensível sob chave fora da lista (ex.: `pin`, `activationCode`, conteúdo de certificado) passaria **[LACUNA]** | `audit.ts:12` |
| Legado | Antes do commit 58290e7 o `/mfa/setup` gravava segredo TOTP/QR/backup em claro — expurgo operacional pendente | `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md:175-177` |
| Request body | Nunca é gravado (só a resposta), então senhas de autorizador (`authorizerPassword`) enviadas no corpo não chegam ao audit | `audit.ts:76` |

## 3. Matriz de eventos

Legenda "campos": Q=quem (`userId`), W=quando, E=empresa, F=filial, A=ação, R=recurso (`entity`+`entityId`),
Antes, Depois, IP/UA. **F e Antes nunca existem** em `audit_logs`. "Depois=null" = linha existe, mas `newValue="null"`
(resposta crua sem `describe`). Redação: "sim" = passa por `redactSensitive`.

| Evento | Auditado? | Onde | Campos gravados | Redação |
|---|---|---|---|---|
| Login OK (sem MFA) | sim (`LOGIN`) | `auth.routes.ts:57-68` | Q W E A R IP/UA; Depois=null | n/a |
| Login OK (via `/auth/verify-mfa`) | **não** **[LACUNA]** | `auth.routes.ts:91-116` | — | — |
| Login falho (senha errada) | **não** em `audit_logs` (só SystemLog `LOGIN_FAILED`) **[LACUNA]** | `api/services/auth.service.ts:245` | SystemLog: userId, companyId, IP, tentativa | — |
| Login falho (usuário inexistente) | **não** (nem SystemLog; só `logger.warn`) **[LACUNA]** | `auth.service.ts:194-195`; `auth.routes.ts:72` | — | — |
| Conta bloqueada / tentativa em conta bloqueada | **não** (SystemLog `ACCOUNT_LOCKED`, `LOGIN_ATTEMPT_WHILE_LOCKED`) **[LACUNA]** | `auth.service.ts:208, 235` | — | — |
| Logout | sim (`LOGOUT`) | `auth.routes.ts:268-279` | Q W E A R IP/UA | n/a |
| Reuso de refresh token | **não** (SystemLog) | `auth.service.ts:438` | — | — |
| MFA setup | sim (UPDATE `User`) | `api/routes/mfa.routes.ts:41` | Q W E A R Depois (segredo/QR/backup redigidos) IP/UA | sim |
| MFA ativação (`/mfa/verify`) | **não** **[LACUNA]** | `mfa.routes.ts:128-161` | — | — |
| MFA uso de código de backup | **não** **[LACUNA]** | `mfa.routes.ts:205` | — | — |
| MFA desativação | sim (UPDATE `User`) | `mfa.routes.ts:424` | Q W E A IP/UA; R só `userId`; Depois=null | sim |
| Senha: reset por admin | sim (UPDATE `User`, não `PASSWORD_RESET`) | `api/routes/user.routes.ts:226` | Q W E A R Depois (usuário) IP/UA | sim |
| Senha: troca pelo próprio usuário / esqueci a senha | **não existe rota** | — | — | — |
| Permissão: conceder/revogar em perfil | sim (UPDATE `Role`) — Depois=null; **qual permissão** não fica registrada (resposta `{success:true}`) **[LACUNA]** | `api/routes/roles.routes.ts:79, 95` | Q W E A R(perfil) IP/UA | sim |
| Permissão: atribuir/remover perfil de usuário | sim (UPDATE `User`) — **qual perfil** não fica registrado **[LACUNA]** | `user.routes.ts:315, 336` | idem | sim |
| Permissão: criar/excluir permissão; CRUD de perfil | sim | `permissions.routes.ts:26, 42`; `roles.routes.ts:35, 54, 67` | Q W E A R Depois IP/UA (delete: Depois=null) | sim |
| Módulo ligar/desligar | sim (UPDATE `CompanyModuleSetting`, `describe`) | `api/routes/module-settings.routes.ts:74-87` | Q W E A R Depois (módulo, filial, estado, motivo) IP/UA | sim |
| Preço (editar produto) | sim (UPDATE `Product`) — Antes e Depois=null: **preço anterior/novo não fica registrado** **[LACUNA]** | `api/routes/products.routes.ts:144, 152` | Q W E A R IP/UA | sim |
| Preço/produto via importação | sim (`auditSummary`) **[CORRIGIDO]** | `api/routes/import.routes.ts:41` | — | — |
| Desconto: regras | sim (`DiscountRule`) — Depois=null em create/update | `discount-rules.routes.ts:63, 96, 135` | Q W E A R(update/delete) IP/UA | sim |
| Desconto: convênios | sim (`Partner`) | `partners.routes.ts:40, 66, 107, 119` | Q W E A R Depois IP/UA | sim |
| Desconto aplicado na venda | só dentro do CREATE `Sale` (Depois=null) + SystemLog `SALE_DISCOUNT_*` **[LACUNA]** | `sales.routes.ts:89`; `sale.service.ts:227`; `dual-authorization.service.ts:114` | — | — |
| Aprovação dupla (desconto, cancelamento, devolução, sangria) | **não** em `audit_logs` — autorizador, sucesso e falhas só no SystemLog **[LACUNA]** | `api/services/dual-authorization.service.ts:39-114` | SystemLog | — |
| Aprovação de pedido de compra / transferência / orçamento | sim (UPDATE) — Depois=null | `purchase-orders.routes.ts:71`; `transfers.routes.ts:68`; `quotes.routes.ts:112` | Q W E A R(param) IP/UA | sim |
| Venda (criar) | sim (CREATE `Sale`) — **`entityId` e Depois=null**: não se sabe qual venda **[LACUNA]** | `api/routes/sales.routes.ts:89, 112` | Q W E A IP/UA | sim |
| Cancelamento de venda | sim (UPDATE `Sale`) + SystemLog | `sales.routes.ts:120-147`; `sale.service.ts:692` | Q W E A R Depois (venda) IP/UA | sim |
| Devolução de venda | sim (UPDATE `Sale`) — Depois=null + SystemLog | `sales.routes.ts:157-185`; `sale.service.ts:903` | Q W E A R(param) IP/UA | sim |
| Estorno de pagamento (`/payments/:id/refund`) | sim **[CORRIGIDO]** | `api/routes/payments.routes.ts:130` | — | — |
| Cancelamento de pagamento (`/payments/:id/cancel`) | sim **[CORRIGIDO]** | `payments.routes.ts:116` | — | — |
| Estorno contas a pagar/receber | sim (UPDATE) — Depois=null | `financial.routes.ts:85, 97, 154, 172` | Q W E A R(param) IP/UA | sim |
| Pagamento (criar / conciliar) | sim (`Payment`) — Depois=null; create sem `entityId` | `payments.routes.ts:72, 98` | Q W E A IP/UA | sim |
| Pagamento de OS (gera conta a receber + comissão) | **não** **[LACUNA]** | `service-orders.routes.ts:179` | — | — |
| Baixa de contas a pagar/receber | sim (UPDATE) — Depois=null | `financial.routes.ts:74, 140` | Q W E A R(param) IP/UA | sim |
| Pagamento de comissão de mecânico | sim (UPDATE) — Depois=null | `mechanics.routes.ts:50` | Q W E A R(param) IP/UA | sim |
| Caixa: abrir/fechar/reforço | sim — Depois=null; abrir/reforço sem `entityId` | `cash-register.routes.ts:126, 146, 165` | Q W E A IP/UA | sim |
| Caixa: sangria (dupla autorização) | sim (UPDATE `CashMovement`) + SystemLog | `cash-register.routes.ts:202-228` | Q W E A R Depois IP/UA | sim |
| Estoque: movimento/ajuste/inventário/transferência simples | sim (CREATE `StockMovement`) — **`entityId` e Depois=null** **[LACUNA]** | `stock.routes.ts:133, 164, 188, 221` | Q W E A IP/UA | sim |
| Estoque: importação | sim (`auditSummary`) **[CORRIGIDO]** | `import.routes.ts:298` (e estoque inicial em `:153`) | — | — |
| Inventário (abrir/contar/fechar/cancelar) | sim — Depois=null | `inventory.routes.ts:26, 67, 93, 111` | Q W E A R(param) IP/UA | sim |
| Avaria (registrar/estornar) | sim — Depois=null | `damage.routes.ts:22, 76` | Q W E A R(param) IP/UA | sim |
| Transferência entre filiais | sim (`Transfer`) — Depois=null; create sem `entityId` | `transfers.routes.ts:23, 68, 86, 106, 125, 146` | Q W E A R(param) IP/UA | sim |
| Compra (criar/aprovar/cancelar/receber/devolver) | sim (`PurchaseOrder`) — Depois=null; create sem `entityId` | `purchase-orders.routes.ts:52, 71, 82, 101, 122` | Q W E A R(param) IP/UA | sim |
| Fiscal: configuração | sim (UPDATE `FiscalConfig`) — Depois=null (resposta crua) | `fiscal.routes.ts:51-65` | Q W E A IP/UA | sim |
| Fiscal: emitir / cancelar documento | sim (`FiscalDocument`) — Depois=null | `fiscal.routes.ts:80, 137` | Q W E A R(cancel) IP/UA | sim |
| OS: criar/itens/status/mecânico/checklist | sim; itens e mecânico com `describe` | `service-orders.routes.ts:60, 79, 108, 130, 195` | itens/mecânico: Q W E A R Depois; demais Depois=null | sim |
| OS: previsão de entrega | **não** | `service-orders.routes.ts:155` | — | — |
| Usuário: criar/editar/excluir/desbloquear/ativar | sim (`User`) | `user.routes.ts:119, 165, 192, 209, 244` | Q W E A R Depois IP/UA (delete: Depois=null) | sim |
| Empresa: criar/editar/excluir/ativar | sim (`Company`) | `company.routes.ts:55, 69, 83, 102` | Q W E A R Depois IP/UA (delete: E e Depois=null) | sim |
| Filial | sim (`Branch`) | `branch.routes.ts:90, 118, 139, 158` | Q W E A R Depois IP/UA | sim |
| Licença: criar/aprovar/suspender/reativar/cancelar | sim (`License`) | `license.routes.ts:70, 89, 111, 124, 137` | Q W E A R Depois IP/UA | sim |
| Dispositivo: solicitar ativação | **não** **[LACUNA]** | `activation.routes.ts:24` | — | — |
| Dispositivo: aprovar/rejeitar/bloquear/desbloquear/revogar/encerrar sessão | sim (`Activation`/`Device`/`DeviceSession`, ações genéricas UPDATE/DELETE) | `activation.routes.ts:87, 104, 167, 185, 202, 230` | Q W E A R Depois (credencial redigida) IP/UA | sim |
| Backup: criar/restaurar/excluir | sim (criar, restaurar, excluir) **[CORRIGIDO]** | `api/routes/backup.routes.ts:46, 150, 225` | — | — |
| Importação de clientes | sim (`auditSummary`) **[CORRIGIDO]** | `import.routes.ts:199` | — | — |

## 4. Quem lê / quem pode alterar

| Pergunta | Código | Onde |
|---|---|---|
| Leitura via API | `GET /audit-logs`, `/audit-logs/entity/:entity/:entityId`, `/audit-logs/:id` — SUPER_ADMIN (qualquer empresa), COMPANY_ADMIN e MANAGER (empresa do token, forçada) | `api/routes/audit-logs.routes.ts:12-67` |
| Recorte por filial | Inexistente (sem coluna): MANAGER de uma filial vê o audit da empresa inteira | `schema:455-478` |
| Linhas de SUPER_ADMIN sem empresa | `companyId` null (ex.: resposta crua em rota da empresa) → só SUPER_ADMIN enxerga | `audit.ts:67-70`; RLS abaixo |
| Tela | Só no app super-admin; o Admin Web não tem tela de auditoria | `apps/super-admin/lib/api.ts` |
| Endpoint de edição/exclusão | **Nenhum.** `audit-log.service.ts` só tem leituras | `api/services/audit-log.service.ts:14-78` |
| RLS | `audit_logs_isolation` sem cláusula `FOR` → vale para **ALL** (SELECT/UPDATE/DELETE): no contexto da empresa (ou SUPER_ADMIN) a aplicação **pode** alterar/apagar linhas; não há trigger nem `REVOKE UPDATE/DELETE` — tabela **não é append-only** no banco **[LACUNA]** | `packages/database/prisma/migrations/0_init/migration.sql:2027-2028, 2194` |
| Expurgo automático | Job apaga `audit_logs` com mais de `AUDIT_LOG_RETENTION_DAYS` (padrão **90 dias**) sob bypass RLS **[DECISÃO NECESSÁRIA]** (retenção legal) | `api/config/scheduler.ts:182-201` |
| Exclusão em cascata | `AuditLog.company onDelete: Cascade`: excluir uma empresa apaga toda a trilha dela (a exclusão só é permitida sem filiais/usuários) **[LACUNA]** | `schema:458`; `api/services/company.service.ts:96-104` |
| Usuário excluído | `onDelete: SetNull` — a linha fica, sem autor | `schema:460` |

## 5. Eventos NÃO auditados em `audit_logs` (resumo — itens 3 a 6 já corrigidos, ver nota ao fim; conferido no código em 2026-10-04)

1. Login concluído via MFA (`auth.routes.ts:91`) e **todo login falho** (`auth.service.ts:194, 208, 235, 245` — no máximo SystemLog).
2. Ativação de MFA e uso de código de backup (`mfa.routes.ts:128, 205`).
3. Estorno e cancelamento de pagamento (`payments.routes.ts:116, 130`).
4. Pagamento de OS (`service-orders.routes.ts:179`), que cria conta a receber e comissão.
5. Importações de produtos/preços, clientes e estoque (`import.routes.ts:41, 199, 298`).
6. Backup criar/restaurar/excluir (`backup.routes.ts:46, 150, 225`).
7. Solicitação de ativação de dispositivo (`activation.routes.ts:24`).
8. Aprovações por dupla autorização (quem autorizou) — só SystemLog (`dual-authorization.service.ts:39-114`).
9. Tentativas negadas (qualquer resposta não-2xx) — `audit.ts:55`.

Auditados **sem conteúdo** (linha existe, mas sem "antes" e com `newValue="null"` e às vezes sem `entityId`):
venda criada, devolução, preço de produto, regras de desconto, pagamentos, movimentos de estoque, transferências,
compras, fiscal, caixa, contas a pagar/receber, concessão de permissão/perfil. Causa única: rotas respondem o objeto
cru (`res.json(obj)`) e o middleware lê `body.data` (`audit.ts:74-76`); `oldValue` nunca é capturado (`audit.ts:75`).

## Atualização 2026-09-25

- **[CORRIGIDO] audit_logs append-only** (migration 20260925100000): UPDATE negado a todos; DELETE só pelo expurgo de retenção (Super Admin + `app.audit_purge`). Não há rota de escrita na API (DELETE /audit-logs/:id → 404, testado como COMPANY_ADMIN/MANAGER/SUPER_ADMIN).

- **[CORRIGIDO] Conteúdo da auditoria:** o middleware usava só `body.data`; rotas que respondem o objeto direto gravavam `newValue` "null" e `entityId` nulo. Agora usa `data` quando existe e, senão, o próprio corpo (segredos redigidos). Prova: `audit.payload.test.ts` e `audit-content.integration.test.ts` (pagamento em dinheiro e pagamento de OS, falham no código antigo).
- **[CORRIGIDO] Eventos que não eram auditados:** cancelar/estornar pagamento, pagamento de OS, importação de produtos/clientes/estoque, criar/restaurar/excluir backup.
- **Campos por evento de escrita (regra):** obrigatórios — ator (`userId`), momento (`createdAt`), empresa (`companyId`, do ator ou do recurso para o Super Admin), ação, entidade, `entityId`, estado resultante (`newValue`), IP e user-agent. **Filial:** `audit_logs` não tem coluna de filial; ela aparece dentro de `newValue` quando o recurso tem `branchId`. **Estado anterior (`oldValue`):** não capturado de forma genérica — exige ler o registro antes da escrita, por entidade. **[DECISÃO NECESSÁRIA]** priorizar em quais entidades (preço, desconto, permissão, módulo já registram motivo/estado próprio).
- **[CORRIGIDO]** Falha de login (`LOGIN_FAILED`: identificador + motivo, nunca a senha; empresa do usuário quando existe) e login concluído via MFA (`LOGIN`) passam a ir para `audit_logs` — `login-failed-audit.integration.test.ts`.
