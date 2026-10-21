/**
 * ENSAIO DE RESTAURAÇÃO (restore drill) — prova, com um arquivo de backup DE VERDADE (o gerado por deploy/backup/backup.sh), que ele
 * restaura num banco ISOLADO e que o resultado é um CÓRTEX utilizável. Nunca restaura por cima de banco existente: cria
 * `lnsystem_restore_drill_<timestamp>`, e só esse banco é removido no fim.
 *
 *   npm run backup:drill -- <arquivo-de-backup> [--compare-source] [--boot] [--anonymize]
 *
 * Passos (cada um vira uma linha OK/FALHA com a medida; o tempo total e o da restauração entram no relatório — insumo do RTO):
 *  1. manifesto presente e SHA-256 do arquivo confere (integridade do armazenamento);
 *  2. decifra (se .enc, com BACKUP_ENCRYPTION_KEY_FILE) para um arquivo temporário e `pg_restore --list` lê o sumário;
 *  3. cria o banco isolado e restaura com `--exit-on-error`;
 *  4. `pg_amcheck` (integridade física de tabelas e índices);
 *  5. migrações: quantidade = manifesto = pastas do repositório, todas concluídas, checksum de cada uma = SHA-256 do migration.sql do repositório;
 *  6. esquema: `prisma migrate diff` restaurado × schema.prisma = vazio (sem deriva);
 *  7. RLS no restaurado: todas as tabelas com FORCE RLS, nº de policies igual ao da origem (com --compare-source), papel de runtime sem contexto não lê
 *     nada, com a empresa só a empresa, e gerente de filial só a própria filial;
 *  8. integridade referencial: FKs NOT VALID = exatamente o legado documentado (nem uma a mais) e nenhuma violação nova;
 *  9. --compare-source: linhas das tabelas estáveis iguais às da origem (use logo depois de gerar o backup);
 * 10. --boot: sobe a API de verdade apontando para o restaurado com o papel de runtime e consulta /api/health/ready (precisa de Redis).
 * 11. --anonymize: anonimiza a CÓPIA restaurada (scripts/lib/anonymize.ts; último passo, depois das provas acima) e prova: nenhum valor original amostrado resta em coluna
 *     de texto/JSON, contagem de linhas inalterada, sem coluna sensível fora das regras (strict).
 * Nada de segredo é impresso; URLs com senha nunca vão para a saída.
 *
 * Variáveis (apps/api/.env): RESTORE_ADMIN_URL (DBA do servidor de ensaio), DATABASE_URL (papel de runtime), BACKUP_DATABASE_URL (origem, só com
 * --compare-source), BACKUP_ENCRYPTION_KEY_FILE (se o arquivo for .enc), PG_BIN_DIR.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { contextSqlStatements } from '@ln-system/database';
import { ensureContextSecret } from './lib/rls-context-secret';
import { anonymizeDatabase, defaultPsql } from './lib/anonymize';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REPO = path.resolve(__dirname, '../../..');
const DB_PKG = path.join(REPO, 'packages', 'database');
const bin = (name: string) => (process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, process.platform === 'win32' ? `${name}.exe` : name) : name);
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
};
const redact = (text: string) => text.replace(/(postgres(?:ql)?:\/\/[^:@/\s]+):[^@\s]+@/g, '$1:***@');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const psql = (url: string, sql: string) => {
  try {
    return execFileSync(bin('psql'), [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
      env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    throw new Error(redact(`psql falhou: ${String(error.stderr || '').trim() || error.message}`));
  }
};
/** vários comandos na MESMA sessão (set_config de sessão); devolve a saída do último SELECT. */
const psqlSession = (url: string, setup: string[], sql: string) => {
  try {
    const out = execFileSync(bin('psql'), [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...[...setup, sql].flatMap((s) => ['-c', s])], {
      encoding: 'utf8',
      env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').pop()!.trim();
  } catch (error: any) {
    throw new Error(redact(`psql falhou: ${String(error.stderr || '').trim() || error.message}`));
  }
};

const STABLE_TABLES = [
  'companies', 'branches', 'users', 'roles', 'permissions', 'licenses', 'devices', 'customers', 'motorcycles', 'products',
  'categories', 'suppliers', 'sales', 'sale_items', 'payments', 'cash_registers', 'cash_movements', 'service_orders',
  'purchase_orders', 'fiscal_configs', 'payment_settings', 'monitoring_thresholds', '_prisma_migrations',
];

type Check = { name: string; ok: boolean; detail: string; ms?: number };

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const compareSource = args.includes('--compare-source');
  const boot = args.includes('--boot');
  const anonymize = args.includes('--anonymize');
  if (!file) throw new Error('uso: backup:drill -- <arquivo-de-backup> [--compare-source] [--boot] [--anonymize]');
  const adminUrl = process.env.RESTORE_ADMIN_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!adminUrl || !runtimeUrl) throw new Error('Configure RESTORE_ADMIN_URL e DATABASE_URL em apps/api/.env');
  const backupUrl = process.env.BACKUP_DATABASE_URL;
  if (compareSource && !backupUrl) throw new Error('--compare-source exige BACKUP_DATABASE_URL');

  const sourceDb = new URL(runtimeUrl).pathname.slice(1);
  const tempDb = `lnsystem_restore_drill_${Date.now()}`;
  if (!/^lnsystem_restore_drill_\d+$/.test(tempDb) || tempDb === sourceDb) throw new Error('nome de banco temporário inválido');
  const tempAdmin = withDb(adminUrl, tempDb);
  const tempRuntime = withDb(runtimeUrl, tempDb);

  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string, ms?: number) => checks.push({ name, ok, detail, ms });
  const t0 = Date.now();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-drill-'));
  let dropDb = false;
  let rawDump = file;

  try {
    // 1. integridade do arquivo
    const bytes = fs.readFileSync(file);
    const manifestFile = `${file}.manifest`;
    let manifest: Record<string, string> = {};
    if (fs.existsSync(manifestFile)) {
      manifest = Object.fromEntries(fs.readFileSync(manifestFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      check('manifesto do backup presente', true, `criado_em=${manifest.criado_em} · postgres ${manifest.postgres} · migrações no manifesto ${manifest.migracoes_aplicadas} · cifrado=${manifest.cifrado}`);
      check('SHA-256 do arquivo confere com o manifesto', sha256(bytes) === manifest.sha256, `${bytes.length} bytes · ${sha256(bytes).slice(0, 16)}…`);
    } else {
      check('manifesto do backup presente', false, `${path.basename(manifestFile)} não encontrado (arquivo sem manifesto não prova integridade)`);
    }

    // 2. decifra (se preciso) e lista o sumário
    if (file.endsWith('.enc')) {
      const keyFile = process.env.BACKUP_ENCRYPTION_KEY_FILE;
      if (!keyFile || !fs.existsSync(keyFile)) throw new Error('arquivo .enc: defina BACKUP_ENCRYPTION_KEY_FILE com a chave');
      rawDump = path.join(scratch, 'dump.bin');
      const dec = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `file:${keyFile}`, '-in', file, '-out', rawDump], { encoding: 'utf8' });
      check('arquivo decifrado (AES-256, chave do cofre)', dec.status === 0, dec.status === 0 ? 'ok' : 'falha ao decifrar — chave errada ou arquivo corrompido');
      if (dec.status !== 0) throw new Error('não decifrou');
      const wrong = path.join(scratch, 'wrong.key');
      fs.writeFileSync(wrong, 'chave-errada-de-proposito');
      const bad = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `file:${wrong}`, '-in', file, '-out', path.join(scratch, 'bad.bin')], { encoding: 'utf8' });
      check('com chave errada o backup NÃO abre', bad.status !== 0, bad.status !== 0 ? 'recusado, como esperado' : 'ABRIU com chave errada');
    }
    const toc = execFileSync(bin('pg_restore'), ['--list', rawDump], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const entries = toc.split('\n').filter((l) => l && !l.startsWith(';')).length;
    check('pg_restore --list lê o sumário', entries > 0, `${entries} entradas`);

    // 3. restauração no banco isolado
    psql(adminUrl, `CREATE DATABASE "${tempDb}"`);
    dropDb = true;
    const tr = Date.now();
    try {
      execFileSync(bin('pg_restore'), ['--exit-on-error', '-d', tempAdmin, rawDump], { encoding: 'utf8', env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      check('pg_restore --exit-on-error', true, `restaurado em ${tempDb}`, Date.now() - tr);
    } catch (error: any) {
      check('pg_restore --exit-on-error', false, redact(String(error.stderr || error.message)).slice(0, 500), Date.now() - tr);
      throw new Error('pg_restore falhou');
    }
    const restoreMs = Date.now() - tr;

    // 3b. CONTEXTO DE RLS ASSINADO (decisão 151): o segredo NÃO vai no backup (schema do cofre fica fora do dump). O restaurado exige assinatura e,
    // sem o segredo, NEGA TUDO (falha fechada) até o DBA provisionar. O ensaio prova as duas pontas.
    const vaultInBackup = psql(tempAdmin, "SELECT count(*) FROM pg_namespace WHERE nspname = 'app_ctx_vault'");
    check('o segredo do contexto de RLS NÃO está no backup (cofre fora do dump)', vaultInBackup === '0', `schema do cofre no restaurado: ${vaultInBackup}`);
    const enforcedRestored = psql(tempAdmin, 'SELECT enforced FROM app_ctx.settings'); // status() lê o cofre, que não existe no restaurado
    check('o restaurado EXIGE contexto assinado (a exigência viaja no backup)', enforcedRestored === 't', `enforced=${enforcedRestored}`);
    const probe = psql(tempAdmin, 'SELECT "companyId" FROM users WHERE "companyId" IS NOT NULL LIMIT 1');
    // sem o cofre, a verificação da assinatura (app_ctx._sig_ok) falha ao ler app_ctx_vault.secrets: a consulta é NEGADA com erro (0 linhas ou erro do cofre = falha fechada)
    let deniedBefore: string;
    try {
      deniedBefore = psqlSession(tempRuntime, contextSqlStatements({ companyId: probe, userType: 'COMPANY_ADMIN', branchId: null }), 'SELECT count(*) FROM users');
    } catch (error: any) {
      deniedBefore = String(error.message).includes('app_ctx_vault') ? 'negado (erro: cofre do segredo ausente)' : `erro inesperado: ${String(error.message).slice(0, 120)}`;
    }
    check(
      'restaurado SEM o segredo provisionado: nem o contexto assinado lê nada (falha fechada)',
      deniedBefore === '0' || deniedBefore.startsWith('negado'),
      `users visíveis: ${deniedBefore}`,
    );
    const admDb = new PrismaClient({ datasources: { db: { url: tempAdmin } } });
    try {
      check('segredo provisionado no restaurado pelo DBA (RLS_CONTEXT_SECRET do cofre)', (await ensureContextSecret(admDb)) !== undefined);
    } finally {
      await admDb.$disconnect();
    }

    // 4. pg_amcheck (integridade física)
    const adminU = new URL(adminUrl);
    const ta = Date.now();
    const am = spawnSync(bin('pg_amcheck'), ['--install-missing', '-d', tempDb], {
      encoding: 'utf8',
      env: { ...process.env, PGHOST: adminU.hostname, PGPORT: adminU.port || '5432', PGUSER: decodeURIComponent(adminU.username), PGPASSWORD: decodeURIComponent(adminU.password) },
    });
    check('pg_amcheck: tabelas e índices sem corrupção', am.status === 0, am.status === 0 ? 'nenhum problema' : redact(`${am.stdout}${am.stderr}`).slice(0, 400), Date.now() - ta);

    // 5. migrações
    const migDirs = fs.readdirSync(path.join(DB_PKG, 'prisma', 'migrations')).filter((d) => fs.existsSync(path.join(DB_PKG, 'prisma', 'migrations', d, 'migration.sql'))).sort();
    const rows = psql(tempAdmin, `SELECT migration_name || '|' || checksum || '|' || (finished_at IS NOT NULL) || '|' || (rolled_back_at IS NOT NULL) FROM _prisma_migrations ORDER BY migration_name`).split('\n').filter(Boolean).map((r) => r.split('|'));
    const applied = new Map(rows.filter((r) => r[2] === 'true').map((r) => [r[0], r[1]]));
    // tentativa que falhou e foi marcada `migrate resolve --rolled-back` (e depois reaplicada) é HISTÓRICO legítimo do Prisma: não conta como migração nem como incompleta
    const rolledBack = rows.filter((r) => r[3] === 'true').length;
    const unfinished = rows.filter((r) => r[2] !== 'true' && r[3] !== 'true').length;
    check(
      'migrações do restaurado = pastas do repositório',
      rows.length - rolledBack === migDirs.length && unfinished === 0 && migDirs.every((d) => applied.has(d)),
      `${applied.size} concluídas · ${migDirs.length} no repositório · ${unfinished} incompletas${rolledBack ? ` · ${rolledBack} tentativa(s) revertida(s) no histórico (reaplicada(s))` : ''}`,
    );
    if (manifest.migracoes_aplicadas) check('migrações do restaurado = manifesto do backup', String(applied.size) === manifest.migracoes_aplicadas, `${applied.size} × ${manifest.migracoes_aplicadas}`);
    const badChecksum = migDirs.filter((d) => applied.get(d) !== sha256(fs.readFileSync(path.join(DB_PKG, 'prisma', 'migrations', d, 'migration.sql'))));
    check('checksum de cada migração = SHA-256 do migration.sql do repositório', badChecksum.length === 0, badChecksum.length ? `divergem: ${badChecksum.join(', ')}` : `${migDirs.length}/${migDirs.length} conferem`);

    // 6. esquema × schema.prisma
    const prismaCli = path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js');
    const diff = spawnSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-url', tempAdmin, '--to-schema-datamodel', path.join(DB_PKG, 'prisma', 'schema.prisma'), '--exit-code'], { cwd: DB_PKG, encoding: 'utf8' });
    check('prisma migrate diff (restaurado × schema.prisma) vazio', diff.status === 0, diff.status === 0 ? 'sem deriva' : redact(`${diff.stdout}${diff.stderr}`).slice(0, 400));

    // 7. RLS no restaurado
    const tables = Number(psql(tempAdmin, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations'"));
    const forced = Number(psql(tempAdmin, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity"));
    const policies = Number(psql(tempAdmin, "SELECT count(*) FROM pg_policies WHERE schemaname='public'"));
    check('RLS ligado e FORÇADO nas tabelas de negócio', forced >= tables - 1 && forced > 0, `${forced} com FORCE RLS de ${tables} tabelas · ${policies} policies`);
    if (compareSource) {
      const srcPolicies = Number(psql(withDb(backupUrl!, sourceDb), "SELECT count(*) FROM pg_policies WHERE schemaname='public'"));
      check('policies do restaurado = origem', srcPolicies === policies, `origem ${srcPolicies} · restaurado ${policies}`);
    }
    const owner = psql(tempAdmin, "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname='public'");
    check('dono das tabelas preservado (não é o papel de runtime)', !owner.split(',').includes(decodeURIComponent(new URL(runtimeUrl).username)) || process.env.DRILL_ALLOW_OWNER_EQUALS_RUNTIME === '1', `donos: ${owner}${owner.split(',').includes(decodeURIComponent(new URL(runtimeUrl).username)) ? ' (== runtime: ambiente de desenvolvimento ainda não separou papéis)' : ''}`);
    const [companyId, usersOfCompany] = psql(tempAdmin, 'SELECT "companyId", count(*) FROM users WHERE "companyId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1').split('|');
    const noCtx = psqlSession(tempRuntime, [], 'SELECT count(*) FROM users');
    const withCtx = psqlSession(tempRuntime, contextSqlStatements({ companyId, userType: 'COMPANY_ADMIN', branchId: null }), 'SELECT count(*) FROM users');
    check('papel de runtime sem contexto não lê nada', noCtx === '0', `users sem contexto: ${noCtx}`);
    check('papel de runtime com a empresa lê só a empresa', withCtx === usersOfCompany, `users visíveis ${withCtx} · esperado ${usersOfCompany}`);
    const branchRow = psql(tempAdmin, `SELECT "branchId" || '|' || count(*) FROM users WHERE "companyId"='${companyId}' AND "branchId" IS NOT NULL GROUP BY "branchId" ORDER BY count(*) DESC LIMIT 1`);
    if (branchRow) {
      const [branchId, inBranch] = branchRow.split('|');
      const expected = psql(tempAdmin, `SELECT count(*) FROM users WHERE "companyId"='${companyId}' AND ("branchId"='${branchId}' OR "branchId" IS NULL OR "userType"='COMPANY_ADMIN')`);
      const managerCtx = contextSqlStatements({ companyId, userType: 'MANAGER', branchId });
      const asManager = psqlSession(tempRuntime, managerCtx, 'SELECT count(*) FROM users');
      const otherBranch = psqlSession(tempRuntime, managerCtx, `SELECT count(*) FROM users WHERE "branchId" IS NOT NULL AND "branchId" <> '${branchId}'`);
      check('gerente de filial só lê a própria filial (regra de escopo restaurada)', asManager === expected && otherBranch === '0', `vê ${asManager} (esperado ${expected}; ${inBranch} da filial) · de outras filiais: ${otherBranch}`);
    }

    // 8. integridade referencial
    const notValid = psql(tempAdmin, "SELECT coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname, ',' ORDER BY c.conname), '') FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT convalidated");
    if (compareSource) {
      const notValidSrc = psql(withDb(backupUrl!, sourceDb), "SELECT coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname, ',' ORDER BY c.conname), '') FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT convalidated");
      check('FKs NOT VALID do restaurado = as da origem (legado documentado)', notValid === notValidSrc, notValid ? `${notValid.split(',').length}: ${notValid}` : 'nenhuma');
    } else {
      check('FKs NOT VALID listadas (legado documentado: recibo órfão)', true, notValid ? `${notValid.split(',').length}: ${notValid}` : 'nenhuma');
    }
    const invalidIdx = psql(tempAdmin, "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid");
    check('nenhum índice inválido', invalidIdx === '0', `${invalidIdx} inválido(s)`);

    // 9. comparação com a origem
    if (compareSource) {
      const src = withDb(backupUrl!, sourceDb);
      const diffs = STABLE_TABLES.filter((t) => psql(src, `SELECT count(*) FROM public."${t}"`) !== psql(tempAdmin, `SELECT count(*) FROM public."${t}"`));
      check(`linhas iguais à origem em ${STABLE_TABLES.length} tabelas`, diffs.length === 0, diffs.length ? `divergem (a origem mudou depois do backup?): ${diffs.join(', ')}` : 'todas iguais');
    }

    // 10. a API sobe contra o restaurado, com o papel de runtime
    if (boot) {
      const port = 3991;
      const child = spawn(process.execPath, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(__dirname, '..', 'src', 'index.ts')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: tempRuntime, API_PORT: String(port), NODE_ENV: 'development' },
        stdio: 'ignore',
      });
      let status = 0;
      let body = '';
      try {
        for (let i = 0; i < 45 && status !== 200; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
            status = r.status;
            body = (await r.text()).slice(0, 120);
          } catch {
            /* ainda subindo */
          }
        }
      } finally {
        child.kill();
      }
      check('API sobe contra o banco restaurado (papel de runtime) e /api/health/ready = 200', status === 200, status === 200 ? body : `sem resposta 200 em 45 s (status ${status})`);
    }

    // 11. anonimização da cópia restaurada (banco isolado criado por este ensaio; nunca a origem)
    if (anonymize) {
      const ta = Date.now();
      try {
        const r = anonymizeDatabase({ url: tempAdmin, confirm: tempDb, strict: true, psqlBin: defaultPsql(process.env.PG_BIN_DIR), protectedUrls: [runtimeUrl, backupUrl || ''] });
        check(
          'anonimização da cópia: sem vazamento, linhas inalteradas, cobertura estrita',
          r.leaks.length === 0 && r.rowCountsEqual && r.uncovered.length === 0,
          `${r.updatedTables} tabelas, ${r.deletedRows} linhas de sessão removidas, ${r.sampled} valores originais amostrados e nenhum encontrado`,
          Date.now() - ta,
        );
      } catch (error: any) {
        check('anonimização da cópia: sem vazamento, linhas inalteradas, cobertura estrita', false, redact(String(error.message || error)));
      }
    }

    const total = Date.now() - t0;
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`${c.ok ? 'OK   ' : 'FALHA'} ${c.name} — ${c.detail}${c.ms !== undefined ? ` [${c.ms} ms]` : ''}`);
    console.log(`\nTEMPO: restauração (pg_restore) ${restoreMs} ms · ensaio completo ${total} ms · arquivo ${bytes.length} bytes`);
    console.log(failed.length ? `RESTAURAÇÃO NÃO VALIDADA: ${failed.length} verificação(ões) falharam.` : `RESTAURAÇÃO VALIDADA: ${checks.length} verificações; banco isolado ${tempDb} removido.`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    // erro no meio do caminho: ainda assim mostra o que foi verificado até ali (o resumo final só sai no caminho feliz)
    if (!process.exitCode && checks.some((c) => !c.ok)) for (const c of checks) console.log(`${c.ok ? 'OK   ' : 'FALHA'} ${c.name} — ${c.detail}`);
    if (dropDb && /^lnsystem_restore_drill_\d+$/.test(tempDb)) psql(adminUrl, `DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('ERRO:', redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
