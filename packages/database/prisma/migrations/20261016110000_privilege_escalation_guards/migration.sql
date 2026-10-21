-- TRAVAS CONTRA ELEVAÇÃO DE PRIVILÉGIO POR SQL DIRETO (2026-10-16, continuação de 20261016100000_branch_scope_rls).
-- PROBLEMA (provado por teste com o papel real da aplicação): as rotas de administração já exigem COMPANY_ADMIN/SUPER_ADMIN, mas as policies de várias tabelas deixavam
-- QUALQUER papel da empresa — inclusive o gerente de filial — gravar nelas por SQL direto (falha de filtro, injeção, script): um gerente podia (a) mudar o próprio
-- `userType` para COMPANY_ADMIN ou o próprio `branchId`; (b) criar `user_roles` para si; (c) criar perfil/permissão e vincular permissões; (d) LIGAR um módulo
-- desativado gravando em `company_module_settings` para a própria filial; (e) criar/renomear/apagar filiais.
-- CORREÇÃO: escrita nessas tabelas passa a exigir papel empresarial (COMPANY_ADMIN) ou SUPER_ADMIN; a leitura NÃO muda. Mais um trigger em `users` que impede papel de
-- filial de alterar `userType`, `companyId`, `branchId` e `isActive` (as demais colunas — último acesso, tentativas, MFA do próprio usuário — seguem como antes).
-- NÃO ALTERA dados, módulos habilitados nem permissões concedidas. Super Admin e contexto de plataforma não mudam; fluxos de login/refresh/MFA rodam em contexto de plataforma.
-- ROLLBACK: DROP TRIGGER users_guard_privileged_columns ON users; DROP FUNCTION users_guard_privileged_columns(); recriar as policies anteriores (0_init,
-- 20261014162000_rls_logs_roles_tighten, 20261016100000_branch_scope_rls).

-- 1. users: papel de filial não muda userType/companyId/branchId/isActive -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION users_guard_privileged_columns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (is_super_admin() OR is_company_wide_role()) AND (
       NEW."userType" IS DISTINCT FROM OLD."userType"
    OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
    OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
    OR NEW."isActive" IS DISTINCT FROM OLD."isActive"
  ) THEN
    RAISE EXCEPTION 'papel de filial não altera tipo, empresa, filial nem situação de usuário' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "users_guard_privileged_columns" BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION users_guard_privileged_columns();

-- 2. user_roles: só empresarial grava ---------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "user_roles_insert" ON "user_roles";
DROP POLICY IF EXISTS "user_roles_update" ON "user_roles";
DROP POLICY IF EXISTS "user_roles_delete" ON "user_roles";
CREATE POLICY "user_roles_insert" ON "user_roles" FOR INSERT WITH CHECK ((is_super_admin() OR is_company_wide_role()) AND "userId" IN (SELECT id FROM users));
CREATE POLICY "user_roles_update" ON "user_roles" FOR UPDATE
  USING ((is_super_admin() OR is_company_wide_role()) AND "userId" IN (SELECT id FROM users))
  WITH CHECK ((is_super_admin() OR is_company_wide_role()) AND "userId" IN (SELECT id FROM users));
CREATE POLICY "user_roles_delete" ON "user_roles" FOR DELETE USING ((is_super_admin() OR is_company_wide_role()) AND "userId" IN (SELECT id FROM users));

-- 3. roles, permissions, role_permissions: só empresarial grava --------------------------------------------------------------------------
DROP POLICY IF EXISTS "roles_insert" ON "roles";
DROP POLICY IF EXISTS "roles_update" ON "roles";
DROP POLICY IF EXISTS "roles_delete" ON "roles";
CREATE POLICY "roles_insert" ON "roles" FOR INSERT WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "roles_update" ON "roles" FOR UPDATE USING (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()))
  WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "roles_delete" ON "roles" FOR DELETE USING (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));

DROP POLICY IF EXISTS "permissions_insert" ON "permissions";
DROP POLICY IF EXISTS "permissions_update" ON "permissions";
DROP POLICY IF EXISTS "permissions_delete" ON "permissions";
CREATE POLICY "permissions_insert" ON "permissions" FOR INSERT WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "permissions_update" ON "permissions" FOR UPDATE USING (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()))
  WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "permissions_delete" ON "permissions" FOR DELETE USING (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));

DROP POLICY IF EXISTS "role_permissions_isolation" ON "role_permissions";
CREATE POLICY "role_permissions_select" ON "role_permissions" FOR SELECT USING ("roleId" IN (SELECT id FROM roles));
CREATE POLICY "role_permissions_insert" ON "role_permissions" FOR INSERT WITH CHECK ((is_super_admin() OR is_company_wide_role()) AND "roleId" IN (SELECT id FROM roles));
CREATE POLICY "role_permissions_update" ON "role_permissions" FOR UPDATE
  USING ((is_super_admin() OR is_company_wide_role()) AND "roleId" IN (SELECT id FROM roles))
  WITH CHECK ((is_super_admin() OR is_company_wide_role()) AND "roleId" IN (SELECT id FROM roles));
CREATE POLICY "role_permissions_delete" ON "role_permissions" FOR DELETE USING ((is_super_admin() OR is_company_wide_role()) AND "roleId" IN (SELECT id FROM roles));

-- 4. company_module_settings: ligar/desligar módulo é administração (leitura por filial inalterada) -------------------------------------
DROP POLICY IF EXISTS "company_module_settings_isolation" ON "company_module_settings";
CREATE POLICY "company_module_settings_select" ON "company_module_settings" FOR SELECT USING (rls_company_branch_match("companyId", "branchId"));
CREATE POLICY "company_module_settings_insert" ON "company_module_settings" FOR INSERT
  WITH CHECK (rls_company_branch_match("companyId", "branchId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "company_module_settings_update" ON "company_module_settings" FOR UPDATE
  USING (rls_company_branch_match("companyId", "branchId") AND (is_super_admin() OR is_company_wide_role()))
  WITH CHECK (rls_company_branch_match("companyId", "branchId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "company_module_settings_delete" ON "company_module_settings" FOR DELETE
  USING (rls_company_branch_match("companyId", "branchId") AND (is_super_admin() OR is_company_wide_role()));

-- 5. branches: criar/alterar/apagar filial é administração (leitura: a própria filial para papel de filial, como antes) -----------------
DROP POLICY IF EXISTS "branches_isolation" ON "branches";
CREATE POLICY "branches_select" ON "branches" FOR SELECT USING (rls_company_branch_match("companyId", id));
CREATE POLICY "branches_insert" ON "branches" FOR INSERT WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "branches_update" ON "branches" FOR UPDATE USING (rls_company_branch_match("companyId", id) AND (is_super_admin() OR is_company_wide_role()))
  WITH CHECK (rls_company_match("companyId") AND (is_super_admin() OR is_company_wide_role()));
CREATE POLICY "branches_delete" ON "branches" FOR DELETE USING (rls_company_branch_match("companyId", id) AND (is_super_admin() OR is_company_wide_role()));
