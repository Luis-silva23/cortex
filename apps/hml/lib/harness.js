// Mini-harness das suítes de homologação: asserções com evidência, sessões reais (login + MFA) e relatório JSON em
// apps/hml/.hml/results/<suite>.json (gitignorado). Sem dependências.
const fs = require('fs');
const path = require('path');
const { api, login, readCredentials } = require('./api');

const RESULTS = path.join(__dirname, '..', '.hml', 'results');

function suite(name) {
  const rows = [];
  const check = (id, ok, detail = '') => {
    rows.push({ id, ok: !!ok, detail: String(detail).slice(0, 400) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`);
    return !!ok;
  };
  const finish = () => {
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify({ suite: name, at: new Date().toISOString(), rows }, null, 2));
    const failed = rows.filter((r) => !r.ok);
    console.log(`\n[${name}] ${rows.length - failed.length}/${rows.length} ok${failed.length ? `, ${failed.length} FALHA(S)` : ''}`);
    process.exit(failed.length ? 1 : 0);
  };
  return { check, finish, rows };
}

/** Login de todos os usuários de homologação (ID numérico + senha + MFA quando houver). */
async function sessions(keys) {
  const cred = readCredentials();
  const out = { cred };
  for (const k of keys || Object.keys(cred.users)) {
    const u = cred.users[k];
    const l = await login({ numericId: u.numericId, password: u.password, mfaSecret: u.mfaSecret });
    if (!l.ok) throw new Error(`login ${k} falhou (${l.status})`);
    out[k] = { token: l.token, refreshToken: l.refreshToken, user: l.user, def: u };
  }
  const sa = await login({ email: cred.sa.email, password: cred.sa.password, mfaSecret: cred.sa.mfaSecret });
  if (!sa.ok) throw new Error('login do Super ADM TI falhou');
  out.sa = { token: sa.token, user: sa.user };
  return out;
}

const idOf = (r) => (r.body?.data ?? r.body)?.id;

module.exports = { suite, sessions, idOf, api, login };
