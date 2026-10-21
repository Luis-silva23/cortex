/**
 * ANONIMIZAÇÃO de uma CÓPIA RESTAURADA do banco (decisão 155): remove dados pessoais, contatos, documentos, segredos, IPs e textos livres antes de a cópia sair do ambiente
 * seguro (homologação, suporte, análise). NUNCA é executada no banco de produção: só aceita um banco ISOLADO (nome de cópia, outro servidor/base que o DATABASE_URL e o
 * BACKUP_DATABASE_URL), por um superusuário (a RLS FORÇADA e os gatilhos de "somente acréscimo" precisam ser contornados NA CÓPIA), e exige confirmação pelo nome do banco.
 *
 * Como funciona: regras declarativas por tabela/coluna (RULES). Valores novos são DETERMINÍSTICOS a partir do id (mesma linha ⇒ mesmo valor ⇒ unicidades e relações
 * preservadas). Colunas que já eram NULL continuam NULL (a forma dos dados não muda). Tudo numa única transação (tudo ou nada).
 * Provas (devolvidas no relatório, sem imprimir valores): (1) contagem de linhas por tabela inalterada; (2) varredura de VAZAMENTO: valores ORIGINAIS amostrados (e-mails,
 * documentos, nomes, telefones, placas) não aparecem mais em nenhuma coluna de texto/JSON; (3) cobertura: colunas com nome de dado pessoal que não têm regra nem estão na lista
 * de "seguras" (SAFE) — com `strict` isso reprova, para que uma coluna nova não escape.
 * Limite honesto: texto livre digitado em colunas que não reconhecemos como sensíveis pode conter dado pessoal; a cobertura aponta as candidatas, mas a revisão humana é o
 * critério final antes de compartilhar a cópia fora do ambiente seguro.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

type Kind =
  | 'null' | 'name' | 'email' | 'phone' | 'cpf' | 'cnpj' | 'zip' | 'street' | 'city' | 'address' | 'plate' | 'chassis' | 'text' | 'secret'
  | 'company' | 'branch' | 'supplier' | 'device' | 'channel' | 'accesskey' | 'file';

/** tabela → coluna → tipo de substituição. Colunas inexistentes no banco são ignoradas (e listadas no relatório). */
export const RULES: Record<string, Record<string, Kind>> = {
  accounts_payable: { description: 'text', notes: 'null' },
  accounts_receivable: { description: 'text', notes: 'null' },
  activations: { ipAddress: 'null' },
  agreement_companies: { legalName: 'company', tradeName: 'company', cnpj: 'cnpj', contactName: 'name', phone: 'phone', whatsapp: 'phone', email: 'email', zipCode: 'zip', street: 'street', city: 'city', notes: 'null' },
  appointments: { confirmedByName: 'name', notes: 'null' },
  audit_logs: { ipAddress: 'null', userAgent: 'null', oldValue: 'null', newValue: 'null' },
  branches: { name: 'branch', document: 'cnpj', address: 'address', city: 'city', zipCode: 'zip', phone: 'phone', email: 'email', whatsapp: 'phone', street: 'street' },
  cash_movements: { notes: 'null' },
  cash_registers: { notes: 'null' },
  channel_api_credentials: { keyId: 'secret', secretEncrypted: 'secret', secretHint: 'secret' },
  channel_events: { message: 'text', data: 'null' },
  channel_inbound_events: { payload: 'null', lastError: 'null' },
  channel_outbox: { payload: 'null', lastError: 'null' },
  collection_attempts: { providerMessage: 'null' },
  companies: { name: 'company', document: 'cnpj', email: 'email', phone: 'phone', legalName: 'company', whatsapp: 'phone', contactName: 'name', zipCode: 'zip', street: 'street', city: 'city' },
  customers: { name: 'name', document: 'cpf', email: 'email', phone: 'phone', address: 'address', city: 'city', zipCode: 'zip', whatsapp: 'phone', notes: 'null' },
  damage_records: { description: 'null', photoUrls: 'null' },
  device_sessions: { ipAddress: 'null' },
  devices: { secretHash: 'null', deviceName: 'device', macAddress: 'null', ipAddress: 'null' },
  discount_events: { description: 'null' },
  employee_agreements: { name: 'name', cpf: 'cpf', notes: 'null' },
  external_orders: { payload: 'null', statusReason: 'null', acceptedBy: 'name' },
  fiscal_configs: { certificatePath: 'null', certificatePassword: 'null', cscToken: 'null' },
  fiscal_documents: { accessKey: 'accesskey', xmlUrl: 'null', pdfUrl: 'null' },
  follow_up_events: { message: 'null' },
  fulfillments: { notes: 'null' },
  follow_ups: { notes: 'null' },
  import_batches: { fileName: 'null', results: 'null' },
  inventories: { notes: 'null' },
  inventory_counts: { notes: 'null' },
  invoices: { accessKey: 'accesskey', xmlUrl: 'null' },
  licenses: { notes: 'null' },
  motorcycles: { licensePlate: 'plate', chassisNumber: 'chassis' },
  payment_exceptions: { notes: 'null' },
  payments: { cardLastDigits: 'null', notes: 'null' },
  privacy_requests: { exportPayload: 'null', justification: 'text', plan: 'null', result: 'null' },
  purchase_orders: { notes: 'null' },
  quote_items: { description: 'text' },
  quote_versions: { decisionNotes: 'null' },
  quotes: { notes: 'null' },
  revisions: { notes: 'null' },
  sale_items: { notes: 'null' },
  sales: { notes: 'null' },
  sales_channels: { displayName: 'channel', externalAccountId: 'null', lastError: 'null' },
  service_order_items: { description: 'text' },
  service_order_status_history: { notes: 'null' },
  service_order_warranties: { notes: 'null' },
  service_orders: { entryNotes: 'null', diagnosticNotes: 'null' },
  stock_movements: { notes: 'null' },
  supplier_return_events: { notes: 'null' },
  supplier_return_items: { notes: 'null' },
  supplier_returns: { description: 'null', decisionNotes: 'null', outcomeNotes: 'null' },
  suppliers: { name: 'supplier', document: 'cnpj', email: 'email', phone: 'phone', address: 'address', city: 'city', zipCode: 'zip', addressComplement: 'null', addressNumber: 'null', notes: 'null', tradeName: 'supplier' },
  support_kb_articles: { authorName: 'name' },
  support_ticket_attachments: { fileName: 'file', uploadedByName: 'name' },
  support_ticket_events: { actorName: 'name' },
  support_ticket_messages: { authorName: 'name', body: 'text' },
  support_tickets: { requesterName: 'name', requesterEmail: 'email', requesterPhone: 'phone', companyName: 'company', branchName: 'branch', description: 'text', subject: 'text', assignedToName: 'name', context: 'null' },
  system_logs: { message: 'text', errorMessage: 'null', stackTrace: 'null', metadata: 'null' },
  tef_payments: { cardLastDigits: 'null' },
  transfer_items: { notes: 'null' },
  transfers: { notes: 'null' },
  users: { name: 'name', email: 'email', phone: 'phone', password: 'secret', mfaSecret: 'null', mfaBackupCodes: 'null', lastLoginIp: 'null' },
  vehicle_entry_checklist_items: { description: 'null', photoUrl: 'null' },
  warranty_claims: { description: 'text', decisionNotes: 'null' },
  refresh_tokens: { ipAddress: 'null', userAgent: 'null' },
};

