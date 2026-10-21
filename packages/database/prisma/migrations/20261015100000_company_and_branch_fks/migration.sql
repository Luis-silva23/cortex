-- FKs de EMPRESA e de FILIAL nas tabelas de negócio (2026-10-15, revisão do banco — achados C-02/D-05, continuação de 20261014180000_composite_company_fks).
-- PROBLEMA: 65 tabelas de negócio tinham "companyId" sem FK para companies (linha órfã de empresa inexistente era possível, ex.: 1 recebível
-- no dev) e 55 tinham "branchId" sem FK para branches — inclusive filial de OUTRA empresa (a checagem de FK do PostgreSQL não passa pela RLS e a
-- policy só olha o companyId da própria linha).
-- ESCOPO: (a) companyId → companies(id) ON DELETE RESTRICT em 65 tabelas de negócio (histórico, dinheiro, estoque, convênios, fiscal, suporte);
-- (b) (companyId, branchId) → branches(companyId, id) ON DELETE RESTRICT em 55 tabelas (filial opcional continua opcional: MATCH SIMPLE não checa
-- quando branchId é NULL). NÃO recebem FK de propósito (retenção/telemetria, sem dado de negócio): request_logs, system_logs, idempotency_keys,
-- device_telemetry, health_incidents, monitoring_*; devices/user_roles (sem companyId obrigatório); users.branchId (já tem FK, SET NULL).
-- EFEITO NA APLICAÇÃO: excluir filial/empresa com qualquer registro vinculado passa a ser recusado pelo banco (P2003). branch.service.delete já traduz P2003 em
-- BRANCH_IN_USE ("desative em vez de excluir"); company.service.delete só exclui empresa vazia.
-- GUARDA: leitura em contexto de plataforma (a validação de FK do dono sob FORCE RLS passa em branco — achado C-03). Se houver linha com filial inexistente ou
-- de OUTRA empresa, a migração ABORTA listando as tabelas (nunca "adivinha" a filial). Linhas cuja EMPRESA não existe mais não são associadas a empresa alguma:
-- ficam intactas e a FK correspondente permanece NOT VALID (vale para linhas novas/alteradas; convalidated=false é o sinal do legado).
-- ROLLBACK (nenhum dado depende das restrições novas): ALTER TABLE <t> DROP CONSTRAINT <t>_companyId_fkey; ALTER TABLE <t> DROP CONSTRAINT <t>_companyId_branchId_fkey;
-- TABELAS (empresa): accounts_payable, accounts_receivable, agenda_unavailabilities, agreement_companies, appointments, business_calendar_exceptions, business_hours, cash_registers, categories, channel_api_credentials, channel_events, channel_inbound_events, channel_outbox, channel_product_links, collection_attempts, commission_rules, company_module_settings, customers, damage_records, device_sessions, discount_events, discount_rules, employee_agreement_charges, employee_agreements, employee_payroll_deductions, external_order_items, external_orders, external_payments, fiscal_configs, fiscal_documents, follow_ups, fulfillments, import_batches, inventories, invoices, mechanic_commissions, motorcycles, payment_exceptions, payment_settings, payments, policy_changes, policy_settings, products, purchase_orders, quote_events, quotes, revisions, sales, sales_channels, service_order_warranties, service_orders, stock_movements, stock_reservations, supplier_return_events, supplier_return_items, supplier_returns, suppliers, support_ticket_attachments, support_ticket_events, support_ticket_messages, support_tickets, tef_payments, transfers, vehicle_entry_checklists, warranty_claims
-- TABELAS (filial): accounts_payable, accounts_receivable, agenda_unavailabilities, agreement_companies, appointments, business_calendar_exceptions, business_hours, cash_registers, channel_api_credentials, channel_events, channel_inbound_events, channel_outbox, channel_product_links, collection_attempts, company_module_settings, damage_records, device_sessions, discount_events, employee_agreement_charges, employee_agreements, employee_payroll_deductions, external_order_items, external_orders, external_payments, fiscal_configs, fiscal_documents, follow_ups, fulfillments, import_batches, installment_policies, inventories, partners, payment_exceptions, payment_settings, policy_changes, policy_settings, products, purchase_orders, quote_events, quotes, revisions, sales, sales_channels, service_order_warranties, service_orders, stock_movements, stock_reservations, supplier_return_events, supplier_return_items, supplier_returns, support_ticket_attachments, support_ticket_events, support_ticket_messages, support_tickets, warranty_claims

