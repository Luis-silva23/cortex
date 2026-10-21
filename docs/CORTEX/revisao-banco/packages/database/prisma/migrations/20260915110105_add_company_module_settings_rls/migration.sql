-- RLS para company_module_settings — mesmo padrão do resto do schema
-- (ver 20260914154543_add_revisions_postsale_agenda_rls para o precedente
-- direto desta sessão). rls_company_branch_match já trata branchId NULL na
-- LINHA como "aplica pra empresa inteira, visível a todo mundo da empresa"
-- — exatamente a semântica de negócio que este gate precisa (uma
-- configuração company-wide deve ser enxergada por usuários de qualquer
-- filial ao decidir se um módulo está ligado).

ALTER TABLE public.company_module_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_module_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY company_module_settings_isolation ON public.company_module_settings
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
