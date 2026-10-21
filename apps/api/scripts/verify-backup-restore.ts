/**
 * Verificação REAL de backup e restauração (não basta o arquivo existir):
 *  1. gera o backup pelo mesmo código da aplicação (BackupService → pg_dump com o role de backup);
 *  2. restaura num banco TEMPORÁRIO (nunca por cima do banco de origem) com o role de DBA;
 *  3. compara origem × restaurado: linhas das tabelas de negócio, RLS ligado e forçado, políticas, constraints
 *     validadas, índices, migrações, dono das tabelas;
 *  4. confere que o RLS continua valendo no restaurado para o role de runtime (sem contexto → nada; com a empresa →
 *     só a empresa);
 *  5. confere os segredos: gravados cifrados (enc:v1), abrem com DATA_ENCRYPTION_KEY, NÃO abrem com outra chave, e o
 *     segredo do MFA de demonstração não aparece em texto puro no arquivo de backup;
 *  6. derruba SOMENTE o banco temporário criado aqui.
 * Nada de segredo ou chave é impresso.
 *
 *   npm run backup:verify   (apps/api/.env: DATABASE_URL, BACKUP_DATABASE_URL, RESTORE_ADMIN_URL, PG_BIN_DIR, DATA_ENCRYPTION_KEY)
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { isSealed, openSecret } from '@ln-system/shared/utils/secret-box';
import { PrismaClient } from '@prisma/client';
import { contextSqlStatements } from '@ln-system/database';
import { ensureContextSecret } from './lib/rls-context-secret';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const bin = (name: string) => (process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, process.platform === 'win32' ? `${name}.exe` : name) : name);
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
};
/** Nunca deixa senha de conexão chegar a log/erro (a mensagem de erro do execFileSync inclui os argumentos). */
const redact = (text: string) => text.replace(/(postgres(?:ql)?:\/\/[^:@/\s]+):[^@\s]+@/g, '$1:***@');
const psql = (url: string, statements: string[]) => {
  try {
    return execFileSync(bin('psql'), [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...statements.flatMap((s) => ['-c', s])], {
      encoding: 'utf8',
      env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    throw new Error(redact(`psql falhou: ${String(error.stderr || '').trim() || error.message}`));
  }
};
const q = (url: string, sql: string) => psql(url, [sql]);
/** Executa comandos de contexto e devolve só a saída do último SELECT. */
const qCtx = (url: string, setup: string[], sql: string) => psql(url, [...setup, sql]).split('\n').pop()!.trim();

// Tabelas de negócio sem escrita de fundo (a API rodando grava logs/telemetria/alertas continuamente).
const STABLE_TABLES = [
  'companies', 'branches', 'users', 'roles', 'permissions', 'licenses', 'devices', 'customers', 'motorcycles', 'products',
  'categories', 'suppliers', 'sales', 'sale_items', 'payments', 'payment_exceptions', 'cash_registers', 'cash_movements',
  'service_orders', 'purchase_orders', 'fiscal_configs', 'payment_settings', 'monitoring_thresholds', '_prisma_migrations',
];

type Check = { name: string; ok: boolean; detail: string };

async function main() {
  const runtimeUrl = process.env.DATABASE_URL;
  const backupUrl = process.env.BACKUP_DATABASE_URL;
  const adminUrl = process.env.RESTORE_ADMIN_URL;
  if (!runtimeUrl || !backupUrl || !adminUrl) {
    throw new Error('Configure DATABASE_URL, BACKUP_DATABASE_URL (role de backup com BYPASSRLS) e RESTORE_ADMIN_URL (DBA) em apps/api/.env');
  }
  const sourceDb = new URL(runtimeUrl).pathname.slice(1);
  const tempDb = `lnsystem_restore_check_${Date.now()}`;
  if (!/^lnsystem_restore_check_\d+$/.test(tempDb) || tempDb === sourceDb) throw new Error('nome de banco temporário inválido');
  const tempAdmin = withDb(adminUrl, tempDb);
  const tempRuntime = withDb(runtimeUrl, tempDb);
  const sourceRead = withDb(backupUrl, sourceDb);
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 1) backup pelo código da aplicação
  const mod: any = await import('../src/services/BackupService');
  const backupService = mod.backupService ?? mod.default?.backupService;
  const backup = await backupService.createBackup();
  if (!backup.success) throw new Error(`backup falhou: ${backup.error}`);
  const file: string = backup.filePath;
  const bytes = fs.readFileSync(file);
  check('backup gerado pelo BackupService (role de backup)', bytes.length > 0, `${path.basename(file)} · ${bytes.length} bytes · sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…`);

  // origem (leitura com o role de backup: enxerga tudo, sem contexto de empresa)
  const count = (url: string, table: string) => Number(q(url, `SELECT count(*) FROM public."${table}"`));
  const source: Record<string, number> = Object.fromEntries(STABLE_TABLES.map((t) => [t, count(sourceRead, t)]));
  const meta = (url: string) => ({
    rlsForced: q(url, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity"),
    policies: q(url, "SELECT count(*) FROM pg_policies WHERE schemaname='public'"),
    constraints: q(url, "SELECT string_agg(contype::text || ':' || n, ',' ORDER BY contype) FROM (SELECT contype, count(*) n FROM pg_constraint c JOIN pg_namespace ns ON ns.oid=c.connamespace WHERE ns.nspname='public' GROUP BY contype) x"),
    indexes: q(url, "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"),
    functions: q(url, "SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (proname LIKE 'rls%' OR proname IN ('is_super_admin','get_current_company_id','get_current_branch_id','is_company_wide_role'))"),
    owners: q(url, "SELECT string_agg(tableowner || ':' || n, ',' ORDER BY tableowner) FROM (SELECT tableowner, count(*) n FROM pg_tables WHERE schemaname='public' GROUP BY tableowner) x"),
    // SQL só em ASCII: no Windows os argumentos do psql passam pela página de código do sistema.
    migrations: q(url, "SELECT count(*) || ' / ' || max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL"),
  });
  const sourceMeta = meta(sourceRead);

  try {
    // 2) restauração num banco temporário
    q(adminUrl, `CREATE DATABASE "${tempDb}"`);
    try {
      execFileSync(bin('pg_restore'), ['--exit-on-error', '-d', tempAdmin, file], { encoding: 'utf8', env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      check('pg_restore sem erros (--exit-on-error)', true, `restaurado em ${tempDb}`);
    } catch (error: any) {
      check('pg_restore sem erros (--exit-on-error)', false, redact(String(error.stderr || error.message)).slice(0, 400));
      throw new Error('pg_restore falhou');
    }

    // 3) conteúdo e estrutura
    const diffs = STABLE_TABLES.filter((t) => count(tempAdmin, t) !== source[t]);
    check(`linhas iguais em ${STABLE_TABLES.length} tabelas de negócio`, diffs.length === 0, diffs.length ? `divergem: ${diffs.join(', ')}` : STABLE_TABLES.map((t) => `${t}=${source[t]}`).join(' '));
    const restoredMeta = meta(tempAdmin);
    for (const k of Object.keys(sourceMeta) as Array<keyof typeof sourceMeta>) {
      check(`estrutura: ${k}`, sourceMeta[k] === restoredMeta[k], `origem ${sourceMeta[k]} · restaurado ${restoredMeta[k]}`);
    }
    // FKs NOT VALID são o legado de dado que a migration 20261015100000 preserva de propósito (linha de empresa que não existe mais). O backup tem que
    // devolver EXATAMENTE as mesmas da origem — nem uma a mais (validação perdida na restauração), nem uma a menos.
    const notValidSql = "SELECT coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname, ',' ORDER BY c.conname), '') FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT convalidated";
    const notValidSource = q(sourceRead, notValidSql);
    const notValidRestored = q(tempAdmin, notValidSql);
    check('constraints: as FKs NOT VALID da origem (legado documentado) voltam iguais, nenhuma a mais', notValidSource === notValidRestored, notValidSource ? `${notValidSource.split(',').length} NOT VALID na origem e no restaurado: ${notValidSource}` : 'nenhuma NOT VALID');

    // 4) RLS vale no restaurado para o role de runtime
    const [companyId, usersOfCompany] = q(tempAdmin, 'SELECT "companyId", count(*) FROM users WHERE "companyId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1').split('|');
    // contexto de RLS ASSINADO (decisão 151): o segredo NÃO vai no backup. Até o DBA provisionar, a consulta é NEGADA (erro de cofre ausente = falha fechada)
    let deniedBefore = '';
    try {
      deniedBefore = `lida: ${qCtx(tempRuntime, [], 'SELECT count(*) FROM users')}`;
    } catch (error: any) {
      deniedBefore = String(error.message).includes('app_ctx_vault') ? 'negada' : `erro inesperado: ${String(error.message).slice(0, 100)}`;
    }
    check('restaurado SEM o segredo provisionado: o papel de runtime é NEGADO (falha fechada)', deniedBefore === 'negada' || deniedBefore === 'lida: 0', deniedBefore);
    const admDb = new PrismaClient({ datasources: { db: { url: tempAdmin } } });
    try {
      await ensureContextSecret(admDb);
    } finally {
      await admDb.$disconnect();
    }
    const noCtx = qCtx(tempRuntime, [], 'SELECT count(*) FROM users');
    const withCtx = qCtx(tempRuntime, contextSqlStatements({ companyId, userType: 'COMPANY_ADMIN', branchId: null }), 'SELECT count(*) FROM users');
    check('RLS no restaurado: role de runtime sem contexto não lê nada', noCtx === '0', `users visíveis sem contexto: ${noCtx}`);
    check('RLS no restaurado: com a empresa, só a empresa', withCtx === usersOfCompany, `users da empresa: ${withCtx} (esperado ${usersOfCompany})`);

    // 5) segredos
    const secrets = q(tempAdmin, `SELECT "mfaSecret" FROM users WHERE "mfaSecret" IS NOT NULL`).split('\n').filter(Boolean);
    const plain = secrets.filter((s) => !isSealed(s));
    check('segredos de MFA cifrados no backup (enc:v1)', secrets.length > 0 && plain.length === 0, `${secrets.length} segredo(s), ${plain.length} em texto puro`);
    let opened = 0;
    for (const s of secrets) if (/^[A-Z2-7]+=*$/.test(openSecret(s))) opened++;
    check('segredos abrem com DATA_ENCRYPTION_KEY (MFA recuperável)', opened === secrets.length, `${opened}/${secrets.length} abertos (valor não exibido)`);
    const realKey = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    let wrongKeyOpened = 0;
    for (const s of secrets) {
      try {
        openSecret(s);
        wrongKeyOpened++;
      } catch {
        /* esperado */
      }
    }
    process.env.DATA_ENCRYPTION_KEY = realKey;
    check('sem a chave certa os segredos NÃO abrem', wrongKeyOpened === 0, `${wrongKeyOpened} aberto(s) com chave errada`);

    const credsFile = path.resolve(__dirname, '../.demo/credentials.json');
    if (fs.existsSync(credsFile)) {
      const demoSecret: string | undefined = JSON.parse(fs.readFileSync(credsFile, 'utf8')).saMfaSecret;
      if (demoSecret) {
        const matches = secrets.some((s) => openSecret(s) === demoSecret);
        check('MFA do Super Admin de demonstração recuperado do backup', matches, 'segredo restaurado = segredo do app autenticador (comparação local, sem exibir)');
        const dumpText = execFileSync(bin('pg_restore'), ['-a', '-t', 'users', '-f', '-', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        check('arquivo de backup não contém o segredo em texto puro', !dumpText.includes(demoSecret), 'busca pelo segredo no conteúdo de users do backup');
      }
    }
  } finally {
    // 6) só o banco temporário criado aqui
    if (/^lnsystem_restore_check_\d+$/.test(tempDb)) q(adminUrl, `DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`);
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'OK ' : 'FALHA'} ${c.name} — ${c.detail}`);
  console.log(failed.length ? `\nRESTAURAÇÃO NÃO VALIDADA: ${failed.length} verificação(ões) falharam.` : `\nRESTAURAÇÃO VALIDADA: ${checks.length} verificações; banco temporário ${tempDb} removido.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERRO:', redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
