# Banco de dados — migrações, RLS, estoque, backup

PostgreSQL 18. Schema em `packages/database/prisma/schema.prisma`: **102 modelos e 48 enums** (contagem de 2026-10-06, depois do Integration Gateway); migrações em
`packages/database/prisma/migrations/`: **31** (a última, `20261006200000_device_enrollment`). Última conferência de RLS no banco de desenvolvimento
(2026-10-06, depois da Fase 3): `npm run db:check-rls` sem falhas, **102 tabelas com RLS `FORCE` e 116 policies**. As 8 tabelas de canais e de Commerce API (`sales_channels`,
`channel_events`, `external_orders`, `channel_inbound_events`, `channel_api_credentials`, `channel_product_links`, `external_order_items`, `external_payments`)
e as 2 da reserva (`stock_reservations`, `fulfillments`) já estão na conferência acima; o teste `rls-invariants.integration` também passou (2026-10-05).

**Integration Gateway (2026-10-06):** `channel_outbox` (caixa de saída; `dedupeKey` único por canal; RLS empresa+filial) e, em `channel_inbound_events`, o evento normalizado e o estado de tratamento (`outcome`: RECEIVED, APPLIED, DEFERRED, REJECTED, REVIEW, FAILED) para reprocessar o que chegou fora de ordem; `sales_channels.inboundCursor` guarda a posição da consulta periódica. Em SQL cru, os instantes das colunas `timestamp` (sem fuso) vão como texto ISO convertido para UTC (`::timestamptz AT TIME ZONE 'UTC'`): passar um `Date` direto fazia o Postgres reinterpretar no fuso da sessão (achado e corrigido nesta fase).

**Venda de canal (2026-10-05):** `sales.userId` e `sales.cashRegisterId` aceitam nulo, **só** com `channelId` (`CHECK sales_physical_origin_check`); `stock_movements.userId` é opcional; `external_orders.saleId` é único e FK; `stock_reservations` é única por pedido+produto. Reversão: nota no cabeçalho de cada migração (só é segura enquanto não houver venda de canal).
*(Histórico: o texto original deste cabeçalho dizia 68 modelos, 21 migrações e 72 policies, conferidos em 2026-09-27 — números daquele dia.)* (Antes em `docs/migracoes-e-rls.md`; §1–4 abaixo são o conteúdo original de
2026-09-21.)

## 1. Aplicar em qualquer ambiente

```
cd packages/database
DATABASE_URL=postgresql://…/<banco> npx prisma migrate deploy     # aplica só o que falta; reaplicar é no-op
cd ../../apps/api
DATABASE_URL=postgresql://…/<banco> npm run db:check-rls          # confere as invariantes de RLS (somente leitura)
```

`migrate deploy` (nunca `migrate dev`/`migrate reset`) é o comando para staging/produção: não pede confirmação de
reset e não recria banco. **Nunca** rodar `prisma migrate reset` ou `db push --force-reset` em banco com dados.

Depois de mudar o schema no desenvolvimento: `prisma migrate deploy` + `prisma generate` + `npm run build` em
`packages/database` (a API consome o pacote compilado).

## 2. O que foi provado (2026-09-21, Postgres real)

| Verificação | Resultado |
| --- | --- |
| Cadeia completa aplica em **banco vazio** (`lnsystem_test`, criado do zero) | 100% das migrações aplicadas, inclusive `20260921120000_branch_rls_for_derived_financial` |
| Reaplicar (`migrate deploy` 2×) | "No pending migrations to apply" (idempotente) |
| Drift de schema entre o banco de dev e o banco migrado do zero (`prisma migrate diff`) | vazio — nenhuma alteração manual só no banco local |
| RLS: policies / tabelas / funções `rls_*` comparadas entre dev e banco novo | 60/60 policies, 61/61 tabelas, 7/7 funções **idênticas** (números da época; ver o topo para os atuais) |
| `FORCE ROW LEVEL SECURITY` | todas as tabelas, exceto `_prisma_migrations` (correto) |
| Role de conexão | `lnsystem` — não é SUPERUSER e não tem BYPASSRLS (senão o RLS seria letra morta) |

