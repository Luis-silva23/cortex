/**
 * PROVA DA SEPARAÇÃO DE PAPÉIS DO BANCO (dono das tabelas × papel de execução da aplicação).
 *
 *   CORTEX_DB_ADMIN_URL=<url de um superusuário local> npm run db:role-split-check [-- --suites | --all]
 *
 * Por quê: hoje o papel `lnsystem` é DONO das tabelas e é o que a aplicação usa. O dono pode `ALTER TABLE … DISABLE ROW LEVEL SECURITY`,
 * `DROP POLICY`, `DROP TABLE`, `TRUNCATE` — uma falha de injeção de SQL (ou um erro de operação) desliga o isolamento entre empresas. A RLS
 * `FORCE` protege o dono contra leitura/escrita sem contexto, não contra DDL. O procedimento correto é o dono (`lnsystem`) só aplicar migrations
 * e a aplicação rodar com um papel SEM posse: DML nas tabelas e nada de DDL (modelo em `deploy/db-runtime-role.sql`).
 *
 * O que este script faz (tudo num banco TEMPORÁRIO `<banco-de-dev>_roles_test_tmp`, que ele cria e remove; RECUSA se já existir):
 *   1. aplica todas as migrations como o dono; cria um papel de execução temporário e aplica os GRANTs do modelo;
 *   2. conecta COMO esse papel e prova: não é superusuário/BYPASSRLS/dono; DDL (desligar RLS, apagar policy/tabela, TRUNCATE, criar tabela) é
 *      NEGADO; `_prisma_migrations` ilegível; a RLS continua valendo (sem contexto = 0 linhas; empresa B não vê a A; INSERT cruzado recusado);
 *      os livros append-only continuam append-only; as funções auxiliares da RLS são executáveis;
 *   3. com `--suites`, roda um subconjunto da suíte de integração real (com `--all`, a suíte COMPLETA) com a aplicação conectada como esse papel;
 *   4. remove o banco e o papel temporários. Não toca no banco de dev/teste. Não imprime URL/senha.
 * Exige um superusuário (CREATE ROLE) via CORTEX_DB_ADMIN_URL; sem ele o script explica e sai com código 2 (nada é feito).
 * Grava docs/CORTEX/revisao-banco/role-split-resultado.md.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes } from 'crypto';
import { CONTEXT_SET_CONFIG_SQL, contextGucs, contextStatement, type ContextGucs } from '@ln-system/database';
import { ensureContextSecret } from './lib/rls-context-secret';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REPO = path.resolve(__dirname, '../../..');
const DB_PKG = path.join(REPO, 'packages/database');
const API = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'docs/CORTEX/revisao-banco');
const SUITES = ['rls-invariants', 'append-only-ledgers', 'company-branch-fk-restrict', 'database-schema-invariants', 'stock-ledger', 'rbac', 'sale-input-validation', 'refresh-token-isolation'];

function withDatabase(url: string, name: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

const redact = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***');

async function main() {
  const devUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.CORTEX_DB_ADMIN_URL;
  if (!devUrl) throw new Error('DATABASE_URL ausente (apps/api/.env).');
  if (!adminUrl) {
    console.error('[role-split-check] CORTEX_DB_ADMIN_URL ausente: criar um papel exige superusuário. Nada foi feito. Ver docs/CORTEX/PRODUCAO.md (modelo: deploy/db-runtime-role.sql).');
    process.exitCode = 2;
    return;
  }
  const devName = new URL(devUrl).pathname.replace(/^\//, '');
  const dbName = `${devName.replace(/_db$/i, '')}_roles_test_tmp`;
  const roleName = `cortex_rt_${crypto.randomBytes(4).toString('hex')}`;
  const rolePass = crypto.randomBytes(18).toString('hex');
  if (!/^[A-Za-z0-9_]+$/.test(dbName) || dbName === devName) throw new Error(`nome de banco temporário inválido: ${dbName}`);

  const admin = new PrismaClient({ datasources: { db: { url: withDatabase(adminUrl, 'postgres') } } });
  const exists = (await admin.$queryRawUnsafe(`SELECT 1 AS x FROM pg_database WHERE datname = '${dbName}'`)) as unknown[];
  if (exists.length) {
    await admin.$disconnect();
    throw new Error(`o banco temporário "${dbName}" já existe — recusado (não apago o que não criei).`);
  }
  const owner = decodeURIComponent(new URL(devUrl).username);
  const ownerUrlTmp = withDatabase(devUrl, dbName);
  const appUrlTmp = withDatabase(devUrl, dbName, roleName, rolePass);
  const lines: string[] = [];
  let ok = true;
  let appClient: PrismaClient | null = null;
  let adminTmp: PrismaClient | null = null;
  const check = (label: string, pass: boolean, detail = '') => {
    lines.push(`- ${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!pass) ok = false;
  };

  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" OWNER "${owner}"`);
    const deploy = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], {
      cwd: DB_PKG,
      env: { ...process.env, DATABASE_URL: ownerUrlTmp },
      encoding: 'utf8',
    });
    check('migrations aplicadas pelo DONO no banco temporário vazio', deploy.status === 0, (deploy.stdout.match(/(\d+) migrations? found/i) ?? [])[0] ?? '');
    if (deploy.status !== 0) {
      lines.push('```\n' + redact(`${deploy.stdout}\n${deploy.stderr}`).split('\n').slice(-10).join('\n') + '\n```');
      return;
    }

    // papel de execução + GRANTs do modelo (deploy/db-runtime-role.sql, aqui com o nome temporário)
    adminTmp = new PrismaClient({ datasources: { db: { url: withDatabase(adminUrl, dbName) } } });
    const exec = (sql: string) => adminTmp!.$executeRawUnsafe(sql);
    await admin.$executeRawUnsafe(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
    await exec(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
    await exec(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
    await exec(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await exec(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    await exec(`REVOKE ALL ON TABLE public."_prisma_migrations" FROM "${roleName}"`);
    await exec(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${roleName}"`);
    await exec(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${roleName}"`);
    check('papel de execução temporário criado com os GRANTs do modelo (DML; sem posse, sem DDL)', true);
    // contexto de RLS ASSINADO (decisão 151): o DONO provisiona o segredo; o papel de execução não pode (provado adiante)
    check('segredo do contexto de RLS provisionado pelo dono (a exigência de assinatura liga)', (await ensureContextSecret(adminTmp)) !== undefined);

    appClient = new PrismaClient({ datasources: { db: { url: appUrlTmp } } });
    const q = async <T = any>(sql: string): Promise<T[]> => (await appClient!.$queryRawUnsafe(sql)) as T[];
    const denied = async (sql: string): Promise<{ denied: boolean; msg: string }> => {
      try {
        await appClient!.$executeRawUnsafe(sql);
        return { denied: false, msg: 'executou' };
      } catch (e: any) {
        const m = String(e?.message ?? e);
        return { denied: /permission denied|must be owner|permissão negada|deve ser o dono|não tem permissão|42501/i.test(m), msg: m.split('\n').pop()!.slice(0, 120) };
      }
    };

    // 1. identidade
    const me = (await q<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`))[0];
    check('o papel de execução não é superusuário, não tem BYPASSRLS, CREATEDB nem CREATEROLE', !me.rolsuper && !me.rolbypassrls && !me.rolcreatedb && !me.rolcreaterole);
    const owned = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`))[0].n;
    check('o papel de execução não é dono de nenhuma tabela', owned === 0, `tabelas de que é dono: ${owned}`);

    // 2. DDL negado
    for (const [label, sql] of [
      ['desligar a RLS de uma tabela (ALTER TABLE … DISABLE ROW LEVEL SECURITY)', 'ALTER TABLE customers DISABLE ROW LEVEL SECURITY'],
      ['desligar o FORCE da RLS (NO FORCE ROW LEVEL SECURITY)', 'ALTER TABLE customers NO FORCE ROW LEVEL SECURITY'],
      ['apagar uma policy (DROP POLICY)', 'DROP POLICY IF EXISTS "stock_movements_select" ON stock_movements'],
      ['alterar uma policy (ALTER POLICY … USING (true))', 'ALTER POLICY "stock_movements_select" ON stock_movements USING (true)'],
      ['apagar uma tabela (DROP TABLE)', 'DROP TABLE customers'],
      ['esvaziar uma tabela (TRUNCATE)', 'TRUNCATE TABLE customers'],
      ['criar uma tabela no schema public (CREATE TABLE)', 'CREATE TABLE public.cortex_intruso (id int)'],
      ['apagar uma restrição (ALTER TABLE … DROP CONSTRAINT)', 'ALTER TABLE products DROP CONSTRAINT "products_companyId_branchId_fkey"'],
    ] as const) {
      const r = await denied(sql);
      check(`DDL negado: ${label}`, r.denied, r.denied ? '' : r.msg);
    }
    const mig = await denied('SELECT 1 FROM "_prisma_migrations" LIMIT 1');
    check('`_prisma_migrations` ilegível para o papel de execução', mig.denied, mig.denied ? '' : mig.msg);

    // 3. a RLS continua valendo para o papel de execução
    const ctx = (company: string | null, type: string) => [contextStatement(appClient!, { companyId: company, userType: type, branchId: null })];
    const stamp = Date.now();
    const mk = async (n: string, doc: string) =>
      (await appClient!.$transaction([...ctx(null, 'SUPER_ADMIN'), appClient!.company.create({ data: { name: `Teste papeis ${n}`, document: doc, email: `rl-${n}-${stamp}@teste.local`, isActive: true } })]))[1] as { id: string };
    const A = await mk('A', String(stamp).slice(-8).padStart(14, '7'));
    const B = await mk('B', String(stamp + 1).slice(-8).padStart(14, '8'));
    await appClient.$transaction([...ctx(A.id, 'COMPANY_ADMIN'), appClient.customer.create({ data: { companyId: A.id, name: `Cliente A ${stamp}` } })]);
    const count = async (company: string | null, type: string) =>
      (await appClient!.$transaction([...ctx(company, type), appClient!.customer.count({ where: { name: `Cliente A ${stamp}` } })]))[1] as number;
    check('RLS: a empresa dona enxerga a própria linha', (await count(A.id, 'COMPANY_ADMIN')) === 1);
    check('RLS: a empresa B NÃO enxerga a linha da A', (await count(B.id, 'COMPANY_ADMIN')) === 0);
    check('RLS: sem contexto de empresa a leitura volta vazia (0 linhas)', (await count(null, 'COMPANY_ADMIN')) === 0);
    let cross = 'aceito';
    try {
      await appClient.$transaction([...ctx(B.id, 'COMPANY_ADMIN'), appClient.customer.create({ data: { companyId: A.id, name: `Cruzado ${stamp}` } })]);
    } catch (e: any) {
      cross = /row-level security|segurança.*linha|new row violates|42501/i.test(String(e?.message)) ? 'recusado' : `erro: ${String(e?.message).split('\n').pop()?.slice(0, 80)}`;
    }
    check('RLS: a empresa B não consegue inserir linha com o companyId da A (WITH CHECK)', cross === 'recusado', cross);

    // 4. livros append-only continuam append-only
    const prod = (await appClient.$transaction([...ctx(A.id, 'COMPANY_ADMIN'), appClient.product.create({ data: { companyId: A.id, sku: `RL-${stamp}`, name: 'p', costPrice: 1, salePrice: 2 } })]))[1] as { id: string };
    const mov = (await appClient.$transaction([...ctx(A.id, 'COMPANY_ADMIN'), appClient.stockMovement.create({ data: { companyId: A.id, productId: prod.id, movementType: 'PURCHASE', quantity: 5 } })]))[1] as { id: string };
    const upd = (await appClient.$transaction([...ctx(A.id, 'COMPANY_ADMIN'), appClient.stockMovement.updateMany({ where: { id: mov.id }, data: { quantity: 999 } })]))[1] as { count: number };
    const del = (await appClient.$transaction([...ctx(A.id, 'COMPANY_ADMIN'), appClient.stockMovement.deleteMany({ where: { id: mov.id } })]))[1] as { count: number };
    check('livro de estoque: UPDATE e DELETE pela empresa afetam 0 linhas (append-only)', upd.count === 0 && del.count === 0, `update ${upd.count}, delete ${del.count}`);

    // 4b. FALSIFICAÇÃO DE CONTEXTO (decisão 151): o que um SQL arbitrário, executado COMO o papel de execução, consegue — e não consegue — fazer
    const gucOf = (g: ContextGucs) => appClient!.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, g['app.current_company_id'], g['app.current_branch_id'], g['app.current_branch_ids'], g['app.user_type'], g['app.user_id'], g['app.ctx_iat'], g['app.ctx_sig']);
    const seen = async (g: ContextGucs | null) =>
      Number(((await appClient!.$transaction([g ? gucOf(g) : appClient!.$executeRawUnsafe('SELECT 1'), appClient!.$queryRawUnsafe('SELECT (SELECT count(*) FROM companies) + (SELECT count(*) FROM customers) AS n')]))[1] as Array<{ n: bigint }>)[0].n);
    const adminA = contextGucs({ companyId: A.id, userType: 'COMPANY_ADMIN', branchId: null });
    const legit = await seen(adminA);
    check('contexto legítimo assinado (administrador da empresa A) enxerga os dados da A', legit >= 2, `linhas visíveis: ${legit}`);
    check('SQL cru: set_config(app.user_type = SUPER_ADMIN) sem assinatura NÃO enxerga nada', (await seen({ ...adminA, 'app.user_type': 'SUPER_ADMIN', 'app.ctx_sig': '' })) === 0);
    check('SQL cru: papel promovido a SUPER_ADMIN reaproveitando a assinatura de COMPANY_ADMIN NÃO enxerga nada', (await seen({ ...adminA, 'app.user_type': 'SUPER_ADMIN' })) === 0);
    check('SQL cru: trocar a empresa (A para B) mantendo a assinatura da A NÃO enxerga nada', (await seen({ ...adminA, 'app.current_company_id': B.id })) === 0);
    check('SQL cru: acrescentar filiais à lista assinada NÃO enxerga nada', (await seen({ ...adminA, 'app.current_branch_ids': 'b1,b2' })) === 0);
    check('SQL cru: assinatura com chave errada (HMAC de outro segredo) NÃO enxerga nada', (await seen({ ...adminA, 'app.ctx_sig': createHmac('sha256', randomBytes(32)).update('v1|x').digest('hex') })) === 0);
    check('SQL cru: assinatura correta porém EXPIRADA (10 min atrás) NÃO enxerga nada', (await seen(contextGucs({ companyId: A.id, userType: 'COMPANY_ADMIN', branchId: null }, Date.now() - 600_000))) === 0);
    check('SQL cru: assinatura correta com relógio no FUTURO (+10 min) NÃO enxerga nada', (await seen(contextGucs({ companyId: A.id, userType: 'COMPANY_ADMIN', branchId: null }, Date.now() + 600_000))) === 0);
    check('SQL cru: sem nenhum contexto NÃO enxerga nada', (await seen(null)) === 0);
    for (const [label, sql] of [
      ['ler o cofre de segredos (app_ctx_vault.secrets)', 'SELECT * FROM app_ctx_vault.secrets'],
      ['ler a configuração (app_ctx.settings)', 'SELECT * FROM app_ctx.settings'],
      ['desligar a exigência de assinatura (UPDATE app_ctx.settings)', 'UPDATE app_ctx.settings SET enforced = false'],
      ['provisionar outro segredo (app_ctx.provision)', "SELECT app_ctx.provision(decode(repeat('ab', 32), 'hex'))"],
      ['aposentar o segredo (app_ctx.retire_previous)', 'SELECT app_ctx.retire_previous()'],
      ['reescrever policies (app_ctx.rewrite_policies)', 'SELECT app_ctx.rewrite_policies()'],
      ['substituir o verificador (CREATE OR REPLACE FUNCTION app_ctx._sig_ok)', "CREATE OR REPLACE FUNCTION app_ctx._sig_ok() RETURNS boolean LANGUAGE sql AS 'SELECT true'"],
      ['criar função no schema do verificador', "CREATE FUNCTION app_ctx.intruso() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
      ['criar objetos temporários (sequestro de search_path via pg_temp)', 'CREATE TEMP TABLE intruso (x int)'],
      ['assumir outro papel (SET ROLE)', 'SET ROLE postgres'],
    ] as const) {
      const r = await denied(sql);
      check(`negado ao papel de execução: ${label}`, r.denied, r.denied ? '' : r.msg);
    }
    lines.push('- ℹ️ Limite registrado (não é falha do teste): quem injeta SQL durante UMA requisição continua com o contexto daquela requisição e pode reutilizar a própria assinatura por até 120 s; não vira outro usuário, papel ou empresa. Quem executa código dentro do processo da API tem o segredo.');

    // 5. funções auxiliares
    const fn = await q<{ ok: boolean }>(`SELECT has_function_privilege(current_user, 'get_current_company_id()'::regprocedure, 'EXECUTE') AS ok`).catch(() => [{ ok: false }]);
    check('as funções auxiliares da RLS são executáveis pelo papel de execução', fn[0]?.ok === true);

    // 6. suíte de integração real com a aplicação conectada como esse papel
    if (process.argv.includes('--suites') || process.argv.includes('--all')) {
      const every = process.argv.includes('--all');
      const args = ['jest', '--config', 'test/integration/jest.integration.config.js', '--runInBand', '--forceExit', ...(every ? [] : SUITES.map((s) => `test/integration/${s}`))];
      const run = spawnSync('npx', args, { cwd: API, env: { ...process.env, TEST_DATABASE_URL: appUrlTmp }, shell: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
      // sem maxBuffer o spawnSync mata o jest quando a saída passa de 1 MB (a suíte completa passa) e o resultado vira "Tests: ?"
      const out = `${run.stdout}\n${run.stderr}`;
      if (run.error) lines.push(`- ⚠️ falha ao executar a suíte: ${String((run.error as Error).message).slice(0, 160)}`);
      const tests = (out.match(/Tests:\s+([^\n]+)/) ?? [])[1] ?? '?';
      const suites = (out.match(/Test Suites:\s+([^\n]+)/) ?? [])[1] ?? '?';
      check(`suíte de integração real (${every ? 'COMPLETA' : `${SUITES.length} arquivos`}) com a aplicação como papel SEM posse`, run.status === 0, `Test Suites: ${suites}; Tests: ${tests}`);
      if (run.status !== 0) lines.push('```\n' + redact(out).split('\n').filter((l) => /FAIL|●.*›|Expected|Received/.test(l)).slice(0, 25).join('\n') + '\n```');
    } else {
      lines.push('- ℹ️ suíte de integração com o papel de execução: não executada nesta chamada (usar `-- --suites`).');
    }
  } finally {
    try {
      if (appClient) await appClient.$disconnect();
      if (adminTmp) await adminTmp.$disconnect();
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`);
      lines.push('- Banco e papel temporários removidos: sim.');
    } catch (e) {
      ok = false;
      lines.push(`- **Banco/papel temporário NÃO removido** (${e instanceof Error ? e.message.split('\n').pop() : 'erro'}): remover à mão \`DROP DATABASE "${dbName}"\` e \`DROP ROLE "${roleName}"\`.`);
    }
    await admin.$disconnect();
  }

  const md = [
    `**Execução de ${new Date().toISOString().slice(0, 10)}** (\`npm run db:role-split-check\`) — banco e papel temporários criados e removidos pelo script; dev/teste intocados. Resultado: **${ok ? 'APROVADO' : 'COM FALHAS'}**.`,
    '',
    ...lines,
    '',
    "> Limite honesto: o contexto da RLS agora é ASSINADO (decisão 151): SQL arbitrário do papel de execução NÃO consegue virar outro papel, outra empresa nem outras filiais, nem ler o segredo, nem desligar a exigência. Continua possível, e não é evitável neste desenho: (a) reutilizar a assinatura da própria requisição por até 120 s; (b) quem executa código dentro do processo da API assina o que quiser (tem o segredo). A separação de papéis impede o DDL; a assinatura impede a falsificação do contexto; nada disso substitui não ter injeção de SQL.",
    '',
  ].join('\n');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'role-split-resultado.md'), md, 'utf8');
  console.log(md);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[erro] ${error instanceof Error ? redact(error.message) : String(error)}`);
  process.exitCode = 1;
});
