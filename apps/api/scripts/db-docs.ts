/**
 * GERADOR DA DOCUMENTAÇÃO DO BANCO PARA REVISÃO EXTERNA — somente leitura do catálogo do PostgreSQL de desenvolvimento/teste.
 *
 *   npm run db:docs            # imprime um resumo (não grava)
 *   npm run db:docs -- --write # grava os arquivos em docs/CORTEX e o pacote docs/CORTEX/revisao-banco
 *
 * Fontes: catálogo do PostgreSQL (pg_catalog), packages/database/prisma/schema.prisma, as migrations versionadas e a tabela
 * `_prisma_migrations` dos bancos de desenvolvimento e de teste. NÃO lê linha de dado de negócio (nem contagem), não grava nada no banco.
 * Saídas:
 *   - BANCO_DE_DADOS.md            (anexo A, entre marcadores: detalhe de cada tabela)
 *   - MAPA_RELACIONAMENTOS.md      (chaves estrangeiras, relações lógicas sem FK, diagramas Mermaid por domínio)
 *   - RELATORIO_MIGRATIONS.md      (ordem, finalidade, estruturas afetadas, aplicação por ambiente, divergências)
 *   - REVISAO_BANCO_PENDENCIAS.md  (bloco de achados automáticos entre marcadores; o restante é escrito à mão)
 *   - revisao-banco/               (cópia do schema + migrations + SHA256SUMS)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { assertIsTestDatabase, deriveTestDatabaseUrl } from '../test/integration/helpers/test-database';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REPO = path.resolve(__dirname, '../../..');
const DOCS = path.join(REPO, 'docs/CORTEX');
const PRISMA_DIR = path.join(REPO, 'packages/database/prisma');
const MIG_DIR = path.join(PRISMA_DIR, 'migrations');
const BUNDLE = path.join(DOCS, 'revisao-banco');
const TODAY = new Date().toISOString().slice(0, 10);

const DOMAINS: Record<string, string[]> = {
  'Plataforma, identidade e acesso': ['companies', 'branches', 'users', 'roles', 'permissions', 'role_permissions', 'user_roles', 'refresh_tokens', 'access_revocations', 'licenses', 'invoices', 'activations', 'devices', 'device_sessions', 'device_telemetry', 'company_module_settings'],
  'Auditoria, observabilidade e operação': ['audit_logs', 'system_logs', 'request_logs', 'idempotency_keys', 'health_incidents', 'monitoring_alerts', 'monitoring_thresholds', 'monitoring_threshold_changes', 'import_batches', 'privacy_requests'],
  'Políticas e calendário': ['policy_settings', 'policy_changes', 'payment_settings', 'installment_policies', 'business_hours', 'business_calendar_exceptions', 'agenda_unavailabilities'],
  'Catálogo e estoque': ['products', 'product_barcodes', 'product_images', 'categories', 'combo_items', 'stock_movements', 'inventories', 'inventory_counts', 'transfers', 'transfer_items', 'damage_records', 'stock_reservations', 'suppliers', 'purchase_orders', 'purchase_order_items', 'supplier_returns', 'supplier_return_items', 'supplier_return_events'],
  'Clientes, veículos e pós-venda': ['customers', 'motorcycles', 'revisions', 'revision_recommendations', 'follow_ups', 'follow_up_events', 'appointments', 'appointment_events'],
  'Vendas, caixa e pagamento': ['sales', 'sale_items', 'payments', 'payment_exceptions', 'tef_payments', 'cash_registers', 'cash_movements', 'discount_rules', 'discount_events', 'partners'],
  'Financeiro e convênios': ['accounts_payable', 'accounts_receivable', 'collection_attempts', 'agreement_companies', 'employee_agreements', 'employee_agreement_charges', 'employee_payroll_deductions', 'commission_rules', 'mechanic_commissions'],
  'Oficina': ['service_orders', 'service_order_items', 'service_order_status_history', 'service_order_warranties', 'warranty_claims', 'quotes', 'quote_versions', 'quote_items', 'quote_events', 'vehicle_entry_checklists', 'vehicle_entry_checklist_items'],
  'Fiscal': ['fiscal_configs', 'fiscal_documents'],
  'Canais e integração': ['sales_channels', 'channel_api_credentials', 'channel_product_links', 'channel_events', 'channel_inbound_events', 'channel_outbox', 'external_orders', 'external_order_items', 'external_payments', 'fulfillments'],
  'Ajuda e Suporte': [],
};
const UNCLASSIFIED = 'Não classificada';
const FINANCIAL_DOMAINS = new Set(['Vendas, caixa e pagamento', 'Financeiro e convênios', 'Fiscal', 'Oficina', 'Auditoria, observabilidade e operação']);

function domainOf(table: string): string {
  for (const [d, list] of Object.entries(DOMAINS)) if (list.includes(table)) return d;
  if (table.startsWith('support_')) return 'Ajuda e Suporte';
  return UNCLASSIFIED;
}

const ON_ACTION: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const cell = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const code = (s: string): string => '`' + s.replace(/`/g, "'") + '`';
const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const sha256 = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex');

interface Col { table: string; name: string; type: string; notnull: boolean; def: string | null; generated: boolean }
interface Fk { table: string; ref: string; name: string; cols: string; refcols: string; del: string; upd: string }
interface Idx { tablename: string; indexname: string; indexdef: string }
interface Pol { tablename: string; policyname: string; cmd: string; permissive: string; roles: string; qual: string | null; with_check: string | null }
interface Con { table: string; name: string; type: string; def: string }
interface Trg { table: string; name: string; def: string }
interface TableRow { relname: string; rls: boolean; frc: boolean; owner: string }
interface MigRow { migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null; applied_steps_count: number }
interface ModelDoc { model: string; table: string; comment: string }

function parseSchema(): ModelDoc[] {
  const lines = fs.readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8').split(/\r?\n/);
  const out: ModelDoc[] = [];
  let comment: string[] = [];
  let model: string | null = null;
  let table: string | null = null;
  let modelComment = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (model === null) {
      if (line.startsWith('///')) { comment.push(line.replace(/^\/\/\/\s?/, '')); continue; }
      const m = /^model\s+(\w+)\s*\{/.exec(line);
      if (m) { model = m[1]; table = null; modelComment = comment.join(' ').replace(/\s+/g, ' ').trim(); comment = []; continue; }
      if (line !== '') comment = [];
    } else {
      const mp = /@@map\("([^"]+)"\)/.exec(line);
      if (mp) table = mp[1];
      if (line === '}') { out.push({ model, table: table ?? model, comment: modelComment }); model = null; }
    }
  }
  return out;
}

interface MigInfo {
  name: string; purpose: string; rollback: boolean; created: string[]; altered: string[]; indexes: number; policies: number;
  triggers: number; functions: number; dataOps: string[]; destructive: string[]; dynamic: boolean; fileSha: string; fileShaLf: string; bytes: number;
}

function parseMigrations(): MigInfo[] {
  const dirs = fs.readdirSync(MIG_DIR).filter((d) => fs.statSync(path.join(MIG_DIR, d)).isDirectory()).sort();
  return dirs.map((name) => {
    const buf = fs.readFileSync(path.join(MIG_DIR, name, 'migration.sql'));
    const text = buf.toString('utf8');
    const header: string[] = [];
    for (const l of text.split(/\r?\n/)) {
      if (l.trim() === '') { if (header.length) break; else continue; }
      if (!l.startsWith('--')) break;
      header.push(l.replace(/^--\s?/, ''));
    }
    const headerText = header.join(' ').replace(/\s+/g, ' ').trim();
    const sql = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
    const uniq = (re: RegExp, g = 1): string[] => [...new Set([...sql.matchAll(re)].map((m) => m[g]))];
    const created = uniq(/CREATE TABLE (?:IF NOT EXISTS )?(?:"public"\.)?"?(\w+)"?/gi);
    const altered = uniq(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:"public"\.)?"?(\w+)"?/gi).filter((t) => !created.includes(t));
    const dataOps: string[] = [];
    for (const [re, label] of [[/INSERT INTO (?:"public"\.)?"?(\w+)"?/gi, 'INSERT'], [/UPDATE (?:"public"\.)?"(\w+)"\s+SET/gi, 'UPDATE']] as const) {
      for (const t of uniq(re)) dataOps.push(`${label} ${t}`);
    }
    const destructive: string[] = [];
    const flags: Array<[RegExp, string]> = [
      [/DROP TABLE/i, 'DROP TABLE'], [/DROP COLUMN/i, 'DROP COLUMN'], [/\bDELETE FROM\b/i, 'DELETE FROM'], [/\bTRUNCATE\b/i, 'TRUNCATE'],
      [/ALTER COLUMN\s+"?\w+"?\s+(?:SET DATA )?TYPE/i, 'ALTER COLUMN TYPE'], [/RENAME (?:COLUMN|TO)/i, 'RENAME'], [/DROP CONSTRAINT/i, 'DROP CONSTRAINT'],
      [/DROP INDEX/i, 'DROP INDEX'], [/DROP POLICY/i, 'DROP POLICY'], [/SET NOT NULL/i, 'SET NOT NULL'],
    ];
    for (const [re, label] of flags) if (re.test(sql)) destructive.push(label);
    return {
      name, purpose: headerText, rollback: /ROLLBACK/i.test(headerText),
      created, altered, indexes: (sql.match(/CREATE (?:UNIQUE )?INDEX/gi) ?? []).length, policies: (sql.match(/CREATE POLICY/gi) ?? []).length,
      triggers: (sql.match(/CREATE (?:OR REPLACE )?TRIGGER/gi) ?? []).length, functions: (sql.match(/CREATE (?:OR REPLACE )?FUNCTION/gi) ?? []).length,
      dataOps, destructive, dynamic: /\bDO\s+\$/i.test(sql), fileSha: sha256(buf), fileShaLf: sha256(text.replace(/\r\n/g, '\n')), bytes: buf.length,
    };
  });
}

async function readMigrations(url: string | null): Promise<{ rows: MigRow[] | null; note: string }> {
  if (!url) return { rows: null, note: 'URL não disponível' };
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = (await db.$queryRawUnsafe(
      `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count::int AS applied_steps_count FROM _prisma_migrations ORDER BY migration_name`
    )) as MigRow[];
    return { rows, note: 'ok' };
  } catch (e) {
    return { rows: null, note: `não consultado (${e instanceof Error ? e.message.split('\n').pop() : 'erro'})` };
  } finally {
    await db.$disconnect();
  }
}

function writeFile(rel: string, content: string, write: boolean) {
  const full = path.join(REPO, rel);
  if (write) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, 'utf8'); }
}

function replaceBetween(file: string, begin: string, end: string, block: string, fallbackAnchor?: string): string {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const wrapped = `${begin}\n${block}\n${end}\n`;
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b >= 0 && e > b) return existing.slice(0, b) + wrapped + existing.slice(e + end.length).replace(/^\r?\n/, '');
  if (fallbackAnchor) {
    const a = existing.indexOf(fallbackAnchor);
    if (a >= 0) return existing.slice(0, a) + wrapped;
  }
  return existing + (existing && !existing.endsWith('\n') ? '\n' : '') + (existing ? '\n' : '') + wrapped;
}

async function main() {
  const write = process.argv.includes('--write');
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) throw new Error('DATABASE_URL ausente (apps/api/.env).');
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const q = async <T = any>(sql: string): Promise<T[]> => (await db.$queryRawUnsafe(sql)) as T[];

  let tables: TableRow[], cols: Col[], fks: Fk[], idxs: Idx[], pols: Pol[], cons: Con[], trgs: Trg[];
  let version: string, role: { current_user: string; rolsuper: boolean; rolbypassrls: boolean }, extensions: string[], serverTz = '?';
  let devMig: { rows: MigRow[] | null; note: string };
  try {
    tables = await q<TableRow>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS frc, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' ORDER BY c.relname`
    );
    cols = await q<Col>(
      `SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS def, (a.attgenerated::text <> '') AS generated
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> '_prisma_migrations'
        ORDER BY c.relname, a.attnum`
    );
    fks = await q<Fk>(
      `SELECT c.relname AS "table", r.relname AS ref, k.conname AS name,
              (SELECT string_agg(a.attname, ', ' ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS cols,
              (SELECT string_agg(a.attname, ', ' ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS refcols,
              k.confdeltype::text AS del, k.confupdtype::text AS upd
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class r ON r.oid = k.confrelid
        WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace ORDER BY c.relname, k.conname`
    );
    idxs = await q<Idx>(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename, indexname`);
    pols = await q<Pol>(`SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`);
    cons = await q<Con>(
      `SELECT c.relname AS "table", k.conname AS name, k.contype::text AS type, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND k.contype IN ('p', 'u', 'c') AND c.relname <> '_prisma_migrations' ORDER BY c.relname, k.contype, k.conname`
    );
    trgs = await q<Trg>(
      `SELECT c.relname AS "table", t.tgname AS name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY c.relname, t.tgname`
    );
    version = ((await q<{ v: string }>(`SELECT version() AS v`))[0]?.v ?? '').split(',')[0];
    role = (await q(`SELECT current_user::text AS current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`))[0];
    extensions = (await q<{ extname: string }>(`SELECT extname FROM pg_extension ORDER BY extname`)).map((e) => e.extname);
    serverTz = (await q<{ TimeZone: string }>(`SHOW timezone`))[0]?.TimeZone ?? '?';
    devMig = await readMigrations(devUrl);
  } finally {
    await db.$disconnect();
  }

  let testUrl: string | null = null;
  try { testUrl = process.env.TEST_DATABASE_URL || deriveTestDatabaseUrl(devUrl); assertIsTestDatabase(testUrl, devUrl); } catch { testUrl = null; }
  const testMig = await readMigrations(testUrl);

  const models = parseSchema();
  const migs = parseMigrations();
  const dbTables = tables.map((t) => t.relname);
  const schemaTables = models.map((m) => m.table);
  const onlyInDb = dbTables.filter((t) => !schemaTables.includes(t));
  const onlyInSchema = schemaTables.filter((t) => !dbTables.includes(t));
  const modelByName = new Map(models.map((m) => [m.model, m.table]));
  const modelDoc = new Map(models.map((m) => [m.table, m]));

  const colsOf = (t: string) => cols.filter((c) => c.table === t);
  const hasCol = (t: string, c: string) => cols.some((x) => x.table === t && x.name === c);
  const fksOf = (t: string) => fks.filter((f) => f.table === t);
  const polsOf = (t: string) => pols.filter((p) => p.tablename === t);
  const idxOf = (t: string) => idxs.filter((i) => i.tablename === t);
  const consOf = (t: string) => cons.filter((c) => c.table === t);
  const trgOf = (t: string) => trgs.filter((x) => x.table === t);
  const scopeOf = (t: string) => [hasCol(t, 'companyId') ? 'empresa' : null, hasCol(t, 'branchId') ? 'filial' : null].filter(Boolean).join('+') || 'plataforma/global';
  const fkCols = new Set(fks.filter((f) => !f.cols.includes(',')).map((f) => `${f.table}.${f.cols}`));
  const uniqueSingle = new Set<string>();
  for (const i of idxs) {
    const m = /CREATE UNIQUE INDEX .* USING \w+ \("?(\w+)"?\)$/.exec(i.indexdef);
    if (m) uniqueSingle.add(`${i.tablename}.${m[1]}`);
  }
  for (const c of cons) if (c.type === 'p' || c.type === 'u') { const m = /\(("?\w+"?)\)$/.exec(c.def); if (m && !c.def.includes(',')) uniqueSingle.add(`${c.table}.${m[1].replace(/"/g, '')}`); }

  // relações lógicas (coluna *Id sem FK cujo nome aponta um modelo) — INFERIDAS por nome, a conferir
  const camelWords = (s: string): string[] => s.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
  function resolveTarget(colName: string): string | null {
    const base = colName.replace(/Id$/, '');
    if (!base) return null;
    const words = camelWords(pascal(base));
    for (let i = 0; i < words.length; i++) {
      const cand = words.slice(i).join('');
      if (modelByName.has(cand)) return modelByName.get(cand)!;
    }
    return null;
  }
  const logical: Array<{ table: string; col: string; target: string }> = [];
  const unresolved: Array<{ table: string; col: string }> = [];
  for (const c of cols) {
    if (!/[a-z]Id$/.test(c.name) || c.name === 'companyId' || c.name === 'branchId' || fkCols.has(`${c.table}.${c.name}`)) continue;
    const target = resolveTarget(c.name);
    if (target && target !== c.table) logical.push({ table: c.table, col: c.name, target });
    else if (!target) unresolved.push({ table: c.table, col: c.name });
  }
  // companyId: FK simples (companyId) → companies; branchId: FK simples ou composta (companyId, branchId) → branches(companyId, id)
  const scopeLogical = (name: 'companyId' | 'branchId') =>
    tables.filter((t) => hasCol(t.relname, name) && !fksOf(t.relname).some((f) => (name === 'companyId' ? f.cols === name : f.cols.split(/\s*,\s*/).includes(name)))).map((t) => t.relname);

  // referências possivelmente CRUZADAS entre empresas: FK simples (uma coluna) em que filho e pai têm `companyId` e a coluna da FK não é o próprio companyId.
  // A checagem de FK do PostgreSQL não passa pela RLS e a policy da linha filha só olha o companyId DA PRÓPRIA linha: nada no banco impede
  // (companyId = A, <pai> = registro da B). A FK composta (companyId, id) fecha isso (feito em product_barcodes/product_images).
  const crossCandidates = fks
    .filter((f) => !f.cols.includes(',') && f.cols !== 'companyId' && hasCol(f.table, 'companyId') && hasCol(f.ref, 'companyId'))
    .map((f) => ({ child: f.table, col: f.cols, parent: f.ref, del: ON_ACTION[f.del] ?? f.del, parentNullable: !(cols.find((c) => c.table === f.ref && c.name === 'companyId')?.notnull ?? false), childNullable: !(cols.find((c) => c.table === f.table && c.name === 'companyId')?.notnull ?? false) }));
  const crossReport: { checked: number; withCross: Array<{ rel: string; count: number }> } = { checked: 0, withCross: [] };
  const fkCheck: { checked: number; violated: Array<{ rel: string; count: number }> } = { checked: 0, violated: [] };

  // órfãos (opcional, `--orphans`): só CONTAGENS, com o papel de backup (BYPASSRLS, leitura) do banco de DESENVOLVIMENTO — a RLS esconderia as linhas do papel da aplicação
  const orphanReport: { note: string; checked: number; withOrphans: Array<{ rel: string; count: number }> } = { note: 'não executada (rode com `--orphans`; exige BACKUP_DATABASE_URL do banco de desenvolvimento)', checked: 0, withOrphans: [] };
  if (process.argv.includes('--orphans')) {
    const url = process.env.BACKUP_DATABASE_URL;
    const devDb = new URL(devUrl).pathname;
    if (!url) orphanReport.note = 'BACKUP_DATABASE_URL ausente — não executada';
    else if (new URL(url).pathname !== devDb) orphanReport.note = 'BACKUP_DATABASE_URL não aponta para o banco de desenvolvimento — recusada';
    else {
      const rdb = new PrismaClient({ datasources: { db: { url } } });
      try {
        const who = (await rdb.$queryRawUnsafe(`SELECT r.rolbypassrls AS bypass, r.rolsuper AS super FROM pg_roles r WHERE r.rolname = current_user`)) as Array<{ bypass: boolean; super: boolean }>;
        if (!who[0] || !(who[0].bypass || who[0].super)) orphanReport.note = 'o papel de leitura não ignora RLS — contagens seriam falsas; não executada';
        else {
          const checks: Array<{ child: string; col: string; parent: string; kind: string }> = [
            ...scopeLogical('companyId').map((t) => ({ child: t, col: 'companyId', parent: 'companies', kind: 'empresa' })),
            ...scopeLogical('branchId').map((t) => ({ child: t, col: 'branchId', parent: 'branches', kind: 'filial' })),
            ...logical.map((l) => ({ child: l.table, col: l.col, parent: l.target, kind: 'lógica inferida' })),
          ];
          const ident = /^\w+$/;
          for (const c of checks) {
            if (![c.child, c.col, c.parent].every((x) => ident.test(x))) continue;
            const rows = (await rdb.$queryRawUnsafe(
              `SELECT count(*)::int AS n FROM "${c.child}" c WHERE c."${c.col}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${c.parent}" p WHERE p.id = c."${c.col}")`
            )) as Array<{ n: number }>;
            orphanReport.checked++;
            if (rows[0].n > 0) orphanReport.withOrphans.push({ rel: `${c.child}.${c.col} → ${c.parent} (${c.kind})`, count: rows[0].n });
          }
          // FKs DECLARADAS: linha sem pai. Uma FK adicionada por migration pelo dono sob FORCE RLS e sem contexto "valida" em branco (provado em
          // experimento revertido), então a existência da FK não prova que os dados antigos a respeitam — conferimos com o papel que ignora RLS.
          for (const f of fks) {
            const cs = f.cols.split(', ');
            const rs = f.refcols.split(', ');
            if (![f.table, f.ref, ...cs, ...rs].every((x) => ident.test(x))) continue;
            const rows = (await rdb.$queryRawUnsafe(
              `SELECT count(*)::int AS n FROM "${f.table}" c WHERE ${cs.map((x) => `c."${x}" IS NOT NULL`).join(' AND ')} AND NOT EXISTS (SELECT 1 FROM "${f.ref}" p WHERE ${cs.map((x, i) => `p."${rs[i]}" = c."${x}"`).join(' AND ')})`
            )) as Array<{ n: number }>;
            fkCheck.checked++;
            if (rows[0].n > 0) fkCheck.violated.push({ rel: `${f.table}(${f.cols}) → ${f.ref}`, count: rows[0].n });
          }
          for (const c of crossCandidates) {
            if (![c.child, c.col, c.parent].every((x) => ident.test(x))) continue;
            const rows = (await rdb.$queryRawUnsafe(
              `SELECT count(*)::int AS n FROM "${c.child}" c JOIN "${c.parent}" p ON p.id = c."${c.col}" WHERE c."companyId" IS NOT NULL AND p."companyId" IS NOT NULL AND c."companyId" <> p."companyId"`
            )) as Array<{ n: number }>;
            crossReport.checked++;
            if (rows[0].n > 0) crossReport.withCross.push({ rel: `${c.child}.${c.col} → ${c.parent}`, count: rows[0].n });
          }
          orphanReport.note = `executada em ${TODAY} no banco de desenvolvimento (dados sintéticos), somente contagens`;
        }
      } finally {
        await rdb.$disconnect();
      }
    }
  }

  const domainsOrdered = [...Object.keys(DOMAINS), UNCLASSIFIED];
  const byDomain = new Map<string, string[]>(domainsOrdered.map((d) => [d, []]));
  for (const t of dbTables) byDomain.get(domainOf(t))!.push(t);

  // ========================= BANCO_DE_DADOS.md — anexo A =========================
  const L: string[] = [];
  L.push(`## Anexo A — inventário técnico detalhado (gerado em ${TODAY}; \`npm run db:docs -- --write\`)`);
  L.push('');
  L.push(`Fonte: catálogo do PostgreSQL do banco de **desenvolvimento** (dados sintéticos; nenhuma linha de dado foi lida) — ${version}. **${tables.length} tabelas**, ${models.length} modelos no schema Prisma. Cada tabela traz domínio, finalidade (comentário do modelo no schema, quando existe), escopo, RLS, colunas, chaves, índices, constraints e políticas. Não há segredo nem dado de cliente neste arquivo (só estrutura).`);
  L.push('');
  L.push('### Índice por domínio');
  L.push('');
  for (const d of domainsOrdered) {
    const list = byDomain.get(d)!;
    if (!list.length) continue;
    // a âncora é a do título da tabela (#### `nome`): o verificador de links da CI e o GitHub geram o mesmo "nome"
    L.push(`**${d}** (${list.length}): ` + list.map((t) => `[${t}](#${t})`).join(' · '));
    L.push('');
  }
  for (const d of domainsOrdered) {
    const list = byDomain.get(d)!;
    if (!list.length) continue;
    L.push(`### ${d}`);
    L.push('');
    for (const t of list) {
      const info = tables.find((x) => x.relname === t)!;
      const md = modelDoc.get(t);
      L.push(`#### ${code(t)}`);
      L.push('');
      L.push(`- **Modelo Prisma:** ${md ? code(md.model) : '— (sem modelo)'} · **Escopo:** ${scopeOf(t)} · **RLS:** ${info.rls ? 'habilitada' : 'NÃO habilitada'} / ${info.frc ? 'forçada' : 'NÃO forçada'} · **Policies:** ${polsOf(t).length} · **Dono:** ${info.owner}`);
      L.push(`- **Finalidade (comentário do schema):** ${md && md.comment ? cell(md.comment).slice(0, 420) + (md.comment.length > 420 ? '…' : '') : '— (sem comentário no modelo; ver a seção do domínio em §2)'}`);
      L.push('');
      L.push('| Coluna | Tipo | Nulo | Padrão |');
      L.push('|---|---|---|---|');
      for (const c of colsOf(t)) L.push(`| ${code(c.name)} | ${cell(c.type)} | ${c.notnull ? 'não' : 'sim'} | ${c.def ? code(cell(c.def)) : c.generated ? 'gerada' : ''} |`);
      L.push('');
      const pk = consOf(t).find((c) => c.type === 'p');
      L.push(`- **Chave primária:** ${pk ? code(cell(pk.def.replace(/^PRIMARY KEY /, ''))) : '— **sem chave primária**'}`);
      const f = fksOf(t);
      L.push(`- **Chaves estrangeiras:** ${f.length ? '' : 'nenhuma (isolamento por RLS, não por FK)'}`);
      for (const x of f) L.push(`  - ${code(x.cols)} → ${code(`${x.ref}(${x.refcols})`)} · ao apagar: **${ON_ACTION[x.del] ?? x.del}** · ao atualizar: ${ON_ACTION[x.upd] ?? x.upd}`);
      const uq = consOf(t).filter((c) => c.type === 'u' || c.type === 'c');
      L.push(`- **Únicos e CHECK (constraints):** ${uq.length ? '' : 'nenhum'}`);
      for (const x of uq) L.push(`  - ${x.type === 'u' ? 'único' : 'check'} ${code(x.name)}: ${code(cell(x.def))}`);
      const ix = idxOf(t);
      L.push(`- **Índices (${ix.length}):**`);
      for (const x of ix) L.push(`  - ${code(x.indexname)} — ${code(cell(x.indexdef.replace(/^CREATE /, '').replace(/ ON public\.\S+ /, ' ')))}`);
      const p = polsOf(t);
      L.push(`- **Políticas RLS:** ${p.length ? '' : '**nenhuma**'}`);
      for (const x of p) L.push(`  - ${code(x.policyname)} (${x.cmd}, ${x.permissive.toLowerCase()}, roles ${x.roles}): USING ${code(cell(x.qual ?? '—'))}${x.with_check ? ` · WITH CHECK ${code(cell(x.with_check))}` : ''}`);
      const tg = trgOf(t);
      if (tg.length) { L.push('- **Triggers:**'); for (const x of tg) L.push(`  - ${code(x.name)}: ${code(cell(x.def).replace(/^CREATE (?:CONSTRAINT )?TRIGGER \S+ /, '').replace(/ ON public\.\S+/, ''))}`); }
      L.push('');
    }
  }
  const annex = L.join('\n');

  // ========================= MAPA_RELACIONAMENTOS.md =========================
  const M: string[] = [];
  M.push('# Mapa de relacionamentos do banco de dados');
  M.push('');
  M.push(`> Gerado em ${TODAY} por \`npm run db:docs -- --write\` a partir do catálogo do PostgreSQL de **desenvolvimento** (${version}), sem ler dado de negócio. Complementa [BANCO_DE_DADOS](BANCO_DE_DADOS.md) (por tabela) e [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md) (riscos).`);
  M.push('');
  M.push('## 1. Como ler');
  M.push('');
  M.push('- **FK declarada** = chave estrangeira real no banco (ao apagar o pai: ver a regra).');
  M.push('- **Relação lógica (sem FK)** = coluna `…Id` cujo nome aponta um modelo, mas **sem** chave estrangeira — a convenção do projeto para quase todo dado de empresa/filial (o isolamento vem da **RLS**, não de FK). É **inferida pelo nome da coluna** (heurística) e deve ser conferida; o que não resolve para um modelo aparece em §6.');
  M.push(`- Contagens: **${tables.length} tabelas**, **${fks.length} FKs declaradas**, **${logical.length} relações lógicas sem FK** inferidas (fora \`companyId\`/\`branchId\`), ${unresolved.length} colunas \`…Id\` sem alvo inferido.`);
  M.push('');
  M.push('## 2. Cadeias principais (empresa → filial → usuário → catálogo → estoque → venda → caixa → compra → pagamento)');
  M.push('');
  M.push('Cada linha é verificada contra o catálogo: **FK** (declarada), **lógica** (coluna existe, sem FK) ou **coluna não encontrada**.');
  M.push('');
  M.push('| Módulo | Filho.coluna | → Pai | Situação | Ao apagar o pai |');
  M.push('|---|---|---|---|---|');
  const chains: Array<[string, string, string, string]> = [
    ['Empresa/filial', 'branches', 'companyId', 'companies'], ['Empresa/filial', 'licenses', 'companyId', 'companies'], ['Empresa/filial', 'invoices', 'companyId', 'companies'],
    ['Usuários', 'users', 'companyId', 'companies'], ['Usuários', 'users', 'branchId', 'branches'], ['Usuários', 'user_roles', 'userId', 'users'], ['Usuários', 'user_roles', 'roleId', 'roles'],
    ['Usuários', 'role_permissions', 'roleId', 'roles'], ['Usuários', 'role_permissions', 'permissionId', 'permissions'], ['Usuários', 'refresh_tokens', 'userId', 'users'],
    ['Produtos', 'products', 'categoryId', 'categories'], ['Produtos', 'products', 'companyId', 'companies'], ['Produtos', 'product_barcodes', 'productId', 'products'], ['Produtos', 'product_images', 'productId', 'products'], ['Produtos', 'combo_items', 'productId', 'products'],
    ['Estoque', 'stock_movements', 'productId', 'products'], ['Estoque', 'stock_movements', 'branchId', 'branches'], ['Estoque', 'stock_movements', 'userId', 'users'],
    ['Estoque', 'stock_reservations', 'productId', 'products'], ['Estoque', 'transfer_items', 'transferId', 'transfers'], ['Estoque', 'transfer_items', 'productId', 'products'], ['Estoque', 'inventory_counts', 'inventoryId', 'inventories'], ['Estoque', 'inventory_counts', 'productId', 'products'], ['Estoque', 'damage_records', 'productId', 'products'],
    ['Vendas', 'sales', 'customerId', 'customers'], ['Vendas', 'sales', 'userId', 'users'], ['Vendas', 'sales', 'branchId', 'branches'], ['Vendas', 'sales', 'cashRegisterId', 'cash_registers'],
    ['Vendas', 'sale_items', 'saleId', 'sales'], ['Vendas', 'sale_items', 'productId', 'products'],
    ['Caixa', 'cash_registers', 'branchId', 'branches'], ['Caixa', 'cash_registers', 'userId', 'users'], ['Caixa', 'cash_movements', 'cashRegisterId', 'cash_registers'],
    ['Pagamentos', 'payments', 'saleId', 'sales'], ['Pagamentos', 'tef_payments', 'saleId', 'sales'], ['Pagamentos', 'payment_exceptions', 'paymentId', 'payments'],
    ['Compras', 'purchase_orders', 'supplierId', 'suppliers'], ['Compras', 'purchase_order_items', 'purchaseOrderId', 'purchase_orders'], ['Compras', 'purchase_order_items', 'productId', 'products'],
    ['Compras', 'supplier_returns', 'supplierId', 'suppliers'], ['Compras', 'supplier_return_items', 'returnId', 'supplier_returns'],
    ['Financeiro', 'accounts_receivable', 'customerId', 'customers'], ['Financeiro', 'accounts_payable', 'supplierId', 'suppliers'], ['Financeiro', 'collection_attempts', 'receivableId', 'accounts_receivable'],
    ['Oficina', 'service_orders', 'customerId', 'customers'], ['Oficina', 'service_orders', 'motorcycleId', 'motorcycles'], ['Oficina', 'service_order_items', 'serviceOrderId', 'service_orders'], ['Oficina', 'motorcycles', 'customerId', 'customers'],
    ['Fiscal', 'fiscal_documents', 'saleId', 'sales'], ['Fiscal', 'fiscal_documents', 'serviceOrderId', 'service_orders'],
    ['Canais', 'external_orders', 'channelId', 'sales_channels'], ['Canais', 'external_order_items', 'orderId', 'external_orders'], ['Canais', 'channel_product_links', 'productId', 'products'],
    ['Privacidade (subjectId é polimórfico, conforme subjectType)', 'privacy_requests', 'subjectId', 'customers'], ['Equipamento', 'device_sessions', 'deviceId', 'devices'],
  ];
  let chainMissing = 0;
  for (const [mod, child, col, parent] of chains) {
    const fk = fksOf(child).find((f) => f.cols === col && f.ref === parent);
    let state: string; let del = '—';
    if (fk) { state = '**FK**'; del = ON_ACTION[fk.del] ?? fk.del; }
    else if (!hasCol(child, col)) { state = 'coluna não encontrada'; chainMissing++; }
    else { state = 'lógica (sem FK)'; }
    M.push(`| ${mod} | ${code(`${child}.${col}`)} | ${code(parent)} | ${state} | ${del} |`);
  }
  M.push('');
  M.push(`Linhas "coluna não encontrada": **${chainMissing}** (nome da coluna difere do esperado; ver a tabela em [BANCO_DE_DADOS](BANCO_DE_DADOS.md)).`);
  M.push('');
  M.push('## 3. Chaves estrangeiras declaradas (todas)');
  M.push('');
  const delCount: Record<string, number> = {};
  for (const f of fks) delCount[ON_ACTION[f.del] ?? f.del] = (delCount[ON_ACTION[f.del] ?? f.del] ?? 0) + 1;
  M.push(`Total **${fks.length}**. Por regra ao apagar o pai: ${Object.entries(delCount).map(([k, v]) => `${k} ${v}`).join(' · ')}.`);
  M.push('');
  M.push('| Domínio (filho) | Filho.coluna | → Pai.coluna | Ao apagar | Ao atualizar |');
  M.push('|---|---|---|---|---|');
  for (const d of domainsOrdered) for (const t of byDomain.get(d)!) for (const f of fksOf(t)) M.push(`| ${d} | ${code(`${t}.${f.cols}`)} | ${code(`${f.ref}.${f.refcols}`)} | ${ON_ACTION[f.del] ?? f.del} | ${ON_ACTION[f.upd] ?? f.upd} |`);
  M.push('');
  M.push('## 4. Escopo de empresa e filial (FK + FK composta + RLS)');
  M.push('');
  const noCompanyFk = scopeLogical('companyId');
  const noBranchFk = scopeLogical('branchId');
  M.push(`- Tabelas com \`companyId\`: **${tables.filter((t) => hasCol(t.relname, 'companyId')).length}** — sem FK para \`companies\`: **${noCompanyFk.length}**${noCompanyFk.length ? ` (${noCompanyFk.map((t) => code(t)).join(', ')} — retenção/telemetria/idempotência, sem dado de negócio a preservar; a policy RLS filtra por \`companyId\`)` : ''}.`);
  M.push(`- Tabelas com \`branchId\`: **${tables.filter((t) => hasCol(t.relname, 'branchId')).length}** — sem FK para \`branches\`: **${noBranchFk.length}**${noBranchFk.length ? ` (${noBranchFk.map((t) => code(t)).join(', ')})` : ''}.`);
  M.push(`- Tabelas **sem** \`companyId\` (${tables.filter((t) => !hasCol(t.relname, 'companyId')).length}): ${tables.filter((t) => !hasCol(t.relname, 'companyId')).map((t) => code(t.relname)).join(', ')}.`);
  M.push('');
  M.push('Consequência: o banco **recusa** (P2003) `companyId` inexistente (fora as tabelas de retenção listadas acima) e filial inexistente ou de outra empresa (FK composta `(companyId, branchId) → branches(companyId, id)`); a RLS (`WITH CHECK`) isola leitura e escrita por empresa/filial; a camada de serviço valida as regras de negócio. Ver [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md).');
  M.push('');
  M.push('## 5. Relações lógicas sem FK (inferidas por nome — conferir)');
  M.push('');
  const logicalByTarget = new Map<string, number>();
  for (const l of logical) logicalByTarget.set(l.target, (logicalByTarget.get(l.target) ?? 0) + 1);
  M.push(`Alvos mais referenciados sem FK: ${[...logicalByTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${code(k)} ${v}`).join(' · ')}.`);
  M.push('');
  M.push('| Domínio (origem) | Origem.coluna | → Alvo inferido |');
  M.push('|---|---|---|');
  for (const d of domainsOrdered) for (const t of byDomain.get(d)!) for (const l of logical.filter((x) => x.table === t)) M.push(`| ${d} | ${code(`${t}.${l.col}`)} | ${code(l.target)} |`);
  M.push('');
  M.push('## 6. Colunas `…Id` sem FK e sem alvo inferido');
  M.push('');
  M.push(unresolved.length ? unresolved.map((u) => code(`${u.table}.${u.col}`)).join(', ') : 'nenhuma');
  M.push('');
  M.push('São identificadores externos (ex.: provedor, canal), referências polimórficas ou nomes que não coincidem com um modelo. Não é afirmação de que estejam corretos: cabe revisão humana.');
  M.push('');
  M.push('## 7. Tabelas sem nenhum relacionamento (nem FK nem lógico)');
  M.push('');
  const participates = new Set<string>();
  for (const f of fks) { participates.add(f.table); participates.add(f.ref); }
  for (const l of logical) { participates.add(l.table); participates.add(l.target); }
  const isolated = dbTables.filter((t) => !participates.has(t));
  M.push(isolated.length ? isolated.map((t) => `${code(t)} (${domainOf(t)}; ${scopeOf(t)})`).join(', ') : 'nenhuma');
  M.push('');
  M.push('## 8. Diagramas por domínio (Mermaid)');
  M.push('');
  M.push('Linha cheia = FK declarada; linha pontilhada = relação lógica sem FK (inferida). `companyId`/`branchId` sem FK não são desenhados (ver §4).');
  M.push('');
  for (const d of domainsOrdered) {
    const list = byDomain.get(d)!;
    if (!list.length) continue;
    const edges: string[] = [];
    for (const t of list) {
      for (const f of fksOf(t)) {
        const card = f.cols.includes(',') ? 'o{' : uniqueSingle.has(`${t}.${f.cols}`) ? 'o|' : 'o{';
        edges.push(`  ${f.ref} ||--${card} ${t} : "${f.cols}"`);
      }
      for (const l of logical.filter((x) => x.table === t)) edges.push(`  ${l.target} ||..o{ ${t} : "${l.col} sem FK"`);
    }
    M.push(`### ${d}`);
    M.push('');
    if (!edges.length) { M.push('_Sem relacionamentos declarados ou inferidos dentro deste domínio._'); M.push(''); continue; }
    M.push('```mermaid');
    M.push('erDiagram');
    M.push(...edges);
    M.push('```');
    M.push('');
  }
  const mapa = M.join('\n') + '\n';

  // ========================= RELATORIO_MIGRATIONS.md =========================
  const devRows = new Map((devMig.rows ?? []).map((r) => [r.migration_name, r]));
  const testRows = new Map((testMig.rows ?? []).map((r) => [r.migration_name, r]));
  const envState = (rows: Map<string, MigRow>, available: boolean, name: string, fileSha: string, fileShaLf: string) => {
    if (!available) return 'não consultado';
    const r = rows.get(name);
    if (!r) return '**não aplicada**';
    if (r.rolled_back_at) return '**revertida**';
    if (!r.finished_at) return '**incompleta**';
    const ok = r.checksum === fileSha || r.checksum === fileShaLf;
    return `aplicada ${r.finished_at.toISOString().slice(0, 10)}${ok ? '' : ' · **checksum diferente do arquivo**'}`;
  };
  const R: string[] = [];
  R.push('# Relatório de migrations');
  R.push('');
  R.push(`> Gerado em ${TODAY} por \`npm run db:docs -- --write\`. Fonte: \`packages/database/prisma/migrations\` (arquivos), \`_prisma_migrations\` dos bancos de **desenvolvimento** e de **teste**, e a comparação com o schema Prisma. **Staging e produção não existem/não foram verificados** — a coluna correspondente é uma pendência, não uma afirmação.`);
  R.push('');
  R.push(`- Migrations versionadas: **${migs.length}** (ordem de execução = ordem lexicográfica do nome, a mesma do Prisma). Provedor: PostgreSQL (\`migration_lock.toml\`).`);
  R.push(`- Banco de desenvolvimento: ${devMig.note === 'ok' ? `${devMig.rows!.length} registradas em \`_prisma_migrations\`` : devMig.note}. Banco de teste: ${testMig.note === 'ok' ? `${testMig.rows!.length} registradas` : testMig.note}.`);
  R.push(`- PostgreSQL consultado: ${version}. Extensões instaladas: ${extensions.join(', ')}.`);
  const unapplied = migs.filter((m) => devMig.rows && !devRows.get(m.name)?.finished_at).map((m) => m.name);
  const orphanDb = (devMig.rows ?? []).filter((r) => !migs.some((m) => m.name === r.migration_name)).map((r) => r.migration_name);
  const checksumBad = migs.filter((m) => { const r = devRows.get(m.name); return r && r.checksum !== m.fileSha && r.checksum !== m.fileShaLf; }).map((m) => m.name);
  const lfOnly = migs.filter((m) => { const r = devRows.get(m.name); return r && r.checksum !== m.fileSha && r.checksum === m.fileShaLf; }).map((m) => m.name);
  R.push('');
  R.push('## 1. Resumo das divergências');
  R.push('');
  R.push('| Verificação | Resultado |');
  R.push('|---|---|');
  R.push(`| Migrations do repositório não aplicadas no dev | ${unapplied.length ? unapplied.map(code).join(', ') : 'nenhuma'} |`);
  R.push(`| Migrations aplicadas no dev que não existem no repositório | ${orphanDb.length ? orphanDb.map(code).join(', ') : 'nenhuma'} |`);
  R.push(`| Arquivo alterado depois de aplicado (checksum do dev ≠ arquivo) | ${checksumBad.length ? checksumBad.map(code).join(', ') : 'nenhum'} |`);
  R.push(`| Checksum só confere após normalizar CRLF→LF (fim de linha do checkout; sem alteração de conteúdo) | ${lfOnly.length ? lfOnly.length + ' arquivo(s)' : 'nenhum'} |`);
  R.push(`| Tabelas no banco sem modelo no schema | ${onlyInDb.length ? onlyInDb.map(code).join(', ') : 'nenhuma'} |`);
  R.push(`| Modelos do schema sem tabela no banco | ${onlyInSchema.length ? onlyInSchema.map(code).join(', ') : 'nenhum'} |`);
  R.push(`| Migrations com operação potencialmente destrutiva (DROP/DELETE/RENAME/ALTER TYPE/SET NOT NULL) | ${migs.filter((m) => m.destructive.length).length} de ${migs.length} (§2) |`);
  R.push('');
  R.push('O diff schema × banco (diferenças que o Prisma não representa) e a prova de que a cadeia de migrations, aplicada do zero em um banco vazio, reproduz o mesmo schema estão na §4.');
  R.push('');
  R.push('## 2. Relação das migrations (ordem de execução)');
  R.push('');
  R.push('| # | Migration | Finalidade (cabeçalho do arquivo) | Reversão documentada | Tabelas criadas | Tabelas alteradas | Índices | Policies | Operações a conferir | Dev | Teste | Staging / produção |');
  R.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  migs.forEach((m, i) => {
    const ops = [...m.destructive, ...m.dataOps.map((d) => `dados: ${d}`), ...(m.dynamic ? ['bloco DO $$'] : [])];
    const purpose = m.purpose ? cell(m.purpose).slice(0, 260) + (m.purpose.length > 260 ? '…' : '') : '(sem cabeçalho descritivo)';
    R.push(`| ${i + 1} | ${code(m.name)} | ${purpose} | ${m.rollback ? 'sim' : 'não'} | ${m.created.length ? m.created.map(code).join(', ') : '—'} | ${m.altered.length ? m.altered.map(code).join(', ') : '—'} | ${m.indexes} | ${m.policies} | ${ops.length ? cell(ops.join('; ')) : '—'} | ${envState(devRows, !!devMig.rows, m.name, m.fileSha, m.fileShaLf)} | ${envState(testRows, !!testMig.rows, m.name, m.fileSha, m.fileShaLf)} | **não aplicada** (ambiente inexistente / não verificado) |`);
  });
  R.push('');
  R.push('Notas: "Operações a conferir" é uma varredura textual do SQL (não executa nada) — marca o que merece olhar humano antes de rodar em produção; **não** significa que a operação seja inadequada. `SET NOT NULL` aparece quando uma coluna passa a ser obrigatória; `bloco DO $$` indica SQL dinâmico (ex.: RLS aplicada em laço), que a varredura não consegue listar tabela a tabela.');
  R.push('');
  R.push('## 3. Estruturas por migration (detalhe)');
  R.push('');
  for (const m of migs) {
    R.push(`### ${code(m.name)}`);
    R.push('');
    R.push(`- Arquivo: ${m.bytes} bytes · sha256 ${code(m.fileSha.slice(0, 16))}…`);
    R.push(`- Finalidade: ${m.purpose ? cell(m.purpose) : '(sem cabeçalho descritivo)'}`);
    R.push(`- Tabelas criadas: ${m.created.length ? m.created.map(code).join(', ') : '—'}`);
    R.push(`- Tabelas alteradas: ${m.altered.length ? m.altered.map(code).join(', ') : '—'} · índices criados: ${m.indexes} · policies criadas: ${m.policies} · triggers: ${m.triggers} · funções: ${m.functions}`);
    R.push(`- Dados: ${m.dataOps.length ? m.dataOps.join('; ') : 'nenhuma carga/atualização de dados'} · operações a conferir: ${m.destructive.length ? m.destructive.join(', ') : 'nenhuma'}${m.dynamic ? ' · contém bloco DO $$' : ''}`);
    R.push('');
  }
  const replayFile = path.join(BUNDLE, 'replay-resultado.md');
  R.push('## 4. Schema × migrations × banco');
  R.push('');
  R.push('### 4.1 Diferenças do banco de desenvolvimento para o schema Prisma');
  R.push('');
  const driftFile = path.join(BUNDLE, 'drift-dev.txt');
  R.push(fs.existsSync(driftFile) ? '```sql\n' + fs.readFileSync(driftFile, 'utf8').trim() + '\n```' : '_Arquivo `revisao-banco/drift-dev.txt` ainda não gerado (rodar `prisma migrate diff`, ver REVISAO_BANCO_PENDENCIAS)._');
  R.push('');
  R.push('### 4.2 Reaplicação das migrations do zero em banco vazio');
  R.push('');
  R.push(fs.existsSync(replayFile) ? fs.readFileSync(replayFile, 'utf8').trim() : '_Ainda não executada (`npm run db:replay-check`)._');
  R.push('');
  R.push('### 4.3 Validação de FK sob FORCE RLS (achado desta revisão)');
  R.push('');
  R.push('Todas as tabelas de empresa são `FORCE ROW LEVEL SECURITY` e a migration roda como o **dono** (o mesmo papel da aplicação), **sem** contexto de empresa. Nesse cenário o dono enxerga **zero linhas**: um `ADD CONSTRAINT … FOREIGN KEY` sobre tabela populada "valida" uma tabela aparentemente vazia e é criado **mesmo com linha que o viola**. Provado em experimento revertido no banco de teste: com uma linha cruzada, o `ADD CONSTRAINT` passou; com `app.user_type = SUPER_ADMIN` (contexto de plataforma) ele falhou como deveria. Consequências: (1) a existência de uma FK não prova que os dados antigos a respeitam — por isso o achado D2b confere todas as FKs com o papel que ignora RLS; (2) toda migration que acrescente FK/constraint sobre tabela populada precisa de uma **guarda explícita** que leia com `set_config(\'app.user_type\', \'SUPER_ADMIN\', true)`. Foi o que `20261014155900_guard_product_children_same_company` passou a fazer (aborta com mensagem clara antes das FKs compostas; testado em banco temporário com dado cruzado — §4.2, cenário com dados).');
  R.push('');
  R.push('### 4.4 Reconciliação de checksum documentada (migration `20261014160000_product_children_same_company`)');
  R.push('');
  R.push('A nota do cabeçalho dessa migration dizia que ela "falha e nada muda" se houvesse dado cruzado — o que o experimento da §4.3 **refutou**. Como a migration tinha acabado de ser criada e só estava aplicada nos bancos locais de desenvolvimento e teste (sem dado cruzado), o **comentário do cabeçalho foi corrigido** (nenhuma instrução SQL mudou) e o checksum registrado em `_prisma_migrations` desses dois bancos foi atualizado de `25802e0c30055e16…` para `55553f4ca2cb8265…` (apenas metadado, sem tocar em estrutura nem dado). Em staging/produção a migration nunca foi aplicada, então não há reconciliação a fazer lá. A guarda foi criada como migration **separada** (`20261014155900…`, nome anterior) em vez de editar mais a existente.');
  R.push('');
  R.push('### 4.5 Tentativa abortada de `20261014180000_composite_company_fks` no banco de desenvolvimento (`_prisma_migrations` tem 1 linha a mais)');
  R.push('');
  R.push('A primeira execução dessa migration no dev **falhou** (a lista de restrições gerada pelo `psql` do Windows trouxe um caractere de retorno de carro (CR) no nome de uma FK) e, como cada migration roda numa única transação, **nada ficou aplicado** (conferido: sem a FK composta e com a FK simples antiga intacta). O procedimento padrão foi seguido: `prisma migrate resolve --rolled-back 20261014180000_composite_company_fks` (marca a tentativa como revertida: `rolled_back_at` preenchido, `applied_steps_count = 0`), correção do gerador e novo `migrate deploy`, que concluiu. Por isso o dev tem **duas** linhas desse nome (a revertida e a concluída), uma a mais que o banco de teste, onde a migration foi aplicada uma única vez. Nenhum checksum foi editado e nenhuma migration foi marcada como aplicada sem comprovação. O mesmo procedimento está provado em banco temporário pelos cenários de dados do `db:replay-check`.');
  R.push('');
  R.push('## 5. Staging e produção');
  R.push('');
  R.push('Nenhuma migration foi aplicada fora de desenvolvimento e teste. Procedimento (sempre **depois de um backup restaurável**): `prisma migrate deploy --schema=packages/database/prisma/schema.prisma`, depois `npm run db:check-rls` ([PRODUCAO §4 e §13–14](PRODUCAO.md)). Compatibilidade de versão: o `docker-compose.yml` usa `postgres:18-alpine`; este relatório consultou **' + version + '** — a execução em PostgreSQL 18 real (Linux) é uma pendência de infraestrutura.');
  R.push('');
  const relatorio = R.join('\n') + '\n';

  // ========================= achados automáticos (REVISAO_BANCO_PENDENCIAS.md) =========================
  const F: string[] = [];
  const noRls = tables.filter((t) => !t.rls || !t.frc).map((t) => t.relname);
  const noPolicy = tables.filter((t) => polsOf(t.relname).length === 0).map((t) => t.relname);
  const noPk = dbTables.filter((t) => !consOf(t).some((c) => c.type === 'p'));
  const nullableCompany = cols.filter((c) => c.name === 'companyId' && !c.notnull).map((c) => c.table);
  const noCompanyTables = tables.filter((t) => !hasCol(t.relname, 'companyId')).map((t) => t.relname);
  const branchNotInPolicy = tables.filter((t) => hasCol(t.relname, 'branchId') && polsOf(t.relname).length && !polsOf(t.relname).some((p) => /branch/i.test(`${p.qual ?? ''} ${p.with_check ?? ''}`))).map((t) => t.relname);
  const isTrue = (s: string | null) => !!s && /^\(?true\)?$/i.test(s.trim());
  // INSERT só tem WITH CHECK (sem USING, por definição): é fraca quando o check falta ou é `true`; as demais, quando o USING falta ou é `true`.
  const weakPolicies = pols
    .filter((p) => (p.cmd === 'INSERT' ? !p.with_check || isTrue(p.with_check) : !p.qual || isTrue(p.qual) || isTrue(p.with_check)))
    .map((p) => `${p.tablename}.${p.policyname} (${p.cmd}: ${p.cmd === 'INSERT' ? p.with_check ?? 'sem check' : isTrue(p.with_check) ? `WITH CHECK ${p.with_check}` : p.qual ?? 'sem condição'})`);
  const cascades = fks.filter((f) => f.del === 'c');
  const noCompanyIndex = tables.filter((t) => hasCol(t.relname, 'companyId') && !idxOf(t.relname).some((i) => /\(\s*"?companyId"?\s*[,)]/.test(i.indexdef))).map((t) => t.relname);
  const sensitive = cols.filter((c) => /password|secret|token|hash|seed|backupcode|apikey|credential|cpf|cnpj|document|email|phone|address|birth|plate|chassis/i.test(c.name));
  const appendOnly = ['audit_logs', 'collection_attempts', 'discount_events', 'policy_changes', 'monitoring_threshold_changes', 'service_order_status_history', 'revisions', 'stock_movements', 'cash_movements', 'sale_items'];
  F.push(`### A. Estrutura e RLS (consulta ao catálogo em ${TODAY})`);
  F.push('');
  F.push(`| Verificação | Resultado |`);
  F.push(`|---|---|`);
  F.push(`| Tabelas (banco) / modelos (schema) | ${tables.length} / ${models.length}${onlyInDb.length || onlyInSchema.length ? ' — **diferem**' : ' — coincidem'} |`);
  F.push(`| Tabelas sem RLS habilitada **e** forçada | ${noRls.length ? noRls.map(code).join(', ') : '0'} |`);
  F.push(`| Tabelas com RLS e **nenhuma** policy | ${noPolicy.length ? noPolicy.map(code).join(', ') : '0'} |`);
  F.push(`| Tabelas sem chave primária | ${noPk.length ? noPk.map(code).join(', ') : '0'} |`);
  F.push(`| Policies sem condição ou \`true\` | ${weakPolicies.length ? weakPolicies.map(code).join(', ') : '0'} |`);
  F.push(`| \`companyId\` anulável (linha sem dono de empresa) | ${nullableCompany.length ? nullableCompany.map(code).join(', ') : '0'} |`);
  F.push(`| Tabelas com \`branchId\` cuja policy **não** menciona filial | ${branchNotInPolicy.length ? `${branchNotInPolicy.length}: ` + branchNotInPolicy.map(code).join(', ') : '0'} |`);
  F.push(`| Tabelas com \`companyId\` sem índice que comece por \`companyId\` | ${noCompanyIndex.length ? `${noCompanyIndex.length}: ` + noCompanyIndex.map(code).join(', ') : '0'} |`);
  F.push(`| Papel de conexão desta consulta | ${code(role.current_user)} — superusuário: ${role.rolsuper ? '**SIM**' : 'não'}; ignora RLS: ${role.rolbypassrls ? '**SIM**' : 'não'} |`);
  F.push('');
  F.push(`### B. Tabelas sem \`companyId\` (${noCompanyTables.length}) e como são isoladas`);
  F.push('');
  F.push('| Tabela | Domínio | Policies (condição resumida) |');
  F.push('|---|---|---|');
  for (const t of noCompanyTables) F.push(`| ${code(t)} | ${domainOf(t)} | ${polsOf(t).length ? polsOf(t).map((p) => `${p.policyname}: ${code(cell(p.qual ?? '—').slice(0, 140))}`).join('; ') : '**nenhuma**'} |`);
  F.push('');
  F.push('### C. Tabelas sem FK de empresa/filial (retenção) e relações lógicas');
  F.push('');
  F.push(`- **${noCompanyFk.length}** tabelas com \`companyId\` sem FK para \`companies\`; **${noBranchFk.length}** com \`branchId\` sem FK para \`branches\`; **${logical.length}** relações \`…Id\` entre entidades sem FK (inferidas; ver [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md) §5).`);
  F.push('- Efeito: as tabelas **com** FK de empresa/filial (a regra desde 2026-10-15) recusam referência órfã e registro apontando para outra empresa (`P2003`); as listadas acima como sem FK são de retenção/telemetria/idempotência (sem dado de negócio a preservar) e continuam protegidas só pela RLS (`WITH CHECK`) e pelos serviços. A conferência de órfãos por contagem usa o papel que ignora RLS (somente leitura; ver D2b).');
  F.push('');
  F.push(`### D. FKs com \`ON DELETE CASCADE\` (${cascades.length}; apagar o pai apaga os filhos — as marcadas com ⚠ ficam em domínio financeiro, fiscal, de oficina ou de auditoria)`);
  F.push('');
  F.push(cascades.length ? cascades.map((f) => `- ${FINANCIAL_DOMAINS.has(domainOf(f.table)) ? '⚠ ' : ''}${code(`${f.table}.${f.cols}`)} → ${code(f.ref)} (${domainOf(f.table)})`).join('\n') : 'nenhuma');
  F.push('');
  F.push(`### D2. Órfãos nas relações sem FK — ${orphanReport.note}`);
  F.push('');
  F.push(orphanReport.checked ? `${orphanReport.checked} relações conferidas (escopo de empresa e de filial sem FK + relações lógicas inferidas por nome); com órfãos: **${orphanReport.withOrphans.length}**.` : 'Nenhuma relação conferida.');
  if (orphanReport.withOrphans.length) {
    F.push('');
    F.push('| Relação | Linhas órfãs |');
    F.push('|---|---|');
    for (const o of orphanReport.withOrphans) F.push(`| ${code(o.rel)} | ${o.count} |`);
    F.push('');
    F.push('Relações "lógica inferida" são deduzidas do nome da coluna: contagem > 0 pode ser erro da inferência (coluna que aponta para outra entidade) e não necessariamente dado órfão — conferir caso a caso.');
  }
  F.push('');
  const cmdsCovered = (t: string): Set<string> => {
    const s = new Set<string>();
    for (const p of polsOf(t)) { if (p.cmd === 'ALL') ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].forEach((c) => s.add(c)); else s.add(p.cmd); }
    return s;
  };
  F.push(`### D2b. FKs declaradas: linhas sem pai — ${fkCheck.checked ? `${fkCheck.checked} FKs conferidas com o papel que ignora RLS; **com violação: ${fkCheck.violated.length}**${fkCheck.violated.length ? ': ' + fkCheck.violated.map((o) => `${code(o.rel)} (${o.count})`).join(', ') : ''}` : 'não conferido (rode com `--orphans`)'}`);
  F.push('');
  F.push('Existir a FK não prova que os dados antigos a respeitam: o `ADD CONSTRAINT` feito pelo dono sob FORCE RLS, sem contexto, não enxerga as linhas (ver [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md) §4.3).');
  F.push('');
  F.push(`### D3. FKs simples restantes onde filho e pai têm \`companyId\` (${crossCandidates.length}) e a proteção de cada uma`);
  F.push('');
  F.push(`A checagem de FK não passa pela RLS e a policy do filho só olha o companyId do próprio filho; por isso a regra do projeto é a FK **composta** \`(companyId, X) → pai(companyId, id)\` (94 relações, migrações 20261014160000 e 20261014180000). Estas FKs simples sobraram **de propósito** e cada uma tem a proteção da última coluna: \`SET NULL\` não pode virar FK composta no Prisma (anularia também o companyId), então \`sales.partnerId\`, \`service_orders.mechanicId\` e \`users.branchId\` têm **trigger de mesma empresa** (20261015160000); \`refresh_tokens.userId\` também tem a FK composta \`(companyId, userId)\`; \`audit_logs.userId\` fica só com a FK simples (log com retenção). Dados atuais: ${crossReport.checked ? `**${crossReport.checked} FKs conferidas, ${crossReport.withCross.length} com linha cruzada**${crossReport.withCross.length ? ': ' + crossReport.withCross.map((o) => `${code(o.rel)} (${o.count})`).join(', ') : ''}` : 'não conferido (rode com `--orphans`)'}. "SET NULL" não pode virar FK composta no Prisma (anularia também o companyId); "pai/filho anulável" exige tratamento próprio.`);
  F.push('');
  const guardOf: Record<string, string> = {
    'sales.partnerId': 'trigger `sales_partner_same_company`',
    'service_orders.mechanicId': 'trigger `service_orders_mechanic_same_company`',
    'users.branchId': 'trigger `users_branch_same_company`',
    'refresh_tokens.userId': 'FK composta `(companyId, userId)`',
    'audit_logs.userId': 'só a FK simples (log com retenção)',
  };
  F.push('| Filho.coluna → Pai | Ao apagar o pai | companyId do pai | companyId do filho | Proteção de mesma empresa |');
  F.push('|---|---|---|---|---|');
  for (const c of crossCandidates) F.push(`| ${code(`${c.child}.${c.col}`)} → ${code(c.parent)} | ${c.del} | ${c.parentNullable ? '**anulável**' : 'obrigatório'} | ${c.childNullable ? '**anulável**' : 'obrigatório'} | ${guardOf[`${c.child}.${c.col}`] ?? '**nenhuma além da RLS**'} |`);
  F.push('');
  F.push('### E. Imutabilidade de histórico e livros: o que a RLS permite');
  F.push('');
  F.push('A imutabilidade no banco é feita por **RLS** (comando sem policy = negado; `FORCE RLS` vale também para o dono), não por trigger. Para cada tabela de histórico/livro, os comandos que têm policy:');
  F.push('');
  F.push('| Tabela | SELECT | INSERT | UPDATE | DELETE | Leitura |');
  F.push('|---|---|---|---|---|---|');
  for (const t of appendOnly) {
    const c = cmdsCovered(t);
    const yn = (k: string) => (c.has(k) ? 'policy' : 'negado');
    const verdict = !c.has('UPDATE') && !c.has('DELETE') ? 'imutável pelo banco' : !c.has('UPDATE') ? 'sem UPDATE; DELETE só pelas condições da policy' : '**UPDATE/DELETE permitidos pela RLS — imutabilidade só na aplicação**';
    F.push(`| ${code(t)} | ${yn('SELECT')} | ${yn('INSERT')} | ${yn('UPDATE')} | ${yn('DELETE')} | ${verdict} |`);
  }
  F.push('');
  F.push(`Triggers não internos no banco (${trgs.length}): ${trgs.length ? trgs.map((x) => code(`${x.table}.${x.name}`)).join(', ') : 'nenhum'}.`);
  F.push('');
  F.push(`### F. Colunas sensíveis a revisar (nome sugere segredo, hash, documento ou dado pessoal) — ${sensitive.length}`);
  F.push('');
  F.push('Só nomes e tipos; nenhum valor foi lido. Confirmar, para cada uma, se o conteúdo é cifrado/hash ou dado pessoal sujeito à LGPD.');
  F.push('');
  F.push('| Tabela | Coluna | Tipo |');
  F.push('|---|---|---|');
  for (const c of sensitive) F.push(`| ${code(c.table)} | ${code(c.name)} | ${cell(c.type)} |`);
  F.push('');
  // G. tipos, defaults e fuso
  const tsNoTz = cols.filter((c) => /^timestamp(\(\d\))? without time zone$/.test(c.type));
  const tsDbDefault = tsNoTz.filter((c) => c.def && /CURRENT_TIMESTAMP|now\(\)/i.test(c.def));
  const floats = cols.filter((c) => /double precision|^real$|money/.test(c.type));
  const numericNoPrecision = cols.filter((c) => c.type === 'numeric');
  F.push('### G. Tipos, defaults e fuso horário');
  F.push('');
  F.push('| Verificação | Resultado |');
  F.push('|---|---|');
  F.push(`| Colunas \`numeric\` sem precisão/escala (valor monetário sem limite) | ${numericNoPrecision.length ? numericNoPrecision.map((c) => code(`${c.table}.${c.name}`)).join(', ') : '0'} |`);
  F.push(`| Colunas de ponto flutuante (\`double precision\`/\`real\`/\`money\`) | ${floats.length}: ${[...new Set(floats.map((c) => c.table))].map(code).join(', ')} — ${floats.some((c) => FINANCIAL_DOMAINS.has(domainOf(c.table)) && domainOf(c.table) !== 'Auditoria, observabilidade e operação') ? '**há coluna em tabela financeira**' : 'só métricas de monitoramento/telemetria (nenhuma financeira)'} |`);
  F.push(`| \`timestamp\` SEM fuso | ${tsNoTz.length} colunas (o Prisma grava em UTC); com fuso: ${cols.filter((c) => /^timestamp(\(\d\))? with time zone$/.test(c.type)).length} |`);
  F.push(`| Dessas, com \`DEFAULT CURRENT_TIMESTAMP\`/\`now()\` no BANCO | ${tsDbDefault.length} — o default do banco usa o fuso da SESSÃO (\`timezone\` do servidor consultado: **${serverTz}**); linhas criadas por SQL direto (migrations, scripts) podem ficar em hora local enquanto as criadas pelo Prisma ficam em UTC |`);
  F.push('');
  // H. índices redundantes (prefixo de outro índice btree sem WHERE)
  type PIdx = { name: string; table: string; unique: boolean; cols: string[] };
  const parsed: PIdx[] = idxs
    .map((i) => {
      const m = /^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING btree \((.*)\)$/.exec(i.indexdef);
      return m ? { name: i.indexname, table: i.tablename, unique: !!m[1], cols: m[2].split(',').map((s) => s.trim()) } : null;
    })
    .filter((x): x is PIdx => !!x)
    // índices parciais (WHERE) e de expressão não substituem um índice comum: ficam fora da comparação
    .filter((p) => !idxs.find((i) => i.indexname === p.name && i.tablename === p.table)!.indexdef.includes(' WHERE ') && !p.cols.some((c) => c.includes('(')));
  const redundant: Array<{ idx: PIdx; by: PIdx }> = [];
  for (const i of parsed.filter((p) => !p.unique)) {
    const by = parsed.find((j) => j.table === i.table && j.name !== i.name && j.cols.length >= i.cols.length && i.cols.every((c, k) => j.cols[k] === c) && (j.cols.length > i.cols.length || j.unique || j.name < i.name));
    if (by) redundant.push({ idx: i, by });
  }
  const exactDup = redundant.filter((r) => r.by.cols.length === r.idx.cols.length);
  const prefixOnly = redundant.filter((r) => r.by.cols.length > r.idx.cols.length);
  F.push(`### H. Índices redundantes — ${exactDup.length} idênticos a outro e ${prefixOnly.length} que são só o início de outro`);
  F.push('');
  F.push(`**Idênticos (mesmas colunas de um índice único ou de outro índice) — ${exactDup.length}:**`);
  F.push('');
  F.push(exactDup.length ? exactDup.map((r) => `- ${code(r.idx.name)} (${r.idx.cols.join(', ')}) = ${code(r.by.name)}${r.by.unique ? ' (único)' : ''} em ${code(r.idx.table)}`).join('\n') : 'nenhum');
  F.push('');
  F.push(`**Início de outro índice (btree comum, sem WHERE) — ${prefixOnly.length}:**`);
  F.push('');
  F.push(prefixOnly.length ? prefixOnly.map((r) => `- ${code(r.idx.name)} (${r.idx.cols.join(', ')}) ⊂ ${code(r.by.name)} (${r.by.cols.join(', ')}) em ${code(r.idx.table)}`).join('\n') : 'nenhum');
  F.push('');
  F.push('Remover índice redundante é ganho de escrita/espaço, não correção: nada foi removido (decisão com medição de uso — `pg_stat_user_indexes` — em staging).');
  F.push('');
  const findings = F.join('\n');

  // ========================= pacote de revisão =========================
  const sums: string[] = [];
  const bundleFiles: Array<{ rel: string; abs: string }> = [{ rel: 'packages/database/prisma/schema.prisma', abs: path.join(PRISMA_DIR, 'schema.prisma') }, { rel: 'packages/database/prisma/migrations/migration_lock.toml', abs: path.join(MIG_DIR, 'migration_lock.toml') }];
  for (const m of migs) bundleFiles.push({ rel: `packages/database/prisma/migrations/${m.name}/migration.sql`, abs: path.join(MIG_DIR, m.name, 'migration.sql') });

  if (write) {
    const bd = path.join(DOCS, 'BANCO_DE_DADOS.md');
    fs.writeFileSync(bd, replaceBetween(bd, '<!-- db-docs:begin -->', '<!-- db-docs:end -->', annex, '## Anexo — inventário técnico gerado'), 'utf8');
    writeFile('docs/CORTEX/MAPA_RELACIONAMENTOS.md', mapa, true);
    writeFile('docs/CORTEX/RELATORIO_MIGRATIONS.md', relatorio, true);
    const rv = path.join(DOCS, 'REVISAO_BANCO_PENDENCIAS.md');
    fs.writeFileSync(rv, replaceBetween(rv, '<!-- db-docs:findings:begin -->', '<!-- db-docs:findings:end -->', findings), 'utf8');
    fs.mkdirSync(BUNDLE, { recursive: true });
    for (const f of bundleFiles) {
      const dest = path.join(BUNDLE, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
      sums.push(`${sha256(fs.readFileSync(f.abs))}  ${f.rel}`);
    }
    fs.writeFileSync(path.join(BUNDLE, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      path.join(BUNDLE, 'LEIA-ME.md'),
      [
        '# Pacote de revisão do banco de dados (CÓRTEX)',
        '',
        `Gerado em ${TODAY} por \`cd apps/api && npm run db:docs -- --write\`. Contém **apenas estrutura**: cópia do schema Prisma e das ${migs.length} migrations (SQL), com SHA-256 em \`SHA256SUMS.txt\`. Sem segredo, sem dado de cliente, sem \`.env\`.`,
        '',
        '- `packages/database/prisma/schema.prisma` — schema atual.',
        '- `packages/database/prisma/migrations/` — todas as migrations, na ordem de execução, e `migration_lock.toml`.',
        '- `drift-dev.txt` — saída de `prisma migrate diff` (banco de desenvolvimento → schema).',
        '- `replay-resultado.md` — resultado de reaplicar as migrations do zero em banco vazio e dos **três cenários com dado inconsistente** (`npm run db:replay-check`).',
        '- `role-split-resultado.md` — prova da separação dono × execução do banco, em banco e papel temporários (`npm run db:role-split-check -- --suites`; modelo em `deploy/db-runtime-role.sql`).',
        '- `resultados-testes.md` — testes executados (unitários, integração completa em três rodadas, E2E, builds), falhas encontradas e correções.',
        '',
        'Documentos relacionados (em `docs/CORTEX`): `BANCO_DE_DADOS.md` (inventário por tabela), `MAPA_RELACIONAMENTOS.md`, `RELATORIO_MIGRATIONS.md`, `REVISAO_BANCO_PENDENCIAS.md`, `DECISIONS.md`.',
        '',
        'Conferir a integridade: `sha256sum -c SHA256SUMS.txt` (a partir desta pasta).',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  const summary = {
    tables: tables.length, models: models.length, migrations: migs.length, fks: fks.length, logicalWithoutFk: logical.length, unresolvedIdCols: unresolved.length,
    noRls: noRls.length, noPolicy: noPolicy.length, noPk: noPk.length, nullableCompany: nullableCompany.length, companyWithoutFk: noCompanyFk.length, branchWithoutFk: noBranchFk.length,
    noCompanyTables: noCompanyTables.length, branchNotInPolicy, noCompanyIndex: noCompanyIndex.length, cascadesFinancial: cascades.length, sensitiveCols: sensitive.length,
    unclassified: byDomain.get(UNCLASSIFIED), onlyInDb, onlyInSchema, unapplied, orphanDb, checksumBad, lfOnly, chainMissing, isolated, devMig: devMig.note, testMig: testMig.note,
    destructiveMigrations: migs.filter((m) => m.destructive.length).map((m) => m.name), noTriggerAppendOnly: appendOnly.filter((t) => !trgOf(t).length), written: write,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