SELECT set_config('app.user_type', 'SUPER_ADMIN', true);

DO $$
DECLARE
  n bigint;
  total bigint := 0;
  msg text := '';
BEGIN
  SELECT count(*) INTO n FROM "accounts_payable" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'accounts_payable', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "accounts_receivable" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'accounts_receivable', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "agenda_unavailabilities" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'agenda_unavailabilities', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "agreement_companies" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'agreement_companies', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "appointments" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'appointments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "business_calendar_exceptions" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'business_calendar_exceptions', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "business_hours" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'business_hours', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "cash_registers" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'cash_registers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_api_credentials" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'channel_api_credentials', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_events" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'channel_events', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_inbound_events" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'channel_inbound_events', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_outbox" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'channel_outbox', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_product_links" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'channel_product_links', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "collection_attempts" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'collection_attempts', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "company_module_settings" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'company_module_settings', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "damage_records" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'damage_records', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "device_sessions" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'device_sessions', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "discount_events" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'discount_events', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreement_charges" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'employee_agreement_charges', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreements" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'employee_agreements', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_payroll_deductions" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'employee_payroll_deductions', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_order_items" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'external_order_items', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_orders" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'external_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_payments" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'external_payments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fiscal_configs" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'fiscal_configs', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fiscal_documents" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'fiscal_documents', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "follow_ups" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'follow_ups', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fulfillments" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'fulfillments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "import_batches" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'import_batches', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "installment_policies" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'installment_policies', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "inventories" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'inventories', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "partners" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'partners', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payment_exceptions" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'payment_exceptions', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payment_settings" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'payment_settings', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "policy_changes" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'policy_changes', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "policy_settings" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'policy_settings', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "products" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "purchase_orders" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'purchase_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "quote_events" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'quote_events', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "quotes" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'quotes', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "revisions" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'revisions', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "sales" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "sales_channels" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_order_warranties" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'service_order_warranties', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_orders" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_movements" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'stock_movements', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_reservations" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'stock_reservations', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_events" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'supplier_return_events', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_items" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'supplier_return_items', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_returns" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'supplier_returns', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_attachments" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'support_ticket_attachments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_events" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'support_ticket_events', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_messages" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'support_ticket_messages', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_tickets" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'support_tickets', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "warranty_claims" c WHERE c."branchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."id" = c."branchId" AND b."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s: %s; ', 'warranty_claims', n); total := total + n; END IF;
  IF total > 0 THEN
    RAISE EXCEPTION 'FKs de filial abortadas: % linha(s) com filial inexistente ou de OUTRA empresa — %. Corrija por procedimento documentado (nunca adivinhando a filial) e reaplique.', total, msg;
  END IF;
END $$;

