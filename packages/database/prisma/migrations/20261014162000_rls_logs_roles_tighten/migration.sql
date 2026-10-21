-- RLS de logs e de perfis/permissões globais (2026-10-14, revisão do banco). Nenhuma linha é lida, alterada ou apagada: só troca de políticas.
-- PROBLEMAS (provados por teste de integração em sessão de EMPRESA, que falhava antes desta migration):
--  1. request_logs e system_logs: "WITH CHECK (true)" deixava a empresa A gravar log em nome da empresa B (ou sem empresa), e
--     "USING (… OR companyId IS NULL)" deixava toda empresa LER os logs de plataforma (companyId nulo) — eventos de segurança de outros
--     usuários, p.ex. REFRESH_TOKEN_REUSE_DETECTED (no dev: 371 system_logs e 3540 request_logs de plataforma visíveis a uma empresa).
--  2. roles e permissions: uma política ALL com "USING (… OR companyId IS NULL)" fazia o DELETE e o UPDATE de uma sessão de empresa
--     alcançarem os perfis e permissões GLOBAIS (de sistema); o WITH CHECK só protegia a gravação nova.
-- CORREÇÃO: logs passam a usar rls_company_match("companyId") (Super Admin OU a própria empresa) em leitura e escrita — quem grava log é o
-- worker, em contexto de plataforma (jobs/observability.job.ts), e a empresa só lê os seus. Roles/permissions: LEITURA continua incluindo
-- os globais (a empresa precisa listá-los e atribuí-los); INSERT/UPDATE/DELETE só da própria empresa ou do Super Admin.
-- ROLLBACK (recria as políticas anteriores):
--   DROP POLICY "request_logs_isolation" ON "request_logs";
--   CREATE POLICY "request_logs_isolation" ON "request_logs" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (true);
--   DROP POLICY "system_logs_isolation" ON "system_logs";
--   CREATE POLICY "system_logs_isolation" ON "system_logs" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (true);
--   DROP POLICY "roles_select" ON "roles"; DROP POLICY "roles_insert" ON "roles"; DROP POLICY "roles_update" ON "roles"; DROP POLICY "roles_delete" ON "roles";
--   CREATE POLICY "roles_isolation" ON "roles" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (is_super_admin() OR ("companyId" = get_current_company_id()));
--   (idem permissions_select/insert/update/delete → permissions_isolation)

-- 1. logs
DROP POLICY "request_logs_isolation" ON "request_logs";
CREATE POLICY "request_logs_isolation" ON "request_logs" USING (rls_company_match("companyId")) WITH CHECK (rls_company_match("companyId"));
DROP POLICY "system_logs_isolation" ON "system_logs";
CREATE POLICY "system_logs_isolation" ON "system_logs" USING (rls_company_match("companyId")) WITH CHECK (rls_company_match("companyId"));

-- 2. perfis e permissões: global legível por todos, escrita só da própria empresa ou do Super Admin
DROP POLICY "roles_isolation" ON "roles";
CREATE POLICY "roles_select" ON "roles" FOR SELECT USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL));
CREATE POLICY "roles_insert" ON "roles" FOR INSERT WITH CHECK (rls_company_match("companyId"));
CREATE POLICY "roles_update" ON "roles" FOR UPDATE USING (rls_company_match("companyId")) WITH CHECK (rls_company_match("companyId"));
CREATE POLICY "roles_delete" ON "roles" FOR DELETE USING (rls_company_match("companyId"));

DROP POLICY "permissions_isolation" ON "permissions";
CREATE POLICY "permissions_select" ON "permissions" FOR SELECT USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL));
CREATE POLICY "permissions_insert" ON "permissions" FOR INSERT WITH CHECK (rls_company_match("companyId"));
CREATE POLICY "permissions_update" ON "permissions" FOR UPDATE USING (rls_company_match("companyId")) WITH CHECK (rls_company_match("companyId"));
CREATE POLICY "permissions_delete" ON "permissions" FOR DELETE USING (rls_company_match("companyId"));
