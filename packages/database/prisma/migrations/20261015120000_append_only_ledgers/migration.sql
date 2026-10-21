-- LIVROS APPEND-ONLY por comando (2026-10-15, revisão do banco — achado E-03).
-- PROBLEMA: stock_movements (livro de estoque), cash_movements (livro de caixa), policy_changes (trilha de mudança de política) e
-- service_order_status_history (histórico de status da OS) tinham UMA policy "ALL" por empresa/filial: qualquer sessão da empresa podia
-- UPDATE/DELETE linhas já gravadas — adulterar histórico de estoque, dinheiro e política sem rastro.
-- VARREDURA: nenhum código de apps/api/src ou scripts faz UPDATE/DELETE nessas tabelas (só INSERT e leitura); o estoque e o caixa se corrigem com
-- NOVO movimento (ajuste/estorno), nunca editando o antigo.
-- CORREÇÃO: policy por comando, igual ao padrão já adotado em audit_logs/discount_events/collection_attempts:
--   SELECT e INSERT mantêm o MESMO critério de antes (empresa/filial); NÃO há policy de UPDATE (sem policy = negado, também para o dono sob FORCE RLS);
--   DELETE só com `is_super_admin()` + `app.audit_purge = 'on'` na mesma transação (expurgo sinalizado: teste sintético, retenção legal, LGPD).
-- ROLLBACK: DROP das 3 policies novas de cada tabela e CREATE POLICY <t>_isolation FOR ALL (critério antigo no corpo abaixo, repetido em cada USING).

-- stock_movements --------------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "stock_movements_isolation" ON "stock_movements";
CREATE POLICY "stock_movements_select" ON "stock_movements" FOR SELECT USING (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "stock_movements_insert" ON "stock_movements" FOR INSERT WITH CHECK (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "stock_movements_purge" ON "stock_movements" FOR DELETE USING (is_super_admin() AND current_setting('app.audit_purge', true) = 'on');

-- policy_changes ---------------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "policy_changes_isolation" ON "policy_changes";
CREATE POLICY "policy_changes_select" ON "policy_changes" FOR SELECT USING (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "policy_changes_insert" ON "policy_changes" FOR INSERT WITH CHECK (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "policy_changes_purge" ON "policy_changes" FOR DELETE USING (is_super_admin() AND current_setting('app.audit_purge', true) = 'on');

-- cash_movements (sem companyId: o escopo vem do caixa) ------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "cash_movements_isolation" ON "cash_movements";
CREATE POLICY "cash_movements_select" ON "cash_movements" FOR SELECT USING ("cashRegisterId" IN (SELECT id FROM cash_registers));
CREATE POLICY "cash_movements_insert" ON "cash_movements" FOR INSERT WITH CHECK ("cashRegisterId" IN (SELECT id FROM cash_registers));
CREATE POLICY "cash_movements_purge" ON "cash_movements" FOR DELETE USING (is_super_admin() AND current_setting('app.audit_purge', true) = 'on');

-- service_order_status_history (sem companyId: o escopo vem da OS) --------------------------------------------------------------------------
DROP POLICY IF EXISTS "service_order_status_history_isolation" ON "service_order_status_history";
CREATE POLICY "service_order_status_history_select" ON "service_order_status_history" FOR SELECT USING ("serviceOrderId" IN (SELECT id FROM service_orders));
CREATE POLICY "service_order_status_history_insert" ON "service_order_status_history" FOR INSERT WITH CHECK ("serviceOrderId" IN (SELECT id FROM service_orders));
CREATE POLICY "service_order_status_history_purge" ON "service_order_status_history" FOR DELETE USING (is_super_admin() AND current_setting('app.audit_purge', true) = 'on');