/** tabelas cujas linhas são sessões/chaves de idempotência (segredos de curta duração): esvaziadas na cópia. */
export const DELETE_ALL = ['refresh_tokens', 'idempotency_keys'];

/** colunas com nome "sensível" que NÃO são dado pessoal (catálogo, configuração, códigos): não precisam de regra. */
export const SAFE = new Set<string>([
  'products.name', 'products.description', 'categories.name', 'categories.description', 'roles.name', 'roles.description', 'permissions.name', 'permissions.description',
  'commission_rules.name', 'discount_rules.name', 'discount_rules.description', 'partners.name', 'partners.description', 'sale_items.productName', 'external_order_items.name',
  'policy_settings.key', 'policy_changes.key', 'idempotency_keys.key', 'idempotency_keys.requestHash', 'business_calendar_exceptions.description',
  'support_kb_categories.name', 'support_kb_articles.keywords', 'payment_settings.cardProvider', 'payment_settings.pixProvider', 'payments.cardBrand', 'tef_payments.cardBrand',
  'refresh_tokens.tokenHash', 'channel_outbox.dedupeKey', 'vehicle_entry_checklist_items.itemName', 'monitoring_thresholds.key',
  '_prisma_migrations.migration_name', 'access_revocations.subject', 'channel_outbox.lastErrorKind', 'privacy_requests.subjectType', 'support_kb_articles.body', 'support_tickets.lastMessageBy',
]);