O verificador (`apps/api/scripts/check-rls.ts`) automatiza isso: roda como teste de integração
(`rls-invariants.integration.test.ts`, no banco de teste migrado do zero) e como comando contra **qualquer** banco.
Ele também reprova o estado anterior à correção por filial (teste "prova que detecta a ausência").

## 3. Migração crítica: `20260921120000_branch_rls_for_derived_financial`

- **O que muda:** `payments`, `mechanic_commissions`, `accounts_payable`, `accounts_receivable` passam a isolar
  **por filial** (regra das tabelas-irmãs: `rls_company_branch_match`; pagamento e comissão herdam a visibilidade
  da venda/OS). Só usa `ALTER POLICY` — não altera colunas, dados nem índices.
- **Idempotência:** `ALTER POLICY` reaplicado com a mesma definição é no-op; o Prisma só a executa uma vez.
- **Rollback (estratégia):** o cabeçalho do `migration.sql` traz os quatro `ALTER POLICY … USING (rls_company_match(…))`
  que restauram o estado anterior (isolamento só por empresa). Para desfazer num ambiente: executar esses
  `ALTER POLICY` num migration novo e reverso (`migrate deploy`), **não** editar a migration já aplicada.
  Rollback = reabrir o vazamento entre filiais; só faça com decisão explícita.
- **Como saber se um ambiente está atualizado:** `npm run db:check-rls` (item 5 do verificador falha com
  "a policy NÃO isola por filial" se a migration não foi aplicada).

## 4. Regras para novas migrações de RLS

1. Toda tabela nova com dados de tenant: `ENABLE` **e** `FORCE ROW LEVEL SECURITY` + policy (o verificador falha sem isso).
2. Registro que nasce de documento de filial herda a visibilidade dele (`… IN (SELECT id FROM <documento>)`) ou usa
   `rls_company_branch_match("companyId","branchId")`.
3. Cabeçalho do `migration.sql` com: achado, regra aplicada, decisões pendentes e **ROLLBACK** (SQL pronto).
4. Depois de `migrate deploy` em cada ambiente: `npm run db:check-rls`. Em CI, `npm run test:integration`
   (prepara o banco de teste do zero e roda o verificador como teste).
5. Migração já aplicada **não se edita** (o Prisma confere o checksum): correção = migração nova.

## 5. Migrações de 2026-09-25 a 2026-09-26

| Migração | O que faz |
|---|---|
| `20260925100000_audit_logs_append_only` | `audit_logs`: SELECT e INSERT como antes, **sem UPDATE**, DELETE só com `app.audit_purge = on` em contexto de Super Admin (retenção, `config/scheduler.ts`). A cascata de exclusão de empresa não passa por RLS. Prova: `audit-log-append-only.integration.test.ts`. |
| `20260925120000_payment_cash_received` … `20260925150000_payment_provider_ref` | recebido/troco/cédulas, `payment_settings` (cédulas, provedor de cartão/PIX, terminal) e referência do provedor no pagamento. |
| `20260925160000_monitoring_telemetry` | `device_telemetry` (telemetria dos equipamentos) e `health_incidents` (incidentes de saúde). |
| `20260926100000_payment_exceptions` | `payment_exceptions` (RLS FORCE por empresa+filial), uma aberta por pagamento (índice único parcial), FK para `payments` com `ON DELETE RESTRICT` (pagamento com exceção não some). |
| `20260926110000_telemetry_runtime_version` | `device_telemetry.runtimeVersion` (Electron/Node/Chrome separado da versão do app). |
| `20260926120000_monitoring_thresholds_alerts` | `monitoring_thresholds` (leitura: global ou da empresa; escrita só Super Admin), `monitoring_threshold_changes` (histórico), `monitoring_alerts` (um aberto por origem+tipo). |
| `20260926130000_users_policy_hide_platform_users` | policy de `users`: `is_super_admin() OR companyId = empresa atual` — antes usuários da plataforma (sem empresa) apareciam para qualquer empresa. Prova: `rls-platform-users.integration.test.ts` (vermelho antes). |
| `20260926140000_appointment_confirmation_evidence` | `appointments.confirmationChannel` e `confirmedByName`. |
| `20260926150000_revision_recommendations` | `revisions.recommendations`. |
| `20260926160000_import_batches` | `import_batches` (RLS FORCE): lote de importação com resultado por linha. |

