-- discount_events e collection_attempts são evidência append-only (sem UPDATE, sem DELETE para usuário). Mesma regra de
-- expurgo de audit_logs: DELETE só em contexto de Super Admin com a flag `app.audit_purge = on` (rotina de retenção ou
-- limpeza de empresa sintética nos testes). Nenhum usuário da aplicação apaga essas linhas.
-- ROLLBACK: DROP POLICY discount_events_purge / collection_attempts_purge.
CREATE POLICY discount_events_purge ON public.discount_events FOR DELETE
  USING (public.is_super_admin() AND current_setting('app.audit_purge', true) = 'on');
CREATE POLICY collection_attempts_purge ON public.collection_attempts FOR DELETE
  USING (public.is_super_admin() AND current_setting('app.audit_purge', true) = 'on');
