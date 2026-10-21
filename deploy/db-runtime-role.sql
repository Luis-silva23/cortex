-- PAPEL DE EXECUÇÃO DA APLICAÇÃO (modelo — executar UMA vez por banco, como superusuário/DBA, ANTES de apontar a API para ele).
-- Separação de papéis: o DONO das tabelas (o papel que roda `prisma migrate deploy`) NÃO é o que a API usa em produção.
--   dono     → migrations (DDL). Fica fora do alcance da aplicação em execução.
--   execução → só DML. Não pode desligar RLS, apagar policy/tabela, TRUNCATE nem criar objeto (provado por `npm run db:role-split-check`).
-- Substitua <banco>, <papel>, <dono> e <senha-forte> (a senha vai para o cofre de segredos do ambiente, NUNCA para o repositório).
--   DATABASE_URL (API em execução)        → postgresql://<papel>:<senha-forte>@<host>:5432/<banco>
--   DATABASE_URL (só no passo de migrate) → URL do dono:  DATABASE_URL=<url-do-dono> npx prisma migrate deploy
-- Depois de CADA migration que cria tabela/sequência/função, repetir os GRANTs abaixo (ou usar ALTER DEFAULT PRIVILEGES, última seção).

CREATE ROLE "<papel>" LOGIN PASSWORD '<senha-forte>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

REVOKE ALL ON DATABASE "<banco>" FROM PUBLIC;
GRANT CONNECT ON DATABASE "<banco>" TO "<papel>";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO "<papel>";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "<papel>";
REVOKE ALL ON TABLE public."_prisma_migrations" FROM "<papel>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "<papel>";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "<papel>";

-- objetos que o DONO criar daqui em diante já nascem com os privilégios (execute como o DONO, no banco da aplicação):
--   ALTER DEFAULT PRIVILEGES FOR ROLE "<dono>" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<papel>";
--   ALTER DEFAULT PRIVILEGES FOR ROLE "<dono>" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "<papel>";
--   ALTER DEFAULT PRIVILEGES FOR ROLE "<dono>" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "<papel>";
-- (`_prisma_migrations` continua sem privilégio: refaça o REVOKE acima se ela for recriada.)

-- Papel de BACKUP/leitura (já existe no ambiente de dev como `lnsystem_backup`): LOGIN, BYPASSRLS, SOMENTE SELECT — nunca o de execução.