const SENSITIVE_NAME = /(name|email|phone|telefone|whatsapp|document|cpf|cnpj|address|street|city|zip|cep|password|secret|token|hash|ipaddress|useragent|plate|chassis|macaddress|notes|description|body|content|message|subject|payload|metadata|context|url|path|digits|license|stack|error)/i;
const TEXTLIKE = new Set(['text', 'character varying', 'jsonb', 'json', 'ARRAY']);

const H = (salt = '') => `md5(id::text${salt ? ` || '${salt}'` : ''})`;
const digits = (n: number, salt: string) => {
  const hex = n > 11 ? 13 : 12;
  const bits = hex * 4;
  const mod = '1' + '0'.repeat(n);
  return `lpad(((('x' || substr(${H(salt)}, 1, ${hex}))::bit(${bits})::bigint) % ${mod})::text, ${n}, '0')`;
};
const EXPR: Record<Exclude<Kind, 'null'>, string> = {
  name: `'Pessoa ' || substr(${H()}, 1, 8)`,
  email: `'anon-' || substr(${H()}, 1, 12) || '@exemplo.invalid'`,
  phone: `'119' || ${digits(8, 'p')}`,
  cpf: digits(11, 'c'),
  cnpj: digits(14, 'j'),
  zip: `'00000000'`,
  street: `'Rua Anonima ' || substr(${H('s')}, 1, 4)`,
  city: `'Cidade Anonima'`,
  address: `'Endereco removido ' || substr(${H('a')}, 1, 4)`,
  plate: `upper(substr(${H('l')}, 1, 7))`,
  chassis: `upper(substr(${H('h')}, 1, 17))`,
  text: `'Texto removido na anonimizacao'`,
  secret: `'anon-' || ${H('k')}`,
  company: `'Empresa ' || substr(${H('e')}, 1, 8)`,
  branch: `'Filial ' || substr(${H('f')}, 1, 8)`,
  supplier: `'Fornecedor ' || substr(${H('u')}, 1, 8)`,
  device: `'Dispositivo ' || substr(${H('d')}, 1, 8)`,
  channel: `'Canal ' || substr(${H('n')}, 1, 8)`,
  accesskey: `${digits(14, 'x1')} || ${digits(14, 'x2')} || ${digits(14, 'x3')} || ${digits(2, 'x4')}`,
  file: `'anexo-' || substr(${H('z')}, 1, 10)`,
};

type Col = { table: string; column: string; type: string; nullable: boolean };
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const redact = (t: string) => t.replace(/(postgres(?:ql)?:\/\/[^:@/\s]+):[^@\s]+@/g, '$1:***@');

export type AnonymizeOptions = {
  /** URL do banco ISOLADO (superusuário). */
  url: string;
  /** nome do banco que o operador confirma estar anonimizando */
  confirm: string;
  strict?: boolean;
  psqlBin?: string;
  /** conexões que NUNCA podem ser o alvo (DATABASE_URL, BACKUP_DATABASE_URL, ...) */
  protectedUrls?: string[];
};
export type AnonymizeReport = { updatedTables: number; deletedRows: number; rowCountsEqual: boolean; leaks: string[]; uncovered: string[]; missingColumns: string[]; sampled: number };

const norm = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname}:${x.port || '5432'}/${decodeURIComponent(x.pathname.replace(/^\//, ''))}`;
  } catch {
    return u;
  }
};

export function assertIsolatedCopy(url: string, confirm: string, protectedUrls: string[] = []) {
  const db = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!db) throw new Error('anonimização recusada: a URL não informa o banco');
  if (confirm !== db) throw new Error(`anonimização recusada: confirmação (${confirm || 'vazia'}) diferente do nome do banco`);
  if (!/(restore|drill|copia|anon|staging|homolog|lab|tmp|temp|try)/i.test(db)) {
    throw new Error(`anonimização recusada: o banco "${db}" não tem nome de CÓPIA (restore/drill/copia/anon/staging/homolog/lab/tmp). Renomeie a cópia — o script nunca anonimiza um banco que possa ser o de produção`);
  }
  if (/(^|[_-])(prod|producao|production)([_-]|$)/i.test(db)) throw new Error(`anonimização recusada: o nome "${db}" indica produção`);
  for (const p of protectedUrls.filter(Boolean)) {
    if (norm(p) === norm(url)) throw new Error('anonimização recusada: o alvo é o MESMO banco de uma conexão protegida (DATABASE_URL/BACKUP_DATABASE_URL)');
  }
}

