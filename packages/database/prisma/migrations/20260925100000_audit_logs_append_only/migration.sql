-- audit_logs append-only (defesa em profundidade).
--
-- Antes: uma única policy (audit_logs_isolation) valia para TODOS os comandos — qualquer sessão da aplicação no
-- contexto da empresa podia UPDATE/DELETE a própria trilha de auditoria. Nenhuma rota faz isso hoje, mas o banco não
-- impedia. Agora:
--   SELECT  — igual a antes (Super Admin ou a própria empresa);
--   INSERT  — igual a antes;
--   UPDATE  — sem policy: sempre negado (FORCE RLS vale também para o dono da tabela);
--   DELETE  — só expurgo explícito: Super Admin COM `app.audit_purge = 'on'` na mesma transação (rotina de retenção).
-- A exclusão em cascata de uma empresa (FK ON DELETE CASCADE) não passa por RLS e continua funcionando.
--
-- Rollback: DROP das três policies abaixo e recriar audit_logs_isolation como em 0_init/migration.sql.

DROP POLICY IF EXISTS audit_logs_isolation ON public.audit_logs;

CREATE POLICY audit_logs_select ON public.audit_logs
  FOR SELECT
  USING (public.is_super_admin() OR ("companyId" = public.get_current_company_id()));

CREATE POLICY audit_logs_insert ON public.audit_logs
  FOR INSERT
  WITH CHECK (public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL));

CREATE POLICY audit_logs_purge ON public.audit_logs
  FOR DELETE
  USING (public.is_super_admin() AND current_setting('app.audit_purge', true) = 'on');
