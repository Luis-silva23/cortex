# Relatório de migrations

> Gerado em 2026-10-19 por `npm run db:docs -- --write`. Fonte: `packages/database/prisma/migrations` (arquivos), `_prisma_migrations` dos bancos de **desenvolvimento** e de **teste**, e a comparação com o schema Prisma. **Staging e produção não existem/não foram verificados** — a coluna correspondente é uma pendência, não uma afirmação.

- Migrations versionadas: **57** (ordem de execução = ordem lexicográfica do nome, a mesma do Prisma). Provedor: PostgreSQL (`migration_lock.toml`).
- Banco de desenvolvimento: 58 registradas em `_prisma_migrations`. Banco de teste: 57 registradas.
- PostgreSQL consultado: PostgreSQL 18.6 on x86_64-windows. Extensões instaladas: plpgsql.

## 1. Resumo das divergências

| Verificação | Resultado |
|---|---|
| Migrations do repositório não aplicadas no dev | nenhuma |
| Migrations aplicadas no dev que não existem no repositório | nenhuma |
| Arquivo alterado depois de aplicado (checksum do dev ≠ arquivo) | nenhum |
| Checksum só confere após normalizar CRLF→LF (fim de linha do checkout; sem alteração de conteúdo) | nenhum |
| Tabelas no banco sem modelo no schema | nenhuma |
| Modelos do schema sem tabela no banco | nenhum |
| Migrations com operação potencialmente destrutiva (DROP/DELETE/RENAME/ALTER TYPE/SET NOT NULL) | 12 de 57 (§2) |

O diff schema × banco (diferenças que o Prisma não representa) e a prova de que a cadeia de migrations, aplicada do zero em um banco vazio, reproduz o mesmo schema estão na §4.

## 2. Relação das migrations (ordem de execução)