export function anonymizeDatabase(opts: AnonymizeOptions): AnonymizeReport {
  assertIsolatedCopy(opts.url, opts.confirm, opts.protectedUrls);
  const bin = opts.psqlBin || 'psql';
  // SQL sempre por STDIN (UTF-8): em argumento de linha de comando o Windows converte para a página de código ANSI e nomes com acento chegam inválidos
  const run = (sql: string, _script = false) => {
    try {
      return execFileSync(bin, [opts.url, '-X', '-q', '-t', '-A', '-F', '\u001f', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
        encoding: 'utf8',
        input: sql,
        env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      }).trim();
    } catch (e: any) {
      throw new Error(redact(`psql falhou: ${String(e.stderr || '').trim().split('\n').slice(0, 4).join(' | ') || e.message}`));
    }
  };

  if (run(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`) !== 't') {
    throw new Error('anonimização recusada: precisa de um superusuário NA CÓPIA isolada (a RLS forçada e os gatilhos de somente-acréscimo são contornados só nela)');
  }
  if (run(`SELECT pg_is_in_recovery()`) === 't') throw new Error('anonimização recusada: o servidor está em recuperação (réplica)');

  const cols: Col[] = run(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [table, column, type, nl] = l.split('\u001f');
      return { table, column, type, nullable: nl === 'YES' };
    });
  const byKey = new Map(cols.map((c) => [`${c.table}.${c.column}`, c]));
  const tables = new Set(cols.map((c) => c.table));

  const countRows = () =>
    run([...tables].sort().map((t) => `SELECT ${lit(t)} || '=' || count(*) FROM ${q(t)}`).join(' UNION ALL '));
  // amostra dos valores ORIGINAIS (em memória; nunca impressa) para a varredura de vazamento
  const sample = (table: string, column: string, kind: 'exact' | 'substr') => {
    if (!byKey.has(`${table}.${column}`)) return [] as { v: string; kind: 'exact' | 'substr' }[];
    const rows = run(`SELECT DISTINCT ${q(column)}::text FROM ${q(table)} WHERE ${q(column)} IS NOT NULL AND length(${q(column)}::text) >= 5 LIMIT 150`);
    return rows.split('\n').filter(Boolean).map((v) => ({ v, kind }));
  };
  const samples = [
    ...sample('users', 'email', 'substr'), ...sample('users', 'name', 'exact'), ...sample('users', 'phone', 'substr'),
    ...sample('customers', 'name', 'exact'), ...sample('customers', 'document', 'substr'), ...sample('customers', 'email', 'substr'), ...sample('customers', 'phone', 'substr'),
    ...sample('companies', 'document', 'substr'), ...sample('companies', 'email', 'substr'), ...sample('companies', 'name', 'exact'), ...sample('companies', 'phone', 'substr'),
    ...sample('branches', 'document', 'substr'), ...sample('suppliers', 'document', 'substr'), ...sample('suppliers', 'name', 'exact'), ...sample('motorcycles', 'licensePlate', 'substr'),
    ...sample('employee_agreements', 'cpf', 'substr'), ...sample('agreement_companies', 'cnpj', 'substr'),
  ];
  const before = countRows();

  const missingColumns: string[] = [];
  const stmts: string[] = ['BEGIN;', 'SET LOCAL session_replication_role = replica;'];
  let updatedTables = 0;
  for (const [table, rules] of Object.entries(RULES)) {
    if (!tables.has(table)) { missingColumns.push(`${table} (tabela)`); continue; }
    const sets: string[] = [];
    for (const [column, kind] of Object.entries(rules)) {
      const c = byKey.get(`${table}.${column}`);
      if (!c) { missingColumns.push(`${table}.${column}`); continue; }
      let expr: string;
      if (kind === 'null') {
        if (c.nullable) expr = 'NULL';
        else if (c.type === 'jsonb' || c.type === 'json') expr = `'{}'::${c.type}`;
        else if (c.type === 'ARRAY') expr = `'{}'`;
        else expr = `'removido'`;
      } else {
        expr = EXPR[kind];
        if (c.type === 'ARRAY') expr = `'{}'`;
        if (c.nullable) expr = `CASE WHEN ${q(column)} IS NULL THEN NULL ELSE ${expr} END`;
      }
      sets.push(`${q(column)} = ${expr}`);
    }
    if (sets.length) { stmts.push(`UPDATE ${q(table)} SET ${sets.join(', ')};`); updatedTables++; }
  }
  for (const t of DELETE_ALL) if (tables.has(t)) stmts.push(`DELETE FROM ${q(t)};`);
  stmts.push(`COMMENT ON DATABASE ${q(decodeURIComponent(new URL(opts.url).pathname.replace(/^\//, '')))} IS 'cortex:anonymized ${new Date().toISOString()}';`, 'COMMIT;');
  run(stmts.join('\n'), true);

  const delCount = DELETE_ALL.filter((t) => tables.has(t));
  const afterCounts = countRows();
  const toMap = (s: string) => new Map(s.split('\n').filter(Boolean).map((l) => l.split('=') as [string, string]));
  const b = toMap(before), a = toMap(afterCounts);
  let deletedRows = 0;
  let rowCountsEqual = true;
  for (const [t, n] of b) {
    if (delCount.includes(t)) { deletedRows += Number(n) - Number(a.get(t) ?? 0); continue; }
    if (a.get(t) !== n) rowCountsEqual = false;
  }

  // varredura de vazamento: valor original ainda presente em alguma coluna de texto/JSON?
  const leaks: string[] = [];
  const exact = samples.filter((s) => s.kind === 'exact').map((s) => lit(s.v));
  const subs = samples.filter((s) => s.kind === 'substr').map((s) => lit(s.v));
  if (samples.length) {
    // UMA sessão: as amostras vão para uma tabela temporária e cada coluna de texto/JSON vira um SELECT (um psql por coluna levaria minutos)
    const scan: string[] = [
      'CREATE TEMP TABLE _anon_samples(v text, exact boolean);',
      ...[exact.map((v) => `(${v}, true)`), subs.map((v) => `(${v}, false)`)].filter((g) => g.length).map((g) => `INSERT INTO _anon_samples VALUES ${g.join(',')};`),
    ];
    for (const c of cols) {
      if (!TEXTLIKE.has(c.type)) continue;
      const asText = c.type === 'ARRAY' || c.type === 'jsonb' || c.type === 'json' ? `${q(c.column)}::text` : q(c.column);
      scan.push(
        `SELECT ${lit(`${c.table}.${c.column}`)}, count(*) FROM ${q(c.table)} t WHERE EXISTS (SELECT 1 FROM _anon_samples s WHERE (s.exact AND ${asText} = s.v) OR (NOT s.exact AND strpos(${asText}, s.v) > 0));`,
      );
    }
    for (const line of run(scan.join('\n')).split('\n').filter(Boolean)) {
      const [name, n] = line.split('\u001f');
      if (Number(n) > 0) leaks.push(`${name}=${n}`);
    }
  }

  // cobertura: coluna com nome sensível, de texto, sem regra e sem estar em SAFE
  const uncovered = cols
    .filter((c) => TEXTLIKE.has(c.type) && SENSITIVE_NAME.test(c.column) && !/Id$/.test(c.column))
    .filter((c) => !(RULES[c.table] && c.column in RULES[c.table]) && !SAFE.has(`${c.table}.${c.column}`) && !DELETE_ALL.includes(c.table))
    .map((c) => `${c.table}.${c.column}`);

  const report: AnonymizeReport = { updatedTables, deletedRows, rowCountsEqual, leaks, uncovered, missingColumns, sampled: samples.length };
  if (!rowCountsEqual) throw new Error('anonimização reprovada: a contagem de linhas mudou');
  if (leaks.length) throw new Error(`anonimização reprovada: valores originais ainda presentes em ${leaks.join(', ')}`);
  if (opts.strict && uncovered.length) throw new Error(`anonimização reprovada (strict): colunas possivelmente sensíveis sem regra: ${uncovered.join(', ')}`);
  return report;
}

export const defaultPsql = (pgBinDir?: string) => (pgBinDir ? path.join(pgBinDir, process.platform === 'win32' ? 'psql.exe' : 'psql') : 'psql');
