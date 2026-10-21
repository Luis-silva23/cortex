// RLS no banco HML com contexto FORJADO, sem passar pela API: a defesa tem que estar no Postgres, não no frontend.
// Usa o mesmo papel da aplicação (lnsystem, sem BYPASSRLS) e define os GUCs que a API define. TODO script roda em
// BEGIN ... ROLLBACK: nada é gravado, nada é apagado. Cada bloqueio vem com um CONTROLE que prova que o mesmo comando
// funciona no contexto certo (senão um erro de coluna obrigatória pareceria "RLS").
const { spawnSyncHidden: spawnSync } = require('../lib/proc');
const path = require('path');
const infra = require('../infra');
const { suite } = require('../lib/harness');
const { readCredentials } = require('../lib/api');

const S = suite('rls');
const { check } = S;
const PSQL = path.join(process.env.LOCALAPPDATA || '', 'ln-system-tools', 'pg-extract', 'pgsql', 'bin', 'psql.exe');
const URL = infra.dbUrl(infra.secrets()).replace(/\?schema=.*$/, '');
if (!/:5433\/lnsystem_hml\b/.test(URL)) throw new Error('banco HML inesperado');
const uuid = (v) => { if (!/^[0-9a-f-]{36}$/i.test(v)) throw new Error('id inválido'); return v; };

/** Executa em transação revertida; devolve { rows, err } sem lançar (o erro faz parte da prova). */
function sql(ctx, statements) {
  const c = ctx || {};
  const script = [
    'BEGIN',
    `SET LOCAL "app.current_company_id" = '${c.company ? uuid(c.company) : ''}'`,
    `SET LOCAL "app.user_type" = '${c.type || ''}'`,
    `SET LOCAL "app.current_branch_id" = '${c.branch ? uuid(c.branch) : ''}'`,
    ...[].concat(statements),
    'ROLLBACK',
  ].join(';\n') + ';\n';
  const r = spawnSync(PSQL, [URL, '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { rows: r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')), err: r.status === 0 ? '' : r.stderr.trim(), out: r.stdout.trim() };
}
const RLS_MSG = /row-level security|segurança no nível de linha/i;
const one = (ctx, q) => { const r = sql(ctx, q); if (r.err) throw new Error(r.err); return r.rows.length ? r.rows[r.rows.length - 1][0] : null; };

// Tabelas cuja política admite companyId NULL para qualquer contexto (achado reportado, não alterado nesta rodada).
const GLOBAL_NULL = ['permissions', 'refresh_tokens', 'request_logs', 'system_logs'];
const BRANCH_COMPANY_SCOPED = ['users', 'user_roles', 'request_logs'];
const cred = readCredentials();
const A = cred.companies.A;
const B = cred.companies.B;
const A1 = A.branches[0].id;
const A2 = A.branches[1].id;

// Tabelas com a coluna dada e com RLS ligado. Erro do banco NÃO é "nenhuma tabela": lança com o motivo real
// (antes a lista vinha vazia e o teste quebrava adiante com `FROM () x`).
const rlsTables = (col) => {
  const r = sql({ type: 'SUPER_ADMIN' }, `SELECT c.table_name FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
  WHERE c.table_schema = 'public' AND c.column_name = '${col}' AND k.relrowsecurity AND k.relkind = 'r' ORDER BY 1`);
  if (r.err) throw new Error(`consulta de tabelas com RLS falhou: ${r.err}`);
  return r.rows.map((x) => x[0]);
};