| # | Migration | Finalidade (cabeçalho do arquivo) | Reversão documentada | Tabelas criadas | Tabelas alteradas | Índices | Policies | Operações a conferir | Dev | Teste | Staging / produção |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `0_init` | LN System — baseline schema migration. This is a single consolidated "0_init" migration standing in for the real (lost) migration history. It recreates the production schema exactly as extracted from a pg_dump of the live database: enums, tables, constraints (… | não | `public` | — | 235 | 54 | — | aplicada 2026-09-14 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 2 | `20260914154506_add_revisions_postsale_agenda` | CreateEnum | não | `revisions`, `follow_ups`, `follow_up_events`, `appointments`, `appointment_events` | — | 21 | 0 | — | aplicada 2026-09-14 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 3 | `20260914154543_add_revisions_postsale_agenda_rls` | RLS for the Revisões / Pós-venda / Agenda domain (revisions, follow_ups, follow_up_events, appointments, appointment_events). Same pattern as the rest of the schema: tenant-scoped tables (own companyId/branchId) use rls_company_branch_match, which already trea… | não | — | `public` | 0 | 5 | — | aplicada 2026-09-14 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 4 | `20260914233256_add_inventory_one_in_progress_per_branch` | Achado de auditoria de integração: nada impedia dois inventários IN_PROGRESS simultâneos na mesma filial (mesma classe do problema já resolvido para CashRegister via índice único parcial). Sem isto, dois inventários abertos ao mesmo tempo capturariam o mesmo s… | não | — | — | 1 | 0 | — | aplicada 2026-09-14 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 5 | `20260915110038_add_company_module_settings` | CreateEnum | não | `company_module_settings` | — | 4 | 0 | — | aplicada 2026-09-15 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 6 | `20260915110105_add_company_module_settings_rls` | RLS para company_module_settings — mesmo padrão do resto do schema (ver 20260914154543_add_revisions_postsale_agenda_rls para o precedente direto desta sessão). rls_company_branch_match já trata branchId NULL na LINHA como "aplica pra empresa inteira, visível … | não | — | `public` | 0 | 1 | — | aplicada 2026-09-15 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 7 | `20260915130221_add_accounts_reversal_unique_reference` | Achado de auditoria de integração: `reversePayable`/`reverseReceivable` (financial.service.ts) só se protegiam contra estorno duplicado via um `findFirst` + `create` sem transação nem lock — o próprio código já documentava a janela de corrida teórica sob conco… | não | — | — | 2 | 0 | — | aplicada 2026-09-15 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 8 | `20260921120000_branch_rls_for_derived_financial` | Isolamento POR FILIAL para os registros financeiros que nascem de documentos de filial. ACHADO (bateria multi-empresa/multi-filial, 20 casos falhando): quatro tabelas só tinham RLS por EMPRESA, então o operador/gerente da filial A1 lia pagamentos, comissões e … | sim | — | — | 0 | 0 | — | aplicada 2026-09-21 | aplicada 2026-09-21 | **não aplicada** (ambiente inexistente / não verificado) |
| 9 | `20260925100000_audit_logs_append_only` | audit_logs append-only (defesa em profundidade). Antes: uma única policy (audit_logs_isolation) valia para TODOS os comandos — qualquer sessão da aplicação no contexto da empresa podia UPDATE/DELETE a própria trilha de auditoria. Nenhuma rota faz isso hoje, ma… | sim | — | — | 0 | 3 | DROP POLICY | aplicada 2026-09-25 | aplicada 2026-09-25 | **não aplicada** (ambiente inexistente / não verificado) |
| 10 | `20260925120000_payment_cash_received` | Dinheiro: valor recebido e troco por pagamento. `amount` passa a ser sempre o valor APLICADO à venda. | não | — | `payments` | 0 | 0 | — | aplicada 2026-09-25 | aplicada 2026-09-25 | **não aplicada** (ambiente inexistente / não verificado) |
| 11 | `20260925130000_payment_settings` | Configuração de pagamento (controle de cédulas opcional) e composição das cédulas por pagamento. | não | `payment_settings` | `payments`, `public` | 3 | 1 | — | aplicada 2026-09-25 | aplicada 2026-09-25 | **não aplicada** (ambiente inexistente / não verificado) |
| 12 | `20260925140000_payment_providers` | Provedor de cartão/PIX e terminal por empresa/filial; herança campo a campo (nulo = herda). | não | — | `payment_settings` | 0 | 0 | — | aplicada 2026-09-25 | aplicada 2026-09-25 | **não aplicada** (ambiente inexistente / não verificado) |
| 13 | `20260925150000_payment_provider_ref` | Provedor externo que processou o pagamento (reconciliação consulta o mesmo provedor, mesmo que a configuração mude). | não | — | `payments` | 0 | 0 | — | aplicada 2026-09-25 | aplicada 2026-09-25 | **não aplicada** (ambiente inexistente / não verificado) |
| 14 | `20260925160000_monitoring_telemetry` | Monitoramento: telemetria real dos equipamentos e histórico de incidentes de saúde. RLS FORCE por empresa/filial. | não | `device_telemetry`, `health_incidents` | `public` | 6 | 2 | — | aplicada 2026-09-25 | aplicada 2026-09-25 | **não aplicada** (ambiente inexistente / não verificado) |
| 15 | `20260926100000_payment_exceptions` | Exceções de pagamento: fato do provedor que conflita com o estado da venda (ex.: aprovado/capturado depois que a venda foi cancelada ou devolvida). O pagamento registra a verdade (APPROVED); a venda fica como está; a exceção fica aberta até alguém tratar. A re… | não | `payment_exceptions` | `public` | 2 | 1 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 16 | `20260926110000_telemetry_runtime_version` | Versão do runtime (Electron/Node/Chrome) separada da versão do app CÓRTEX: o PDV não empacotado reportava a versão do Electron (28.3.3) em `appVersion`. | não | — | `device_telemetry` | 0 | 0 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 17 | `20260926120000_monitoring_thresholds_alerts` | Limites do monitoramento configuráveis (global → empresa → filial) com histórico, e alertas com deduplicação. | não | `monitoring_thresholds`, `monitoring_threshold_changes`, `monitoring_alerts` | `public` | 5 | 5 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 18 | `20260926130000_users_policy_hide_platform_users` | A política de users deixava QUALQUER contexto de empresa ler as linhas dos usuários da plataforma (companyId nulo: Super Admins) — hash de senha e segredo de MFA (cifrado) incluídos — pela cláusula `OR "companyId" IS NULL`. O login não depende dela (busca o us… | não | — | — | 0 | 0 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 19 | `20260926140000_appointment_confirmation_evidence` | Confirmação do agendamento = aceite do CLIENTE/responsável pelo veículo. Antes só o funcionário ficava registrado (performedBy); agora a confirmação guarda quem confirmou e por qual canal. Confirmações antigas ficam nulas. | não | — | `appointments` | 0 | 0 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 20 | `20260926150000_revision_recommendations` | Recomendação ao cliente registrada na revisão (o que fazer/observar até a próxima). Revisões antigas ficam nulas. | não | — | `revisions` | 0 | 0 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 21 | `20260926160000_import_batches` | Rastreabilidade da importação em lote: cada importação vira um lote com o resultado de CADA linha (criada, atualizada, sem alteração, erro + motivo). As linhas continuam independentes (uma linha ruim não derruba as boas), mas nada fica parcialmente importado s… | não | `import_batches` | `public` | 1 | 1 | — | aplicada 2026-09-26 | aplicada 2026-09-26 | **não aplicada** (ambiente inexistente / não verificado) |
| 22 | `20260927100000_policies_and_new_domains` | Políticas por empresa/filial e domínios novos (2026-09-27), decididos pelo dono do produto: * políticas configuráveis (padrão da empresa + override da filial quando o catálogo permite), com histórico; * cadastro da empresa/filial/cliente; horário de funcioname… | sim | `policy_settings`, `policy_changes`, `business_hours`, `business_calendar_exceptions`, `discount_events`, `quote_events`, `service_order_warranties`, `warranty_claims`, `employee_agreements`, `employee_agreement_charges`, `employee_payroll_deductions`, `agreement_companies`, `collection_attempts` | `companies`, `branches`, `customers`, `cash_registers`, `quotes`, `appointments`, `service_orders`, `accounts_receivable`, `payments`, `public` | 23 | 3 | bloco DO $$ | aplicada 2026-09-27 | aplicada 2026-09-27 | **não aplicada** (ambiente inexistente / não verificado) |
| 23 | `20260927100500_evidence_purge_policy` | discount_events e collection_attempts são evidência append-only (sem UPDATE, sem DELETE para usuário). Mesma regra de expurgo de audit_logs: DELETE só em contexto de Super Admin com a flag `app.audit_purge = on` (rotina de retenção ou limpeza de empresa sintét… | sim | — | — | 0 | 2 | — | aplicada 2026-09-27 | aplicada 2026-09-27 | **não aplicada** (ambiente inexistente / não verificado) |
| 24 | `20260928100000_consolidation_cash_agenda_supplier_returns` | Consolidação das políticas (2026-09-28): fechamento de caixa por forma de pagamento, convênio por filial, capacidade da agenda e devolução ao fornecedor. Só acrescenta colunas/tabelas/valor de enum; nada existente muda de sentido. | não | `agenda_unavailabilities`, `supplier_returns`, `supplier_return_items`, `supplier_return_events` | `cash_registers`, `employee_agreements`, `agreement_companies`, `appointments`, `public` | 8 | 1 | bloco DO $$ | aplicada 2026-09-28 | aplicada 2026-09-28 | **não aplicada** (ambiente inexistente / não verificado) |
| 25 | `20260928200000_support_center` | Central de Ajuda e Suporte (2026-09-28). Chamados da empresa (RLS empresa+filial), histórico e mensagens que só crescem, anexos no banco (sob RLS) e base de conhecimento global (leitura para todos os logados, escrita só da plataforma). Carga inicial da base AN… | não | `support_tickets`, `support_ticket_messages`, `support_ticket_attachments`, `support_ticket_events`, `support_kb_categories`, `support_kb_articles` | `public` | 14 | 8 | dados: INSERT support_kb_categories; dados: INSERT support_kb_articles; bloco DO $$ | aplicada 2026-09-28 | aplicada 2026-09-28 | **não aplicada** (ambiente inexistente / não verificado) |
| 26 | `20261004200000_sales_channels` | Canais de venda (2026-10-04): módulo CANAIS (nasce desativado), canais configuráveis por empresa/filial, pedidos externos, idempotência de eventos e origem da venda. Aditiva: nenhuma linha existente muda (venda sem canal = loja física). ROLLBACK: DROP das 4 ta… | sim | `sales_channels`, `channel_events`, `external_orders`, `channel_inbound_events` | `sales`, `public` | 9 | 1 | bloco DO $$ | aplicada 2026-10-05 | aplicada 2026-10-05 | **não aplicada** (ambiente inexistente / não verificado) |
| 27 | `20261005100000_commerce_api_foundation` | Commerce API, Fase 1 (2026-10-05): credenciais de canal (servidor -> servidor), publicação de produtos por canal, itens do pedido externo e pagamento externo. Aditiva: nenhuma linha existente muda (colunas novas de `external_orders` têm padrão). RISCO: nenhum.… | sim | `channel_api_credentials`, `channel_product_links`, `external_order_items`, `external_payments` | `external_orders`, `public` | 11 | 1 | bloco DO $$ | aplicada 2026-10-05 | aplicada 2026-10-05 | **não aplicada** (ambiente inexistente / não verificado) |
| 28 | `20261005200000_stock_reservations_and_channel_sales` | Fase 2 da Commerce API (2026-10-05): reserva de estoque, venda de canal sem caixa físico e fulfillment mínimo. Aditiva. Venda física continua exigindo usuário e caixa: o CHECK só libera `userId`/`cashRegisterId` nulos quando há `channelId` (todas as linhas exi… | sim | `stock_reservations`, `fulfillments` | `sales`, `external_orders`, `external_payments`, `public` | 7 | 1 | bloco DO $$ | aplicada 2026-10-05 | aplicada 2026-10-05 | **não aplicada** (ambiente inexistente / não verificado) |
| 29 | `20261005210000_stock_movement_user_optional` | Fase 2 da Commerce API (2026-10-05): `stock_movements.userId` passa a aceitar nulo. Só o movimento SALE de uma venda de canal convertida sem operador o usa; todo movimento físico (PDV, balcão, OS, transferência, ajuste…) continua gravando o usuário. Aditiva: n… | sim | — | `stock_movements` | 0 | 0 | — | aplicada 2026-10-05 | aplicada 2026-10-05 | **não aplicada** (ambiente inexistente / não verificado) |
| 30 | `20261006100000_integration_gateway` | Fase 3 (2026-10-06): Integration Gateway — caixa de entrada com reprocessamento (eventos fora de ordem), caixa de saída e cursor de consulta. Aditiva: colunas novas anuláveis/com padrão, uma tabela nova e um enum novo. Nada existente muda de significado. ROLLB… | sim | `channel_outbox` | `sales_channels`, `channel_inbound_events`, `public` | 5 | 1 | — | aplicada 2026-10-05 | aplicada 2026-10-05 | **não aplicada** (ambiente inexistente / não verificado) |
| 31 | `20261006200000_device_enrollment` | Autorização de dispositivos (2026-10-06): enrolamento sem empresa, vínculo a licença e filial feito pelo administrador, chave do equipamento (guardada só como hash) e sessão de login presa à sessão de equipamento. Aditiva e compatível: os equipamentos existent… | sim | — | `devices`, `refresh_tokens` | 2 | 0 | — | aplicada 2026-10-06 | aplicada 2026-10-06 | **não aplicada** (ambiente inexistente / não verificado) |
| 32 | `20261014100000_product_barcodes` | Vários códigos de barras por produto (2026-10-14). ADITIVA: nenhuma coluna ou linha existente é alterada ou removida. * `products.barcode` continua existindo (código "principal", usado por telas e integrações atuais) e é sincronizado com esta tabela pela aplic… | sim | `product_barcodes` | `public` | 3 | 1 | dados: INSERT product_barcodes | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 33 | `20261014120000_access_revocations` | Revogação durável de access token (decisão 107, 2026-10-14). ADITIVA: tabela nova, nada existente é alterado. * O Redis segue como caminho rápido da checagem; esta tabela é a fonte de verdade quando o Redis cai (a API passa a consultar aqui em vez de aceitar u… | sim | `access_revocations` | `public` | 2 | 1 | — | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 34 | `20261014130000_mfa_replay_guard` | Anti-reuso de código TOTP (decisão 123, 2026-10-14). ADITIVA: uma coluna anulável; nada existente é alterado. * users."mfaLastStep" guarda o último passo TOTP de 30 s já consumido; a aplicação recusa código de passo igual ou anterior (atualização condicional a… | sim | — | `users` | 0 | 0 | — | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 35 | `20261014140000_privacy_requests` | Pedidos de titular — LGPD (decisão 120, 2026-10-14). ADITIVA: uma tabela nova e uma coluna anulável em customers. * privacy_requests: registro durável do pedido (exportação ou anonimização de UM cliente): quem pediu, quando, por quê, o que foi feito e o que fo… | sim | `privacy_requests` | `customers`, `public` | 3 | 1 | — | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 36 | `20261014150000_product_images` | Imagem opcional do produto (decisão 122, 2026-10-14). ADITIVA: uma tabela nova; nenhum dado existente muda. * No máximo UMA imagem por produto (productId único). O conteúdo (PNG/JPEG/WebP já validado e saneado pela aplicação: sem metadados, sem bytes sobrando,… | sim | `product_images` | `public` | 2 | 1 | — | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 37 | `20261014155900_guard_product_children_same_company` | GUARDA da migration 20261014160000_product_children_same_company (2026-10-14). Só LÊ; não altera nada. Aborta se houver dado que violaria a FK composta. POR QUE EXISTE: o ADD CONSTRAINT de uma FK valida as linhas existentes COM A RLS DO DONO. As tabelas são FO… | sim | — | — | 0 | 0 | bloco DO $$ | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 38 | `20261014160000_product_children_same_company` | Códigos de barras e imagem do produto: o produto tem que ser da MESMA empresa da linha (2026-10-14, revisão do banco). PROBLEMA: product_barcodes e product_images tinham FK só em (productId) → products(id), e a policy RLS da linha filha só confere o "companyId… | sim | — | `product_barcodes`, `product_images` | 1 | 0 | DROP CONSTRAINT | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 39 | `20261014161000_product_images_company_product_unique` | Imagem do produto: chave única ("companyId","productId") (2026-10-14, continuação de 20261014160000_product_children_same_company). O Prisma só aceita a relação 1:1 Product.image ↔ ProductImage pela FK composta (companyId, productId) se a tabela filha tiver ES… | sim | — | — | 1 | 0 | — | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 40 | `20261014162000_rls_logs_roles_tighten` | RLS de logs e de perfis/permissões globais (2026-10-14, revisão do banco). Nenhuma linha é lida, alterada ou apagada: só troca de políticas. PROBLEMAS (provados por teste de integração em sessão de EMPRESA, que falhava antes desta migration): 1. request_logs e… | sim | — | — | 0 | 10 | DROP POLICY | aplicada 2026-10-14 | aplicada 2026-10-14 | **não aplicada** (ambiente inexistente / não verificado) |
| 41 | `20261014170000_refresh_tokens_hash_and_company` | refresh_tokens: hash do token, empresa preenchida e RLS de verdade (2026-10-14, revisão do banco — achado D-01, gravidade Alta). PROBLEMAS (provados antes): (1) a coluna "token" guardava o refresh token EM TEXTO — quem lesse a tabela ou um backup obtinha sessõ… | sim | — | `refresh_tokens` | 2 | 1 | DROP COLUMN; DROP POLICY; SET NOT NULL; dados: UPDATE refresh_tokens; bloco DO $$ | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 42 | `20261014180000_composite_company_fks` | FKs COMPOSTAS (companyId, X) → pai(companyId, id) nas relações de negócio (2026-10-14, revisão do banco — achados C-02/D-05; gerado por codemod, revisado). PROBLEMA: a checagem de FK do PostgreSQL não passa pela RLS e a policy da linha filha só olha o companyI… | sim | — | `appointments`, `categories`, `channel_api_credentials`, `channel_events`, `channel_inbound_events`, `channel_outbox`, `channel_product_links`, `collection_attempts`, `damage_records`, `device_sessions`, `employee_agreement_charges`, `employee_payroll_deductions`, `external_order_items`, `external_orders`, `external_payments`, `follow_ups`, `fulfillments`, `invoices`, `mechanic_commissions`, `motorcycles`, `payment_exceptions`, `payments`, `products`, `purchase_orders`, `quote_events`, `quotes`, `revisions`, `sales`, `service_order_warranties`, `service_orders`, `stock_movements`, `stock_reservations`, `supplier_return_events`, `supplier_return_items`, `supplier_returns`, `support_ticket_attachments`, `support_ticket_events`, `support_ticket_messages`, `vehicle_entry_checklists`, `warranty_claims`, `accounts_payable`, `accounts_receivable`, `cash_registers`, `discount_events`, `employee_agreements`, `fiscal_documents`, `import_batches`, `tef_payments`, `transfers` | 32 | 0 | DROP CONSTRAINT; bloco DO $$ | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 43 | `20261015100000_company_and_branch_fks` | FKs de EMPRESA e de FILIAL nas tabelas de negócio (2026-10-15, revisão do banco — achados C-02/D-05, continuação de 20261014180000_composite_company_fks). PROBLEMA: 65 tabelas de negócio tinham "companyId" sem FK para companies (linha órfã de empresa inexisten… | sim | — | `accounts_payable`, `accounts_receivable`, `agenda_unavailabilities`, `agreement_companies`, `appointments`, `business_calendar_exceptions`, `business_hours`, `cash_registers`, `categories`, `channel_api_credentials`, `channel_events`, `channel_inbound_events`, `channel_outbox`, `channel_product_links`, `collection_attempts`, `commission_rules`, `company_module_settings`, `customers`, `damage_records`, `device_sessions`, `discount_events`, `discount_rules`, `employee_agreement_charges`, `employee_agreements`, `employee_payroll_deductions`, `external_order_items`, `external_orders`, `external_payments`, `fiscal_configs`, `fiscal_documents`, `follow_ups`, `fulfillments`, `import_batches`, `inventories`, `invoices`, `mechanic_commissions`, `motorcycles`, `payment_exceptions`, `payment_settings`, `payments`, `policy_changes`, `policy_settings`, `products`, `purchase_orders`, `quote_events`, `quotes`, `revisions`, `sales`, `sales_channels`, `service_order_warranties`, `service_orders`, `stock_movements`, `stock_reservations`, `supplier_return_events`, `supplier_return_items`, `supplier_returns`, `suppliers`, `support_ticket_attachments`, `support_ticket_events`, `support_ticket_messages`, `support_tickets`, `tef_payments`, `transfers`, `vehicle_entry_checklists`, `warranty_claims`, `installment_policies`, `partners` | 0 | 0 | bloco DO $$ | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 44 | `20261015110000_cascade_to_restrict_history` | ON DELETE CASCADE → RESTRICT em histórico, dinheiro, estoque, serviço e auditoria (2026-10-15, revisão do banco — achado D-05). PROBLEMA: apagar uma venda levava junto os pagamentos; apagar um produto, o livro de estoque; apagar um caixa, os movimentos; apagar… | sim | — | `audit_logs`, `branches`, `users`, `licenses`, `privacy_requests`, `cash_movements`, `payments`, `sale_items`, `stock_movements`, `purchase_order_items`, `quote_events`, `quote_items`, `quote_versions`, `service_order_items`, `service_order_status_history`, `transfer_items`, `vehicle_entry_checklist_items`, `vehicle_entry_checklists`, `appointment_events`, `follow_up_events`, `inventory_counts` | 0 | 0 | DROP CONSTRAINT; bloco DO $$ | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 45 | `20261015120000_append_only_ledgers` | LIVROS APPEND-ONLY por comando (2026-10-15, revisão do banco — achado E-03). PROBLEMA: stock_movements (livro de estoque), cash_movements (livro de caixa), policy_changes (trilha de mudança de política) e service_order_status_history (histórico de status da OS… | sim | — | — | 0 | 12 | DROP POLICY | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 46 | `20261015130000_drop_duplicate_indexes` | ÍNDICES DUPLICADOS (2026-10-15, revisão do banco — achado F-02). Cada par abaixo tem o MESMO conjunto de colunas: um índice único (que já atende às buscas e à unicidade) e um índice comum idêntico, que só custa escrita e espaço. Mantém-se o ÚNICO e remove-se o… | sim | — | — | 0 | 0 | DROP INDEX | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 47 | `20261015140000_missing_fk_and_rls_indexes` | ÍNDICES FALTANTES (2026-10-15, revisão do banco — achado F-03). (a) 9 tabelas tinham "companyId" (coluna filtrada por TODA policy de RLS) sem nenhum índice que começasse por ela; (b) 7 colunas de FK (estoque→usuário, pagamento→convênio, recebível→convênio, exc… | sim | — | — | 16 | 0 | — | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 48 | `20261015150000_database_timezone_utc` | FUSO DO BANCO = UTC (2026-10-15, revisão do banco — achado F-04). PROBLEMA: o banco rodava em America/Sao_Paulo. As 273 colunas `timestamp without time zone` guardam UTC (o Prisma grava sempre UTC), mas os 110 `DEFAULT CURRENT_TIMESTAMP` convertem pelo fuso da… | sim | — | — | 0 | 0 | bloco DO $$ | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 49 | `20261015160000_same_company_ref_triggers` | MESMA EMPRESA NAS 3 REFERÊNCIAS QUE NÃO PODEM TER FK COMPOSTA (2026-10-15, revisão do banco — achado C-02, resíduo). PROBLEMA: sales.partnerId (SET NULL; a aplicação apaga convênios), service_orders.mechanicId (SET NULL; a aplicação apaga usuários) e users.bra… | sim | — | — | 0 | 0 | bloco DO $$ | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 50 | `20261015170000_drop_redundant_company_indexes` | ÍNDICES "companyId" REDUNDANTES COM O ALVO DAS FKs COMPOSTAS (2026-10-15, revisão do banco — achado F-02, continuação). As FKs compostas (companyId, X) -> pai(companyId, id) exigiram o índice ÚNICO (companyId, id) em cada pai (migration 20261014180000 e anteri… | sim | — | — | 0 | 0 | DROP INDEX | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 51 | `20261016100000_branch_scope_rls` | ESCOPO DE FILIAL NAS TABELAS QUE SÓ ISOLAVAM POR EMPRESA (2026-10-16, produção/segurança multi-tenant). REGRA DE NEGÓCIO (definida): usuário com acesso EMPRESARIAL (COMPANY_ADMIN; SUPER_ADMIN na empresa-alvo) consulta todas as filiais da PRÓPRIA empresa e o da… | sim | — | — | 0 | 29 | DROP POLICY | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 52 | `20261016110000_privilege_escalation_guards` | TRAVAS CONTRA ELEVAÇÃO DE PRIVILÉGIO POR SQL DIRETO (2026-10-16, continuação de 20261016100000_branch_scope_rls). PROBLEMA (provado por teste com o papel real da aplicação): as rotas de administração já exigem COMPANY_ADMIN/SUPER_ADMIN, mas as policies de vári… | sim | — | — | 0 | 21 | DROP POLICY | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 53 | `20261017100000_rls_signed_context` | CONTEXTO DE RLS ASSINADO (2026-10-17, decisão 151) — mitigação do risco "SQL arbitrário na conexão da API escolhe o contexto da RLS". PROBLEMA (documentado na decisão 132 e provado antes): as policies leem variáveis de sessão (`app.user_type`, `app.current_com… | sim | `app_ctx`, `app_ctx_vault` | — | 0 | 0 | DELETE FROM; dados: INSERT app_ctx; dados: INSERT app_ctx_vault | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 54 | `20261017110000_user_branches` | VÍNCULOS DE FILIAL DO USUÁRIO (2026-10-17, decisão 153) — gerente de UMA ou de VÁRIAS filiais. PROBLEMA: o modelo só tinha `users.branchId` (uma filial). Um gerente responsável por duas filiais precisava de dois usuários ou de acesso empresarial. CORREÇÃO (adi… | sim | `user_branches` | — | 2 | 4 | — | aplicada 2026-10-15 | aplicada 2026-10-15 | **não aplicada** (ambiente inexistente / não verificado) |
| 55 | `20261018100000_user_password_change` | TROCA DE SENHA PELO PRÓPRIO USUÁRIO E SENHA TEMPORÁRIA (2026-10-18, decisão 157). PROBLEMA: só um administrador redefinia senha. Quem criava a conta de um cliente conhecia a senha dele para sempre, e o usuário não tinha como trocá-la sozinho. CORREÇÃO (aditiva… | sim | — | `users` | 0 | 0 | — | aplicada 2026-10-18 | aplicada 2026-10-18 | **não aplicada** (ambiente inexistente / não verificado) |
| 56 | `20261019100000_monitoring_central` | CENTRAL DE MONITORAMENTO (2026-10-19) — estrutura ADITIVA do Super Admin: tratamento de alertas, amostras de saúde, funil comercial, entregas externas e ajustes. PROBLEMA: o monitoramento existente (monitoring_alerts, health_incidents, thresholds) mostrava o e… | sim | `monitoring_alert_events`, `service_health_samples`, `commercial_leads`, `commercial_lead_events`, `external_deliveries`, `monitoring_settings` | `monitoring_alerts` | 10 | 10 | — | aplicada 2026-10-19 | aplicada 2026-10-19 | **não aplicada** (ambiente inexistente / não verificado) |
| 57 | `20261019110000_monitoring_alert_events_company_index` | ÍNDICE POR EMPRESA NO HISTÓRICO DE ALERTAS (2026-10-19) — complemento ADITIVO de 20261019100000_monitoring_central. PROBLEMA: o teste de invariantes do banco (database-schema-invariants: "toda tabela com companyId tem índice que COMEÇA por companyId") apontou … | sim | — | — | 1 | 0 | — | aplicada 2026-10-19 | aplicada 2026-10-19 | **não aplicada** (ambiente inexistente / não verificado) |

Notas: "Operações a conferir" é uma varredura textual do SQL (não executa nada) — marca o que merece olhar humano antes de rodar em produção; **não** significa que a operação seja inadequada. `SET NOT NULL` aparece quando uma coluna passa a ser obrigatória; `bloco DO $$` indica SQL dinâmico (ex.: RLS aplicada em laço), que a varredura não consegue listar tabela a tabela.

## 3. Estruturas por migration (detalhe)

### `0_init`

- Arquivo: 96661 bytes · sha256 `97b7951529cdd84e`…
- Finalidade: LN System — baseline schema migration. This is a single consolidated "0_init" migration standing in for the real (lost) migration history. It recreates the production schema exactly as extracted from a pg_dump of the live database: enums, tables, constraints (PK/UNIQUE/FK), indexes, the RLS helper functions, RLS enablement, and RLS policies — in that dependency order. _prisma_migrations is intentionally NOT created here: Prisma's migration engine manages that table itself.
- Tabelas criadas: `public`
- Tabelas alteradas: — · índices criados: 235 · policies criadas: 54 · triggers: 0 · funções: 7
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260914154506_add_revisions_postsale_agenda`

- Arquivo: 7177 bytes · sha256 `78fc62621dab52a6`…
- Finalidade: CreateEnum
- Tabelas criadas: `revisions`, `follow_ups`, `follow_up_events`, `appointments`, `appointment_events`
- Tabelas alteradas: — · índices criados: 21 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260914154543_add_revisions_postsale_agenda_rls`

- Arquivo: 2329 bytes · sha256 `a7a9d118aca743b8`…
- Finalidade: RLS for the Revisões / Pós-venda / Agenda domain (revisions, follow_ups, follow_up_events, appointments, appointment_events). Same pattern as the rest of the schema: tenant-scoped tables (own companyId/branchId) use rls_company_branch_match, which already treats a NULL branchId as "company-wide" (see 0_init/migration.sql). Event tables (no companyId of their own) isolate via a join to their parent, matching service_order_status_history_isolation — the parent's own RLS filters the subquery, so this only works because the connecting role never bypasses RLS (verified live this session: FORCE ROW LEVEL SECURITY + non-superuser role).
- Tabelas criadas: —
- Tabelas alteradas: `public` · índices criados: 0 · policies criadas: 5 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260914233256_add_inventory_one_in_progress_per_branch`

- Arquivo: 563 bytes · sha256 `014fa0a9c11aa077`…
- Finalidade: Achado de auditoria de integração: nada impedia dois inventários IN_PROGRESS simultâneos na mesma filial (mesma classe do problema já resolvido para CashRegister via índice único parcial). Sem isto, dois inventários abertos ao mesmo tempo capturariam o mesmo systemQuantity desatualizado e, no fechamento, o segundo sobrescreveria silenciosamente a correção do primeiro.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 1 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260915110038_add_company_module_settings`

- Arquivo: 1541 bytes · sha256 `ad8825353488954b`…
- Finalidade: CreateEnum
- Tabelas criadas: `company_module_settings`
- Tabelas alteradas: — · índices criados: 4 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260915110105_add_company_module_settings_rls`

- Arquivo: 862 bytes · sha256 `9b9b778671cddca1`…
- Finalidade: RLS para company_module_settings — mesmo padrão do resto do schema (ver 20260914154543_add_revisions_postsale_agenda_rls para o precedente direto desta sessão). rls_company_branch_match já trata branchId NULL na LINHA como "aplica pra empresa inteira, visível a todo mundo da empresa" — exatamente a semântica de negócio que este gate precisa (uma configuração company-wide deve ser enxergada por usuários de qualquer filial ao decidir se um módulo está ligado).
- Tabelas criadas: —
- Tabelas alteradas: `public` · índices criados: 0 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260915130221_add_accounts_reversal_unique_reference`

- Arquivo: 983 bytes · sha256 `cbc776bc1e3ed729`…
- Finalidade: Achado de auditoria de integração: `reversePayable`/`reverseReceivable` (financial.service.ts) só se protegiam contra estorno duplicado via um `findFirst` + `create` sem transação nem lock — o próprio código já documentava a janela de corrida teórica sob concorrência (clique duplo, retry de cliente) e a deixava sem correção no banco. Mesma classe do problema já resolvido para CashRegister/Inventory via índice único parcial: sem isto, duas chamadas de estorno simultâneas para a mesma conta paga podiam ambas ler "nenhum estorno ainda" e ambas criar um lançamento negativo, duplicando o efeito no fluxo de caixa.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 2 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260921120000_branch_rls_for_derived_financial`

- Arquivo: 3419 bytes · sha256 `1437d04d24347cc6`…
- Finalidade: Isolamento POR FILIAL para os registros financeiros que nascem de documentos de filial. ACHADO (bateria multi-empresa/multi-filial, 20 casos falhando): quatro tabelas só tinham RLS por EMPRESA, então o operador/gerente da filial A1 lia pagamentos, comissões e contas a pagar/receber da filial A2 — inclusive de vendas e OS que a própria RLS já escondia dele: payments -> Payment.saleId é obrigatório (onDelete Cascade): o pagamento pertence à venda, que é isolada por filial (NSU, autorização, final do cartão eram legíveis por outra filial); mechanic_commissions -> serviceOrderId obrigatório: a comissão pertence à OS, isolada por filial; accounts_payable / accounts_receivable -> têm `branchId` (com índice) e nascem de compras/OS/vendas de uma filial, mas a policy ignorava a coluna. Regra aplicada = a MESMA que já vale nas tabelas-irmãs (rls_company_branch_match): SUPER_ADMIN e COMPANY_ADMIN enxergam todas as filiais da empresa; os demais papéis enxergam a própria filial e os registros SEM filial (branchId NULL = da empresa toda). Pagamento e comissão herdam a visibilidade do documento de origem (mesmo padrão de sale_items -> sales e service_order_items -> service_orders). Não alterado de propósito (decisão de produto pendente, docs/tech-debt.md): customers, motorcycles, suppliers, categories, partners, installment_policies, discount_rules, commission_rules, transfers, invoices, tef_payments — cadastros/configurações da empresa. ROLLBACK (restaura as policies anteriores, só por empresa): ALTER POLICY payments_isolation ON public.payments USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId")); ALTER POLICY mechanic_commissions_isolation ON public.mechanic_commissions USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId")); ALTER POLICY accounts_payable_isolation ON public.accounts_payable USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId")); ALTER POLICY accounts_receivable_isolation ON public.accounts_receivable USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260925100000_audit_logs_append_only`

- Arquivo: 1401 bytes · sha256 `5fb30ac7462f4e24`…
- Finalidade: audit_logs append-only (defesa em profundidade). Antes: uma única policy (audit_logs_isolation) valia para TODOS os comandos — qualquer sessão da aplicação no contexto da empresa podia UPDATE/DELETE a própria trilha de auditoria. Nenhuma rota faz isso hoje, mas o banco não impedia. Agora: SELECT — igual a antes (Super Admin ou a própria empresa); INSERT — igual a antes; UPDATE — sem policy: sempre negado (FORCE RLS vale também para o dono da tabela); DELETE — só expurgo explícito: Super Admin COM `app.audit_purge = 'on'` na mesma transação (rotina de retenção). A exclusão em cascata de uma empresa (FK ON DELETE CASCADE) não passa por RLS e continua funcionando. Rollback: DROP das três policies abaixo e recriar audit_logs_isolation como em 0_init/migration.sql.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 3 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP POLICY

### `20260925120000_payment_cash_received`

- Arquivo: 255 bytes · sha256 `bd0839a41226f19f`…
- Finalidade: Dinheiro: valor recebido e troco por pagamento. `amount` passa a ser sempre o valor APLICADO à venda.
- Tabelas criadas: —
- Tabelas alteradas: `payments` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260925130000_payment_settings`

- Arquivo: 1188 bytes · sha256 `57f6e34bdb16dc85`…
- Finalidade: Configuração de pagamento (controle de cédulas opcional) e composição das cédulas por pagamento.
- Tabelas criadas: `payment_settings`
- Tabelas alteradas: `payments`, `public` · índices criados: 3 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260925140000_payment_providers`

- Arquivo: 452 bytes · sha256 `8c2df3e48145c455`…
- Finalidade: Provedor de cartão/PIX e terminal por empresa/filial; herança campo a campo (nulo = herda).
- Tabelas criadas: —
- Tabelas alteradas: `payment_settings` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260925150000_payment_provider_ref`

- Arquivo: 175 bytes · sha256 `27a4d2275eea7a4f`…
- Finalidade: Provedor externo que processou o pagamento (reconciliação consulta o mesmo provedor, mesmo que a configuração mude).
- Tabelas criadas: —
- Tabelas alteradas: `payments` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260925160000_monitoring_telemetry`

- Arquivo: 2443 bytes · sha256 `1aa8159f86877e82`…
- Finalidade: Monitoramento: telemetria real dos equipamentos e histórico de incidentes de saúde. RLS FORCE por empresa/filial.
- Tabelas criadas: `device_telemetry`, `health_incidents`
- Tabelas alteradas: `public` · índices criados: 6 · policies criadas: 2 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926100000_payment_exceptions`

- Arquivo: 1719 bytes · sha256 `73eaddba344d6c50`…
- Finalidade: Exceções de pagamento: fato do provedor que conflita com o estado da venda (ex.: aprovado/capturado depois que a venda foi cancelada ou devolvida). O pagamento registra a verdade (APPROVED); a venda fica como está; a exceção fica aberta até alguém tratar. A regra comercial de tratamento é [DECISÃO NECESSÁRIA] (docs/CORTEX/BUSINESS_RULES.md).
- Tabelas criadas: `payment_exceptions`
- Tabelas alteradas: `public` · índices criados: 2 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926110000_telemetry_runtime_version`

- Arquivo: 229 bytes · sha256 `e08f6dfc00b8b1f0`…
- Finalidade: Versão do runtime (Electron/Node/Chrome) separada da versão do app CÓRTEX: o PDV não empacotado reportava a versão do Electron (28.3.3) em `appVersion`.
- Tabelas criadas: —
- Tabelas alteradas: `device_telemetry` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926120000_monitoring_thresholds_alerts`

- Arquivo: 3771 bytes · sha256 `fe1beee566a40b32`…
- Finalidade: Limites do monitoramento configuráveis (global → empresa → filial) com histórico, e alertas com deduplicação.
- Tabelas criadas: `monitoring_thresholds`, `monitoring_threshold_changes`, `monitoring_alerts`
- Tabelas alteradas: `public` · índices criados: 5 · policies criadas: 5 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926130000_users_policy_hide_platform_users`

- Arquivo: 493 bytes · sha256 `3f2ad0757b6bbbdd`…
- Finalidade: A política de users deixava QUALQUER contexto de empresa ler as linhas dos usuários da plataforma (companyId nulo: Super Admins) — hash de senha e segredo de MFA (cifrado) incluídos — pela cláusula `OR "companyId" IS NULL`. O login não depende dela (busca o usuário em contexto SUPER_ADMIN). Leitura agora: Super Admin, ou a própria empresa.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926140000_appointment_confirmation_evidence`

- Arquivo: 379 bytes · sha256 `678ca726e444a975`…
- Finalidade: Confirmação do agendamento = aceite do CLIENTE/responsável pelo veículo. Antes só o funcionário ficava registrado (performedBy); agora a confirmação guarda quem confirmou e por qual canal. Confirmações antigas ficam nulas.
- Tabelas criadas: —
- Tabelas alteradas: `appointments` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926150000_revision_recommendations`

- Arquivo: 182 bytes · sha256 `4fcf4b4e24d5f536`…
- Finalidade: Recomendação ao cliente registrada na revisão (o que fazer/observar até a próxima). Revisões antigas ficam nulas.
- Tabelas criadas: —
- Tabelas alteradas: `revisions` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260926160000_import_batches`

- Arquivo: 1328 bytes · sha256 `b5ce765db9e21527`…
- Finalidade: Rastreabilidade da importação em lote: cada importação vira um lote com o resultado de CADA linha (criada, atualizada, sem alteração, erro + motivo). As linhas continuam independentes (uma linha ruim não derruba as boas), mas nada fica parcialmente importado sem registro. Movimentos de estoque apontam para o lote (referenceId).
- Tabelas criadas: `import_batches`
- Tabelas alteradas: `public` · índices criados: 1 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260927100000_policies_and_new_domains`

- Arquivo: 16243 bytes · sha256 `306d1deb5158832b`…
- Finalidade: Políticas por empresa/filial e domínios novos (2026-09-27), decididos pelo dono do produto: * políticas configuráveis (padrão da empresa + override da filial quando o catálogo permite), com histórico; * cadastro da empresa/filial/cliente; horário de funcionamento e calendário; * desconto auditado item a item; fechamento de caixa forçado; histórico de orçamento; conclusão de agendamento sem confirmação com autorização; garantia de OS e ocorrências; convênio de funcionário e de empresa externa; cobrança manual autorizada (sem robô de cobrança). Só acrescenta tabelas e colunas (nulas ou com padrão): nada existente muda de significado. ROLLBACK (migração reversa, nunca editar esta): DROP das tabelas novas; DROP COLUMN das colunas novas. Os valores novos do enum "PaymentMethod" não podem ser removidos no Postgres (inofensivos se não usados).
- Tabelas criadas: `policy_settings`, `policy_changes`, `business_hours`, `business_calendar_exceptions`, `discount_events`, `quote_events`, `service_order_warranties`, `warranty_claims`, `employee_agreements`, `employee_agreement_charges`, `employee_payroll_deductions`, `agreement_companies`, `collection_attempts`
- Tabelas alteradas: `companies`, `branches`, `customers`, `cash_registers`, `quotes`, `appointments`, `service_orders`, `accounts_receivable`, `payments`, `public` · índices criados: 23 · policies criadas: 3 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20260927100500_evidence_purge_policy`

- Arquivo: 748 bytes · sha256 `f9fa856af1f2937b`…
- Finalidade: discount_events e collection_attempts são evidência append-only (sem UPDATE, sem DELETE para usuário). Mesma regra de expurgo de audit_logs: DELETE só em contexto de Super Admin com a flag `app.audit_purge = on` (rotina de retenção ou limpeza de empresa sintética nos testes). Nenhum usuário da aplicação apaga essas linhas. ROLLBACK: DROP POLICY discount_events_purge / collection_attempts_purge.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 2 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20260928100000_consolidation_cash_agenda_supplier_returns`

- Arquivo: 6199 bytes · sha256 `772119284a0a7656`…
- Finalidade: Consolidação das políticas (2026-09-28): fechamento de caixa por forma de pagamento, convênio por filial, capacidade da agenda e devolução ao fornecedor. Só acrescenta colunas/tabelas/valor de enum; nada existente muda de sentido.
- Tabelas criadas: `agenda_unavailabilities`, `supplier_returns`, `supplier_return_items`, `supplier_return_events`
- Tabelas alteradas: `cash_registers`, `employee_agreements`, `agreement_companies`, `appointments`, `public` · índices criados: 8 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20260928200000_support_center`

- Arquivo: 20175 bytes · sha256 `5a2c3349b6d0ebea`…
- Finalidade: Central de Ajuda e Suporte (2026-09-28). Chamados da empresa (RLS empresa+filial), histórico e mensagens que só crescem, anexos no banco (sob RLS) e base de conhecimento global (leitura para todos os logados, escrita só da plataforma). Carga inicial da base ANTES de ligar a RLS: com FORCE, até o dono da tabela passaria pela política.
- Tabelas criadas: `support_tickets`, `support_ticket_messages`, `support_ticket_attachments`, `support_ticket_events`, `support_kb_categories`, `support_kb_articles`
- Tabelas alteradas: `public` · índices criados: 14 · policies criadas: 8 · triggers: 0 · funções: 0
- Dados: INSERT support_kb_categories; INSERT support_kb_articles · operações a conferir: nenhuma · contém bloco DO $$

### `20261004200000_sales_channels`

- Arquivo: 5150 bytes · sha256 `a1694cde7b343b78`…
- Finalidade: Canais de venda (2026-10-04): módulo CANAIS (nasce desativado), canais configuráveis por empresa/filial, pedidos externos, idempotência de eventos e origem da venda. Aditiva: nenhuma linha existente muda (venda sem canal = loja física). ROLLBACK: DROP das 4 tabelas e dos 4 tipos; ALTER TABLE sales DROP COLUMN "channelId". (O valor 'CANAIS' do enum SystemModule não é removível.)
- Tabelas criadas: `sales_channels`, `channel_events`, `external_orders`, `channel_inbound_events`
- Tabelas alteradas: `sales`, `public` · índices criados: 9 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261005100000_commerce_api_foundation`

- Arquivo: 6607 bytes · sha256 `b7435626a25392e6`…
- Finalidade: Commerce API, Fase 1 (2026-10-05): credenciais de canal (servidor -> servidor), publicação de produtos por canal, itens do pedido externo e pagamento externo. Aditiva: nenhuma linha existente muda (colunas novas de `external_orders` têm padrão). RISCO: nenhum. Estes objetos só são usados pela Commerce API (`/commerce/v1`), que nasce sem nenhuma credencial emitida. ROLLBACK (nesta ordem): DROP TABLE external_payments, external_order_items, channel_product_links, channel_api_credentials; ALTER TABLE external_orders DROP COLUMN totalAmount, channelTotal, source, correlationId, statusReason, statusChangedAt; DROP TYPE "ChannelCredentialScope". (As quatro tabelas só têm dados se a Commerce API foi usada; o rollback as descarta — exporte antes.)
- Tabelas criadas: `channel_api_credentials`, `channel_product_links`, `external_order_items`, `external_payments`
- Tabelas alteradas: `external_orders`, `public` · índices criados: 11 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261005200000_stock_reservations_and_channel_sales`

- Arquivo: 5501 bytes · sha256 `b2ba0ce4a90c9909`…
- Finalidade: Fase 2 da Commerce API (2026-10-05): reserva de estoque, venda de canal sem caixa físico e fulfillment mínimo. Aditiva. Venda física continua exigindo usuário e caixa: o CHECK só libera `userId`/`cashRegisterId` nulos quando há `channelId` (todas as linhas existentes têm os dois preenchidos e nenhum canal, então satisfazem o CHECK). ROLLBACK (nesta ordem): DROP TABLE fulfillments, stock_reservations; ALTER TABLE external_payments DROP COLUMN method; ALTER TABLE external_orders DROP CONSTRAINT external_orders_saleId_fkey, DROP COLUMN acceptedAt, acceptedBy, convertedAt; ALTER TABLE sales DROP CONSTRAINT sales_physical_origin_check; -- só se NENHUMA venda de canal existir: ALTER TABLE sales ALTER COLUMN "userId" SET NOT NULL, ALTER COLUMN "cashRegisterId" SET NOT NULL; DROP TYPE "FulfillmentStatus", "FulfillmentType", "StockReservationStatus". (O valor 'EXPIRED' de "ExternalOrderStatus" não é removível sem recriar o tipo.)
- Tabelas criadas: `stock_reservations`, `fulfillments`
- Tabelas alteradas: `sales`, `external_orders`, `external_payments`, `public` · índices criados: 7 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261005210000_stock_movement_user_optional`

- Arquivo: 496 bytes · sha256 `7c402acac6f976c1`…
- Finalidade: Fase 2 da Commerce API (2026-10-05): `stock_movements.userId` passa a aceitar nulo. Só o movimento SALE de uma venda de canal convertida sem operador o usa; todo movimento físico (PDV, balcão, OS, transferência, ajuste…) continua gravando o usuário. Aditiva: nenhuma linha existente muda. ROLLBACK (só se nenhum movimento tiver userId nulo): ALTER TABLE "stock_movements" ALTER COLUMN "userId" SET NOT NULL;
- Tabelas criadas: —
- Tabelas alteradas: `stock_movements` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261006100000_integration_gateway`

- Arquivo: 3402 bytes · sha256 `acfb8c4b101733e3`…
- Finalidade: Fase 3 (2026-10-06): Integration Gateway — caixa de entrada com reprocessamento (eventos fora de ordem), caixa de saída e cursor de consulta. Aditiva: colunas novas anuláveis/com padrão, uma tabela nova e um enum novo. Nada existente muda de significado. ROLLBACK (nesta ordem): DROP TABLE channel_outbox; DROP TYPE "ChannelOutboxStatus"; DROP INDEX "channel_inbound_events_channelId_orderRef_outcome_idx", "channel_inbound_events_outcome_receivedAt_idx"; ALTER TABLE channel_inbound_events DROP COLUMN payload, DROP COLUMN "occurredAt", DROP COLUMN "orderRef", DROP COLUMN "correlationId", DROP COLUMN attempts, DROP COLUMN "processedAt", DROP COLUMN "lastError"; ALTER TABLE sales_channels DROP COLUMN "inboundCursor"; (Perde só o que a Fase 3 gravou: eventos adiados e linhas pendentes de envio.)
- Tabelas criadas: `channel_outbox`
- Tabelas alteradas: `sales_channels`, `channel_inbound_events`, `public` · índices criados: 5 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261006200000_device_enrollment`

- Arquivo: 1534 bytes · sha256 `7e97016e23dcb248`…
- Finalidade: Autorização de dispositivos (2026-10-06): enrolamento sem empresa, vínculo a licença e filial feito pelo administrador, chave do equipamento (guardada só como hash) e sessão de login presa à sessão de equipamento. Aditiva e compatível: os equipamentos existentes têm licença e ficam como estão (sem chave = legado, a reenrolar). ROLLBACK (nesta ordem, só se NENHUM equipamento sem licença existir): ALTER TABLE devices DROP CONSTRAINT devices_active_needs_license_check; DROP INDEX "refresh_tokens_deviceSessionId_idx", "devices_enrollmentCode_key"; ALTER TABLE refresh_tokens DROP COLUMN "deviceSessionId"; ALTER TABLE devices DROP COLUMN "enrollmentCode", DROP COLUMN "secretHash", DROP COLUMN "branchId"; -- só sem equipamentos pendentes sem licença: ALTER TABLE devices ALTER COLUMN "licenseId" SET NOT NULL;
- Tabelas criadas: —
- Tabelas alteradas: `devices`, `refresh_tokens` · índices criados: 2 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261014100000_product_barcodes`

- Arquivo: 2901 bytes · sha256 `bc3a28c84f0e5555`…
- Finalidade: Vários códigos de barras por produto (2026-10-14). ADITIVA: nenhuma coluna ou linha existente é alterada ou removida. * `products.barcode` continua existindo (código "principal", usado por telas e integrações atuais) e é sincronizado com esta tabela pela aplicação; o backfill abaixo copia os códigos já cadastrados. * (companyId, code) é ÚNICO: um código de barras identifica UM produto na empresa. Desativar mantém a linha (histórico, e o código não é reaproveitado em silêncio por outro produto); duplicatas LEGADAS em products.barcode não são descartadas — só a primeira entra aqui e as demais continuam em products.barcode, onde a leitura as trata como ambíguas (409). * O código é texto: zeros à esquerda são preservados. ROLLBACK (nada mais depende desta tabela; products.barcode permanece intacto): DROP TABLE "product_barcodes";
- Tabelas criadas: `product_barcodes`
- Tabelas alteradas: `public` · índices criados: 3 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: INSERT product_barcodes · operações a conferir: nenhuma

### `20261014120000_access_revocations`

- Arquivo: 1676 bytes · sha256 `f1af8b6c6dd4b83c`…
- Finalidade: Revogação durável de access token (decisão 107, 2026-10-14). ADITIVA: tabela nova, nada existente é alterado. * O Redis segue como caminho rápido da checagem; esta tabela é a fonte de verdade quando o Redis cai (a API passa a consultar aqui em vez de aceitar um token revogado) e a origem da ressincronização do Redis quando ele volta. * kind = TOKEN (subject = sha256 do access token) \| USER \| COMPANY (subject = id; revokedAt = "tudo emitido até aqui está revogado"). * Só a plataforma (SUPER_ADMIN no contexto RLS) lê e grava: o middleware de autenticação roda antes de existir contexto de empresa. ROLLBACK (a API volta a depender só do Redis; sem dado de negócio aqui): DROP TABLE "access_revocations";
- Tabelas criadas: `access_revocations`
- Tabelas alteradas: `public` · índices criados: 2 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261014130000_mfa_replay_guard`

- Arquivo: 468 bytes · sha256 `889793f6132b4c8c`…
- Finalidade: Anti-reuso de código TOTP (decisão 123, 2026-10-14). ADITIVA: uma coluna anulável; nada existente é alterado. * users."mfaLastStep" guarda o último passo TOTP de 30 s já consumido; a aplicação recusa código de passo igual ou anterior (atualização condicional atômica: duas requisições com o mesmo código não passam as duas). ROLLBACK: ALTER TABLE "users" DROP COLUMN "mfaLastStep";
- Tabelas criadas: —
- Tabelas alteradas: `users` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261014140000_privacy_requests`

- Arquivo: 2701 bytes · sha256 `cf69dc804fecd2b0`…
- Finalidade: Pedidos de titular — LGPD (decisão 120, 2026-10-14). ADITIVA: uma tabela nova e uma coluna anulável em customers. * privacy_requests: registro durável do pedido (exportação ou anonimização de UM cliente): quem pediu, quando, por quê, o que foi feito e o que foi retido (e por quê). Não guarda o dado anonimizado; o arquivo de exportação é cifrado pela aplicação (enc:v1), vale só até exportExpiresAt e é apagado por rotina. * customers."anonymizedAt": marca o cadastro anonimizado (irreversível: os dados originais não são guardados em lugar nenhum). ROLLBACK (nenhum outro dado depende destes objetos): DROP TABLE "privacy_requests"; ALTER TABLE "customers" DROP COLUMN "anonymizedAt";
- Tabelas criadas: `privacy_requests`
- Tabelas alteradas: `customers`, `public` · índices criados: 3 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261014150000_product_images`

- Arquivo: 2318 bytes · sha256 `24d98d6b7b5ad941`…
- Finalidade: Imagem opcional do produto (decisão 122, 2026-10-14). ADITIVA: uma tabela nova; nenhum dado existente muda. * No máximo UMA imagem por produto (productId único). O conteúdo (PNG/JPEG/WebP já validado e saneado pela aplicação: sem metadados, sem bytes sobrando, dimensões e tamanho limitados) fica no banco sob RLS — a mesma arquitetura dos anexos do Suporte; não existe armazenamento de arquivo externo no projeto. Só sai por rota autenticada da própria empresa. * Apagar o produto apaga a imagem (cascata). Produto sem imagem continua exatamente como antes (cadastro e importação não mudam). ROLLBACK (nenhum outro dado depende desta tabela): DROP TABLE "product_images";
- Tabelas criadas: `product_images`
- Tabelas alteradas: `public` · índices criados: 2 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261014155900_guard_product_children_same_company`

- Arquivo: 2409 bytes · sha256 `5c27f0c69528852c`…
- Finalidade: GUARDA da migration 20261014160000_product_children_same_company (2026-10-14). Só LÊ; não altera nada. Aborta se houver dado que violaria a FK composta. POR QUE EXISTE: o ADD CONSTRAINT de uma FK valida as linhas existentes COM A RLS DO DONO. As tabelas são FORCE ROW LEVEL SECURITY e a migration roda como o dono (o mesmo papel da aplicação) SEM contexto de empresa: o dono enxerga ZERO linhas, o PostgreSQL "valida" uma tabela aparentemente vazia e a FK é criada MESMO COM linha violando (provado em experimento revertido: com uma linha cruzada, o ADD CONSTRAINT passou; com app.user_type = 'SUPER_ADMIN' ele falhou). A nota "esta migration falha se houver dado inconsistente" não valia sozinha. Esta guarda faz a checagem EXPLÍCITA, em contexto de plataforma (visível: todas as linhas), antes de qualquer constraint. ORDEM: o nome (155900) a coloca ANTES de 20261014160000 em banco novo/staging/produção. Nos bancos de dev/teste, onde a 160000 já tinha sido aplicada (sem dado cruzado), ela roda depois e apenas confirma o estado. SE FALHAR: corrija as linhas por procedimento documentado e rastreável (nunca apagando histórico) e reaplique: SELECT b.id, b."companyId" AS barcode_company, p."companyId" AS product_company FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId"; (idem product_images). Depois de corrigir: prisma migrate resolve --rolled-back 20261014155900_guard_product_children_same_company e prisma migrate deploy. ROLLBACK: nada a desfazer (não altera estrutura nem dado).
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261014160000_product_children_same_company`

- Arquivo: 3760 bytes · sha256 `55553f4ca2cb8265`…
- Finalidade: Códigos de barras e imagem do produto: o produto tem que ser da MESMA empresa da linha (2026-10-14, revisão do banco). PROBLEMA: product_barcodes e product_images tinham FK só em (productId) → products(id), e a policy RLS da linha filha só confere o "companyId" da PRÓPRIA linha. A checagem de FK do PostgreSQL NÃO passa pela RLS: uma sessão da empresa A gravava (companyId = A, productId = produto da empresa B) e a linha ficava "da A" apontando para o produto da B (provado por teste de integração: product-children-same-company, que falhava antes desta migration). CORREÇÃO (ADITIVA para os dados; troca de restrição): (1) chave única composta products("companyId","id") — redundante com a PK, mas é o alvo que uma FK composta exige; (2) FK composta ("companyId","productId") → products("companyId","id") nas duas tabelas, com as MESMAS regras de antes (código de barras: ON DELETE RESTRICT; imagem: ON DELETE CASCADE; ON UPDATE CASCADE); (3) as FKs simples antigas saem (a composta já garante a existência do produto). Nenhuma linha é lida/alterada/apagada; as FKs para "companies" ficam como estão. PRÉ-CHECAGEM: feita pela migration 20261014155900_guard_product_children_same_company (roda ANTES desta em banco novo/staging/produção). ATENÇÃO — correção de uma nota anterior: o ADD CONSTRAINT abaixo, executado pelo dono da tabela sob FORCE ROW LEVEL SECURITY e sem contexto de empresa, NÃO enxerga as linhas (a RLS as esconde) e "valida" em branco; por isso NÃO se pode contar com ele para detectar dado cruzado (provado em experimento revertido). A detecção é a da migration-guarda, que lê com app.user_type = 'SUPER_ADMIN'. Consulta manual (como Super Admin / papel que ignora RLS; os dois devem dar 0): SELECT count(*) FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId"; SELECT count(*) FROM product_images i JOIN products p ON p.id = i."productId" WHERE p."companyId" <> i."companyId"; BLOQUEIO: CREATE UNIQUE INDEX e ADD CONSTRAINT tomam lock curto (tabelas pequenas: catálogo de produtos); em tabela muito grande, criar o índice antes com CREATE UNIQUE INDEX CONCURRENTLY (fora de transação) e depois aplicar esta migration. ROLLBACK (nenhum dado depende das restrições novas): ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE; ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; ALTER TABLE "product_barcodes" DROP CONSTRAINT "product_barcodes_companyId_productId_fkey"; ALTER TABLE "product_images" DROP CONSTRAINT "product_images_companyId_productId_fkey"; DROP INDEX "products_companyId_id_key";
- Tabelas criadas: —
- Tabelas alteradas: `product_barcodes`, `product_images` · índices criados: 1 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP CONSTRAINT

### `20261014161000_product_images_company_product_unique`

- Arquivo: 776 bytes · sha256 `77021c21f2651111`…
- Finalidade: Imagem do produto: chave única ("companyId","productId") (2026-10-14, continuação de 20261014160000_product_children_same_company). O Prisma só aceita a relação 1:1 Product.image ↔ ProductImage pela FK composta (companyId, productId) se a tabela filha tiver ESSA chave única declarada. É redundante com o índice único já existente em ("productId") — "no máximo uma imagem por produto" continua garantido por ele —, não muda nenhum dado nem regra, e custa um índice pequeno (uma imagem por produto, no máximo). ROLLBACK: DROP INDEX "product_images_companyId_productId_key"; (e remover o @@unique([companyId, productId]) do schema)
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 1 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261014162000_rls_logs_roles_tighten`

- Arquivo: 3883 bytes · sha256 `99f89237e11ce771`…
- Finalidade: RLS de logs e de perfis/permissões globais (2026-10-14, revisão do banco). Nenhuma linha é lida, alterada ou apagada: só troca de políticas. PROBLEMAS (provados por teste de integração em sessão de EMPRESA, que falhava antes desta migration): 1. request_logs e system_logs: "WITH CHECK (true)" deixava a empresa A gravar log em nome da empresa B (ou sem empresa), e "USING (… OR companyId IS NULL)" deixava toda empresa LER os logs de plataforma (companyId nulo) — eventos de segurança de outros usuários, p.ex. REFRESH_TOKEN_REUSE_DETECTED (no dev: 371 system_logs e 3540 request_logs de plataforma visíveis a uma empresa). 2. roles e permissions: uma política ALL com "USING (… OR companyId IS NULL)" fazia o DELETE e o UPDATE de uma sessão de empresa alcançarem os perfis e permissões GLOBAIS (de sistema); o WITH CHECK só protegia a gravação nova. CORREÇÃO: logs passam a usar rls_company_match("companyId") (Super Admin OU a própria empresa) em leitura e escrita — quem grava log é o worker, em contexto de plataforma (jobs/observability.job.ts), e a empresa só lê os seus. Roles/permissions: LEITURA continua incluindo os globais (a empresa precisa listá-los e atribuí-los); INSERT/UPDATE/DELETE só da própria empresa ou do Super Admin. ROLLBACK (recria as políticas anteriores): DROP POLICY "request_logs_isolation" ON "request_logs"; CREATE POLICY "request_logs_isolation" ON "request_logs" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (true); DROP POLICY "system_logs_isolation" ON "system_logs"; CREATE POLICY "system_logs_isolation" ON "system_logs" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (true); DROP POLICY "roles_select" ON "roles"; DROP POLICY "roles_insert" ON "roles"; DROP POLICY "roles_update" ON "roles"; DROP POLICY "roles_delete" ON "roles"; CREATE POLICY "roles_isolation" ON "roles" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (is_super_admin() OR ("companyId" = get_current_company_id())); (idem permissions_select/insert/update/delete → permissions_isolation)
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 10 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP POLICY

### `20261014170000_refresh_tokens_hash_and_company`

- Arquivo: 5945 bytes · sha256 `81c7483fbc97865d`…
- Finalidade: refresh_tokens: hash do token, empresa preenchida e RLS de verdade (2026-10-14, revisão do banco — achado D-01, gravidade Alta). PROBLEMAS (provados antes): (1) a coluna "token" guardava o refresh token EM TEXTO — quem lesse a tabela ou um backup obtinha sessões utilizáveis por 7 dias; (2) "companyId" era NULO em 100% das linhas (136/136 no dev) e a policy aceitava "companyId IS NULL" para qualquer sessão: uma sessão de EMPRESA enxergava (e poderia alterar/apagar) as sessões de todas as empresas e as do Super Admin. ESTRATÉGIA (sem derrubar sessão legítima — o mesmo token continua achando a mesma linha): 1. nova coluna "tokenHash" = SHA-256 (hex) do token, calculada em SQL com o MESMO algoritmo da aplicação (encode(sha256(convert_to(token,'UTF8')),'hex') == createHash('sha256').update(token,'utf8').digest('hex')); 2. "companyId" preenchido SÓ a partir de users."companyId" (a única relação confiável: refresh_tokens.userId → users); sessão de usuário de plataforma (users."companyId" nulo) continua com companyId nulo, visível só ao Super Admin. Nada é "adivinhado": se algum token já tiver companyId diferente do usuário, a migration ABORTA (investigar), em vez de sobrescrever; 3. a coluna "token" (texto) é REMOVIDA depois de conferido que todas as linhas têm hash — é a remoção deliberada do segredo em texto; 4. FK "companyId" → companies (CASCADE: a sessão morre com a empresa) e FK composta ("companyId","userId") → users("companyId","id") (a sessão de um usuário não pode ser gravada em empresa que não é a dele; a FK simples userId → users continua para as de plataforma); 5. policy: Super Admin OU a própria empresa (sem o ramo "companyId IS NULL"). A migration roda como DONO sob FORCE RLS: sem contexto o dono enxerga ZERO linhas (e a validação das FKs passaria em branco), por isso a 1ª instrução põe o contexto de plataforma NESTA transação. COMPATIBILIDADE: a aplicação nova busca por "tokenHash". Voltar o código sem o banco quebra a renovação das sessões abertas (precisariam entrar de novo); o banco não volta ao texto — o hash não permite reconstruir o token. ROLLBACK (parcial, sem recuperar o texto dos tokens — as sessões abertas caem e a pessoa entra de novo): DROP POLICY "refresh_tokens_isolation" ON "refresh_tokens"; CREATE POLICY "refresh_tokens_isolation" ON "refresh_tokens" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)); ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_companyId_userId_fkey", DROP CONSTRAINT "refresh_tokens_companyId_fkey"; DROP INDEX "users_companyId_id_key"; ALTER TABLE "refresh_tokens" ADD COLUMN "token" TEXT; UPDATE "refresh_tokens" SET "token" = "id" \|\| '-revogado'; UPDATE "refresh_tokens" SET "isRevoked" = true; ALTER TABLE "refresh_tokens" ALTER COLUMN "token" SET NOT NULL; CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token"); CREATE INDEX "refresh_tokens_token_idx" ON "refresh_tokens"("token"); DROP INDEX "refresh_tokens_tokenHash_key"; ALTER TABLE "refresh_tokens" DROP COLUMN "tokenHash";
- Tabelas criadas: —
- Tabelas alteradas: `refresh_tokens` · índices criados: 2 · policies criadas: 1 · triggers: 0 · funções: 0
- Dados: UPDATE refresh_tokens · operações a conferir: DROP COLUMN, DROP POLICY, SET NOT NULL · contém bloco DO $$

### `20261014180000_composite_company_fks`

- Arquivo: 84188 bytes · sha256 `9618c9e5ac64f597`…
- Finalidade: FKs COMPOSTAS (companyId, X) → pai(companyId, id) nas relações de negócio (2026-10-14, revisão do banco — achados C-02/D-05; gerado por codemod, revisado). PROBLEMA: a checagem de FK do PostgreSQL não passa pela RLS e a policy da linha filha só olha o companyId da PRÓPRIA linha; nenhuma FK simples impede (companyId = A, <pai> = registro da empresa B). Provado em product_barcodes/product_images (migrations 20261014155900–161000). ESCOPO: 61 FKs EXISTENTES viram compostas (as simples saem; mesmas regras de exclusão) e 33 relações que eram só colunas soltas ganham FK composta ON DELETE RESTRICT (financeiras, estoque, convênios, fiscal, devolução, transferência entre filiais). 8 relações "SET NULL" sem caminho de exclusão na aplicação (varredura do código) passam a RESTRICT; sales.partnerId (a aplicação apaga convênios) e service_orders.mechanicId (a aplicação apaga usuários) ficam SET NULL e SEM composta — o Prisma não modela SET NULL parcial (anularia o companyId) — protegidas só pela aplicação e pelo teste de dados (decisão 129, resíduo documentado). GUARDA: a validação de FK feita pelo dono sob FORCE RLS passa em branco (achado C-03); o bloco DO abaixo lê com contexto de plataforma e ABORTA, listando as relações, se houver linha cujo pai não exista OU seja de outra empresa. Linhas de empresas que NÃO EXISTEM MAIS (órfãs por limpeza de teste, ex.: 1 recebível no dev) não são "associadas" a nenhuma empresa por suposição: ficam intactas e a FK correspondente permanece NOT VALID (vale para linhas novas e alteradas; convalidated = false é o sinal para tratar o legado). CRIAÇÃO: ADD CONSTRAINT … NOT VALID (lock curto) e depois VALIDATE (em contexto de plataforma). Os índices únicos (companyId, id) são redundantes com a PK e servem de alvo. ROLLBACK (nenhum dado depende das restrições novas; recria as FKs simples): para cada relação "up": ALTER TABLE <filho> DROP CONSTRAINT <filho>_companyId_<col>_fkey; ALTER TABLE <filho> ADD CONSTRAINT <nome-antigo> FOREIGN KEY (<col>) REFERENCES <pai>(id) ON DELETE <regra> ON UPDATE CASCADE; para cada relação "new": ALTER TABLE <filho> DROP CONSTRAINT <filho>_companyId_<col>_fkey; DROP INDEX <pai>_companyId_id_key (todos os pais). RELAÇÕES (up = FK existente que vira composta; new = FK nova): up appointments.customerId → customers (RESTRICT) up appointments.followUpId → follow_ups (RESTRICT) up appointments.motorcycleId → motorcycles (RESTRICT) up categories.parentId → categories (RESTRICT) up channel_api_credentials.channelId → sales_channels (RESTRICT) up channel_events.channelId → sales_channels (RESTRICT) up channel_inbound_events.channelId → sales_channels (RESTRICT) up channel_outbox.channelId → sales_channels (RESTRICT) up channel_product_links.channelId → sales_channels (RESTRICT) up channel_product_links.productId → products (RESTRICT) up collection_attempts.receivableId → accounts_receivable (RESTRICT) up damage_records.productId → products (RESTRICT) up device_sessions.userId → users (CASCADE) up employee_agreement_charges.agreementId → employee_agreements (RESTRICT) up employee_payroll_deductions.chargeId → employee_agreement_charges (RESTRICT) up external_order_items.orderId → external_orders (RESTRICT) up external_order_items.productId → products (RESTRICT) up external_orders.channelId → sales_channels (RESTRICT) up external_orders.saleId → sales (RESTRICT) up external_payments.channelId → sales_channels (RESTRICT) up external_payments.orderId → external_orders (RESTRICT) up follow_ups.customerId → customers (RESTRICT) up follow_ups.motorcycleId → motorcycles (RESTRICT) up follow_ups.revisionId → revisions (RESTRICT) up fulfillments.orderId → external_orders (RESTRICT) up fulfillments.saleId → sales (RESTRICT) up invoices.purchaseOrderId → purchase_orders (RESTRICT) up invoices.supplierId → suppliers (RESTRICT) up mechanic_commissions.serviceOrderId → service_orders (RESTRICT) up motorcycles.customerId → customers (RESTRICT) up payment_exceptions.paymentId → payments (RESTRICT) up payments.saleId → sales (CASCADE) up products.categoryId → categories (RESTRICT) up purchase_orders.supplierId → suppliers (RESTRICT) up quote_events.quoteId → quotes (CASCADE) up quotes.customerId → customers (RESTRICT) up quotes.motorcycleId → motorcycles (RESTRICT) up revisions.customerId → customers (RESTRICT) up revisions.motorcycleId → motorcycles (RESTRICT) up revisions.serviceOrderId → service_orders (RESTRICT) up sales.channelId → sales_channels (RESTRICT) up sales.customerId → customers (RESTRICT) up sales.userId → users (RESTRICT) up service_order_warranties.serviceOrderId → service_orders (RESTRICT) up service_orders.customerId → customers (RESTRICT) up service_orders.motorcycleId → motorcycles (RESTRICT) up stock_movements.productId → products (CASCADE) up stock_reservations.channelId → sales_channels (RESTRICT) up stock_reservations.orderId → external_orders (RESTRICT) up stock_reservations.productId → products (RESTRICT) up supplier_return_events.returnId → supplier_returns (RESTRICT) up supplier_return_items.productId → products (RESTRICT) up supplier_return_items.returnId → supplier_returns (RESTRICT) up supplier_returns.supplierId → suppliers (RESTRICT) up support_ticket_attachments.messageId → support_ticket_messages (RESTRICT) up support_ticket_attachments.ticketId → support_tickets (RESTRICT) up support_ticket_events.ticketId → support_tickets (RESTRICT) up support_ticket_messages.ticketId → support_tickets (RESTRICT) up vehicle_entry_checklists.motorcycleId → motorcycles (RESTRICT) up vehicle_entry_checklists.serviceOrderId → service_orders (CASCADE) up warranty_claims.warrantyId → service_order_warranties (RESTRICT) new accounts_payable.supplierId → suppliers (RESTRICT) new accounts_receivable.agreementCompanyId → agreement_companies (RESTRICT) new accounts_receivable.customerId → customers (RESTRICT) new accounts_receivable.employeeAgreementId → employee_agreements (RESTRICT) new cash_registers.userId → users (RESTRICT) new collection_attempts.agreementCompanyId → agreement_companies (RESTRICT) new discount_events.quoteId → quotes (RESTRICT) new discount_events.saleId → sales (RESTRICT) new discount_events.serviceOrderId → service_orders (RESTRICT) new employee_agreement_charges.paymentId → payments (RESTRICT) new employee_agreement_charges.saleId → sales (RESTRICT) new employee_agreements.customerId → customers (RESTRICT) new employee_agreements.userId → users (RESTRICT) new fiscal_documents.saleId → sales (RESTRICT) new fiscal_documents.serviceOrderId → service_orders (RESTRICT) new import_batches.userId → users (RESTRICT) new payment_exceptions.saleId → sales (RESTRICT) new payments.agreementCompanyId → agreement_companies (RESTRICT) new payments.employeeAgreementId → employee_agreements (RESTRICT) new sales.cashRegisterId → cash_registers (RESTRICT) new service_order_warranties.customerId → customers (RESTRICT) new service_order_warranties.motorcycleId → motorcycles (RESTRICT) new stock_movements.userId → users (RESTRICT) new supplier_return_events.userId → users (RESTRICT) new supplier_return_items.damageRecordId → damage_records (RESTRICT) new supplier_returns.purchaseOrderId → purchase_orders (RESTRICT) new tef_payments.paymentId → payments (RESTRICT) new tef_payments.saleId → sales (RESTRICT) new tef_payments.serviceOrderId → service_orders (RESTRICT) new transfers.fromBranchId → branches (RESTRICT) new transfers.toBranchId → branches (RESTRICT) new warranty_claims.newServiceOrderId → service_orders (RESTRICT) new warranty_claims.serviceOrderId → service_orders (RESTRICT)
- Tabelas criadas: —
- Tabelas alteradas: `appointments`, `categories`, `channel_api_credentials`, `channel_events`, `channel_inbound_events`, `channel_outbox`, `channel_product_links`, `collection_attempts`, `damage_records`, `device_sessions`, `employee_agreement_charges`, `employee_payroll_deductions`, `external_order_items`, `external_orders`, `external_payments`, `follow_ups`, `fulfillments`, `invoices`, `mechanic_commissions`, `motorcycles`, `payment_exceptions`, `payments`, `products`, `purchase_orders`, `quote_events`, `quotes`, `revisions`, `sales`, `service_order_warranties`, `service_orders`, `stock_movements`, `stock_reservations`, `supplier_return_events`, `supplier_return_items`, `supplier_returns`, `support_ticket_attachments`, `support_ticket_events`, `support_ticket_messages`, `vehicle_entry_checklists`, `warranty_claims`, `accounts_payable`, `accounts_receivable`, `cash_registers`, `discount_events`, `employee_agreements`, `fiscal_documents`, `import_batches`, `tef_payments`, `transfers` · índices criados: 32 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP CONSTRAINT · contém bloco DO $$

### `20261015100000_company_and_branch_fks`

- Arquivo: 56915 bytes · sha256 `2dd583ef05f3b185`…
- Finalidade: FKs de EMPRESA e de FILIAL nas tabelas de negócio (2026-10-15, revisão do banco — achados C-02/D-05, continuação de 20261014180000_composite_company_fks). PROBLEMA: 65 tabelas de negócio tinham "companyId" sem FK para companies (linha órfã de empresa inexistente era possível, ex.: 1 recebível no dev) e 55 tinham "branchId" sem FK para branches — inclusive filial de OUTRA empresa (a checagem de FK do PostgreSQL não passa pela RLS e a policy só olha o companyId da própria linha). ESCOPO: (a) companyId → companies(id) ON DELETE RESTRICT em 65 tabelas de negócio (histórico, dinheiro, estoque, convênios, fiscal, suporte); (b) (companyId, branchId) → branches(companyId, id) ON DELETE RESTRICT em 55 tabelas (filial opcional continua opcional: MATCH SIMPLE não checa quando branchId é NULL). NÃO recebem FK de propósito (retenção/telemetria, sem dado de negócio): request_logs, system_logs, idempotency_keys, device_telemetry, health_incidents, monitoring_*; devices/user_roles (sem companyId obrigatório); users.branchId (já tem FK, SET NULL). EFEITO NA APLICAÇÃO: excluir filial/empresa com qualquer registro vinculado passa a ser recusado pelo banco (P2003). branch.service.delete já traduz P2003 em BRANCH_IN_USE ("desative em vez de excluir"); company.service.delete só exclui empresa vazia. GUARDA: leitura em contexto de plataforma (a validação de FK do dono sob FORCE RLS passa em branco — achado C-03). Se houver linha com filial inexistente ou de OUTRA empresa, a migração ABORTA listando as tabelas (nunca "adivinha" a filial). Linhas cuja EMPRESA não existe mais não são associadas a empresa alguma: ficam intactas e a FK correspondente permanece NOT VALID (vale para linhas novas/alteradas; convalidated=false é o sinal do legado). ROLLBACK (nenhum dado depende das restrições novas): ALTER TABLE <t> DROP CONSTRAINT <t>_companyId_fkey; ALTER TABLE <t> DROP CONSTRAINT <t>_companyId_branchId_fkey; TABELAS (empresa): accounts_payable, accounts_receivable, agenda_unavailabilities, agreement_companies, appointments, business_calendar_exceptions, business_hours, cash_registers, categories, channel_api_credentials, channel_events, channel_inbound_events, channel_outbox, channel_product_links, collection_attempts, commission_rules, company_module_settings, customers, damage_records, device_sessions, discount_events, discount_rules, employee_agreement_charges, employee_agreements, employee_payroll_deductions, external_order_items, external_orders, external_payments, fiscal_configs, fiscal_documents, follow_ups, fulfillments, import_batches, inventories, invoices, mechanic_commissions, motorcycles, payment_exceptions, payment_settings, payments, policy_changes, policy_settings, products, purchase_orders, quote_events, quotes, revisions, sales, sales_channels, service_order_warranties, service_orders, stock_movements, stock_reservations, supplier_return_events, supplier_return_items, supplier_returns, suppliers, support_ticket_attachments, support_ticket_events, support_ticket_messages, support_tickets, tef_payments, transfers, vehicle_entry_checklists, warranty_claims TABELAS (filial): accounts_payable, accounts_receivable, agenda_unavailabilities, agreement_companies, appointments, business_calendar_exceptions, business_hours, cash_registers, channel_api_credentials, channel_events, channel_inbound_events, channel_outbox, channel_product_links, collection_attempts, company_module_settings, damage_records, device_sessions, discount_events, employee_agreement_charges, employee_agreements, employee_payroll_deductions, external_order_items, external_orders, external_payments, fiscal_configs, fiscal_documents, follow_ups, fulfillments, import_batches, installment_policies, inventories, partners, payment_exceptions, payment_settings, policy_changes, policy_settings, products, purchase_orders, quote_events, quotes, revisions, sales, sales_channels, service_order_warranties, service_orders, stock_movements, stock_reservations, supplier_return_events, supplier_return_items, supplier_returns, support_ticket_attachments, support_ticket_events, support_ticket_messages, support_tickets, warranty_claims
- Tabelas criadas: —
- Tabelas alteradas: `accounts_payable`, `accounts_receivable`, `agenda_unavailabilities`, `agreement_companies`, `appointments`, `business_calendar_exceptions`, `business_hours`, `cash_registers`, `categories`, `channel_api_credentials`, `channel_events`, `channel_inbound_events`, `channel_outbox`, `channel_product_links`, `collection_attempts`, `commission_rules`, `company_module_settings`, `customers`, `damage_records`, `device_sessions`, `discount_events`, `discount_rules`, `employee_agreement_charges`, `employee_agreements`, `employee_payroll_deductions`, `external_order_items`, `external_orders`, `external_payments`, `fiscal_configs`, `fiscal_documents`, `follow_ups`, `fulfillments`, `import_batches`, `inventories`, `invoices`, `mechanic_commissions`, `motorcycles`, `payment_exceptions`, `payment_settings`, `payments`, `policy_changes`, `policy_settings`, `products`, `purchase_orders`, `quote_events`, `quotes`, `revisions`, `sales`, `sales_channels`, `service_order_warranties`, `service_orders`, `stock_movements`, `stock_reservations`, `supplier_return_events`, `supplier_return_items`, `supplier_returns`, `suppliers`, `support_ticket_attachments`, `support_ticket_events`, `support_ticket_messages`, `support_tickets`, `tef_payments`, `transfers`, `vehicle_entry_checklists`, `warranty_claims`, `installment_policies`, `partners` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261015110000_cascade_to_restrict_history`

- Arquivo: 10272 bytes · sha256 `0815195b790efd03`…
- Finalidade: ON DELETE CASCADE → RESTRICT em histórico, dinheiro, estoque, serviço e auditoria (2026-10-15, revisão do banco — achado D-05). PROBLEMA: apagar uma venda levava junto os pagamentos; apagar um produto, o livro de estoque; apagar um caixa, os movimentos; apagar uma OS, itens e histórico de status; apagar um orçamento, versões/itens/eventos; apagar uma empresa, auditoria, licenças e pedidos LGPD — silenciosamente e sem rastro. VARREDURA DO CÓDIGO (apps/api/src): a aplicação NUNCA exclui venda, pagamento, caixa, inventário, ordem de compra, orçamento, OS, transferência, produto, agendamento, retorno, checklist (só marca status/inativa), então nenhum fluxo depende da cascata; nada muda para o usuário. MANTIDO CASCADE de propósito: sessões/dispositivos (refresh_tokens, device_sessions, devices, activations), papéis/permissões (user_roles, role_permissions, roles, permissions — role.service exclui), composição de combo (combo_items), imagens/códigos de barras do produto, políticas de parcelamento, parceiros — dados derivados ou de configuração, sem histórico a preservar. EXCLUSÃO LEGÍTIMA: retenção de auditoria (scheduler) e expurgo de teste usam DELETE direto nas tabelas, não a cascata; excluir empresa/filial/venda com histórico agora exige remover o histórico por procedimento explícito de plataforma (e é recusado pelo banco: P2003). CRIAÇÃO: DROP + ADD CONSTRAINT (mesmo nome, mesma coluna, ação RESTRICT) NOT VALID na mesma transação e VALIDATE em contexto de plataforma (a FK já era válida; a validação confirma). ROLLBACK: repetir o par DROP/ADD com ON DELETE CASCADE. CONSTRAINTS: audit_logs.audit_logs_companyId_fkey, branches.branches_companyId_fkey, users.users_companyId_fkey, licenses.licenses_companyId_fkey, privacy_requests.privacy_requests_companyId_fkey, cash_movements.cash_movements_cashRegisterId_fkey, payments.payments_companyId_saleId_fkey, sale_items.sale_items_saleId_fkey, stock_movements.stock_movements_companyId_productId_fkey, purchase_order_items.purchase_order_items_purchaseOrderId_fkey, quote_events.quote_events_companyId_quoteId_fkey, quote_items.quote_items_quoteVersionId_fkey, quote_versions.quote_versions_quoteId_fkey, service_order_items.service_order_items_serviceOrderId_fkey, service_order_status_history.service_order_status_history_serviceOrderId_fkey, transfer_items.transfer_items_transferId_fkey, vehicle_entry_checklist_items.vehicle_entry_checklist_items_checklistId_fkey, vehicle_entry_checklists.vehicle_entry_checklists_companyId_serviceOrderId_fkey, appointment_events.appointment_events_appointmentId_fkey, follow_up_events.follow_up_events_followUpId_fkey, inventory_counts.inventory_counts_inventoryId_fkey
- Tabelas criadas: —
- Tabelas alteradas: `audit_logs`, `branches`, `users`, `licenses`, `privacy_requests`, `cash_movements`, `payments`, `sale_items`, `stock_movements`, `purchase_order_items`, `quote_events`, `quote_items`, `quote_versions`, `service_order_items`, `service_order_status_history`, `transfer_items`, `vehicle_entry_checklist_items`, `vehicle_entry_checklists`, `appointment_events`, `follow_up_events`, `inventory_counts` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP CONSTRAINT · contém bloco DO $$

### `20261015120000_append_only_ledgers`

- Arquivo: 3857 bytes · sha256 `ce481e0ae9e901b9`…
- Finalidade: LIVROS APPEND-ONLY por comando (2026-10-15, revisão do banco — achado E-03). PROBLEMA: stock_movements (livro de estoque), cash_movements (livro de caixa), policy_changes (trilha de mudança de política) e service_order_status_history (histórico de status da OS) tinham UMA policy "ALL" por empresa/filial: qualquer sessão da empresa podia UPDATE/DELETE linhas já gravadas — adulterar histórico de estoque, dinheiro e política sem rastro. VARREDURA: nenhum código de apps/api/src ou scripts faz UPDATE/DELETE nessas tabelas (só INSERT e leitura); o estoque e o caixa se corrigem com NOVO movimento (ajuste/estorno), nunca editando o antigo. CORREÇÃO: policy por comando, igual ao padrão já adotado em audit_logs/discount_events/collection_attempts: SELECT e INSERT mantêm o MESMO critério de antes (empresa/filial); NÃO há policy de UPDATE (sem policy = negado, também para o dono sob FORCE RLS); DELETE só com `is_super_admin()` + `app.audit_purge = 'on'` na mesma transação (expurgo sinalizado: teste sintético, retenção legal, LGPD). ROLLBACK: DROP das 3 policies novas de cada tabela e CREATE POLICY <t>_isolation FOR ALL (critério antigo no corpo abaixo, repetido em cada USING).
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 12 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP POLICY

### `20261015130000_drop_duplicate_indexes`

- Arquivo: 767 bytes · sha256 `f1de18bc7631f3b6`…
- Finalidade: ÍNDICES DUPLICADOS (2026-10-15, revisão do banco — achado F-02). Cada par abaixo tem o MESMO conjunto de colunas: um índice único (que já atende às buscas e à unicidade) e um índice comum idêntico, que só custa escrita e espaço. Mantém-se o ÚNICO e remove-se o comum; o schema.prisma deixou de declarar o @@index correspondente. (O de refresh_tokens já saiu em 20261014170000.) ROLLBACK: CREATE INDEX <nome> ON <tabela>(<colunas>) com as colunas do índice único correspondente.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP INDEX

### `20261015140000_missing_fk_and_rls_indexes`

- Arquivo: 2194 bytes · sha256 `61931c50d9adfbc5`…
- Finalidade: ÍNDICES FALTANTES (2026-10-15, revisão do banco — achado F-03). (a) 9 tabelas tinham "companyId" (coluna filtrada por TODA policy de RLS) sem nenhum índice que começasse por ela; (b) 7 colunas de FK (estoque→usuário, pagamento→convênio, recebível→convênio, exceção→venda, reserva→produto, venda→canal) sem índice: excluir/atualizar o pai (RESTRICT) e listar por pai viravam varredura da tabela. Só índices comuns (sem mudar dado); IF NOT EXISTS torna a migração repetível. ROLLBACK: DROP INDEX <nome> (todos terminam em _idx).
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 16 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261015150000_database_timezone_utc`

- Arquivo: 1430 bytes · sha256 `826d165a76026b3a`…
- Finalidade: FUSO DO BANCO = UTC (2026-10-15, revisão do banco — achado F-04). PROBLEMA: o banco rodava em America/Sao_Paulo. As 273 colunas `timestamp without time zone` guardam UTC (o Prisma grava sempre UTC), mas os 110 `DEFAULT CURRENT_TIMESTAMP` convertem pelo fuso da SESSÃO: linha criada por DEFAULT do banco (SQL manual, script, migração de dados) saía 3 h adiantada/atrasada em relação às criadas pela aplicação — comparações de vencimento/expiração erradas sem erro algum. VARREDURA: a aplicação não faz INSERT cru e todo SQL cru com data converte explicitamente (`AT TIME ZONE 'UTC'` em dashboard-management, observability e outbox), então UTC na sessão não muda nenhum resultado; o fuso de negócio continua vindo de `company.timezone`. EFEITO: vale para NOVAS sessões do banco atual (conexões já abertas só mudam ao reconectar); NÃO altera nenhum dado existente. Se o papel que migra não for dono do banco, a migração apenas avisa (o operador aplica `ALTER DATABASE … SET timezone TO 'UTC'`, ver PRODUCAO.md). ROLLBACK: ALTER DATABASE <banco> RESET timezone.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261015160000_same_company_ref_triggers`

- Arquivo: 4036 bytes · sha256 `a6d00b96d40387c6`…
- Finalidade: MESMA EMPRESA NAS 3 REFERÊNCIAS QUE NÃO PODEM TER FK COMPOSTA (2026-10-15, revisão do banco — achado C-02, resíduo). PROBLEMA: sales.partnerId (SET NULL; a aplicação apaga convênios), service_orders.mechanicId (SET NULL; a aplicação apaga usuários) e users.branchId (companyId pode ser NULO para usuário de plataforma) têm FK SIMPLES — que não olha a empresa, e a RLS não passa pela checagem de FK: uma sessão da empresa A conseguia gravar venda com convênio da B, OS com mecânico da B, usuário da A com filial da B. O Prisma não modela FK composta com SET NULL parcial (anularia o companyId) e a exclusão precisa continuar anulando só a coluna da referência — por isso a regra vai num TRIGGER, não numa FK. REGRA: BEFORE INSERT/UPDATE da coluna: se a linha tem empresa e a referência não é nula, o registro referenciado precisa existir NA MESMA empresa; senão ERRO 23503 (foreign_key_violation → P2003 no Prisma), igual a uma FK. Roda como o chamador (a RLS vale): quem não enxerga o pai (outra empresa/filial) também recebe o erro. GUARDA: se já houver linha violando a regra, a migração ABORTA listando as contagens (nunca corrige por suposição). ROLLBACK: DROP TRIGGER <nome> ON <tabela>; DROP FUNCTION enforce_same_company_ref().
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 3 · funções: 1
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma · contém bloco DO $$

### `20261015170000_drop_redundant_company_indexes`

- Arquivo: 1447 bytes · sha256 `086079805bf7966a`…
- Finalidade: ÍNDICES "companyId" REDUNDANTES COM O ALVO DAS FKs COMPOSTAS (2026-10-15, revisão do banco — achado F-02, continuação). As FKs compostas (companyId, X) -> pai(companyId, id) exigiram o índice ÚNICO (companyId, id) em cada pai (migration 20261014180000 e anteriores). Esse índice já começa por companyId e atende exatamente às mesmas consultas (a RLS filtra por companyId = ?): o índice comum "<tabela>_companyId_idx" ficou redundante (só custa escrita e espaço). Removidos apenas os 13 que ESTA revisão tornou redundantes; os demais prefixos (ex.: companyId, status) ficam para decisão com medição de uso em staging. O @@index([companyId]) correspondente saiu do schema.prisma (sem deriva). ROLLBACK: CREATE INDEX "<tabela>_companyId_idx" ON "<tabela>"("companyId");
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP INDEX

### `20261016100000_branch_scope_rls`

- Arquivo: 11097 bytes · sha256 `2c3322065d456ba2`…
- Finalidade: ESCOPO DE FILIAL NAS TABELAS QUE SÓ ISOLAVAM POR EMPRESA (2026-10-16, produção/segurança multi-tenant). REGRA DE NEGÓCIO (definida): usuário com acesso EMPRESARIAL (COMPANY_ADMIN; SUPER_ADMIN na empresa-alvo) consulta todas as filiais da PRÓPRIA empresa e o dashboard consolidado; o GERENTE de filial (MANAGER, e os demais papéis de filial) consulta EXCLUSIVAMENTE a filial a que está vinculado — nunca outra filial, nem da mesma empresa, por API, exportação ou SQL direto — e não amplia o próprio acesso alterando ids/parâmetros. PROBLEMA (provado antes por teste e por leitura do catálogo): 9 tabelas com `branchId` tinham policy só por empresa — `users` (gerente da filial A listava e-mail, telefone, MFA e `numericId` de TODOS os usuários da empresa), `user_roles`, `partners` (convênio de outra filial visível e editável), `installment_policies`, `devices` (qualquer papel listava os equipamentos de todas as filiais e o gerente encerrava a sessão de equipamento de outra filial), `monitoring_thresholds`, `monitoring_threshold_changes`, `request_logs`, `system_logs`. Também: `transfers` (gerente via todas as transferências da empresa) e `audit_logs` (sem filial: o gerente lia a auditoria de todas as filiais, inclusive `new_value`). CORREÇÃO (RLS; a API é a 1ª camada e esta é a defesa em profundidade contra SQL direto/falha de filtro): • LEITURA por filial = a regra F já usada nos documentos (`rls_company_branch_match`): empresa inteira vê tudo da empresa; papel de filial vê a própria filial + linhas da empresa toda (`branchId` NULO = cadastro compartilhado, ex.: convênio válido para todas as filiais). • ESCRITA por filial (nova `rls_company_branch_write`): papel de filial só grava linha da PRÓPRIA filial — não grava "da empresa toda" (NULL) nem de outra filial. • users: papel de filial vê a própria filial, os usuários sem filial e os COMPANY_ADMIN (autorizadores da empresa); grava só na própria filial. user_roles: leitura herda de users; escrita só para usuário da própria filial. audit_logs: papel de filial lê só a auditoria de usuários da própria filial. transfers: papel de filial vê/grava as transferências em que a própria filial é origem ou destino. Monitoramento e logs: leitura só de SUPER_ADMIN/COMPANY_ADMIN (nenhuma rota de filial os usa); UPDATE/DELETE de logs só do SUPER_ADMIN (retenção). • installment_policies: escrita só empresarial (como a API já exigia). NÃO ALTERA dados, módulos habilitados, permissões nem estrutura de tabelas; só funções e policies. Super Admin e contexto de plataforma não mudam. ROLLBACK: recriar as policies anteriores (ver migrations 0_init, 20260926130000_users_policy_hide_platform_users, 20260925100000_audit_logs_append_only, 20261014162000_rls_logs_roles_tighten e 20260926120000_monitoring_thresholds_alerts) e `DROP FUNCTION rls_company_branch_write(text,text)`.
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 29 · triggers: 0 · funções: 1
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP POLICY

### `20261016110000_privilege_escalation_guards`

- Arquivo: 7530 bytes · sha256 `6237389a4b5611f1`…
- Finalidade: TRAVAS CONTRA ELEVAÇÃO DE PRIVILÉGIO POR SQL DIRETO (2026-10-16, continuação de 20261016100000_branch_scope_rls). PROBLEMA (provado por teste com o papel real da aplicação): as rotas de administração já exigem COMPANY_ADMIN/SUPER_ADMIN, mas as policies de várias tabelas deixavam QUALQUER papel da empresa — inclusive o gerente de filial — gravar nelas por SQL direto (falha de filtro, injeção, script): um gerente podia (a) mudar o próprio `userType` para COMPANY_ADMIN ou o próprio `branchId`; (b) criar `user_roles` para si; (c) criar perfil/permissão e vincular permissões; (d) LIGAR um módulo desativado gravando em `company_module_settings` para a própria filial; (e) criar/renomear/apagar filiais. CORREÇÃO: escrita nessas tabelas passa a exigir papel empresarial (COMPANY_ADMIN) ou SUPER_ADMIN; a leitura NÃO muda. Mais um trigger em `users` que impede papel de filial de alterar `userType`, `companyId`, `branchId` e `isActive` (as demais colunas — último acesso, tentativas, MFA do próprio usuário — seguem como antes). NÃO ALTERA dados, módulos habilitados nem permissões concedidas. Super Admin e contexto de plataforma não mudam; fluxos de login/refresh/MFA rodam em contexto de plataforma. ROLLBACK: DROP TRIGGER users_guard_privileged_columns ON users; DROP FUNCTION users_guard_privileged_columns(); recriar as policies anteriores (0_init, 20261014162000_rls_logs_roles_tighten, 20261016100000_branch_scope_rls).
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 21 · triggers: 1 · funções: 1
- Dados: nenhuma carga/atualização de dados · operações a conferir: DROP POLICY

### `20261017100000_rls_signed_context`

- Arquivo: 15435 bytes · sha256 `c65fad178561bc30`…
- Finalidade: CONTEXTO DE RLS ASSINADO (2026-10-17, decisão 151) — mitigação do risco "SQL arbitrário na conexão da API escolhe o contexto da RLS". PROBLEMA (documentado na decisão 132 e provado antes): as policies leem variáveis de sessão (`app.user_type`, `app.current_company_id`, `app.current_branch_id`) que qualquer comando SQL executado pelo papel de execução pode gravar com `set_config(...)`. Uma injeção de SQL (ou SQL cru com falha de filtro) virava `set_config('app.user_type','SUPER_ADMIN',true)` e a RLS inteira deixava de valer. CORREÇÃO: a aplicação ASSINA o contexto (HMAC-SHA256: empresa, filial ativa, filiais autorizadas, papel, usuário e instante) e o banco só o aceita se a assinatura conferir: • `app_ctx_vault.secrets` guarda o segredo já derivado (ipad/opad do HMAC) num schema SEM privilégio para o papel de execução (nem leitura, nem escrita); • `app_ctx._sig_ok()` (SECURITY DEFINER, search_path fixo) confere a assinatura, a janela de ±120 s (`transaction_timestamp()` × `iat`) e compara por hash (sem vazar prefixo por tempo); • `app_ctx.company_id()/branch_id()/branch_ids()/user_type()/user_id()/is_super_admin()/is_company_wide()` devolvem o contexto SÓ se verificado (NULL/falso caso contrário ⇒ a RLS nega tudo); • as 161 policies passam a chamar essas funções como sub-select escalar `(SELECT app_ctx.x())`, que o PostgreSQL avalia UMA vez por consulta (InitPlan) — medido: 200 mil linhas, 15 ms, contra 4 300 ms se a verificação fosse repetida por linha; as funções antigas (`get_current_*`, `is_super_admin`, `rls_company_*`) continuam existindo e agora também VERIFICAM (seguras, porém mais lentas por linha — uma policy nova deve chamar `SELECT app_ctx.rewrite_policies();` no fim da migração para ser reescrita na forma rápida). • filiais autorizadas passam a ser um CONJUNTO (`app.current_branch_ids`, assinado); sem a lista, vale só a filial ativa (comportamento anterior). ENFORCEMENT EM DOIS PASSOS (rollout seguro): esta migração NÃO liga a exigência. Enquanto `app_ctx.settings.enforced` for falso o banco aceita o contexto cru (comportamento de hoje). A exigência liga quando o DONO executa `SELECT app_ctx.provision(<segredo>)` (passo operacional: docs/CORTEX/RLS_CONTEXTO_ASSINADO.md) — a API em produção RECUSA subir se não estiver ligada. LIMITES: quem executa código DENTRO do processo da API tem o segredo; quem só injeta SQL numa requisição fica com o contexto daquela requisição (não vira outro usuário, papel ou empresa). O segredo NÃO entra no backup (`pg_dump --exclude-schema=app_ctx_vault`): depois de restaurar é preciso `app_ctx.provision` de novo (até lá, tudo negado — falha fechada). NÃO ALTERA dados de negócio, tabelas de negócio, módulos nem permissões; só funções, schemas novos e policies (mesma semântica, outra forma de escrever). ROLLBACK: `UPDATE app_ctx.settings SET enforced = false;` (volta a aceitar contexto cru) e, para desfazer a forma das policies, recriá-las pelas migrações 0_init, 20261014162000, 20261016100000 e 20261016110000; `DROP SCHEMA app_ctx CASCADE; DROP SCHEMA app_ctx_vault CASCADE;` só depois de recriar as funções antigas.
- Tabelas criadas: `app_ctx`, `app_ctx_vault`
- Tabelas alteradas: — · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 21
- Dados: INSERT app_ctx; INSERT app_ctx_vault · operações a conferir: DELETE FROM

### `20261017110000_user_branches`

- Arquivo: 4560 bytes · sha256 `8e91210b00b807ad`…
- Finalidade: VÍNCULOS DE FILIAL DO USUÁRIO (2026-10-17, decisão 153) — gerente de UMA ou de VÁRIAS filiais. PROBLEMA: o modelo só tinha `users.branchId` (uma filial). Um gerente responsável por duas filiais precisava de dois usuários ou de acesso empresarial. CORREÇÃO (aditiva): `user_branches` guarda as filiais ADICIONAIS autorizadas. O conjunto autorizado de quem NÃO é de empresa inteira passa a ser `users.branchId` (principal, como sempre) + as linhas desta tabela. O servidor calcula o conjunto a cada requisição a partir do banco (nunca do cliente) e o assina no contexto da RLS (migração 20261017100000), então remover o vínculo revoga o acesso na próxima requisição. NÃO MIGRA nem altera dado algum: quem já existe continua com a filial principal e nada mais. • FK composta (companyId, userId) → users e (companyId, branchId) → branches: o vínculo só existe dentro da MESMA empresa (referência cruzada é recusada pelo banco); CASCADE: o vínculo é configuração, não histórico (apagar usuário ou filial remove o vínculo; a auditoria de quem concedeu/retirou fica em `audit_logs`). • RLS (forma rápida da migração anterior): leitura = administração vê a empresa; o usuário vê só as PRÓPRIAS linhas; escrita só SUPER_ADMIN/COMPANY_ADMIN. • Trigger: vínculo só para papéis de filial (SUPER_ADMIN/COMPANY_ADMIN já enxergam a empresa inteira — vínculo seria ruído e confusão de auditoria). ROLLBACK: DROP TABLE "user_branches"; DROP FUNCTION user_branches_guard(); (os usuários voltam a ter só a filial principal.)
- Tabelas criadas: `user_branches`
- Tabelas alteradas: — · índices criados: 2 · policies criadas: 4 · triggers: 1 · funções: 1
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261018100000_user_password_change`

- Arquivo: 2287 bytes · sha256 `d7ffa0b7ae25e665`…
- Finalidade: TROCA DE SENHA PELO PRÓPRIO USUÁRIO E SENHA TEMPORÁRIA (2026-10-18, decisão 157). PROBLEMA: só um administrador redefinia senha. Quem criava a conta de um cliente conhecia a senha dele para sempre, e o usuário não tinha como trocá-la sozinho. CORREÇÃO (aditiva): `users.mustChangePassword` marca a senha como TEMPORÁRIA (definida por um administrador) — a API não emite sessão enquanto ela não for trocada — e `users.passwordChangedAt` registra quando a senha mudou pela última vez. NÃO MIGRA nem altera dado algum: os dois campos nascem `false`/`NULL` para todos os usuários existentes (nada passa a ser exigido de quem já tem conta). `ADD COLUMN` com valor padrão constante é só metadado no PostgreSQL (sem reescrita da tabela, sem bloqueio longo). GATILHO: `users_guard_privileged_columns` já impedia papel de filial de mudar tipo, empresa, filial e situação de usuário; passa a impedir também a SENHA e os dois campos novos (um gerente comprometido não pode redefinir a senha de um colega nem desligar a exigência de troca). SUPER_ADMIN/COMPANY_ADMIN e o contexto de plataforma da autenticação seguem livres. ROLLBACK: ALTER TABLE "users" DROP COLUMN "mustChangePassword", DROP COLUMN "passwordChangedAt"; e recriar `users_guard_privileged_columns` com a definição da migração 20261016110000.
- Tabelas criadas: —
- Tabelas alteradas: `users` · índices criados: 0 · policies criadas: 0 · triggers: 0 · funções: 1
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261019100000_monitoring_central`

- Arquivo: 9394 bytes · sha256 `057db35cd25bb1d5`…
- Finalidade: CENTRAL DE MONITORAMENTO (2026-10-19) — estrutura ADITIVA do Super Admin: tratamento de alertas, amostras de saúde, funil comercial, entregas externas e ajustes. PROBLEMA: o monitoramento existente (monitoring_alerts, health_incidents, thresholds) mostrava o estado ATUAL, mas (a) o alerta não tinha ciclo de tratamento (reconhecer, assumir, resolver, histórico), (b) não havia série histórica de disponibilidade/latência/servidor da plataforma para os gráficos, (c) não existia nenhum registro do funil comercial (interessado → cliente ativo), (d) nada limitava nem registrava envios a serviços externos (e-mail de alerta, erros) e (e) os ajustes de coleta/notificação só existiam em variável de ambiente. ESCOPO (só adiciona; nenhuma tabela existente perde coluna ou dado): • monitoring_alerts: 6 colunas de tratamento (handling com padrão 'OPEN', assignedTo, acknowledgedAt/By, resolvedBy, resolutionNote). Alerta já encerrado continua encerrado: o estado exposto é calculado (endedAt preenchido = RESOLVIDO), por isso NÃO há UPDATE de dados nesta migração. • monitoring_alert_events (histórico imutável), service_health_samples (telemetria com retenção), commercial_leads + commercial_lead_events (funil), external_deliveries (telemetria com retenção), monitoring_settings (ajustes). SEGURANÇA: as 6 tabelas novas são de PLATAFORMA: RLS habilitada e FORÇADA, policy só para SUPER_ADMIN (mesma forma de access_revocations_platform, helper app_ctx.is_super_admin() em sub-select). Os dois históricos (alert_events, lead_events) são append-only como os demais livros: sem policy de UPDATE; DELETE só com o expurgo sinalizado (`app.audit_purge = 'on'`) em contexto de Super Admin. Nenhuma tabela de empresa muda de política; nenhum acesso de papel de empresa é aberto. FK: commercial_leads.companyId → companies (RESTRICT) e commercial_lead_events.leadId → commercial_leads (RESTRICT). As tabelas de telemetria seguem a convenção de monitoring_* (sem FK de propósito: retenção). ROLLBACK: remover as 6 tabelas novas (monitoring_settings, external_deliveries, commercial_lead_events, commercial_leads, service_health_samples, monitoring_alert_events) e as 6 colunas de monitoring_alerts (handling, assignedTo, acknowledgedAt, acknowledgedBy, resolvedBy, resolutionNote).
- Tabelas criadas: `monitoring_alert_events`, `service_health_samples`, `commercial_leads`, `commercial_lead_events`, `external_deliveries`, `monitoring_settings`
- Tabelas alteradas: `monitoring_alerts` · índices criados: 10 · policies criadas: 10 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

### `20261019110000_monitoring_alert_events_company_index`

- Arquivo: 805 bytes · sha256 `9c834419094498d8`…
- Finalidade: ÍNDICE POR EMPRESA NO HISTÓRICO DE ALERTAS (2026-10-19) — complemento ADITIVO de 20261019100000_monitoring_central. PROBLEMA: o teste de invariantes do banco (database-schema-invariants: "toda tabela com companyId tem índice que COMEÇA por companyId") apontou que monitoring_alert_events guarda "companyId" (nulo para alerta da infraestrutura central) sem índice que o inicie; a consulta do histórico por empresa varreria a tabela. ESCOPO: um único índice (companyId, createdAt). Não altera dado, coluna, política de RLS nem permissão. Tabela nova e vazia/pequena: criação imediata. ROLLBACK: DROP INDEX "monitoring_alert_events_companyId_createdAt_idx";
- Tabelas criadas: —
- Tabelas alteradas: — · índices criados: 1 · policies criadas: 0 · triggers: 0 · funções: 0
- Dados: nenhuma carga/atualização de dados · operações a conferir: nenhuma

## 4. Schema × migrations × banco

### 4.1 Diferenças do banco de desenvolvimento para o schema Prisma

```sql
-- This is an empty migration.
```

### 4.2 Reaplicação das migrations do zero em banco vazio

**Execução de 2026-10-19** (`npm run db:replay-check`) — banco temporário vazio, criado e removido pelo script; o banco de desenvolvimento só foi lido. Resultado: **IDÊNTICO — nada no banco de desenvolvimento escapa das migrations**.

- `prisma migrate deploy` em banco vazio: sucesso (57 migrations encontradas em `prisma/migrations`).
- `prisma migrate diff` (banco → schema.prisma): banco reaplicado do zero e banco de desenvolvimento produzem **exatamente a mesma saída** — **vazia (0 instruções): o `schema.prisma` descreve exatamente o banco**.
- Catálogo completo (colunas, índices, constraints, policies, RLS, triggers, funções, sequências, enums): dev = 3712 itens, reaplicado = 3712 itens; **só no dev: 0**; **só no reaplicado: 0**.
- PostgreSQL: PostgreSQL 18.6 on x86_64-windows.
- FKs NOT VALID (legado de dado, normalizadas na comparação acima): dev = 3 (accounts_receivable.accounts_receivable_companyId_branchId_fkey, accounts_receivable.accounts_receivable_companyId_customerId_fkey, accounts_receivable.accounts_receivable_companyId_fkey); reaplicado do zero = 0.
- `db:check-rls` no banco reaplicado: todas as invariantes OK — [check-rls] "lnsystem_db_replay_tmp": todas as invariantes de RLS OK
- Banco temporário removido: sim.

**Cenário com dados inconsistentes (migration das FKs compostas):**

- Banco temporário 2: 36 migrations aplicadas (até a anterior à FK composta): sucesso.
- Dados sintéticos: 2 empresas, 1 produto em cada e **1 código de barras da empresa A apontando para o produto da empresa B** (aceito pela FK antiga); linhas cruzadas confirmadas antes do deploy: 1.
- `migrate deploy` completo com a linha inconsistente: **falhou como esperado** (a migration `20261014155900_guard_product_children_same_company` recusou o dado cruzado).
- Atomicidade: depois da falha, índice composto 0, FK composta 0, FK antiga 1 → **nada ficou aplicado pela metade**.
- Recuperação (corrigir a linha → `migrate resolve --rolled-back 20261014155900_guard_product_children_same_company` → `migrate deploy`): **concluiu**, as 2 FKs compostas existem.
- Banco temporário 2 removido: sim.

**Cenário de sessões (migration de refresh_tokens: hash, empresa e RLS):**

- Banco temporário 3: 40 migrations aplicadas (até a anterior à de refresh_tokens): sucesso.
- Dados sintéticos: 3 sessões legadas (token em texto): 2 do usuário da empresa A e 1 de plataforma; **uma das sessões da A gravada com a empresa da B** (inconsistente).
- `migrate deploy` com sessão de empresa divergente: **abortou como esperado**.
- Atomicidade: depois do aborto, coluna em texto ainda existe e coluna de hash não existe → **nada ficou pela metade; nenhuma sessão perdida**.
- Recuperação (corrigir a linha → `migrate resolve --rolled-back` → `migrate deploy`): **concluiu**.
- Sessões preservadas: o hash calculado em SQL é **igual** ao SHA-256 da aplicação nas 3 sessões → **sim** (o mesmo token continua achando a mesma linha).
- Empresa preenchida só pelo usuário: sessões da A → empresa A; sessão de plataforma → nula → **conforme**.
- Estado de revogação preservado (a revogada continua revogada, a ativa continua ativa): **sim**.
- Segredo em texto: coluna `token` removida e nenhum valor "legacy-…" restou em nenhuma coluna → **ausente**.
- Banco temporário 3 removido: sim.

**Cenário de filial/empresa (migration das FKs de empresa e filial: guarda, atomicidade, legado preservado):**

- Banco temporário 4: 42 migrations aplicadas (até a anterior à de FKs de empresa/filial): sucesso.
- Dados sintéticos: **1 produto da empresa A gravado com a filial da empresa B** e **1 cliente de empresa inexistente** (os dois aceitos pelo schema antigo, sem FK).
- `migrate deploy` com filial de outra empresa: **abortou como esperado** (a guarda recusou o dado cruzado e listou a tabela).
- Atomicidade: depois do aborto, FK de filial 0, FK de empresa 0 → **nada ficou aplicado pela metade**.
- Recuperação (corrigir a filial do produto → `migrate resolve --rolled-back` → `migrate deploy`): **concluiu**.
- Resultado: FK de filial validada = true; FK de empresa de `customers` validada = false (deve ser **false**: existe o cliente órfão); cliente órfão preservado = 1 → **o legado fica visível (NOT VALID) e nada foi apagado nem associado a empresa por suposição**.
- Linha NOVA com empresa inexistente: **recusada (P2003)** — NOT VALID protege tudo que entra daqui em diante.
- Banco temporário 4 removido: sim.

### 4.3 Validação de FK sob FORCE RLS (achado desta revisão)

Todas as tabelas de empresa são `FORCE ROW LEVEL SECURITY` e a migration roda como o **dono** (o mesmo papel da aplicação), **sem** contexto de empresa. Nesse cenário o dono enxerga **zero linhas**: um `ADD CONSTRAINT … FOREIGN KEY` sobre tabela populada "valida" uma tabela aparentemente vazia e é criado **mesmo com linha que o viola**. Provado em experimento revertido no banco de teste: com uma linha cruzada, o `ADD CONSTRAINT` passou; com `app.user_type = SUPER_ADMIN` (contexto de plataforma) ele falhou como deveria. Consequências: (1) a existência de uma FK não prova que os dados antigos a respeitam — por isso o achado D2b confere todas as FKs com o papel que ignora RLS; (2) toda migration que acrescente FK/constraint sobre tabela populada precisa de uma **guarda explícita** que leia com `set_config('app.user_type', 'SUPER_ADMIN', true)`. Foi o que `20261014155900_guard_product_children_same_company` passou a fazer (aborta com mensagem clara antes das FKs compostas; testado em banco temporário com dado cruzado — §4.2, cenário com dados).

### 4.4 Reconciliação de checksum documentada (migration `20261014160000_product_children_same_company`)

A nota do cabeçalho dessa migration dizia que ela "falha e nada muda" se houvesse dado cruzado — o que o experimento da §4.3 **refutou**. Como a migration tinha acabado de ser criada e só estava aplicada nos bancos locais de desenvolvimento e teste (sem dado cruzado), o **comentário do cabeçalho foi corrigido** (nenhuma instrução SQL mudou) e o checksum registrado em `_prisma_migrations` desses dois bancos foi atualizado de `25802e0c30055e16…` para `55553f4ca2cb8265…` (apenas metadado, sem tocar em estrutura nem dado). Em staging/produção a migration nunca foi aplicada, então não há reconciliação a fazer lá. A guarda foi criada como migration **separada** (`20261014155900…`, nome anterior) em vez de editar mais a existente.

### 4.5 Tentativa abortada de `20261014180000_composite_company_fks` no banco de desenvolvimento (`_prisma_migrations` tem 1 linha a mais)

A primeira execução dessa migration no dev **falhou** (a lista de restrições gerada pelo `psql` do Windows trouxe um caractere de retorno de carro (CR) no nome de uma FK) e, como cada migration roda numa única transação, **nada ficou aplicado** (conferido: sem a FK composta e com a FK simples antiga intacta). O procedimento padrão foi seguido: `prisma migrate resolve --rolled-back 20261014180000_composite_company_fks` (marca a tentativa como revertida: `rolled_back_at` preenchido, `applied_steps_count = 0`), correção do gerador e novo `migrate deploy`, que concluiu. Por isso o dev tem **duas** linhas desse nome (a revertida e a concluída), uma a mais que o banco de teste, onde a migration foi aplicada uma única vez. Nenhum checksum foi editado e nenhuma migration foi marcada como aplicada sem comprovação. O mesmo procedimento está provado em banco temporário pelos cenários de dados do `db:replay-check`.

## 5. Staging e produção

Nenhuma migration foi aplicada fora de desenvolvimento e teste. Procedimento (sempre **depois de um backup restaurável**): `prisma migrate deploy --schema=packages/database/prisma/schema.prisma`, depois `npm run db:check-rls` ([PRODUCAO §4 e §13–14](PRODUCAO.md)). Compatibilidade de versão: o `docker-compose.yml` usa `postgres:18-alpine`; este relatório consultou **PostgreSQL 18.6 on x86_64-windows** — a execução em PostgreSQL 18 real (Linux) é uma pendência de infraestrutura.

