-- ON DELETE CASCADE → RESTRICT em histórico, dinheiro, estoque, serviço e auditoria (2026-10-15, revisão do banco — achado D-05).
-- PROBLEMA: apagar uma venda levava junto os pagamentos; apagar um produto, o livro de estoque; apagar um caixa, os movimentos; apagar uma OS, itens e
-- histórico de status; apagar um orçamento, versões/itens/eventos; apagar uma empresa, auditoria, licenças e pedidos LGPD — silenciosamente e sem rastro.
-- VARREDURA DO CÓDIGO (apps/api/src): a aplicação NUNCA exclui venda, pagamento, caixa, inventário, ordem de compra, orçamento, OS, transferência,
-- produto, agendamento, retorno, checklist (só marca status/inativa), então nenhum fluxo depende da cascata; nada muda para o usuário.
-- MANTIDO CASCADE de propósito: sessões/dispositivos (refresh_tokens, device_sessions, devices, activations), papéis/permissões (user_roles,
-- role_permissions, roles, permissions — role.service exclui), composição de combo (combo_items), imagens/códigos de barras do produto, políticas de
-- parcelamento, parceiros — dados derivados ou de configuração, sem histórico a preservar.
-- EXCLUSÃO LEGÍTIMA: retenção de auditoria (scheduler) e expurgo de teste usam DELETE direto nas tabelas, não a cascata; excluir empresa/filial/venda
-- com histórico agora exige remover o histórico por procedimento explícito de plataforma (e é recusado pelo banco: P2003).
-- CRIAÇÃO: DROP + ADD CONSTRAINT (mesmo nome, mesma coluna, ação RESTRICT) NOT VALID na mesma transação e VALIDATE em contexto de plataforma (a FK já
-- era válida; a validação confirma). ROLLBACK: repetir o par DROP/ADD com ON DELETE CASCADE.
-- CONSTRAINTS: audit_logs.audit_logs_companyId_fkey, branches.branches_companyId_fkey, users.users_companyId_fkey, licenses.licenses_companyId_fkey, privacy_requests.privacy_requests_companyId_fkey, cash_movements.cash_movements_cashRegisterId_fkey, payments.payments_companyId_saleId_fkey, sale_items.sale_items_saleId_fkey, stock_movements.stock_movements_companyId_productId_fkey, purchase_order_items.purchase_order_items_purchaseOrderId_fkey, quote_events.quote_events_companyId_quoteId_fkey, quote_items.quote_items_quoteVersionId_fkey, quote_versions.quote_versions_quoteId_fkey, service_order_items.service_order_items_serviceOrderId_fkey, service_order_status_history.service_order_status_history_serviceOrderId_fkey, transfer_items.transfer_items_transferId_fkey, vehicle_entry_checklist_items.vehicle_entry_checklist_items_checklistId_fkey, vehicle_entry_checklists.vehicle_entry_checklists_companyId_serviceOrderId_fkey, appointment_events.appointment_events_appointmentId_fkey, follow_up_events.follow_up_events_followUpId_fkey, inventory_counts.inventory_counts_inventoryId_fkey