**Aplicar com `prisma migrate deploy` em staging/produção.**

## 6. Migração de 2026-10-06 — enrolamento de equipamento

| Migração | O que faz |
|---|---|
| `20261006200000_device_enrollment` | `devices.licenseId` passa a aceitar **nulo** (equipamento PENDENTE ainda sem empresa) e ganha `branchId`, `secretHash` (SHA-256 da chave; a chave nunca é guardada) e `enrollmentCode` (único). `CHECK devices_active_needs_license_check`: **equipamento ATIVO sempre tem licença**. `refresh_tokens.deviceSessionId` (+ índice) prende a renovação à sessão de equipamento. Aditiva; a reversão está no cabeçalho do arquivo (só é segura enquanto não houver equipamento enrolado sem licença). RLS: `devices_isolation` inalterada — equipamento sem licença só é visível ao Super Admin. `db:check-rls` OK depois da migração. Detalhe: [DISPOSITIVOS](DISPOSITIVOS.md). |

## Livro de estoque

Não existe saldo armazenado: o saldo é derivado de `stock_movements` (regra em [BUSINESS_RULES](BUSINESS_RULES.md#estoque)).
`apps/api/src/services/stock-ledger.ts` calcula no banco: último INVENTORY (por produto, `DISTINCT ON`) + soma com
sinal do que veio depois, em ordem `createdAt, id`; vários produtos numa consulta; histórico das 10 últimas só quando
pedido (janela `sum() OVER (PARTITION BY segmento)`). Leitura dentro da transação de quem chama quando há trava.
Índices usados: `(productId, createdAt)`, `(branchId, productId)`.

Medido em 2026-09-27 com 20 001 movimentos de um produto: 371 ms (histórico inteiro no Node) → 34 ms
([evidência](../evidencias/2026-09-27/01-performance-saldo-estoque.md)). O custo ainda cresce com o histórico dentro do
banco; saldo materializado (tabela de saldo mantida na mesma transação do movimento) fica no [ROADMAP](ROADMAP.md).

## Backup e restauração

- **Backup** (`BackupService`, rota do Super Admin e job semanal): `pg_dump` com o role **dedicado** de
  `BACKUP_DATABASE_URL` (BYPASSRLS + `pg_read_all_data`). Com RLS FORCE, o role da aplicação copiaria tabelas vazias.
- **Restauração** é procedimento de DBA (não pela API com o role de backup).
- **Conferência real** — `npm run backup:verify` (`apps/api/scripts/verify-backup-restore.ts`; precisa de
  `DATABASE_URL`, `BACKUP_DATABASE_URL`, `RESTORE_ADMIN_URL`, `PG_BIN_DIR`, `DATA_ENCRYPTION_KEY`): faz um backup,
  restaura num banco **temporário** `lnsystem_restore_check_<data>`, compara contagens de 24 tabelas, policies, RLS,
  constraints, índices, funções, donos e migrações; testa o RLS com o role da aplicação; confere que os segredos estão
  cifrados, abrem com a chave, **não** abrem com outra chave e não aparecem em texto no dump; apaga só o banco temporário;
  esconde senhas nas mensagens de erro. Resultado em 2026-09-26: **18/18 verificações OK**.
- Backup sem a `DATA_ENCRYPTION_KEY` não recupera os segredos ([SECURITY](SECURITY.md#data_encryption_key--obrigatória)).

## Bancos de desenvolvimento e teste

Ver [VISUAL_REFERENCES](VISUAL_REFERENCES.md#bancos-e-redis--dev-vs-teste): `lnsystem_db` (dev) e `lnsystem_test`
(integração, recriado pelas migrações), Redis 0 e 1, trava contra limpeza sem escopo nos testes.
