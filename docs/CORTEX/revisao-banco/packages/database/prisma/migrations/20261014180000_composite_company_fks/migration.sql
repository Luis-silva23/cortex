-- FKs COMPOSTAS (companyId, X) → pai(companyId, id) nas relações de negócio (2026-10-14, revisão do banco — achados C-02/D-05; gerado por codemod, revisado).
-- PROBLEMA: a checagem de FK do PostgreSQL não passa pela RLS e a policy da linha filha só olha o companyId da PRÓPRIA linha; nenhuma FK
-- simples impede (companyId = A, <pai> = registro da empresa B). Provado em product_barcodes/product_images (migrations 20261014155900–161000).
-- ESCOPO: 61 FKs EXISTENTES viram compostas (as simples saem; mesmas regras de exclusão) e 33 relações que eram só colunas soltas
-- ganham FK composta ON DELETE RESTRICT (financeiras, estoque, convênios, fiscal, devolução, transferência entre filiais). 8 relações
-- "SET NULL" sem caminho de exclusão na aplicação (varredura do código) passam a RESTRICT; sales.partnerId (a aplicação apaga convênios) e
-- service_orders.mechanicId (a aplicação apaga usuários) ficam SET NULL e SEM composta — o Prisma não modela SET NULL parcial (anularia o
-- companyId) — protegidas só pela aplicação e pelo teste de dados (decisão 129, resíduo documentado).
-- GUARDA: a validação de FK feita pelo dono sob FORCE RLS passa em branco (achado C-03); o bloco DO abaixo lê com contexto de plataforma e
-- ABORTA, listando as relações, se houver linha cujo pai não exista OU seja de outra empresa. Linhas de empresas que NÃO EXISTEM MAIS (órfãs
-- por limpeza de teste, ex.: 1 recebível no dev) não são "associadas" a nenhuma empresa por suposição: ficam intactas e a FK correspondente
-- permanece NOT VALID (vale para linhas novas e alteradas; convalidated = false é o sinal para tratar o legado).
-- CRIAÇÃO: ADD CONSTRAINT … NOT VALID (lock curto) e depois VALIDATE (em contexto de plataforma). Os índices únicos (companyId, id) são redundantes com a PK
-- e servem de alvo.
-- ROLLBACK (nenhum dado depende das restrições novas; recria as FKs simples):
--   para cada relação "up": ALTER TABLE <filho> DROP CONSTRAINT <filho>_companyId_<col>_fkey; ALTER TABLE <filho> ADD CONSTRAINT <nome-antigo> FOREIGN KEY (<col>) REFERENCES <pai>(id) ON DELETE <regra> ON UPDATE CASCADE;
--   para cada relação "new": ALTER TABLE <filho> DROP CONSTRAINT <filho>_companyId_<col>_fkey;
--   DROP INDEX <pai>_companyId_id_key (todos os pais).
-- RELAÇÕES (up = FK existente que vira composta; new = FK nova):
--   up  appointments.customerId → customers (RESTRICT)
--   up  appointments.followUpId → follow_ups (RESTRICT)
--   up  appointments.motorcycleId → motorcycles (RESTRICT)
--   up  categories.parentId → categories (RESTRICT)
--   up  channel_api_credentials.channelId → sales_channels (RESTRICT)
--   up  channel_events.channelId → sales_channels (RESTRICT)
--   up  channel_inbound_events.channelId → sales_channels (RESTRICT)
--   up  channel_outbox.channelId → sales_channels (RESTRICT)
--   up  channel_product_links.channelId → sales_channels (RESTRICT)
--   up  channel_product_links.productId → products (RESTRICT)
--   up  collection_attempts.receivableId → accounts_receivable (RESTRICT)
--   up  damage_records.productId → products (RESTRICT)
--   up  device_sessions.userId → users (CASCADE)
--   up  employee_agreement_charges.agreementId → employee_agreements (RESTRICT)
--   up  employee_payroll_deductions.chargeId → employee_agreement_charges (RESTRICT)
--   up  external_order_items.orderId → external_orders (RESTRICT)
--   up  external_order_items.productId → products (RESTRICT)
--   up  external_orders.channelId → sales_channels (RESTRICT)
--   up  external_orders.saleId → sales (RESTRICT)
--   up  external_payments.channelId → sales_channels (RESTRICT)
--   up  external_payments.orderId → external_orders (RESTRICT)
--   up  follow_ups.customerId → customers (RESTRICT)
--   up  follow_ups.motorcycleId → motorcycles (RESTRICT)
--   up  follow_ups.revisionId → revisions (RESTRICT)
--   up  fulfillments.orderId → external_orders (RESTRICT)
--   up  fulfillments.saleId → sales (RESTRICT)
--   up  invoices.purchaseOrderId → purchase_orders (RESTRICT)
--   up  invoices.supplierId → suppliers (RESTRICT)
--   up  mechanic_commissions.serviceOrderId → service_orders (RESTRICT)
--   up  motorcycles.customerId → customers (RESTRICT)
--   up  payment_exceptions.paymentId → payments (RESTRICT)
--   up  payments.saleId → sales (CASCADE)
--   up  products.categoryId → categories (RESTRICT)
--   up  purchase_orders.supplierId → suppliers (RESTRICT)
--   up  quote_events.quoteId → quotes (CASCADE)
--   up  quotes.customerId → customers (RESTRICT)
--   up  quotes.motorcycleId → motorcycles (RESTRICT)
--   up  revisions.customerId → customers (RESTRICT)
--   up  revisions.motorcycleId → motorcycles (RESTRICT)
--   up  revisions.serviceOrderId → service_orders (RESTRICT)
--   up  sales.channelId → sales_channels (RESTRICT)
--   up  sales.customerId → customers (RESTRICT)
--   up  sales.userId → users (RESTRICT)
--   up  service_order_warranties.serviceOrderId → service_orders (RESTRICT)
--   up  service_orders.customerId → customers (RESTRICT)
--   up  service_orders.motorcycleId → motorcycles (RESTRICT)
--   up  stock_movements.productId → products (CASCADE)
--   up  stock_reservations.channelId → sales_channels (RESTRICT)
--   up  stock_reservations.orderId → external_orders (RESTRICT)
--   up  stock_reservations.productId → products (RESTRICT)
--   up  supplier_return_events.returnId → supplier_returns (RESTRICT)
--   up  supplier_return_items.productId → products (RESTRICT)
--   up  supplier_return_items.returnId → supplier_returns (RESTRICT)
--   up  supplier_returns.supplierId → suppliers (RESTRICT)
--   up  support_ticket_attachments.messageId → support_ticket_messages (RESTRICT)
--   up  support_ticket_attachments.ticketId → support_tickets (RESTRICT)
--   up  support_ticket_events.ticketId → support_tickets (RESTRICT)
--   up  support_ticket_messages.ticketId → support_tickets (RESTRICT)
--   up  vehicle_entry_checklists.motorcycleId → motorcycles (RESTRICT)
--   up  vehicle_entry_checklists.serviceOrderId → service_orders (CASCADE)
--   up  warranty_claims.warrantyId → service_order_warranties (RESTRICT)
--   new accounts_payable.supplierId → suppliers (RESTRICT)
--   new accounts_receivable.agreementCompanyId → agreement_companies (RESTRICT)
--   new accounts_receivable.customerId → customers (RESTRICT)
--   new accounts_receivable.employeeAgreementId → employee_agreements (RESTRICT)
--   new cash_registers.userId → users (RESTRICT)
--   new collection_attempts.agreementCompanyId → agreement_companies (RESTRICT)
--   new discount_events.quoteId → quotes (RESTRICT)
--   new discount_events.saleId → sales (RESTRICT)
--   new discount_events.serviceOrderId → service_orders (RESTRICT)
--   new employee_agreement_charges.paymentId → payments (RESTRICT)
--   new employee_agreement_charges.saleId → sales (RESTRICT)
--   new employee_agreements.customerId → customers (RESTRICT)
--   new employee_agreements.userId → users (RESTRICT)
--   new fiscal_documents.saleId → sales (RESTRICT)
--   new fiscal_documents.serviceOrderId → service_orders (RESTRICT)
--   new import_batches.userId → users (RESTRICT)
--   new payment_exceptions.saleId → sales (RESTRICT)
--   new payments.agreementCompanyId → agreement_companies (RESTRICT)
--   new payments.employeeAgreementId → employee_agreements (RESTRICT)
--   new sales.cashRegisterId → cash_registers (RESTRICT)
--   new service_order_warranties.customerId → customers (RESTRICT)
--   new service_order_warranties.motorcycleId → motorcycles (RESTRICT)
--   new stock_movements.userId → users (RESTRICT)
--   new supplier_return_events.userId → users (RESTRICT)
--   new supplier_return_items.damageRecordId → damage_records (RESTRICT)
--   new supplier_returns.purchaseOrderId → purchase_orders (RESTRICT)
--   new tef_payments.paymentId → payments (RESTRICT)
--   new tef_payments.saleId → sales (RESTRICT)
--   new tef_payments.serviceOrderId → service_orders (RESTRICT)
--   new transfers.fromBranchId → branches (RESTRICT)
--   new transfers.toBranchId → branches (RESTRICT)
--   new warranty_claims.newServiceOrderId → service_orders (RESTRICT)
--   new warranty_claims.serviceOrderId → service_orders (RESTRICT)