-- adiciona NOT VALID (lock curto) …
ALTER TABLE "accounts_payable" ADD CONSTRAINT "accounts_payable_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_receivable" ADD CONSTRAINT "accounts_receivable_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agenda_unavailabilities" ADD CONSTRAINT "agenda_unavailabilities_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agreement_companies" ADD CONSTRAINT "agreement_companies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "business_calendar_exceptions" ADD CONSTRAINT "business_calendar_exceptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "categories" ADD CONSTRAINT "categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_api_credentials" ADD CONSTRAINT "channel_api_credentials_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_inbound_events" ADD CONSTRAINT "channel_inbound_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_product_links" ADD CONSTRAINT "channel_product_links_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "company_module_settings" ADD CONSTRAINT "company_module_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "customers" ADD CONSTRAINT "customers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "damage_records" ADD CONSTRAINT "damage_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_events" ADD CONSTRAINT "discount_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_rules" ADD CONSTRAINT "discount_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreement_charges" ADD CONSTRAINT "employee_agreement_charges_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreements" ADD CONSTRAINT "employee_agreements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_payroll_deductions" ADD CONSTRAINT "employee_payroll_deductions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_order_items" ADD CONSTRAINT "external_order_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_payments" ADD CONSTRAINT "external_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fiscal_configs" ADD CONSTRAINT "fiscal_configs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "mechanic_commissions" ADD CONSTRAINT "mechanic_commissions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "motorcycles" ADD CONSTRAINT "motorcycles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "policy_changes" ADD CONSTRAINT "policy_changes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "policy_settings" ADD CONSTRAINT "policy_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "products" ADD CONSTRAINT "products_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_order_warranties" ADD CONSTRAINT "service_order_warranties_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_events" ADD CONSTRAINT "supplier_return_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tef_payments" ADD CONSTRAINT "tef_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "vehicle_entry_checklists" ADD CONSTRAINT "vehicle_entry_checklists_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_payable" ADD CONSTRAINT "accounts_payable_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_receivable" ADD CONSTRAINT "accounts_receivable_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agenda_unavailabilities" ADD CONSTRAINT "agenda_unavailabilities_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agreement_companies" ADD CONSTRAINT "agreement_companies_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "business_calendar_exceptions" ADD CONSTRAINT "business_calendar_exceptions_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_api_credentials" ADD CONSTRAINT "channel_api_credentials_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_inbound_events" ADD CONSTRAINT "channel_inbound_events_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_product_links" ADD CONSTRAINT "channel_product_links_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "company_module_settings" ADD CONSTRAINT "company_module_settings_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "damage_records" ADD CONSTRAINT "damage_records_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_events" ADD CONSTRAINT "discount_events_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreement_charges" ADD CONSTRAINT "employee_agreement_charges_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreements" ADD CONSTRAINT "employee_agreements_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_payroll_deductions" ADD CONSTRAINT "employee_payroll_deductions_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_order_items" ADD CONSTRAINT "external_order_items_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_payments" ADD CONSTRAINT "external_payments_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fiscal_configs" ADD CONSTRAINT "fiscal_configs_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "installment_policies" ADD CONSTRAINT "installment_policies_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "partners" ADD CONSTRAINT "partners_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "policy_changes" ADD CONSTRAINT "policy_changes_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "policy_settings" ADD CONSTRAINT "policy_settings_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "products" ADD CONSTRAINT "products_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_order_warranties" ADD CONSTRAINT "service_order_warranties_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_events" ADD CONSTRAINT "supplier_return_events_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- … e valida com contexto de plataforma; só as que ainda têm linha órfã de empresa inexistente ficam NOT VALID (aviso)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('accounts_payable', 'accounts_payable_companyId_fkey'),
    ('accounts_receivable', 'accounts_receivable_companyId_fkey'),
    ('agenda_unavailabilities', 'agenda_unavailabilities_companyId_fkey'),
    ('agreement_companies', 'agreement_companies_companyId_fkey'),
    ('appointments', 'appointments_companyId_fkey'),
    ('business_calendar_exceptions', 'business_calendar_exceptions_companyId_fkey'),
    ('business_hours', 'business_hours_companyId_fkey'),
    ('cash_registers', 'cash_registers_companyId_fkey'),
    ('categories', 'categories_companyId_fkey'),
    ('channel_api_credentials', 'channel_api_credentials_companyId_fkey'),
    ('channel_events', 'channel_events_companyId_fkey'),
    ('channel_inbound_events', 'channel_inbound_events_companyId_fkey'),
    ('channel_outbox', 'channel_outbox_companyId_fkey'),
    ('channel_product_links', 'channel_product_links_companyId_fkey'),
    ('collection_attempts', 'collection_attempts_companyId_fkey'),
    ('commission_rules', 'commission_rules_companyId_fkey'),
    ('company_module_settings', 'company_module_settings_companyId_fkey'),
    ('customers', 'customers_companyId_fkey'),
    ('damage_records', 'damage_records_companyId_fkey'),
    ('device_sessions', 'device_sessions_companyId_fkey'),
    ('discount_events', 'discount_events_companyId_fkey'),
    ('discount_rules', 'discount_rules_companyId_fkey'),
    ('employee_agreement_charges', 'employee_agreement_charges_companyId_fkey'),
    ('employee_agreements', 'employee_agreements_companyId_fkey'),
    ('employee_payroll_deductions', 'employee_payroll_deductions_companyId_fkey'),
    ('external_order_items', 'external_order_items_companyId_fkey'),
    ('external_orders', 'external_orders_companyId_fkey'),
    ('external_payments', 'external_payments_companyId_fkey'),
    ('fiscal_configs', 'fiscal_configs_companyId_fkey'),
    ('fiscal_documents', 'fiscal_documents_companyId_fkey'),
    ('follow_ups', 'follow_ups_companyId_fkey'),
    ('fulfillments', 'fulfillments_companyId_fkey'),
    ('import_batches', 'import_batches_companyId_fkey'),
    ('inventories', 'inventories_companyId_fkey'),
    ('invoices', 'invoices_companyId_fkey'),
    ('mechanic_commissions', 'mechanic_commissions_companyId_fkey'),
    ('motorcycles', 'motorcycles_companyId_fkey'),
    ('payment_exceptions', 'payment_exceptions_companyId_fkey'),
    ('payment_settings', 'payment_settings_companyId_fkey'),
    ('payments', 'payments_companyId_fkey'),
    ('policy_changes', 'policy_changes_companyId_fkey'),
    ('policy_settings', 'policy_settings_companyId_fkey'),
    ('products', 'products_companyId_fkey'),
    ('purchase_orders', 'purchase_orders_companyId_fkey'),
    ('quote_events', 'quote_events_companyId_fkey'),
    ('quotes', 'quotes_companyId_fkey'),
    ('revisions', 'revisions_companyId_fkey'),
    ('sales', 'sales_companyId_fkey'),
    ('sales_channels', 'sales_channels_companyId_fkey'),
    ('service_order_warranties', 'service_order_warranties_companyId_fkey'),
    ('service_orders', 'service_orders_companyId_fkey'),
    ('stock_movements', 'stock_movements_companyId_fkey'),
    ('stock_reservations', 'stock_reservations_companyId_fkey'),
    ('supplier_return_events', 'supplier_return_events_companyId_fkey'),
    ('supplier_return_items', 'supplier_return_items_companyId_fkey'),
    ('supplier_returns', 'supplier_returns_companyId_fkey'),
    ('suppliers', 'suppliers_companyId_fkey'),
    ('support_ticket_attachments', 'support_ticket_attachments_companyId_fkey'),
    ('support_ticket_events', 'support_ticket_events_companyId_fkey'),
    ('support_ticket_messages', 'support_ticket_messages_companyId_fkey'),
    ('support_tickets', 'support_tickets_companyId_fkey'),
    ('tef_payments', 'tef_payments_companyId_fkey'),
    ('transfers', 'transfers_companyId_fkey'),
    ('vehicle_entry_checklists', 'vehicle_entry_checklists_companyId_fkey'),
    ('warranty_claims', 'warranty_claims_companyId_fkey'),
    ('accounts_payable', 'accounts_payable_companyId_branchId_fkey'),
    ('accounts_receivable', 'accounts_receivable_companyId_branchId_fkey'),
    ('agenda_unavailabilities', 'agenda_unavailabilities_companyId_branchId_fkey'),
    ('agreement_companies', 'agreement_companies_companyId_branchId_fkey'),
    ('appointments', 'appointments_companyId_branchId_fkey'),
    ('business_calendar_exceptions', 'business_calendar_exceptions_companyId_branchId_fkey'),
    ('business_hours', 'business_hours_companyId_branchId_fkey'),
    ('cash_registers', 'cash_registers_companyId_branchId_fkey'),
    ('channel_api_credentials', 'channel_api_credentials_companyId_branchId_fkey'),
    ('channel_events', 'channel_events_companyId_branchId_fkey'),
    ('channel_inbound_events', 'channel_inbound_events_companyId_branchId_fkey'),
    ('channel_outbox', 'channel_outbox_companyId_branchId_fkey'),
    ('channel_product_links', 'channel_product_links_companyId_branchId_fkey'),
    ('collection_attempts', 'collection_attempts_companyId_branchId_fkey'),
    ('company_module_settings', 'company_module_settings_companyId_branchId_fkey'),
    ('damage_records', 'damage_records_companyId_branchId_fkey'),
    ('device_sessions', 'device_sessions_companyId_branchId_fkey'),
    ('discount_events', 'discount_events_companyId_branchId_fkey'),
    ('employee_agreement_charges', 'employee_agreement_charges_companyId_branchId_fkey'),
    ('employee_agreements', 'employee_agreements_companyId_branchId_fkey'),
    ('employee_payroll_deductions', 'employee_payroll_deductions_companyId_branchId_fkey'),
    ('external_order_items', 'external_order_items_companyId_branchId_fkey'),
    ('external_orders', 'external_orders_companyId_branchId_fkey'),
    ('external_payments', 'external_payments_companyId_branchId_fkey'),
    ('fiscal_configs', 'fiscal_configs_companyId_branchId_fkey'),
    ('fiscal_documents', 'fiscal_documents_companyId_branchId_fkey'),
    ('follow_ups', 'follow_ups_companyId_branchId_fkey'),
    ('fulfillments', 'fulfillments_companyId_branchId_fkey'),
    ('import_batches', 'import_batches_companyId_branchId_fkey'),
    ('installment_policies', 'installment_policies_companyId_branchId_fkey'),
    ('inventories', 'inventories_companyId_branchId_fkey'),
    ('partners', 'partners_companyId_branchId_fkey'),
    ('payment_exceptions', 'payment_exceptions_companyId_branchId_fkey'),
    ('payment_settings', 'payment_settings_companyId_branchId_fkey'),
    ('policy_changes', 'policy_changes_companyId_branchId_fkey'),
    ('policy_settings', 'policy_settings_companyId_branchId_fkey'),
    ('products', 'products_companyId_branchId_fkey'),
    ('purchase_orders', 'purchase_orders_companyId_branchId_fkey'),
    ('quote_events', 'quote_events_companyId_branchId_fkey'),
    ('quotes', 'quotes_companyId_branchId_fkey'),
    ('revisions', 'revisions_companyId_branchId_fkey'),
    ('sales', 'sales_companyId_branchId_fkey'),
    ('sales_channels', 'sales_channels_companyId_branchId_fkey'),
    ('service_order_warranties', 'service_order_warranties_companyId_branchId_fkey'),
    ('service_orders', 'service_orders_companyId_branchId_fkey'),
    ('stock_movements', 'stock_movements_companyId_branchId_fkey'),
    ('stock_reservations', 'stock_reservations_companyId_branchId_fkey'),
    ('supplier_return_events', 'supplier_return_events_companyId_branchId_fkey'),
    ('supplier_return_items', 'supplier_return_items_companyId_branchId_fkey'),
    ('supplier_returns', 'supplier_returns_companyId_branchId_fkey'),
    ('support_ticket_attachments', 'support_ticket_attachments_companyId_branchId_fkey'),
    ('support_ticket_events', 'support_ticket_events_companyId_branchId_fkey'),
    ('support_ticket_messages', 'support_ticket_messages_companyId_branchId_fkey'),
    ('support_tickets', 'support_tickets_companyId_branchId_fkey'),
    ('warranty_claims', 'warranty_claims_companyId_branchId_fkey')
  ) AS t(tabela, restricao) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.tabela, r.restricao);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'FK % em % ficou NOT VALID: existem linhas órfãs de empresa inexistente (legado de limpeza de teste), tratadas à parte', r.restricao, r.tabela;
    END;
  END LOOP;
END $$;
