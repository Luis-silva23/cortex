# Arquitetura

## Monorepo

```
apps/
  api/            Express + Prisma (Node 20) — única API de todos os frontends (/api/*, Swagger em /api/docs)
  admin-web/      Next 14 — painel da empresa (porta 3002)
  super-admin/    Next 14 — painel da plataforma (porta 3000)
  pdv-desktop/    Electron + Vite/React — frente de caixa (web em 5173 para desenvolvimento)
  mobile/         Expo (React Native) — mecânico/equipe
  tv/             Expo Android TV — painel da oficina
  e2e/            testes de navegador (Chrome real contra o ambiente de desenvolvimento; hoje só a Central de Ajuda; fora do CI)
  hml/            homologação em ambiente isolado (perfis, RLS, pagamentos, evidência visual); carga travada por LOAD_DISABLED
packages/
  database/       schema Prisma, migrações (com RLS), cliente estendido com contexto RLS — consumido compilado (dist)
  shared/         tipos, erros (AppError, ConflictError…), validadores zod, utilitários (token, senha, cofre de segredos)
```

Infraestrutura: PostgreSQL 18 (RLS `FORCE` em toda tabela de empresa), Redis 7+ (cache, sessões, limites de tentativa,
filas BullMQ). Portas e bancos de dev/teste: [VISUAL_REFERENCES](VISUAL_REFERENCES.md).

## Caminho de uma requisição

```
helmet → cors → compression → json (5 MB) → clampPaginationLimit (limit ≤ 100, page ≥ 1)
  → rateLimitGeneral (por usuário do Bearer; sem token, por IP; Redis, com contagem em memória se o Redis cair)
  → /api router:
      requestContext (requestId, métrica da requisição na saída)
      translateErrors (toda resposta ≥ 400: PT-BR; texto do Prisma/Zod nunca sai; banco fora → 503)
      rejectInvalidDateQuery (startDate/endDate inválidos → 400)
      rota: authMiddleware → tenantIsolation (abre o contexto RLS) → companyScoped (SUPER_ADMIN escolhe a empresa)
            → requireModuleEnabled → requirePermission / requireUserType → idempotency() → auditLog() → handler
  → errorHandler (AppError/Zod/Prisma → status certo; banco inacessível → 503 com Retry-After)
```

**Contexto RLS.** `tenantIsolation` roda o resto da requisição dentro de `runWithRLSContext({ companyId, branchId,
userType })` (AsyncLocalStorage). O cliente Prisma estendido aplica `set_config('app.current_company_id' | …)` em cada
operação de modelo; transações usam `runInTransaction` (o contexto vale na conexão da transação — obrigatório para
`$queryRaw` e `SELECT … FOR UPDATE`). Jobs e o agendador abrem o próprio contexto. Detalhes:
[contracts/tenant-branch-scope](contracts/tenant-branch-scope.md), [DATABASE](DATABASE.md).

## Filas e agendador (BullMQ sobre Redis)

Filas: `email`, `report`, `notification`, `audit-log`, `request-metrics`, `system-log`. A auditoria e a métrica de
requisição são enfileiradas sem segurar a resposta; se o Redis cair, ficam na fila offline do cliente Redis em memória e
seguem quando ele volta ([evidência](../evidencias/2026-09-27/02-resiliencia-caos-controlado.md)).

Jobs recorrentes (`apps/api/src/config/scheduler.ts`):

| Job | Quando | Faz |
|---|---|---|
| `evaluate-health-1min` | a cada minuto | avalia saúde de filiais/central, abre e fecha incidentes e alertas |
| `reconcile-external-payments-5min` | a cada 5 min | consulta o provedor de pagamentos PENDING há mais de 1 min |
| `check-low-stock-hourly` | a cada hora | alerta de estoque baixo (saldo agregado no banco) |
| `check-expiring-licenses-daily` | 9h | licenças a vencer |
| `mark-overdue-accounts-daily` | 00h30 | contas vencidas |
| `cleanup-old-logs-daily` | 0h | retenção de logs de requisição/sistema, telemetria, incidentes, auditoria (expurgo com flag) |
| `auto-backup-weekly` | domingo 2h | backup automático |
| `monthly-report` | dia 1, 8h | relatório mensal |

## Adaptadores (integrações externas)

