#!/usr/bin/env node
// Provisiona o ambiente HML pelos CAMINHOS REAIS da API (nada de escrita direta no banco, exceto o primeiro Super Admin):
//   Super ADM TI (MFA) → empresas HML Alfa e HML Beta → filiais → CEO de cada empresa (COMPANY_ADMIN, MFA)
//   → catálogo de permissões (as mesmas strings que as rotas exigem) → perfis "Administrativo" e "Gerente"
//   → Gerente, Administrativo e Caixa por filial. Cada usuário recebe ID numérico do sistema e senha própria aleatória.
// Idempotente: reexecutar reaproveita o que já existe em apps/hml/.hml/credentials.json (gitignorado).
//
// Pré-requisitos: node apps/hml/infra.js init|start ; node apps/hml/infra.js api-start ;
//                 node apps/hml/run.js --cwd apps/api -- npx tsx scripts/hml-seed-sa.ts
const crypto = require('crypto');
const { api, login, totp, readCredentials, writeCredentials } = require('./lib/api');

const pw = () => `Hm${crypto.randomBytes(12).toString('base64url')}#9`;
const must = (r, what) => {
  if (r.status < 200 || r.status >= 300) throw new Error(`${what} falhou: HTTP ${r.status} ${r.text?.slice(0, 300) || r.error}`);
  return r.body?.data ?? r.body;
};

// Permissões que as rotas realmente exigem (requirePermission) — o catálogo não é semeado por migração.
const CATALOG = [
  'finance:manage', 'finance:pay', 'finance:reverse', 'purchases:manage', 'purchases:approve', 'purchases:receive',
  'stock:adjust', 'stock:transfer', 'data:import', 'support:view_company',
];
// Composição dos perfis granulares (só permissões que já existem; nenhuma criada para facilitar teste).
const ROLE_PERMS = {
  Administrativo: ['finance:manage', 'finance:pay', 'purchases:manage', 'purchases:receive', 'data:import'],
  Gerente: ['stock:adjust', 'stock:transfer', 'purchases:approve'],
};

const COMPANIES = {
  A: { name: 'HML Motos Alfa', document: '11.111.111/0001-11', email: 'contato@alfa.hml.local', branches: ['Alfa — Matriz', 'Alfa — Filial 2'] },
  B: { name: 'HML Motos Beta', document: '22.222.222/0001-22', email: 'contato@beta.hml.local', branches: ['Beta — Matriz'] },
};

// key, empresa, filial (índice) ou null, tipo, perfil granular, MFA
const USERS = [
  ['ceo.a', 'A', null, 'COMPANY_ADMIN', null, true, 'CEO Alfa'],
  ['gerente.a1', 'A', 0, 'MANAGER', 'Gerente', true, 'Gerente Alfa Matriz'],
  ['gerente.a2', 'A', 1, 'MANAGER', 'Gerente', true, 'Gerente Alfa Filial 2'],
  ['administrativo.a1', 'A', 0, 'OPERATOR', 'Administrativo', false, 'Administrativo Alfa Matriz'],
  ['caixa.a1', 'A', 0, 'OPERATOR', null, false, 'Caixa 1 Alfa Matriz'],
  ['caixa.a1b', 'A', 0, 'OPERATOR', null, false, 'Caixa 2 Alfa Matriz'],
  ['caixa.a2', 'A', 1, 'OPERATOR', null, false, 'Caixa Alfa Filial 2'],
  ['ceo.b', 'B', null, 'COMPANY_ADMIN', null, true, 'CEO Beta'],
  ['gerente.b1', 'B', 0, 'MANAGER', 'Gerente', true, 'Gerente Beta Matriz'],
  ['caixa.b1', 'B', 0, 'OPERATOR', null, false, 'Caixa Beta Matriz'],
  ['balcao.a1', 'A', 0, 'OPERATOR', null, false, 'HML-BALCAO Alfa Matriz'],
  ['mecanico.a1', 'A', 0, 'MECHANIC', null, false, 'HML-MECANICO Alfa Matriz'],
  ['viewer.a1', 'A', 0, 'VIEWER', null, false, 'HML-VIEWER Alfa Matriz'],
];

async function enrollMfa(token, who) {
  const s = must(await api.post('/api/mfa/setup', {}, { token }), `MFA setup ${who}`);
  const v = await api.post('/api/mfa/verify', { code: totp(s.secret) }, { token });
  if (v.status !== 200) throw new Error(`MFA verify ${who}: HTTP ${v.status} ${v.text?.slice(0, 200)}`);
  return s.secret;
}

