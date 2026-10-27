#!/usr/bin/env node
/**
 * ENSAIO de PostgreSQL GERENCIADO (Neon, Supabase e similares) — roda LOCAL, em banco TEMPORÁRIO, sem tocar em nada existente.
 *
 * Por quê: em serviço gerenciado o administrador NÃO é superusuário (no Neon: membro de `neon_superuser`, com CREATEROLE/CREATEDB e BYPASSRLS em projetos recentes). O CÓRTEX só é
 * seguro se (1) os três papéis (dono / aplicação / backup) puderem ser criados SEM superusuário, (2) as migrações rodarem como o dono, (3) o papel da aplicação NÃO tiver posse nem
 * BYPASSRLS e (4) o contexto assinado de RLS puder ser provisionado. O `db-role-split-check` prova a separação, mas EXIGE superusuário; este script prova a mesma coisa com um
 * administrador que imita o gerenciado (LOGIN CREATEROLE CREATEDB BYPASSRLS NOSUPERUSER).
 *
 * Uso:   CORTEX_DB_ADMIN_URL=postgresql://postgres@localhost:5432/postgres node deploy/neon/ensaio-pg-gerenciado.js
 *        (precisa de `psql` no PATH ou em PSQL=...; o `prisma` vem de node_modules). RECUSA se o banco temporário já existir. Não imprime senhas. Remove tudo o que criou.
 * Limite: simula as RESTRIÇÕES do gerenciado, não o serviço real (latência, auto-suspensão, pooler). A prova no Neon real continua pendente (ver docs/CORTEX/HOSPEDAGEM_GRATUITA.md).
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const ADMIN = process.env.CORTEX_DB_ADMIN_URL;
const PSQL = process.env.PSQL || 'psql';
const DB = 'cortex_managed_sim';
const ROLES = { admin: 'sim_managed_admin', owner: 'sim_owner', app: 'sim_app', bkp: 'sim_backup' };
const pw = () => crypto.randomBytes(18).toString('base64url');
const PASS = { admin: pw(), owner: pw(), app: pw(), bkp: pw() };
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${what}`);
  if (!ok) failures++;
};

if (!ADMIN) {
  console.error('Defina CORTEX_DB_ADMIN_URL (um superusuário LOCAL, só para criar o ambiente de ensaio). Nada foi feito.');
  process.exit(2);
}
const url = (db, user, password) => {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
};
/** psql sem eco de credenciais; devolve { ok, out }. Variáveis vão por -v (escape correto no próprio psql). */
function sql(connUrl, text, vars = {}) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-t', '-A', connUrl];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync(PSQL, args, { input: text, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim().split('\n')[0] };
}
function sqlFile(connUrl, file, vars) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file, connUrl];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync(PSQL, args, { encoding: 'utf8' });
  return { ok: r.status === 0, err: (r.stderr || '').trim().split('\n').slice(0, 2).join(' | ') };
}

