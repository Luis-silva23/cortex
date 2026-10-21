-- PRIVILÉGIOS DA APLICAÇÃO E DO BACKUP DEPOIS DAS MIGRATIONS (idempotente; rodar como o DONO das tabelas após CADA `prisma migrate deploy`).
--   psql -v ON_ERROR_STOP=1 -v app=lnsystem_app -v bkp=lnsystem_backup -f after-migrate.sql <url do dono>
-- Papel da API: só DML (nada de DDL, TRUNCATE nem posse). _prisma_migrations fica ILEGÍVEL para ele (uma falha na aplicação não reescreve o histórico).
-- Papel de backup: SELECT em tudo (BYPASSRLS vem do próprio papel), inclusive _prisma_migrations (o manifesto do backup conta as migrações aplicadas).
-- Mesmo modelo de deploy/db-runtime-role.sql, que continua válido para bancos que já existem.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app";
REVOKE ALL ON TABLE public."_prisma_migrations" FROM :"app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app";

GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"bkp";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"bkp";

-- CONTEXTO DE RLS ASSINADO (decisão 151). O papel de execução NÃO recebe nada em app_ctx além do que a migração já deu a todos (USAGE no schema e EXECUTE nas funções
-- de leitura do contexto): nada no cofre `app_ctx_vault`, nenhuma tabela de `app_ctx`, nenhuma função administrativa (provision/retire_previous/rewrite_policies).
-- O papel de backup lê a configuração (o cofre do segredo fica FORA do dump: `pg_dump --exclude-schema=app_ctx_vault`).
GRANT SELECT ON TABLE app_ctx.settings TO :"bkp";
-- liga a exigência de assinatura com o segredo do ambiente (idempotente: o mesmo segredo não gira os slots). `ctx_secret_b64` vem do ambiente do serviço
-- `db-grants` (RLS_CONTEXT_SECRET, do cofre de segredos) — NUNCA fica escrito aqui. Sem ele o comando falha e a API não sobe (de propósito).
SELECT app_ctx.provision(decode(:'ctx_secret_b64', 'base64'));