// Linhas cuja coluna é diferente da própria (NULL só conta quando nullOk=false).
const foreignRows = (ctx, tables, col, own, nullOk) => {
  const cond = nullOk ? `"${col}" IS NOT NULL AND "${col}" <> '${own}'` : `"${col}" IS DISTINCT FROM '${own}'`;
  const parts = tables.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM "${t}" WHERE ${cond}`);
  const r = sql(ctx, `SELECT t, n FROM (${parts.join(' UNION ALL ')}) x WHERE n > 0 ORDER BY t`);
  if (r.err) throw new Error(r.err);
  return r.rows;
};

(() => {
  // 1) Banco indisponível (porta aberta mas sem aceitar consulta, desligado, senha errada) é diferente de
  // 2) banco disponível sem tabelas (migrações não aplicadas): cada um tem a sua mensagem e sai com 2, antes de qualquer verificação.
  const ping = sql({}, 'SELECT 1');
  if (ping.err) {
    console.error(`[rls] BANCO HML INDISPONÍVEL — nada foi verificado. Suba com "node apps/hml/infra.js start". Motivo: ${ping.err.split('\n')[0]}`);
    process.exit(2);
  }
  const tableCount = sql({ type: 'SUPER_ADMIN' }, "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'");
  if (tableCount.err || Number(tableCount.rows[0]?.[0]) === 0) {
    console.error('[rls] BANCO HML DISPONÍVEL, MAS SEM TABELAS — aplique as migrações ("node apps/hml/infra.js migrate"); nada foi verificado.');
    process.exit(2);
  }

  const role = sql({}, 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user').rows[0];
  check('0/o papel da aplicação não é superusuário nem BYPASSRLS', role && role[0] === 'f' && role[1] === 'f', JSON.stringify(role));

  const companyTables = rlsTables('companyId');
  const branchTables = rlsTables('branchId');
  check('0/varredura cobre muitas tabelas com companyId', companyTables.length >= 50, `${companyTables.length} tabelas`);

  const seen = Number(one({ type: 'SUPER_ADMIN' }, `SELECT count(*) FROM customers WHERE "companyId" = '${uuid(A.id)}'`));
  const seenB = Number(one({ type: 'SUPER_ADMIN' }, `SELECT count(*) FROM customers WHERE "companyId" = '${uuid(B.id)}'`));
  check('0/controle: o Super Admin enxerga clientes das duas empresas (há o que vazar)', seen > 0 && seenB > 0, `A=${seen} B=${seenB}`);

  // 1. Sem contexto nenhum, nada aparece (falha fechada)
  {
    const total = one({}, `SELECT (SELECT count(*) FROM customers) + (SELECT count(*) FROM sales) + (SELECT count(*) FROM products) + (SELECT count(*) FROM users) + (SELECT count(*) FROM audit_logs) + (SELECT count(*) FROM payments)`);
    check('1/sem contexto (nenhum GUC): 0 linhas em clientes/vendas/produtos/usuários/auditoria/pagamentos', Number(total) === 0, `total=${total}`);
    const bogus = one({ company: A.id }, `SELECT count(*) FROM customers`);
    check('1/contexto de empresa sem userType é só da empresa (não vira Super Admin)', Number(bogus) === seen, `${bogus} vs ${seen}`);
  }

  // 2. Varredura: no contexto da empresa X, nenhuma linha de outra empresa em NENHUMA tabela
  for (const [name, co, other] of [['A', A.id, B.id], ['B', B.id, A.id]]) {
    const rows = foreignRows({ company: co, type: 'COMPANY_ADMIN' }, companyTables.filter((t) => !GLOBAL_NULL.includes(t)), 'companyId', co, false);
    const nullRows = foreignRows({ company: co, type: 'COMPANY_ADMIN' }, companyTables.filter((t) => GLOBAL_NULL.includes(t)), 'companyId', co, true);
    check(`2/tabelas globais (${GLOBAL_NULL.join(', ')}): nenhuma linha de OUTRA empresa (as de companyId NULL são o achado documentado)`, nullRows.length === 0, JSON.stringify(nullRows));
    check(`2/varredura (${companyTables.length} tabelas): contexto da empresa ${name} não vê linha de outra empresa`, rows.length === 0, JSON.stringify(rows));
    const dir = one({ company: co, type: 'COMPANY_ADMIN' }, `SELECT count(*) FROM customers WHERE "companyId" = '${uuid(other)}'`);
    check(`2/filtro explícito pela outra empresa (companyId forjado no WHERE) devolve 0 para ${name}`, Number(dir) === 0, dir);
  }

  // 3. Filial: gerente da filial A1 não vê a filial A2 em nenhuma tabela com branchId
  {
    const mgr = { company: A.id, type: 'MANAGER', branch: A1 };
    const rows = foreignRows(mgr, branchTables.filter((t) => !BRANCH_COMPANY_SCOPED.includes(t)), 'branchId', A1, true);
    check(`3/varredura (${branchTables.length} tabelas com filial): MANAGER da filial A1 não vê linha da filial A2`, rows.length === 0, JSON.stringify(rows));
    const admin = Number(one({ company: A.id, type: 'COMPANY_ADMIN' }, `SELECT count(*) FROM stock_movements WHERE "branchId" = '${A2}'`));
    const forged = Number(one(mgr, `SELECT count(*) FROM stock_movements WHERE "branchId" = '${A2}'`));
    const nulls = ['refresh_tokens', 'request_logs', 'system_logs'].map((t) => `${t}=${one({ company: A.id, type: 'COMPANY_ADMIN' }, `SELECT count(*) FROM ${t} WHERE "companyId" IS NULL`)}`).join(' ');
    console.log(`INFO  achado (não alterado): linhas com companyId NULL visíveis a QUALQUER empresa: ${nulls}`);
    check('3/controle: o Administrador da empresa vê as movimentações de estoque da filial A2; o gerente da A1, com filial forjada no WHERE, vê 0', admin > 0 && forged === 0, `admin=${admin} gerenteA1=${forged}`);
    const upd = sql(mgr, `WITH u AS (UPDATE stock_movements SET notes = 'forjado' WHERE "companyId" = '${A.id}' AND "branchId" = '${A2}' RETURNING 1) SELECT count(*) FROM u`);
    check('3/UPDATE em movimentação de estoque de outra filial altera 0 linhas', !upd.err && upd.rows[0][0] === '0', upd.err || upd.out);
  }

  // 4. Escrita forjada de empresa (insert/update/delete) com o contexto da empresa A
  {
    const ctxA = { company: A.id, type: 'COMPANY_ADMIN' };
    const ins = (co) => `INSERT INTO customers (id, "companyId", name, "updatedAt") VALUES (gen_random_uuid()::text, '${uuid(co)}', '[HML-STRESS] rls forjado', now())`;
    const ok = sql(ctxA, ins(A.id));
    check('4/controle: o INSERT de cliente na própria empresa é válido (a recusa abaixo é da RLS, não de coluna)', !ok.err, ok.err);
    const bad = sql(ctxA, ins(B.id));
    check('4/INSERT de cliente com companyId da empresa B no contexto da A é recusado pela RLS', RLS_MSG.test(bad.err), bad.err || 'inseriu!');
    const move = sql(ctxA, `UPDATE customers SET "companyId" = '${uuid(B.id)}' WHERE "companyId" = '${A.id}' AND id = (SELECT id FROM customers WHERE "companyId" = '${A.id}' LIMIT 1)`);
    check('4/UPDATE que tenta MOVER um cliente da empresa A para a B é recusado pela RLS', RLS_MSG.test(move.err), move.err || 'moveu!');
    const updB = sql(ctxA, `WITH u AS (UPDATE customers SET name = 'forjado' WHERE "companyId" = '${uuid(B.id)}' RETURNING 1) SELECT count(*) FROM u`);
    check('4/UPDATE em cliente da empresa B altera 0 linhas', !updB.err && updB.rows[0][0] === '0', updB.err || updB.out);
    const delB = sql(ctxA, `WITH d AS (DELETE FROM customers WHERE "companyId" = '${uuid(B.id)}' RETURNING 1) SELECT count(*) FROM d`);
    check('4/DELETE em cliente da empresa B apaga 0 linhas', !delB.err && delB.rows[0][0] === '0', delB.err || delB.out);
    const ctlDel = sql(ctxA, `WITH d AS (DELETE FROM customers WHERE "companyId" = '${A.id}' AND name LIKE '[HML-STRESS]%' RETURNING 1) SELECT count(*) FROM d`);
    // Com massa de homologação acumulada, a linha alcançada pode ter moto/OS vinculada: a FK RESTRICT recusa DEPOIS de a
    // RLS ter deixado a linha passar. O que o controle prova é "a recusa não é da RLS".
    const fkRestrict = /violates RESTRICT setting of foreign key/.test(ctlDel.err || '');
    check('4/controle: o mesmo DELETE na própria empresa roda (revertido, nada apagado) — a RLS não o recusa', !ctlDel.err || (fkRestrict && !RLS_MSG.test(ctlDel.err)), ctlDel.err);
    const stillB = Number(one({ type: 'SUPER_ADMIN' }, `SELECT count(*) FROM customers WHERE "companyId" = '${uuid(B.id)}'`));
    check('4/a empresa B continua com todos os clientes (nada foi gravado)', stillB === seenB, `${stillB} vs ${seenB}`);
    const insBranch = sql(ctxA, `INSERT INTO branches (id, "companyId", name, "updatedAt") VALUES (gen_random_uuid()::text, '${uuid(B.id)}', 'forjada', now())`);
    check('4/INSERT de filial na empresa B pelo contexto da A não passa', insBranch.err !== '', insBranch.err || 'inseriu!');
  }

  // 5. Histórico: auditoria só cresce (append-only) mesmo para o Super Admin
  {
    const n = Number(one({ type: 'SUPER_ADMIN' }, `SELECT count(*) FROM audit_logs WHERE "companyId" = '${A.id}'`));
    const del = sql({ type: 'SUPER_ADMIN' }, `WITH d AS (DELETE FROM audit_logs WHERE "companyId" = '${A.id}' RETURNING 1) SELECT count(*) FROM d`);
    check('5/DELETE em audit_logs pelo Super Admin sem a chave de expurgo: 0 linhas ou erro', n > 0 && (del.err !== '' || del.rows[0][0] === '0'), del.err || del.out);
    const upd = sql({ type: 'SUPER_ADMIN' }, `WITH u AS (UPDATE audit_logs SET "newValue" = 'adulterado' WHERE "companyId" = '${A.id}' RETURNING 1) SELECT count(*) FROM u`);
    check('5/UPDATE em audit_logs (adulterar histórico): 0 linhas ou erro', upd.err !== '' || upd.rows[0][0] === '0', upd.err || upd.out);
    const delC = sql({ company: A.id, type: 'COMPANY_ADMIN' }, `WITH d AS (DELETE FROM audit_logs WHERE "companyId" = '${A.id}' RETURNING 1) SELECT count(*) FROM d`);
    check('5/DELETE em audit_logs pelo Administrador da empresa: 0 linhas ou erro', delC.err !== '' || delC.rows[0][0] === '0', delC.err || delC.out);
    const after = Number(one({ type: 'SUPER_ADMIN' }, `SELECT count(*) FROM audit_logs WHERE "companyId" = '${A.id}'`));
    check('5/a auditoria da empresa A continua com todas as linhas', after === n, `${after} vs ${n}`);
  }

  S.finish();
})();