function cleanup() {
  sql(url('postgres'), `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  for (const r of [ROLES.app, ROLES.bkp, ROLES.owner, ROLES.admin]) sql(url('postgres'), `DROP ROLE IF EXISTS ${r};`);
}

(async () => {
  const exists = sql(url('postgres'), `SELECT 1 FROM pg_database WHERE datname='${DB}'`);
  if (exists.out === '1') {
    console.error(`O banco temporário ${DB} já existe: recusando (nada foi feito).`);
    process.exit(2);
  }
  const ver = sql(url('postgres'), 'SHOW server_version');
  console.log(`PostgreSQL local de ensaio: ${ver.out}`);

  // 1) administrador "gerenciado": SEM superusuário
  let r = sql(url('postgres'), `CREATE ROLE ${ROLES.admin} LOGIN PASSWORD '${PASS.admin}' NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS;`);
  check(r.ok, 'administrador gerenciado criado (LOGIN CREATEROLE CREATEDB BYPASSRLS, NOSUPERUSER)');
  r = sql(url('postgres'), `CREATE DATABASE ${DB} OWNER ${ROLES.admin};`);
  check(r.ok, `banco temporário ${DB} criado`);
  const admin = url(DB, ROLES.admin, PASS.admin);
  check(sql(admin, "SELECT NOT rolsuper FROM pg_roles WHERE rolname = current_user").out === 't', 'o administrador de ensaio NÃO é superusuário');

  // 2) papéis (mesmo modelo de deploy/postgres-init/10-roles.sh), criados PELO administrador sem superusuário
  const roles = `
    CREATE ROLE :"owner" LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    CREATE ROLE :"app"   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
    CREATE ROLE :"bkp"   LOGIN PASSWORD :'bkp_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;
    -- ACHADO do ensaio: sem superusuário, quem cria o papel só tem ADMIN sobre ele; para transferir a posse do banco/schema é preciso poder fazer SET ROLE (PostgreSQL 16+)
    GRANT :"owner" TO CURRENT_USER WITH SET TRUE;
    ALTER DATABASE :"dbname" OWNER TO :"owner";
    REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
    GRANT CONNECT ON DATABASE :"dbname" TO :"owner", :"app", :"bkp";
    ALTER SCHEMA public OWNER TO :"owner";
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO :"app", :"bkp";`;
  const vars = { owner: ROLES.owner, app: ROLES.app, bkp: ROLES.bkp, owner_pw: PASS.owner, app_pw: PASS.app, bkp_pw: PASS.bkp, dbname: DB };
  r = sql(admin, roles, vars);
  check(r.ok, `papéis dono/aplicação/backup criados sem superusuário (incl. BYPASSRLS do backup)${r.ok ? '' : ' — ' + r.err}`);
  if (!r.ok) return finish();

  // 3) migrações COMO O DONO (nada destrutivo: banco novo)
  const ownerUrl = url(DB, ROLES.owner, PASS.owner);
  const mig = spawnSync(process.execPath, [path.join(REPO, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=packages/database/prisma/schema.prisma'], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: ownerUrl },
    encoding: 'utf8',
  });
  const applied = (mig.stdout.match(/(\d+) migrations? (?:found|applied)/g) || []).join(' / ');
  check(mig.status === 0, `prisma migrate deploy como dono (sem superusuário) — ${applied || (mig.stderr || '').split('\n')[0]}`);
  if (mig.status !== 0) return finish();

  // 4) privilégios + contexto de RLS assinado (after-migrate.sql, também como dono)
  const secretB64 = crypto.randomBytes(32).toString('base64');
  const am = sqlFile(ownerUrl, path.join(REPO, 'deploy/postgres-init/after-migrate.sql'), { app: ROLES.app, bkp: ROLES.bkp, ctx_secret_b64: secretB64 });
  check(am.ok, `after-migrate.sql (GRANTs + contexto assinado) como dono${am.ok ? '' : ' — ' + am.err}`);
  if (!am.ok) return finish();

  // 5) o papel da aplicação, de verdade
  const appUrl = url(DB, ROLES.app, PASS.app);
  const q = (s) => sql(appUrl, s);
  check(q("SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) FROM pg_roles WHERE rolname = current_user").out === 't', 'papel da aplicação: sem superusuário, BYPASSRLS, CREATEROLE nem CREATEDB');
  const tables = sql(ownerUrl, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'").out;
  const forced = sql(ownerUrl, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity").out;
  check(Number(forced) > 0, `RLS FORÇADA nas tabelas de negócio: ${forced} de ${tables} tabelas`);
  check(q('SELECT count(*) FROM companies').ok, 'a aplicação lê/escreve tabelas (DML permitido)');
  for (const [what, stmt] of [
    ['desligar a RLS', 'ALTER TABLE companies DISABLE ROW LEVEL SECURITY'],
    ['TRUNCATE', 'TRUNCATE companies'],
    ['DROP TABLE', 'DROP TABLE companies'],
    ['criar tabela', 'CREATE TABLE sim_intruso (id int)'],
    ['ler _prisma_migrations', 'SELECT * FROM "_prisma_migrations"'],
  ]) check(!q(stmt).ok, `a aplicação NÃO consegue: ${what}`);
  check(sql(url(DB, ROLES.bkp, PASS.bkp), 'SELECT count(*) FROM "_prisma_migrations"').ok, 'o papel de backup lê o histórico de migrações (BYPASSRLS)');
  check(sql(url(DB, ROLES.bkp, PASS.bkp), 'SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user').out === 't', 'o papel de backup tem BYPASSRLS (criado sem superusuário)');
  // contexto assinado: sem contexto válido a aplicação não enxerga nem escreve em tabela de empresa
  check(q("SELECT count(*) FROM companies").out === '0', 'sem contexto de RLS a aplicação enxerga 0 linhas');
  finish();
})().catch((e) => {
  console.error('ERRO', e.message);
  failures++;
  finish();
});

function finish() {
  cleanup();
  const gone = sql(url('postgres'), `SELECT count(*) FROM pg_database WHERE datname='${DB}'`).out === '0';
  check(gone, 'banco e papéis temporários removidos');
  console.log(failures ? `\n${failures} verificação(ões) FALHOU` : '\nTodas as verificações passaram (restrições de PostgreSQL gerenciado simuladas; o serviço real continua por provar)');
  process.exit(failures ? 1 : 0);
}
