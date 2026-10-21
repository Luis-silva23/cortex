-- ESCOPO DE FILIAL NAS TABELAS QUE SÓ ISOLAVAM POR EMPRESA (2026-10-16, produção/segurança multi-tenant).
-- REGRA DE NEGÓCIO (definida): usuário com acesso EMPRESARIAL (COMPANY_ADMIN; SUPER_ADMIN na empresa-alvo) consulta todas as filiais da PRÓPRIA empresa e o
-- dashboard consolidado; o GERENTE de filial (MANAGER, e os demais papéis de filial) consulta EXCLUSIVAMENTE a filial a que está vinculado — nunca outra filial,
-- nem da mesma empresa, por API, exportação ou SQL direto — e não amplia o próprio acesso alterando ids/parâmetros.
-- PROBLEMA (provado antes por teste e por leitura do catálogo): 9 tabelas com `branchId` tinham policy só por empresa — `users` (gerente da filial A listava e-mail,
-- telefone, MFA e `numericId` de TODOS os usuários da empresa), `user_roles`, `partners` (convênio de outra filial visível e editável), `installment_policies`,
-- `devices` (qualquer papel listava os equipamentos de todas as filiais e o gerente encerrava a sessão de equipamento de outra filial), `monitoring_thresholds`,
-- `monitoring_threshold_changes`, `request_logs`, `system_logs`. Também: `transfers` (gerente via todas as transferências da empresa) e `audit_logs` (sem filial: o
-- gerente lia a auditoria de todas as filiais, inclusive `new_value`).
-- CORREÇÃO (RLS; a API é a 1ª camada e esta é a defesa em profundidade contra SQL direto/falha de filtro):
--   • LEITURA por filial = a regra F já usada nos documentos (`rls_company_branch_match`): empresa inteira vê tudo da empresa; papel de filial vê a própria filial + linhas
--     da empresa toda (`branchId` NULO = cadastro compartilhado, ex.: convênio válido para todas as filiais).
--   • ESCRITA por filial (nova `rls_company_branch_write`): papel de filial só grava linha da PRÓPRIA filial — não grava "da empresa toda" (NULL) nem de outra filial.
--   • users: papel de filial vê a própria filial, os usuários sem filial e os COMPANY_ADMIN (autorizadores da empresa); grava só na própria filial. user_roles: leitura herda
--     de users; escrita só para usuário da própria filial. audit_logs: papel de filial lê só a auditoria de usuários da própria filial. transfers: papel de filial vê/grava
--     as transferências em que a própria filial é origem ou destino. Monitoramento e logs: leitura só de SUPER_ADMIN/COMPANY_ADMIN (nenhuma rota de filial os usa);
--     UPDATE/DELETE de logs só do SUPER_ADMIN (retenção).
--   • installment_policies: escrita só empresarial (como a API já exigia).
-- NÃO ALTERA dados, módulos habilitados, permissões nem estrutura de tabelas; só funções e policies. Super Admin e contexto de plataforma não mudam.
-- ROLLBACK: recriar as policies anteriores (ver migrations 0_init, 20260926130000_users_policy_hide_platform_users, 20260925100000_audit_logs_append_only,
-- 20261014162000_rls_logs_roles_tighten e 20260926120000_monitoring_thresholds_alerts) e `DROP FUNCTION rls_company_branch_write(text,text)`.

