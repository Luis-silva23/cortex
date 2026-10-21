-- ÍNDICES FALTANTES (2026-10-15, revisão do banco — achado F-03).
-- (a) 9 tabelas tinham "companyId" (coluna filtrada por TODA policy de RLS) sem nenhum índice que começasse por ela; (b) 7 colunas de FK
-- (estoque→usuário, pagamento→convênio, recebível→convênio, exceção→venda, reserva→produto, venda→canal) sem índice: excluir/atualizar o pai
-- (RESTRICT) e listar por pai viravam varredura da tabela. Só índices comuns (sem mudar dado); IF NOT EXISTS torna a migração repetível.
-- ROLLBACK: DROP INDEX <nome> (todos terminam em _idx).
CREATE INDEX IF NOT EXISTS "stock_reservations_productId_idx" ON "stock_reservations"("productId");
CREATE INDEX IF NOT EXISTS "external_order_items_companyId_idx" ON "external_order_items"("companyId");
CREATE INDEX IF NOT EXISTS "support_ticket_events_companyId_idx" ON "support_ticket_events"("companyId");
CREATE INDEX IF NOT EXISTS "support_ticket_attachments_companyId_idx" ON "support_ticket_attachments"("companyId");
CREATE INDEX IF NOT EXISTS "supplier_return_events_companyId_idx" ON "supplier_return_events"("companyId");
CREATE INDEX IF NOT EXISTS "supplier_return_items_companyId_idx" ON "supplier_return_items"("companyId");
CREATE INDEX IF NOT EXISTS "employee_payroll_deductions_companyId_idx" ON "employee_payroll_deductions"("companyId");
CREATE INDEX IF NOT EXISTS "warranty_claims_companyId_idx" ON "warranty_claims"("companyId");
CREATE INDEX IF NOT EXISTS "quote_events_companyId_idx" ON "quote_events"("companyId");
CREATE INDEX IF NOT EXISTS "stock_movements_userId_idx" ON "stock_movements"("userId");
CREATE INDEX IF NOT EXISTS "sales_channelId_idx" ON "sales"("channelId");
CREATE INDEX IF NOT EXISTS "payment_exceptions_saleId_idx" ON "payment_exceptions"("saleId");
CREATE INDEX IF NOT EXISTS "payments_employeeAgreementId_idx" ON "payments"("employeeAgreementId");
CREATE INDEX IF NOT EXISTS "payments_agreementCompanyId_idx" ON "payments"("agreementCompanyId");
CREATE INDEX IF NOT EXISTS "monitoring_thresholds_companyId_idx" ON "monitoring_thresholds"("companyId");
CREATE INDEX IF NOT EXISTS "accounts_receivable_employeeAgreementId_idx" ON "accounts_receivable"("employeeAgreementId");
