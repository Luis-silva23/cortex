// Consulta direta ao banco HML (porta 5433, lnsystem_hml) via psql, SEMPRE dentro de uma transação com contexto
// SUPER_ADMIN (RLS FORCE devolve 0 linhas sem ele). Serve para PROVAR invariantes — resposta HTTP 200 não prova nada.
// Só lê por padrão. Escrita (limpeza) exige `write: true` e SQL com company_id explícito; recusa TRUNCATE e
// DELETE/UPDATE sem company_id.
const { spawnSyncHidden: spawnSync } = require('./proc');
const path = require('path');
const infra = require('../infra');

const PSQL = path.join(process.env.LOCALAPPDATA || '', 'ln-system-tools', 'pg-extract', 'pgsql', 'bin', 'psql.exe');

function run(sql, { write = false, company = '', pre = [] } = {}) {
  const url = infra.dbUrl(infra.secrets()).replace(/\?schema=.*$/, '');
  if (!/:5433\/lnsystem_hml\b/.test(url)) throw new Error('banco HML inesperado');
  if (/[^0-9a-f-]/i.test(company)) throw new Error('company inválido');
  if (write) {
    if (/\btruncate\b/i.test(sql)) throw new Error('TRUNCATE proibido na limpeza HML');
    if (/\b(delete|update)\b/i.test(sql) && !/company_?id/i.test(sql)) throw new Error('DELETE/UPDATE sem companyId proibido');
  }
  const head = [
    'BEGIN',
    `SET LOCAL "app.current_company_id" = '${company}'`,
    `SET LOCAL "app.user_type" = 'SUPER_ADMIN'`,
    `SET LOCAL "app.current_branch_id" = ''`,
    ...pre,
  ];
  const script = `${head.join(';\n')};\n${sql};\n${write ? 'COMMIT' : 'ROLLBACK'};\n`;
  const r = spawnSync(PSQL, [url, '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim().slice(0, 500)}`);
  return r.stdout.split(/\r?\n/).filter((l) => l.length).map((l) => l.split('\t'));
}

/** Escalar: primeira coluna da última linha. */
const scalar = (sql, opts) => {
  const rows = run(sql, opts);
  return rows.length ? rows[rows.length - 1][0] : null;
};

module.exports = { run, scalar };