SELECT set_config('app.user_type', 'SUPER_ADMIN', true);

DO $$
DECLARE
  n bigint;
  total bigint := 0;
  msg text := '';
BEGIN
  SELECT count(*) INTO n FROM "appointments" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'appointments', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "appointments" c WHERE c."followUpId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "follow_ups" p WHERE p."id" = c."followUpId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'appointments', 'followUpId', 'follow_ups', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "appointments" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'appointments', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "categories" c WHERE c."parentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "categories" p WHERE p."id" = c."parentId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'categories', 'parentId', 'categories', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_api_credentials" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'channel_api_credentials', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_events" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'channel_events', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_inbound_events" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'channel_inbound_events', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_outbox" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'channel_outbox', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_product_links" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'channel_product_links', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "channel_product_links" c WHERE c."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = c."productId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'channel_product_links', 'productId', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "collection_attempts" c WHERE c."receivableId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "accounts_receivable" p WHERE p."id" = c."receivableId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'collection_attempts', 'receivableId', 'accounts_receivable', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "damage_records" c WHERE c."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = c."productId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'damage_records', 'productId', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "device_sessions" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'device_sessions', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreement_charges" c WHERE c."agreementId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "employee_agreements" p WHERE p."id" = c."agreementId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'employee_agreement_charges', 'agreementId', 'employee_agreements', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_payroll_deductions" c WHERE c."chargeId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "employee_agreement_charges" p WHERE p."id" = c."chargeId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'employee_payroll_deductions', 'chargeId', 'employee_agreement_charges', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_order_items" c WHERE c."orderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "external_orders" p WHERE p."id" = c."orderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'external_order_items', 'orderId', 'external_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_order_items" c WHERE c."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = c."productId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'external_order_items', 'productId', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_orders" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'external_orders', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_orders" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'external_orders', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_payments" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'external_payments', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "external_payments" c WHERE c."orderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "external_orders" p WHERE p."id" = c."orderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'external_payments', 'orderId', 'external_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "follow_ups" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'follow_ups', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "follow_ups" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'follow_ups', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "follow_ups" c WHERE c."revisionId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "revisions" p WHERE p."id" = c."revisionId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'follow_ups', 'revisionId', 'revisions', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fulfillments" c WHERE c."orderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "external_orders" p WHERE p."id" = c."orderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'fulfillments', 'orderId', 'external_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fulfillments" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'fulfillments', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "invoices" c WHERE c."purchaseOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "purchase_orders" p WHERE p."id" = c."purchaseOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'invoices', 'purchaseOrderId', 'purchase_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "invoices" c WHERE c."supplierId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "suppliers" p WHERE p."id" = c."supplierId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'invoices', 'supplierId', 'suppliers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "mechanic_commissions" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'mechanic_commissions', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "motorcycles" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'motorcycles', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payment_exceptions" c WHERE c."paymentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."id" = c."paymentId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'payment_exceptions', 'paymentId', 'payments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payments" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'payments', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "products" c WHERE c."categoryId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "categories" p WHERE p."id" = c."categoryId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'products', 'categoryId', 'categories', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "purchase_orders" c WHERE c."supplierId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "suppliers" p WHERE p."id" = c."supplierId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'purchase_orders', 'supplierId', 'suppliers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "quote_events" c WHERE c."quoteId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "quotes" p WHERE p."id" = c."quoteId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'quote_events', 'quoteId', 'quotes', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "quotes" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'quotes', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "quotes" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'quotes', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "revisions" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'revisions', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "revisions" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'revisions', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "revisions" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'revisions', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "sales" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'sales', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "sales" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'sales', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "sales" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'sales', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_order_warranties" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'service_order_warranties', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_orders" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'service_orders', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_orders" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'service_orders', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_movements" c WHERE c."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = c."productId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'stock_movements', 'productId', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_reservations" c WHERE c."channelId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales_channels" p WHERE p."id" = c."channelId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'stock_reservations', 'channelId', 'sales_channels', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_reservations" c WHERE c."orderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "external_orders" p WHERE p."id" = c."orderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'stock_reservations', 'orderId', 'external_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_reservations" c WHERE c."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = c."productId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'stock_reservations', 'productId', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_events" c WHERE c."returnId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "supplier_returns" p WHERE p."id" = c."returnId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_return_events', 'returnId', 'supplier_returns', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_items" c WHERE c."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = c."productId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_return_items', 'productId', 'products', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_items" c WHERE c."returnId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "supplier_returns" p WHERE p."id" = c."returnId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_return_items', 'returnId', 'supplier_returns', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_returns" c WHERE c."supplierId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "suppliers" p WHERE p."id" = c."supplierId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_returns', 'supplierId', 'suppliers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_attachments" c WHERE c."messageId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "support_ticket_messages" p WHERE p."id" = c."messageId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'support_ticket_attachments', 'messageId', 'support_ticket_messages', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_attachments" c WHERE c."ticketId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "support_tickets" p WHERE p."id" = c."ticketId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'support_ticket_attachments', 'ticketId', 'support_tickets', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_events" c WHERE c."ticketId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "support_tickets" p WHERE p."id" = c."ticketId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'support_ticket_events', 'ticketId', 'support_tickets', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "support_ticket_messages" c WHERE c."ticketId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "support_tickets" p WHERE p."id" = c."ticketId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'support_ticket_messages', 'ticketId', 'support_tickets', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "vehicle_entry_checklists" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'vehicle_entry_checklists', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "vehicle_entry_checklists" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'vehicle_entry_checklists', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "warranty_claims" c WHERE c."warrantyId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_order_warranties" p WHERE p."id" = c."warrantyId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'warranty_claims', 'warrantyId', 'service_order_warranties', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "accounts_payable" c WHERE c."supplierId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "suppliers" p WHERE p."id" = c."supplierId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'accounts_payable', 'supplierId', 'suppliers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "accounts_receivable" c WHERE c."agreementCompanyId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "agreement_companies" p WHERE p."id" = c."agreementCompanyId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'accounts_receivable', 'agreementCompanyId', 'agreement_companies', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "accounts_receivable" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'accounts_receivable', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "accounts_receivable" c WHERE c."employeeAgreementId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "employee_agreements" p WHERE p."id" = c."employeeAgreementId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'accounts_receivable', 'employeeAgreementId', 'employee_agreements', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "cash_registers" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'cash_registers', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "collection_attempts" c WHERE c."agreementCompanyId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "agreement_companies" p WHERE p."id" = c."agreementCompanyId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'collection_attempts', 'agreementCompanyId', 'agreement_companies', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "discount_events" c WHERE c."quoteId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "quotes" p WHERE p."id" = c."quoteId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'discount_events', 'quoteId', 'quotes', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "discount_events" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'discount_events', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "discount_events" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'discount_events', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreement_charges" c WHERE c."paymentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."id" = c."paymentId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'employee_agreement_charges', 'paymentId', 'payments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreement_charges" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'employee_agreement_charges', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreements" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'employee_agreements', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "employee_agreements" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'employee_agreements', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fiscal_documents" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'fiscal_documents', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "fiscal_documents" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'fiscal_documents', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "import_batches" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'import_batches', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payment_exceptions" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'payment_exceptions', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payments" c WHERE c."agreementCompanyId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "agreement_companies" p WHERE p."id" = c."agreementCompanyId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'payments', 'agreementCompanyId', 'agreement_companies', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "payments" c WHERE c."employeeAgreementId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "employee_agreements" p WHERE p."id" = c."employeeAgreementId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'payments', 'employeeAgreementId', 'employee_agreements', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "sales" c WHERE c."cashRegisterId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "cash_registers" p WHERE p."id" = c."cashRegisterId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'sales', 'cashRegisterId', 'cash_registers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_order_warranties" c WHERE c."customerId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "customers" p WHERE p."id" = c."customerId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'service_order_warranties', 'customerId', 'customers', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "service_order_warranties" c WHERE c."motorcycleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "motorcycles" p WHERE p."id" = c."motorcycleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'service_order_warranties', 'motorcycleId', 'motorcycles', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "stock_movements" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'stock_movements', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_events" c WHERE c."userId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "users" p WHERE p."id" = c."userId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_return_events', 'userId', 'users', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_return_items" c WHERE c."damageRecordId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "damage_records" p WHERE p."id" = c."damageRecordId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_return_items', 'damageRecordId', 'damage_records', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "supplier_returns" c WHERE c."purchaseOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "purchase_orders" p WHERE p."id" = c."purchaseOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'supplier_returns', 'purchaseOrderId', 'purchase_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "tef_payments" c WHERE c."paymentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."id" = c."paymentId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'tef_payments', 'paymentId', 'payments', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "tef_payments" c WHERE c."saleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "sales" p WHERE p."id" = c."saleId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'tef_payments', 'saleId', 'sales', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "tef_payments" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'tef_payments', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "transfers" c WHERE c."fromBranchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" p WHERE p."id" = c."fromBranchId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'transfers', 'fromBranchId', 'branches', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "transfers" c WHERE c."toBranchId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "branches" p WHERE p."id" = c."toBranchId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'transfers', 'toBranchId', 'branches', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "warranty_claims" c WHERE c."newServiceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."newServiceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'warranty_claims', 'newServiceOrderId', 'service_orders', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM "warranty_claims" c WHERE c."serviceOrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "companies" co WHERE co."id" = c."companyId") AND NOT EXISTS (SELECT 1 FROM "service_orders" p WHERE p."id" = c."serviceOrderId" AND p."companyId" = c."companyId");
  IF n > 0 THEN msg := msg || format('%s.%s → %s: %s; ', 'warranty_claims', 'serviceOrderId', 'service_orders', n); total := total + n; END IF;
  IF total > 0 THEN
    RAISE EXCEPTION 'FKs compostas abortadas: % linha(s) com pai inexistente ou de OUTRA empresa — %. Corrija por procedimento documentado (nunca apagando histórico) e reaplique (ver o cabeçalho).', total, msg;
  END IF;