- **Pagamento** (`apps/api/src/services/payment-adapters/`): provedores registrados por nome. Em produção só existe
  `MANUAL` — cartão confirmado pelo operador na maquininha, PIX pendente até conciliação, dinheiro direto. Um provedor
  real (TEF/PSP) entra com `registerPaymentProvider` e segue o fluxo "intenção primeiro" (PENDING com `transactionId` →
  terminal → liquidação; sem resposta fica PENDING, nunca recusado; reconciliação com guarda). Adaptadores falsos existem
  **só** nos testes de integração. Regras: [BUSINESS_RULES](BUSINESS_RULES.md#pagamentos).
- **Fiscal** (`apps/api/src/services/fiscal-adapters/`): só `unconfigured-adapter` (devolve PENDING; nada é simulado).
- **E-mail/SMS de MFA**: sem provedor; em produção a rota responde 503 e o login usa TOTP.

## Estoque

Não há saldo armazenado: o saldo é o livro `stock_movements`. `stock-ledger.ts` calcula no Postgres (último inventário +
soma com sinal do que veio depois), para um ou vários produtos numa consulta; as leituras que precisam de trava rodam na
transação de quem chama. Regras: [BUSINESS_RULES](BUSINESS_RULES.md#estoque).

## Dashboard gerencial e canais de venda (2026-10-05)

- **Dashboard gerencial** (Administrador e Gerente): `GET /api/dashboard/management/summary` e `/timeseries`. O período é resolvido **só na API**
  (`utils/dashboard-period.ts`, dias civis de `America/Sao_Paulo`); cada endpoint abre **uma** transação de leitura (`runInTransaction`, contexto RLS
  aplicado uma vez) e agrega no PostgreSQL. Não usa cache. [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md).
- **Canais de venda** — **base, não e-commerce**: o módulo `CANAIS` (opt-in) liga `services/sales-channels/` (`sales-channel.service`, `external-order.service`,
  `gateway`) e as tabelas `sales_channels`, `channel_events`, `external_orders`, `channel_inbound_events` (RLS por empresa e filial). Fluxo **planejado**:
  `canal externo → Commerce API → camada de integração (gateway) → CÓRTEX`; o canal nunca acessa o PostgreSQL. Hoje: registro de provedores **vazio**, nenhuma rota
  pública de webhook, nenhuma Commerce API; o pedido externo é registrado, **não** vira venda, pagamento nem baixa de estoque. PostgreSQL é a fonte da verdade e o CÓRTEX a
  autoridade dos dados; Redis não guarda estado de negócio. [CANAIS](CANAIS.md), [ROADMAP](ROADMAP.md#sequência-oficial-de-evolução).

## Monitoramento e telemetria

```
PDV/equipamentos ──POST /api/telemetry (CPU, RAM, disco, latência, perda, versão do app e do runtime)──▶ device_telemetry
Toda requisição ──fila request-metrics──▶ request_logs (latência, status, rota, empresa/filial)
Postgres, Redis, filas ──sondas do observability.service──▶ saúde central
evaluate-health (1 min) ──limites efetivos (filial → empresa → global → padrão)──▶ monitoring_alerts / incidentes
Super Admin ──/api/monitoring/*──▶ Empresas → Empresa → Filiais → Filial (séries de 24 h, alertas, limites, histórico)
```

"Sem dados" (sem coleta) nunca vira "normal" nem abre alerta; equipamento que para de enviar abre `DEVICE_OFFLINE`.
Alertas com deduplicação (um aberto por origem+tipo), reabertura só após 10 min e fechamento automático na recuperação.
Limites configuráveis só pelo Super Admin, com teto por métrica, motivo obrigatório, histórico e auditoria
([BUSINESS_RULES](BUSINESS_RULES.md#monitoramento)).

## Frontends

Admin Web e Super Admin: Next 14 (App Router), cliente HTTP único em `lib/api.ts` com renovação de token single-flight.
PDV: Electron (processo principal com impressão, sessão protegida, telemetria) + renderer React (HashRouter para rodar em
`file://`). Mobile/TV: Expo com tokens em `expo-secure-store`. Detalhes em [FRONTEND](FRONTEND.md), [MOBILE](MOBILE.md),
[ANDROID_TV](ANDROID_TV.md).