(async () => {
  const cred = readCredentials();
  if (!cred.sa) throw new Error('Super Admin TI ausente: rode hml-seed-sa.ts primeiro');
  cred.companies ||= {};
  cred.users ||= {};
  const save = () => writeCredentials(cred);

  // 1. Super ADM TI + MFA (pela API)
  let sa = await login({ email: cred.sa.email, password: cred.sa.password, mfaSecret: cred.sa.mfaSecret });
  if (!sa.ok) throw new Error(`login do Super ADM TI falhou: ${sa.status}`);
  if (!cred.sa.mfaSecret) { cred.sa.mfaSecret = await enrollMfa(sa.token, 'Super ADM TI'); save(); sa = await login({ email: cred.sa.email, password: cred.sa.password, mfaSecret: cred.sa.mfaSecret }); }
  const SA = sa.token;
  console.log('[bootstrap] Super ADM TI com MFA ativo');

  // 2. Catálogo global de permissões (SUPER_ADMIN, companyId null)
  const existing = must(await api.get('/api/permissions', { token: SA }), 'listar permissões');
  const permId = {};
  for (const p of existing) if (!p.companyId) permId[p.name] = p.id;
  for (const name of CATALOG) {
    if (permId[name]) continue;
    permId[name] = must(await api.post('/api/permissions', { name, description: `HML: ${name}`, companyId: null }, { token: SA }), `criar permissão ${name}`).id;
  }

  // 3. Empresas e filiais
  for (const [k, c] of Object.entries(COMPANIES)) {
    let co = cred.companies[k];
    if (!co) {
      const created = must(await api.post('/api/companies', { name: c.name, document: c.document, email: c.email }, { token: SA }), `empresa ${k}`);
      co = { id: created.id, name: c.name, branches: [] };
      cred.companies[k] = co; save();
    }
    for (let i = co.branches.length; i < c.branches.length; i++) {
      const b = must(await api.post('/api/branches', { companyId: co.id, name: c.branches[i], isHeadquarter: i === 0 }, { token: SA }), `filial ${c.branches[i]}`);
      co.branches.push({ id: b.id, name: c.branches[i] }); save();
    }
  }
  console.log('[bootstrap] empresas e filiais:', Object.entries(cred.companies).map(([k, c]) => `${k}=${c.branches.length} filiais`).join(', '));

  // 4. CEO (COMPANY_ADMIN) de cada empresa, criado pelo Super ADM TI; depois o CEO cria o resto.
  const sessions = {};
  const ensureLogin = async (key) => {
    const u = cred.users[key];
    const l = await login({ numericId: u.numericId, password: u.password, mfaSecret: u.mfaSecret });
    if (!l.ok) throw new Error(`login ${key} falhou: ${l.status}`);
    return l;
  };
  for (const co of ['A', 'B']) {
    const key = `ceo.${co.toLowerCase()}`;
    const def = USERS.find((u) => u[0] === key);
    if (!cred.users[key]) {
      const password = pw();
      const email = `${key}@hml.local`;
      const u = must(await api.post('/api/users', { name: def[6], email, password, userType: 'COMPANY_ADMIN', companyId: cred.companies[co].id }, { token: SA }), `criar ${key}`);
      cred.users[key] = { email, numericId: u.numericId, password, userType: 'COMPANY_ADMIN', company: co, branch: null }; save();
    }
    let l = await ensureLogin(key);
    if (def[5] && !cred.users[key].mfaSecret) { cred.users[key].mfaSecret = await enrollMfa(l.token, key); save(); l = await ensureLogin(key); }
    sessions[key] = l.token;
  }

  // 5. Perfis granulares (pelo CEO da empresa) e usuários
  const roleId = {};
  for (const co of ['A', 'B']) {
    const ceo = sessions[`ceo.${co.toLowerCase()}`];
    const roles = must(await api.get('/api/roles', { token: ceo }), 'listar perfis');
    roleId[co] = {};
    for (const [name, perms] of Object.entries(ROLE_PERMS)) {
      let r = roles.find((x) => x.name === `HML ${name}` && x.companyId === cred.companies[co].id);
      if (!r) {
        r = must(await api.post('/api/roles', { name: `HML ${name}`, description: `Perfil ${name} (HML)` }, { token: ceo }), `criar perfil ${name}`);
        for (const p of perms) must(await api.post(`/api/roles/${r.id}/permissions`, { permissionId: permId[p] }, { token: ceo }), `perm ${p}`);
      }
      roleId[co][name] = r.id;
    }
  }

  for (const [key, co, bi, userType, role, mfa, name] of USERS) {
    if (key.startsWith('ceo.')) continue;
    const ceo = sessions[`ceo.${co.toLowerCase()}`];
    const company = cred.companies[co];
    if (!cred.users[key]) {
      const password = pw();
      const email = `${key}@hml.local`;
      const body = { name, email, password, userType, branchId: bi === null ? undefined : company.branches[bi].id };
      const u = must(await api.post('/api/users', body, { token: ceo }), `criar ${key}`);
      cred.users[key] = { email, numericId: u.numericId, password, userType, company: co, branch: bi, role }; save();
      if (role) must(await api.post(`/api/users/${u.id}/roles`, { roleId: roleId[co][role], branchId: company.branches[bi].id }, { token: ceo }), `perfil de ${key}`);
    }
    if (mfa && !cred.users[key].mfaSecret) {
      const l = await ensureLogin(key);
      cred.users[key].mfaSecret = await enrollMfa(l.token, key); save();
    }
  }
  console.log('[bootstrap] usuários:', Object.entries(cred.users).map(([k, u]) => `${k}(#${u.numericId}${u.mfaSecret ? ',MFA' : ''})`).join(' '));
  console.log('[bootstrap] ok — credenciais em apps/hml/.hml/credentials.json (gitignorado)');
})().catch((e) => { console.error('[bootstrap] ERRO:', e.message); process.exit(1); });
