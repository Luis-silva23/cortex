-- Isolamento POR FILIAL para os registros financeiros que nascem de documentos de filial.
--
-- ACHADO (bateria multi-empresa/multi-filial, 20 casos falhando): quatro tabelas só
-- tinham RLS por EMPRESA, então o operador/gerente da filial A1 lia pagamentos,
-- comissões e contas a pagar/receber da filial A2 — inclusive de vendas e OS que a
-- própria RLS já escondia dele:
--
--   payments             -> Payment.saleId é obrigatório (onDelete Cascade): o pagamento
--                           pertence à venda, que é isolada por filial (NSU, autorização,
--                           final do cartão eram legíveis por outra filial);
--   mechanic_commissions -> serviceOrderId obrigatório: a comissão pertence à OS, isolada
--                           por filial;
--   accounts_payable / accounts_receivable -> têm `branchId` (com índice) e nascem de
--                           compras/OS/vendas de uma filial, mas a policy ignorava a coluna.
--
-- Regra aplicada = a MESMA que já vale nas tabelas-irmãs (rls_company_branch_match):
-- SUPER_ADMIN e COMPANY_ADMIN enxergam todas as filiais da empresa; os demais papéis
-- enxergam a própria filial e os registros SEM filial (branchId NULL = da empresa toda).
-- Pagamento e comissão herdam a visibilidade do documento de origem (mesmo padrão de
-- sale_items -> sales e service_order_items -> service_orders).
--
-- Não alterado de propósito (decisão de produto pendente, docs/tech-debt.md): customers,
-- motorcycles, suppliers, categories, partners, installment_policies, discount_rules,
-- commission_rules, transfers, invoices, tef_payments — cadastros/configurações da empresa.
--
-- ROLLBACK (restaura as policies anteriores, só por empresa):
--   ALTER POLICY payments_isolation ON public.payments
--     USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));
--   ALTER POLICY mechanic_commissions_isolation ON public.mechanic_commissions
--     USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));
--   ALTER POLICY accounts_payable_isolation ON public.accounts_payable
--     USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));
--   ALTER POLICY accounts_receivable_isolation ON public.accounts_receivable
--     USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

ALTER POLICY payments_isolation ON public.payments
  USING (public.rls_company_match("companyId") AND "saleId" IN (SELECT id FROM public.sales))
  WITH CHECK (public.rls_company_match("companyId") AND "saleId" IN (SELECT id FROM public.sales));

ALTER POLICY mechanic_commissions_isolation ON public.mechanic_commissions
  USING (public.rls_company_match("companyId") AND "serviceOrderId" IN (SELECT id FROM public.service_orders))
  WITH CHECK (public.rls_company_match("companyId") AND "serviceOrderId" IN (SELECT id FROM public.service_orders));

ALTER POLICY accounts_payable_isolation ON public.accounts_payable
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

ALTER POLICY accounts_receivable_isolation ON public.accounts_receivable
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