SELECT set_config('app.user_type', 'SUPER_ADMIN', true);

ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_companyId_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "branches" DROP CONSTRAINT "branches_companyId_fkey";
ALTER TABLE "branches" ADD CONSTRAINT "branches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "users" DROP CONSTRAINT "users_companyId_fkey";
ALTER TABLE "users" ADD CONSTRAINT "users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "licenses" DROP CONSTRAINT "licenses_companyId_fkey";
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "privacy_requests" DROP CONSTRAINT "privacy_requests_companyId_fkey";
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_cashRegisterId_fkey";
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES cash_registers(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "payments" DROP CONSTRAINT "payments_companyId_saleId_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_saleId_fkey" FOREIGN KEY ("companyId", "saleId") REFERENCES sales("companyId", id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "sale_items" DROP CONSTRAINT "sale_items_saleId_fkey";
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES sales(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_companyId_productId_fkey";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_productId_fkey" FOREIGN KEY ("companyId", "productId") REFERENCES products("companyId", id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_purchaseOrderId_fkey";
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "quote_events" DROP CONSTRAINT "quote_events_companyId_quoteId_fkey";
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_companyId_quoteId_fkey" FOREIGN KEY ("companyId", "quoteId") REFERENCES quotes("companyId", id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "quote_items" DROP CONSTRAINT "quote_items_quoteVersionId_fkey";
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quoteVersionId_fkey" FOREIGN KEY ("quoteVersionId") REFERENCES quote_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "quote_versions" DROP CONSTRAINT "quote_versions_quoteId_fkey";
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "service_order_items" DROP CONSTRAINT "service_order_items_serviceOrderId_fkey";
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES service_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "service_order_status_history" DROP CONSTRAINT "service_order_status_history_serviceOrderId_fkey";
ALTER TABLE "service_order_status_history" ADD CONSTRAINT "service_order_status_history_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES service_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "transfer_items" DROP CONSTRAINT "transfer_items_transferId_fkey";
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES transfers(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "vehicle_entry_checklist_items" DROP CONSTRAINT "vehicle_entry_checklist_items_checklistId_fkey";
ALTER TABLE "vehicle_entry_checklist_items" ADD CONSTRAINT "vehicle_entry_checklist_items_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES vehicle_entry_checklists(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "vehicle_entry_checklists" DROP CONSTRAINT "vehicle_entry_checklists_companyId_serviceOrderId_fkey";
ALTER TABLE "vehicle_entry_checklists" ADD CONSTRAINT "vehicle_entry_checklists_companyId_serviceOrderId_fkey" FOREIGN KEY ("companyId", "serviceOrderId") REFERENCES service_orders("companyId", id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "appointment_events" DROP CONSTRAINT "appointment_events_appointmentId_fkey";
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES appointments(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "follow_up_events" DROP CONSTRAINT "follow_up_events_followUpId_fkey";
ALTER TABLE "follow_up_events" ADD CONSTRAINT "follow_up_events_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES follow_ups(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE "inventory_counts" DROP CONSTRAINT "inventory_counts_inventoryId_fkey";
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES inventories(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('audit_logs', 'audit_logs_companyId_fkey'),
    ('branches', 'branches_companyId_fkey'),
    ('users', 'users_companyId_fkey'),
    ('licenses', 'licenses_companyId_fkey'),
    ('privacy_requests', 'privacy_requests_companyId_fkey'),
    ('cash_movements', 'cash_movements_cashRegisterId_fkey'),
    ('payments', 'payments_companyId_saleId_fkey'),
    ('sale_items', 'sale_items_saleId_fkey'),
    ('stock_movements', 'stock_movements_companyId_productId_fkey'),
    ('purchase_order_items', 'purchase_order_items_purchaseOrderId_fkey'),
    ('quote_events', 'quote_events_companyId_quoteId_fkey'),
    ('quote_items', 'quote_items_quoteVersionId_fkey'),
    ('quote_versions', 'quote_versions_quoteId_fkey'),
    ('service_order_items', 'service_order_items_serviceOrderId_fkey'),
    ('service_order_status_history', 'service_order_status_history_serviceOrderId_fkey'),
    ('transfer_items', 'transfer_items_transferId_fkey'),
    ('vehicle_entry_checklist_items', 'vehicle_entry_checklist_items_checklistId_fkey'),
    ('vehicle_entry_checklists', 'vehicle_entry_checklists_companyId_serviceOrderId_fkey'),
    ('appointment_events', 'appointment_events_appointmentId_fkey'),
    ('follow_up_events', 'follow_up_events_followUpId_fkey'),
    ('inventory_counts', 'inventory_counts_inventoryId_fkey')
  ) AS t(tabela, restricao) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.tabela, r.restricao);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'FK % em % ficou NOT VALID: existem linhas órfãs de empresa inexistente (legado de limpeza de teste)', r.restricao, r.tabela;
    END;
  END LOOP;
END $$;
