#!/bin/sh
# CÓRTEX — separação de papéis do PostgreSQL na PRIMEIRA inicialização do volume (executado pelo entrypoint da imagem oficial).
# Por quê: na imagem oficial o POSTGRES_USER é SUPERUSUÁRIO. Uma API conectada como superusuário IGNORA a RLS (tudo que a migration 20261016* e
# anteriores protegem ficaria inerte). Aqui nascem três papéis sem poder de superusuário:
#   $DB_OWNER_USER  (lnsystem_owner)  dono das tabelas: roda `prisma migrate deploy` (DDL). NÃO é usado pela API em execução.
#   $DB_APP_USER    (lnsystem_app)    papel da API: só DML. NOSUPERUSER NOBYPASSRLS, sem posse, sem DDL, sem _prisma_migrations.
#   $DB_BACKUP_USER (lnsystem_backup) leitura com BYPASSRLS para o pg_dump (nunca usado pela API para servir requisições).
# O superusuário do contêiner (POSTGRES_USER) fica só para administração de emergência por DBA; nenhum serviço do compose o usa.
# Senhas: vêm de variáveis de ambiente OBRIGATÓRIAS do compose (DB_OWNER_PASSWORD, DB_APP_PASSWORD, DB_BACKUP_PASSWORD) — nada escrito aqui.
# Só funciona em volume NOVO (initdb.d é ignorado se o diretório de dados já existe). Para um banco existente aplique deploy/db-runtime-role.sql à mão.
set -eu

: "${DB_OWNER_USER:=lnsystem_owner}"
: "${DB_APP_USER:=lnsystem_app}"
: "${DB_BACKUP_USER:=lnsystem_backup}"
: "${DB_OWNER_PASSWORD:?defina DB_OWNER_PASSWORD}"
: "${DB_APP_PASSWORD:?defina DB_APP_PASSWORD}"
: "${DB_BACKUP_PASSWORD:?defina DB_BACKUP_PASSWORD}"

# senhas entram como variáveis do psql (:'var' faz o escape correto) — o heredoc é entre aspas, o shell não interpreta nada dentro dele
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner="$DB_OWNER_USER" -v app="$DB_APP_USER" -v bkp="$DB_BACKUP_USER" \
  -v owner_pw="$DB_OWNER_PASSWORD" -v app_pw="$DB_APP_PASSWORD" -v bkp_pw="$DB_BACKUP_PASSWORD" \
  -v dbname="$POSTGRES_DB" <<'EOSQL'
CREATE ROLE :"owner" LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE :"app"   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
CREATE ROLE :"bkp"   LOGIN PASSWORD :'bkp_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;

ALTER DATABASE :"dbname" OWNER TO :"owner";
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO :"owner", :"app", :"bkp";

-- o schema public passa a ser do dono; ninguém além dele cria objetos nele
ALTER SCHEMA public OWNER TO :"owner";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app", :"bkp";

-- Os GRANTs sobre as tabelas NÃO são feitos aqui (as tabelas ainda não existem): o serviço `db-grants` do compose roda
-- deploy/postgres-init/after-migrate.sql depois de CADA `migrate deploy`, de forma idempotente, e tira _prisma_migrations do papel da API.
EOSQL

echo "[10-roles] papéis criados: owner=$DB_OWNER_USER app=$DB_APP_USER backup=$DB_BACKUP_USER (senhas não registradas)"