-- 1. função de escrita por filial -------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rls_company_branch_write(row_company_id text, row_branch_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT rls_company_match(row_company_id)
    AND (
      is_super_admin()
      OR is_company_wide_role()
      OR (row_branch_id IS NOT NULL AND row_branch_id = get_current_branch_id())
    );
$$;

-- 2. users ---------------------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "users_isolation" ON "users";
CREATE POLICY "users_select" ON "users" FOR SELECT USING (
  is_super_admin()
  OR ("companyId" = get_current_company_id()
      AND (is_company_wide_role() OR "branchId" IS NULL OR "branchId" = get_current_branch_id() OR "userType" = 'COMPANY_ADMIN'))
);
CREATE POLICY "users_insert" ON "users" FOR INSERT WITH CHECK (is_super_admin() OR rls_company_branch_write("companyId", "branchId"));
CREATE POLICY "users_update" ON "users" FOR UPDATE
  USING (
    is_super_admin()
    OR ("companyId" = get_current_company_id()
        AND (is_company_wide_role() OR "branchId" IS NULL OR "branchId" = get_current_branch_id() OR "userType" = 'COMPANY_ADMIN'))
  )
  WITH CHECK (is_super_admin() OR rls_company_branch_write("companyId", "branchId"));
CREATE POLICY "users_delete" ON "users" FOR DELETE USING (is_super_admin() OR rls_company_branch_write("companyId", "branchId"));

-- 3. user_roles (leitura herda a visibilidade de users; escrita só para usuário da própria filial) ---------------------------------------------
DROP POLICY IF EXISTS "user_roles_isolation" ON "user_roles";
CREATE POLICY "user_roles_select" ON "user_roles" FOR SELECT USING ("userId" IN (SELECT id FROM users));
CREATE POLICY "user_roles_insert" ON "user_roles" FOR INSERT WITH CHECK (
  "userId" IN (SELECT u.id FROM users u WHERE is_super_admin() OR is_company_wide_role() OR u."branchId" = get_current_branch_id())
);
CREATE POLICY "user_roles_update" ON "user_roles" FOR UPDATE
  USING ("userId" IN (SELECT id FROM users))
  WITH CHECK ("userId" IN (SELECT u.id FROM users u WHERE is_super_admin() OR is_company_wide_role() OR u."branchId" = get_current_branch_id()));
CREATE POLICY "user_roles_delete" ON "user_roles" FOR DELETE USING (
  "userId" IN (SELECT u.id FROM users u WHERE is_super_admin() OR is_company_wide_role() OR u."branchId" = get_current_branch_id())
);

-- 4. partners (convênios) ------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "partners_isolation" ON "partners";
CREATE POLICY "partners_select" ON "partners" FOR SELECT USING (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "partners_insert" ON "partners" FOR INSERT WITH CHECK (rls_company_branch_write("companyId", "branchId"));
CREATE POLICY "partners_update" ON "partners" FOR UPDATE USING (rls_company_branch_match("companyId", "branchId")) WITH CHECK (rls_company_branch_write("companyId", "branchId"));
CREATE POLICY "partners_delete" ON "partners" FOR DELETE USING (rls_company_branch_write("companyId", "branchId"));

-- 5. installment_policies (leitura por filial; escrita só empresarial) ---------------------------------------------------------------------
DROP POLICY IF EXISTS "installment_policies_isolation" ON "installment_policies";
CREATE POLICY "installment_policies_select" ON "installment_policies" FOR SELECT USING (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "installment_policies_insert" ON "installment_policies" FOR INSERT WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "installment_policies_update" ON "installment_policies" FOR UPDATE
  USING (rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "installment_policies_delete" ON "installment_policies" FOR DELETE USING (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));

-- 6. devices (equipamento: empresa pela licença; filial pelo `branchId` definido na autorização) -------------------------------------------
DROP POLICY IF EXISTS "devices_isolation" ON "devices";
CREATE POLICY "devices_isolation" ON "devices"
  USING (
    is_super_admin()
    OR ("licenseId" IN (SELECT licenses.id FROM licenses WHERE licenses."companyId" = get_current_company_id())
        AND (is_company_wide_role() OR "branchId" IS NULL OR "branchId" = get_current_branch_id()))
  )
  WITH CHECK (
    is_super_admin()
    OR ("licenseId" IN (SELECT licenses.id FROM licenses WHERE licenses."companyId" = get_current_company_id())
        AND (is_company_wide_role() OR "branchId" IS NULL OR "branchId" = get_current_branch_id()))
  );

-- 7. monitoramento (nenhuma rota de filial usa; leitura só empresarial) --------------------------------------------------------------------
DROP POLICY IF EXISTS "monitoring_thresholds_read" ON "monitoring_thresholds";
CREATE POLICY "monitoring_thresholds_read" ON "monitoring_thresholds" FOR SELECT USING (
  is_super_admin() OR (is_company_wide_role() AND ("companyId" IS NULL OR "companyId" = get_current_company_id()))
);
DROP POLICY IF EXISTS "monitoring_threshold_changes_read" ON "monitoring_threshold_changes";
CREATE POLICY "monitoring_threshold_changes_read" ON "monitoring_threshold_changes" FOR SELECT USING (
  is_super_admin() OR (is_company_wide_role() AND ("companyId" IS NULL OR "companyId" = get_current_company_id()))
);

-- 8. request_logs e system_logs (leitura empresarial; gravação por filial; UPDATE/DELETE só Super Admin) ---------------------------------
DROP POLICY IF EXISTS "request_logs_isolation" ON "request_logs";
CREATE POLICY "request_logs_select" ON "request_logs" FOR SELECT USING (is_super_admin() OR (is_company_wide_role() AND "companyId" = get_current_company_id()));
CREATE POLICY "request_logs_insert" ON "request_logs" FOR INSERT WITH CHECK (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "request_logs_update" ON "request_logs" FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());
CREATE POLICY "request_logs_delete" ON "request_logs" FOR DELETE USING (is_super_admin());
DROP POLICY IF EXISTS "system_logs_isolation" ON "system_logs";
CREATE POLICY "system_logs_select" ON "system_logs" FOR SELECT USING (is_super_admin() OR (is_company_wide_role() AND "companyId" = get_current_company_id()));
CREATE POLICY "system_logs_insert" ON "system_logs" FOR INSERT WITH CHECK (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "system_logs_update" ON "system_logs" FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());
CREATE POLICY "system_logs_delete" ON "system_logs" FOR DELETE USING (is_super_admin());

-- 9. audit_logs (sem coluna de filial: papel de filial lê só a auditoria de usuários da própria filial) ----------------------------------
DROP POLICY IF EXISTS "audit_logs_select" ON "audit_logs";
CREATE POLICY "audit_logs_select" ON "audit_logs" FOR SELECT USING (
  is_super_admin()
  OR ("companyId" = get_current_company_id()
      AND (is_company_wide_role()
           OR "userId" IN (SELECT u.id FROM users u WHERE u."branchId" = get_current_branch_id())))
);

-- 10. transfers (papel de filial vê/grava só as transferências em que a própria filial é origem ou destino) ---------------------------------
DROP POLICY IF EXISTS "transfers_isolation" ON "transfers";
CREATE POLICY "transfers_isolation" ON "transfers"
  USING (
    rls_company_match("companyId")
    AND (is_super_admin() OR is_company_wide_role() OR "fromBranchId" = get_current_branch_id() OR "toBranchId" = get_current_branch_id())
  )
  WITH CHECK (
    rls_company_match("companyId")
    AND (is_super_admin() OR is_company_wide_role() OR "fromBranchId" = get_current_branch_id() OR "toBranchId" = get_current_branch_id())
  );