END $$;

-- alvos das FKs compostas (e, nas relações 1:1, o índice (companyId, coluna) que o Prisma exige no filho)
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_receivable_companyId_id_key" ON "accounts_receivable"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_companies_companyId_id_key" ON "agreement_companies"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "branches_companyId_id_key" ON "branches"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "cash_registers_companyId_id_key" ON "cash_registers"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "categories_companyId_id_key" ON "categories"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_companyId_id_key" ON "customers"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "damage_records_companyId_id_key" ON "damage_records"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "employee_agreement_charges_companyId_id_key" ON "employee_agreement_charges"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "employee_agreements_companyId_id_key" ON "employee_agreements"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "external_orders_companyId_id_key" ON "external_orders"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "follow_ups_companyId_id_key" ON "follow_ups"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "motorcycles_companyId_id_key" ON "motorcycles"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "payments_companyId_id_key" ON "payments"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "products_companyId_id_key" ON "products"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_companyId_id_key" ON "purchase_orders"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "quotes_companyId_id_key" ON "quotes"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "revisions_companyId_id_key" ON "revisions"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_companyId_id_key" ON "sales"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_channels_companyId_id_key" ON "sales_channels"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "service_order_warranties_companyId_id_key" ON "service_order_warranties"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "service_orders_companyId_id_key" ON "service_orders"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_returns_companyId_id_key" ON "supplier_returns"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_companyId_id_key" ON "suppliers"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "support_ticket_messages_companyId_id_key" ON "support_ticket_messages"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_companyId_id_key" ON "support_tickets"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "users_companyId_id_key" ON "users"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "appointments_companyId_followUpId_key" ON "appointments"("companyId", "followUpId");
CREATE UNIQUE INDEX IF NOT EXISTS "external_orders_companyId_saleId_key" ON "external_orders"("companyId", "saleId");
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillments_companyId_orderId_key" ON "fulfillments"("companyId", "orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillments_companyId_saleId_key" ON "fulfillments"("companyId", "saleId");
CREATE UNIQUE INDEX IF NOT EXISTS "service_order_warranties_companyId_serviceOrderId_key" ON "service_order_warranties"("companyId", "serviceOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_entry_checklists_companyId_serviceOrderId_key" ON "vehicle_entry_checklists"("companyId", "serviceOrderId");

-- FKs compostas (adiciona ANTES de remover as simples antigas: nunca há janela sem proteção)
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_companyId_followUpId_fkey" FOREIGN KEY ("companyId", "followUpId") REFERENCES "follow_ups"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "categories" ADD CONSTRAINT "categories_companyId_parentId_fkey" FOREIGN KEY ("companyId", "parentId") REFERENCES "categories"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_api_credentials" ADD CONSTRAINT "channel_api_credentials_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_inbound_events" ADD CONSTRAINT "channel_inbound_events_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_product_links" ADD CONSTRAINT "channel_product_links_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "channel_product_links" ADD CONSTRAINT "channel_product_links_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_companyId_receivableId_fkey" FOREIGN KEY ("companyId", "receivableId") REFERENCES "accounts_receivable"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "damage_records" ADD CONSTRAINT "damage_records_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreement_charges" ADD CONSTRAINT "employee_agreement_charges_companyId_agreementId_fkey" FOREIGN KEY ("companyId", "agreementId") REFERENCES "employee_agreements"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_payroll_deductions" ADD CONSTRAINT "employee_payroll_deductions_companyId_chargeId_fkey" FOREIGN KEY ("companyId", "chargeId") REFERENCES "employee_agreement_charges"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_order_items" ADD CONSTRAINT "external_order_items_companyId_orderId_fkey" FOREIGN KEY ("companyId", "orderId") REFERENCES "external_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_order_items" ADD CONSTRAINT "external_order_items_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_payments" ADD CONSTRAINT "external_payments_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_payments" ADD CONSTRAINT "external_payments_companyId_orderId_fkey" FOREIGN KEY ("companyId", "orderId") REFERENCES "external_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_companyId_revisionId_fkey" FOREIGN KEY ("companyId", "revisionId") REFERENCES "revisions"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_companyId_orderId_fkey" FOREIGN KEY ("companyId", "orderId") REFERENCES "external_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_purchaseOrderId_fkey" FOREIGN KEY ("companyId", "purchaseOrderId") REFERENCES "purchase_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "mechanic_commissions" ADD CONSTRAINT "mechanic_commissions_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "motorcycles" ADD CONSTRAINT "motorcycles_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_companyId_paymentId_fkey" FOREIGN KEY ("companyId", "paymentId") REFERENCES "payments"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "products" ADD CONSTRAINT "products_companyId_categoryId_fkey" FOREIGN KEY ("companyId", "categoryId") REFERENCES "categories"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_companyId_quoteId_fkey" FOREIGN KEY ("companyId", "quoteId") REFERENCES "quotes"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_order_warranties" ADD CONSTRAINT "service_order_warranties_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_companyId_channelId_fkey" FOREIGN KEY ("companyId", "channelId") REFERENCES "sales_channels"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_companyId_orderId_fkey" FOREIGN KEY ("companyId", "orderId") REFERENCES "external_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_events" ADD CONSTRAINT "supplier_return_events_companyId_returnId_fkey" FOREIGN KEY ("companyId", "returnId") REFERENCES "supplier_returns"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_companyId_returnId_fkey" FOREIGN KEY ("companyId", "returnId") REFERENCES "supplier_returns"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_companyId_messageId_fkey" FOREIGN KEY ("companyId", "messageId") REFERENCES "support_ticket_messages"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_companyId_ticketId_fkey" FOREIGN KEY ("companyId", "ticketId") REFERENCES "support_tickets"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_companyId_ticketId_fkey" FOREIGN KEY ("companyId", "ticketId") REFERENCES "support_tickets"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_companyId_ticketId_fkey" FOREIGN KEY ("companyId", "ticketId") REFERENCES "support_tickets"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "vehicle_entry_checklists" ADD CONSTRAINT "vehicle_entry_checklists_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "vehicle_entry_checklists" ADD CONSTRAINT "vehicle_entry_checklists_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_companyId_warrantyId_fkey" FOREIGN KEY ("companyId", "warrantyId") REFERENCES "service_order_warranties"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_payable" ADD CONSTRAINT "accounts_payable_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_receivable" ADD CONSTRAINT "accounts_receivable_companyId_agreementCompanyId_fkey" FOREIGN KEY ("companyId", "agreementCompanyId") REFERENCES "agreement_companies"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_receivable" ADD CONSTRAINT "accounts_receivable_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "accounts_receivable" ADD CONSTRAINT "accounts_receivable_companyId_employeeAgreementId_fkey" FOREIGN KEY ("companyId", "employeeAgreementId") REFERENCES "employee_agreements"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_companyId_agreementCompanyId_fkey" FOREIGN KEY ("companyId", "agreementCompanyId") REFERENCES "agreement_companies"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_events" ADD CONSTRAINT "discount_events_companyId_quoteId_fkey" FOREIGN KEY ("companyId", "quoteId") REFERENCES "quotes"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_events" ADD CONSTRAINT "discount_events_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_events" ADD CONSTRAINT "discount_events_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreement_charges" ADD CONSTRAINT "employee_agreement_charges_companyId_paymentId_fkey" FOREIGN KEY ("companyId", "paymentId") REFERENCES "payments"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreement_charges" ADD CONSTRAINT "employee_agreement_charges_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreements" ADD CONSTRAINT "employee_agreements_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_agreements" ADD CONSTRAINT "employee_agreements_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_agreementCompanyId_fkey" FOREIGN KEY ("companyId", "agreementCompanyId") REFERENCES "agreement_companies"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_employeeAgreementId_fkey" FOREIGN KEY ("companyId", "employeeAgreementId") REFERENCES "employee_agreements"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_companyId_cashRegisterId_fkey" FOREIGN KEY ("companyId", "cashRegisterId") REFERENCES "cash_registers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_order_warranties" ADD CONSTRAINT "service_order_warranties_companyId_customerId_fkey" FOREIGN KEY ("companyId", "customerId") REFERENCES "customers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "service_order_warranties" ADD CONSTRAINT "service_order_warranties_companyId_motorcycleId_fkey" FOREIGN KEY ("companyId", "motorcycleId") REFERENCES "motorcycles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_events" ADD CONSTRAINT "supplier_return_events_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_companyId_damageRecordId_fkey" FOREIGN KEY ("companyId", "damageRecordId") REFERENCES "damage_records"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_companyId_purchaseOrderId_fkey" FOREIGN KEY ("companyId", "purchaseOrderId") REFERENCES "purchase_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tef_payments" ADD CONSTRAINT "tef_payments_companyId_paymentId_fkey" FOREIGN KEY ("companyId", "paymentId") REFERENCES "payments"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tef_payments" ADD CONSTRAINT "tef_payments_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES "sales"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tef_payments" ADD CONSTRAINT "tef_payments_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_companyId_fromBranchId_fkey" FOREIGN KEY ("companyId", "fromBranchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_companyId_toBranchId_fkey" FOREIGN KEY ("companyId", "toBranchId") REFERENCES "branches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_companyId_newServiceOrderId_fkey" FOREIGN KEY ("companyId", "newServiceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES "service_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- FKs simples antigas das relações "up" (substituídas)
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_customerId_fkey";
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_followUpId_fkey";
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_motorcycleId_fkey";
ALTER TABLE "categories" DROP CONSTRAINT "categories_parentId_fkey";
ALTER TABLE "channel_api_credentials" DROP CONSTRAINT "channel_api_credentials_channelId_fkey";
ALTER TABLE "channel_events" DROP CONSTRAINT "channel_events_channelId_fkey";
ALTER TABLE "channel_inbound_events" DROP CONSTRAINT "channel_inbound_events_channelId_fkey";
ALTER TABLE "channel_outbox" DROP CONSTRAINT "channel_outbox_channelId_fkey";
ALTER TABLE "channel_product_links" DROP CONSTRAINT "channel_product_links_channelId_fkey";
ALTER TABLE "channel_product_links" DROP CONSTRAINT "channel_product_links_productId_fkey";
ALTER TABLE "collection_attempts" DROP CONSTRAINT "collection_attempts_receivableId_fkey";
ALTER TABLE "damage_records" DROP CONSTRAINT "damage_records_productId_fkey";
ALTER TABLE "device_sessions" DROP CONSTRAINT "device_sessions_userId_fkey";
ALTER TABLE "employee_agreement_charges" DROP CONSTRAINT "employee_agreement_charges_agreementId_fkey";
ALTER TABLE "employee_payroll_deductions" DROP CONSTRAINT "employee_payroll_deductions_chargeId_fkey";
ALTER TABLE "external_order_items" DROP CONSTRAINT "external_order_items_orderId_fkey";
ALTER TABLE "external_order_items" DROP CONSTRAINT "external_order_items_productId_fkey";
ALTER TABLE "external_orders" DROP CONSTRAINT "external_orders_channelId_fkey";
ALTER TABLE "external_orders" DROP CONSTRAINT "external_orders_saleId_fkey";
ALTER TABLE "external_payments" DROP CONSTRAINT "external_payments_channelId_fkey";
ALTER TABLE "external_payments" DROP CONSTRAINT "external_payments_orderId_fkey";
ALTER TABLE "follow_ups" DROP CONSTRAINT "follow_ups_customerId_fkey";
ALTER TABLE "follow_ups" DROP CONSTRAINT "follow_ups_motorcycleId_fkey";
ALTER TABLE "follow_ups" DROP CONSTRAINT "follow_ups_revisionId_fkey";
ALTER TABLE "fulfillments" DROP CONSTRAINT "fulfillments_orderId_fkey";
ALTER TABLE "fulfillments" DROP CONSTRAINT "fulfillments_saleId_fkey";
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_purchaseOrderId_fkey";
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_supplierId_fkey";
ALTER TABLE "mechanic_commissions" DROP CONSTRAINT "mechanic_commissions_serviceOrderId_fkey";
ALTER TABLE "motorcycles" DROP CONSTRAINT "motorcycles_customerId_fkey";
ALTER TABLE "payment_exceptions" DROP CONSTRAINT "payment_exceptions_paymentId_fkey";
ALTER TABLE "payments" DROP CONSTRAINT "payments_saleId_fkey";
ALTER TABLE "products" DROP CONSTRAINT "products_categoryId_fkey";
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_supplierId_fkey";
ALTER TABLE "quote_events" DROP CONSTRAINT "quote_events_quoteId_fkey";
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_customerId_fkey";
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_motorcycleId_fkey";
ALTER TABLE "revisions" DROP CONSTRAINT "revisions_customerId_fkey";
ALTER TABLE "revisions" DROP CONSTRAINT "revisions_motorcycleId_fkey";
ALTER TABLE "revisions" DROP CONSTRAINT "revisions_serviceOrderId_fkey";
ALTER TABLE "sales" DROP CONSTRAINT "sales_channelId_fkey";
ALTER TABLE "sales" DROP CONSTRAINT "sales_customerId_fkey";
ALTER TABLE "sales" DROP CONSTRAINT "sales_userId_fkey";
ALTER TABLE "service_order_warranties" DROP CONSTRAINT "service_order_warranties_serviceOrderId_fkey";
ALTER TABLE "service_orders" DROP CONSTRAINT "service_orders_customerId_fkey";
ALTER TABLE "service_orders" DROP CONSTRAINT "service_orders_motorcycleId_fkey";
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_productId_fkey";
ALTER TABLE "stock_reservations" DROP CONSTRAINT "stock_reservations_channelId_fkey";
ALTER TABLE "stock_reservations" DROP CONSTRAINT "stock_reservations_orderId_fkey";
ALTER TABLE "stock_reservations" DROP CONSTRAINT "stock_reservations_productId_fkey";
ALTER TABLE "supplier_return_events" DROP CONSTRAINT "supplier_return_events_returnId_fkey";
ALTER TABLE "supplier_return_items" DROP CONSTRAINT "supplier_return_items_productId_fkey";
ALTER TABLE "supplier_return_items" DROP CONSTRAINT "supplier_return_items_returnId_fkey";
ALTER TABLE "supplier_returns" DROP CONSTRAINT "supplier_returns_supplierId_fkey";
ALTER TABLE "support_ticket_attachments" DROP CONSTRAINT "support_ticket_attachments_messageId_fkey";
ALTER TABLE "support_ticket_attachments" DROP CONSTRAINT "support_ticket_attachments_ticketId_fkey";
ALTER TABLE "support_ticket_events" DROP CONSTRAINT "support_ticket_events_ticketId_fkey";
ALTER TABLE "support_ticket_messages" DROP CONSTRAINT "support_ticket_messages_ticketId_fkey";
ALTER TABLE "vehicle_entry_checklists" DROP CONSTRAINT "vehicle_entry_checklists_motorcycleId_fkey";
ALTER TABLE "vehicle_entry_checklists" DROP CONSTRAINT "vehicle_entry_checklists_serviceOrderId_fkey";
ALTER TABLE "warranty_claims" DROP CONSTRAINT "warranty_claims_warrantyId_fkey";

-- valida as novas com contexto de plataforma; só as que ainda têm linha órfã de empresa inexistente ficam NOT VALID (aviso)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('appointments', 'appointments_companyId_customerId_fkey'),
    ('appointments', 'appointments_companyId_followUpId_fkey'),
    ('appointments', 'appointments_companyId_motorcycleId_fkey'),
    ('categories', 'categories_companyId_parentId_fkey'),
    ('channel_api_credentials', 'channel_api_credentials_companyId_channelId_fkey'),
    ('channel_events', 'channel_events_companyId_channelId_fkey'),
    ('channel_inbound_events', 'channel_inbound_events_companyId_channelId_fkey'),
    ('channel_outbox', 'channel_outbox_companyId_channelId_fkey'),
    ('channel_product_links', 'channel_product_links_companyId_channelId_fkey'),
    ('channel_product_links', 'channel_product_links_companyId_productId_fkey'),
    ('collection_attempts', 'collection_attempts_companyId_receivableId_fkey'),
    ('damage_records', 'damage_records_companyId_productId_fkey'),
    ('device_sessions', 'device_sessions_companyId_userId_fkey'),
    ('employee_agreement_charges', 'employee_agreement_charges_companyId_agreementId_fkey'),
    ('employee_payroll_deductions', 'employee_payroll_deductions_companyId_chargeId_fkey'),
    ('external_order_items', 'external_order_items_companyId_orderId_fkey'),
    ('external_order_items', 'external_order_items_companyId_productId_fkey'),
    ('external_orders', 'external_orders_companyId_channelId_fkey'),
    ('external_orders', 'external_orders_companyId_saleId_fkey'),
    ('external_payments', 'external_payments_companyId_channelId_fkey'),
    ('external_payments', 'external_payments_companyId_orderId_fkey'),
    ('follow_ups', 'follow_ups_companyId_customerId_fkey'),
    ('follow_ups', 'follow_ups_companyId_motorcycleId_fkey'),
    ('follow_ups', 'follow_ups_companyId_revisionId_fkey'),
    ('fulfillments', 'fulfillments_companyId_orderId_fkey'),
    ('fulfillments', 'fulfillments_companyId_saleId_fkey'),
    ('invoices', 'invoices_companyId_purchaseOrderId_fkey'),
    ('invoices', 'invoices_companyId_supplierId_fkey'),
    ('mechanic_commissions', 'mechanic_commissions_companyId_serviceOrderId_fkey'),
    ('motorcycles', 'motorcycles_companyId_customerId_fkey'),
    ('payment_exceptions', 'payment_exceptions_companyId_paymentId_fkey'),
    ('payments', 'payments_companyId_saleId_fkey'),
    ('products', 'products_companyId_categoryId_fkey'),
    ('purchase_orders', 'purchase_orders_companyId_supplierId_fkey'),
    ('quote_events', 'quote_events_companyId_quoteId_fkey'),
    ('quotes', 'quotes_companyId_customerId_fkey'),
    ('quotes', 'quotes_companyId_motorcycleId_fkey'),
    ('revisions', 'revisions_companyId_customerId_fkey'),
    ('revisions', 'revisions_companyId_motorcycleId_fkey'),
    ('revisions', 'revisions_companyId_serviceOrderId_fkey'),
    ('sales', 'sales_companyId_channelId_fkey'),
    ('sales', 'sales_companyId_customerId_fkey'),
    ('sales', 'sales_companyId_userId_fkey'),
    ('service_order_warranties', 'service_order_warranties_companyId_serviceOrderId_fkey'),
    ('service_orders', 'service_orders_companyId_customerId_fkey'),
    ('service_orders', 'service_orders_companyId_motorcycleId_fkey'),
    ('stock_movements', 'stock_movements_companyId_productId_fkey'),
    ('stock_reservations', 'stock_reservations_companyId_channelId_fkey'),
    ('stock_reservations', 'stock_reservations_companyId_orderId_fkey'),
    ('stock_reservations', 'stock_reservations_companyId_productId_fkey'),
    ('supplier_return_events', 'supplier_return_events_companyId_returnId_fkey'),
    ('supplier_return_items', 'supplier_return_items_companyId_productId_fkey'),
    ('supplier_return_items', 'supplier_return_items_companyId_returnId_fkey'),
    ('supplier_returns', 'supplier_returns_companyId_supplierId_fkey'),
    ('support_ticket_attachments', 'support_ticket_attachments_companyId_messageId_fkey'),
    ('support_ticket_attachments', 'support_ticket_attachments_companyId_ticketId_fkey'),
    ('support_ticket_events', 'support_ticket_events_companyId_ticketId_fkey'),
    ('support_ticket_messages', 'support_ticket_messages_companyId_ticketId_fkey'),
    ('vehicle_entry_checklists', 'vehicle_entry_checklists_companyId_motorcycleId_fkey'),
    ('vehicle_entry_checklists', 'vehicle_entry_checklists_companyId_serviceOrderId_fkey'),
    ('warranty_claims', 'warranty_claims_companyId_warrantyId_fkey'),
    ('accounts_payable', 'accounts_payable_companyId_supplierId_fkey'),
    ('accounts_receivable', 'accounts_receivable_companyId_agreementCompanyId_fkey'),
    ('accounts_receivable', 'accounts_receivable_companyId_customerId_fkey'),
    ('accounts_receivable', 'accounts_receivable_companyId_employeeAgreementId_fkey'),
    ('cash_registers', 'cash_registers_companyId_userId_fkey'),
    ('collection_attempts', 'collection_attempts_companyId_agreementCompanyId_fkey'),
    ('discount_events', 'discount_events_companyId_quoteId_fkey'),
    ('discount_events', 'discount_events_companyId_saleId_fkey'),
    ('discount_events', 'discount_events_companyId_serviceOrderId_fkey'),
    ('employee_agreement_charges', 'employee_agreement_charges_companyId_paymentId_fkey'),
    ('employee_agreement_charges', 'employee_agreement_charges_companyId_saleId_fkey'),
    ('employee_agreements', 'employee_agreements_companyId_customerId_fkey'),
    ('employee_agreements', 'employee_agreements_companyId_userId_fkey'),
    ('fiscal_documents', 'fiscal_documents_companyId_saleId_fkey'),
    ('fiscal_documents', 'fiscal_documents_companyId_serviceOrderId_fkey'),
    ('import_batches', 'import_batches_companyId_userId_fkey'),
    ('payment_exceptions', 'payment_exceptions_companyId_saleId_fkey'),
    ('payments', 'payments_companyId_agreementCompanyId_fkey'),
    ('payments', 'payments_companyId_employeeAgreementId_fkey'),
    ('sales', 'sales_companyId_cashRegisterId_fkey'),
    ('service_order_warranties', 'service_order_warranties_companyId_customerId_fkey'),
    ('service_order_warranties', 'service_order_warranties_companyId_motorcycleId_fkey'),
    ('stock_movements', 'stock_movements_companyId_userId_fkey'),
    ('supplier_return_events', 'supplier_return_events_companyId_userId_fkey'),
    ('supplier_return_items', 'supplier_return_items_companyId_damageRecordId_fkey'),
    ('supplier_returns', 'supplier_returns_companyId_purchaseOrderId_fkey'),
    ('tef_payments', 'tef_payments_companyId_paymentId_fkey'),
    ('tef_payments', 'tef_payments_companyId_saleId_fkey'),
    ('tef_payments', 'tef_payments_companyId_serviceOrderId_fkey'),
    ('transfers', 'transfers_companyId_fromBranchId_fkey'),
    ('transfers', 'transfers_companyId_toBranchId_fkey'),
    ('warranty_claims', 'warranty_claims_companyId_newServiceOrderId_fkey'),
    ('warranty_claims', 'warranty_claims_companyId_serviceOrderId_fkey')
  ) AS t(tabela, restricao) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.tabela, r.restricao);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'FK % em % ficou NOT VALID: existem linhas órfãs de empresa inexistente (legado de limpeza de teste), tratadas à parte', r.restricao, r.tabela;
    END;
  END LOOP;
END $$;
