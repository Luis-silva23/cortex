// Matriz de perfis × ações (HML). Cada linha prova o que o perfil PODE e o que NÃO PODE, direto na API (sem passar
// por tela escondendo botão): rotas com requirePermission/requireUserType, escalada de privilégio, ID de outro usuário,
// companyId/branchId forjados em corpo, query e cabeçalho, token de uma empresa com contexto de outra.
// Rotas protegidas por permissão são chamadas com corpo vazio / ID inexistente: 403 = barrado no gate; qualquer outro
// status (400/404) = passou do gate e foi recusado pela validação — nada é criado.
const { suite, sessions, idOf, api } = require('../lib/harness');

const S = suite('profiles');
const { check } = S;

const PERMS = {
  'ceo.a': ['finance:manage', 'finance:pay', 'finance:reverse', 'purchases:manage', 'purchases:approve', 'purchases:receive', 'stock:adjust', 'stock:transfer'],
  'gerente.a1': ['stock:adjust', 'stock:transfer', 'purchases:approve'],
  'administrativo.a1': ['finance:manage', 'finance:pay', 'purchases:manage', 'purchases:receive'],
  'caixa.a1': [],
};

const GATED = [
  ['POST', '/api/stock/movement', 'stock:adjust'],
  ['POST', '/api/stock/adjustment', 'stock:adjust'],
  ['POST', '/api/stock/transfer', 'stock:transfer'],
  ['POST', '/api/stock/inventory', 'stock:adjust'],
  ['POST', '/api/financial/payables', 'finance:manage'],
  ['POST', '/api/financial/payables/inexistente/pay', 'finance:pay'],
  ['POST', '/api/financial/payables/inexistente/cancel', 'finance:reverse'],
  ['POST', '/api/financial/payables/inexistente/reverse', 'finance:reverse'],
  ['POST', '/api/financial/receivables', 'finance:manage'],
  ['POST', '/api/financial/receivables/inexistente/receive', 'finance:pay'],
  ['POST', '/api/financial/receivables/inexistente/cancel', 'finance:reverse'],
  ['POST', '/api/payments/inexistente/cancel', 'finance:reverse'],
  ['POST', '/api/payments/exceptions/inexistente/resolve', 'finance:reverse'],
  ['POST', '/api/purchase-orders', 'purchases:manage'],
  ['POST', '/api/purchase-orders/inexistente/cancel', 'purchases:manage'],
  ['POST', '/api/purchase-orders/inexistente/approve', 'purchases:approve'],
  ['POST', '/api/purchase-orders/inexistente/receive', 'purchases:receive'],
  ['POST', '/api/purchase-orders/inexistente/return', 'purchases:receive'],
  ['POST', '/api/service-orders/inexistente/payment', 'finance:pay'],
];

// userType: quem pode (SA/CA/MANAGER...) — o resto deve receber 403
const BY_TYPE = [
  ['GET', '/api/roles', ['ceo.a']],
  ['GET', '/api/audit-logs', ['ceo.a', 'gerente.a1']],
  ['GET', '/api/policies', ['ceo.a', 'gerente.a1']],
  ['GET', '/api/companies', []],
  ['GET', '/api/backup', []],
  ['GET', '/api/observability/summary', []],
  ['POST', '/api/users', ['ceo.a'], {}],
  ['POST', '/api/roles', ['ceo.a'], {}],
  ['POST', '/api/permissions', ['ceo.a'], {}],
  ['POST', '/api/branches', ['ceo.a'], {}],
];

(async () => {
  const keys = ['ceo.a', 'gerente.a1', 'gerente.a2', 'administrativo.a1', 'caixa.a1', 'caixa.a2', 'ceo.b', 'gerente.b1', 'caixa.b1'];
  const s = await sessions(keys);
  const { cred } = s;
  const A = cred.companies.A, B = cred.companies.B;

  // 0. Cada usuário: tipo, empresa e filial corretos no token/usuário real
  for (const k of keys) {
    const d = s[k].def, u = s[k].user || {};
    const co = cred.companies[d.company];
    check(`ctx/${k}: empresa do token`, u.companyId === co.id, `${u.companyId} vs ${co.id}`);
    check(`ctx/${k}: tipo ${d.userType}`, u.userType === d.userType, u.userType);
    if (d.branch !== null) check(`ctx/${k}: filial do usuário`, u.branchId === co.branches[d.branch].id, `${u.branchId}`);
  }

  // 1. Permissões granulares: gate certo para cada perfil
  for (const [who, perms] of Object.entries(PERMS)) {
    for (const [m, p, perm] of GATED) {
      const r = await api.request(m, p, { token: s[who].token, body: {} });
      const allowed = perms.includes(perm);
      const ok = allowed ? (r.status !== 403 && r.status !== 401 && r.status < 500) : r.status === 403;
      check(`perm/${who} ${allowed ? 'PODE' : 'NÃO PODE'} ${m} ${p.replace('/inexistente', '/:id')} [${perm}]`, ok, `HTTP ${r.status} ${r.text?.slice(0, 120)}`);
    }
  }

  // 2. Rotas por tipo de usuário
  for (const who of Object.keys(PERMS)) {
    for (const [m, p, allowedWho, body] of BY_TYPE) {
      const r = await api.request(m, p, { token: s[who].token, body });
      const allowed = allowedWho.includes(who);
      const ok = allowed ? (r.status !== 403 && r.status !== 401 && r.status < 500) : r.status === 403;
      check(`tipo/${who} ${allowed ? 'PODE' : 'NÃO PODE'} ${m} ${p}`, ok, `HTTP ${r.status} ${r.text?.slice(0, 120)}`);
    }
  }

  // 3. Diretório de usuários: perfil operacional não vê e-mail/MFA/último acesso dos colegas
  const dirCaixa = (await api.get('/api/users', { token: s['caixa.a1'].token })).body?.data || [];
  check('dir/caixa vê só o diretório enxuto (sem e-mail/MFA)', dirCaixa.length > 0 && dirCaixa.every((u) => !('email' in u) && !('mfaEnabled' in u) && !('lastLoginAt' in u)), JSON.stringify(dirCaixa[0]));
  const dirCeo = (await api.get('/api/users', { token: s['ceo.a'].token })).body?.data || [];
  check('dir/CEO vê registro completo', dirCeo.some((u) => 'email' in u), JSON.stringify(dirCeo[0]));
  check('dir/CEO A só vê usuários da empresa A', dirCeo.length > 0 && dirCeo.every((u) => !u.companyId || u.companyId === A.id), `${dirCeo.length} usuários`);
  check('dir/CEO A não vê nenhum usuário da empresa B', !dirCeo.some((u) => [cred.users['ceo.b'].email, cred.users['caixa.b1'].email].includes(u.email)), '');
  check('dir/nenhuma resposta vaza hash de senha ou segredo MFA', ![dirCeo, dirCaixa].some((d) => JSON.stringify(d).match(/\$2[aby]\$|"password"|mfaSecret|backupCodes/)), '');

  // 4. Escalada de privilégio
  const caixaId = s['caixa.a1'].user.id, gerenteA1Id = s['gerente.a1'].user.id, ceoAId = s['ceo.a'].user.id;
  let r = await api.post('/api/users', { name: 'Escalada', email: `esc.${Date.now()}@hml.local`, password: 'Xx!12345678a', userType: 'SUPER_ADMIN' }, { token: s['ceo.a'].token });
  check('escalada/CEO não cria SUPER_ADMIN', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  r = await api.put(`/api/users/${caixaId}`, { userType: 'COMPANY_ADMIN' }, { token: s['caixa.a1'].token });
  check('escalada/Caixa não promove a si mesmo', r.status === 403, `HTTP ${r.status}`);
  r = await api.put(`/api/users/${caixaId}`, { userType: 'MANAGER' }, { token: s['gerente.a1'].token });
  check('escalada/Gerente não altera tipo de outro usuário', r.status === 403, `HTTP ${r.status}`);
  r = await api.post(`/api/users/${caixaId}/roles`, { roleId: 'qualquer' }, { token: s['administrativo.a1'].token });
  check('escalada/Administrativo não atribui perfil', r.status === 403, `HTTP ${r.status}`);
  r = await api.post(`/api/users/${caixaId}/toggle-active`, {}, { token: s['gerente.a1'].token });
  check('escalada/Gerente não desativa usuário', r.status === 403, `HTTP ${r.status}`);
  r = await api.post(`/api/users/${caixaId}/reset-password`, { newPassword: 'Xx!12345678a' }, { token: s['caixa.a1'].token });
  check('escalada/Caixa não redefine senha de ninguém', r.status === 403, `HTTP ${r.status}`);
  const roleList = (await api.get('/api/roles', { token: s['ceo.a'].token })).body;
  const rolesA = roleList?.data || roleList || [];
  const gerRole = rolesA.find((x) => x.name === 'HML Gerente');
  if (gerRole) {
    r = await api.post(`/api/users/${ceoAId}/roles`, { roleId: gerRole.id }, { token: s['ceo.a'].token });
    check('escalada/CEO não atribui perfil a si mesmo', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
    const rolesB = (await api.get('/api/roles', { token: s['ceo.b'].token })).body;
    const gerB = (rolesB?.data || rolesB || []).find((x) => x.name === 'HML Gerente');
    r = await api.post(`/api/users/${s['caixa.a1'].user.id}/roles`, { roleId: gerB?.id }, { token: s['ceo.a'].token });
    check('escalada/CEO A não usa perfil da empresa B', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
    r = await api.post(`/api/users/${s['caixa.b1'].user.id}/roles`, { roleId: gerRole.id }, { token: s['ceo.a'].token });
    check('escalada/CEO A não atribui perfil a usuário da empresa B', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  }

  // 5. ID de outro usuário / outra empresa
  const caixaB = s['caixa.b1'].user.id;
  for (const [label, call] of [
    ['GET /users/:id', () => api.get(`/api/users/${caixaB}`, { token: s['ceo.a'].token })],
    ['PUT /users/:id', () => api.put(`/api/users/${caixaB}`, { name: 'Invasor' }, { token: s['ceo.a'].token })],
    ['DELETE /users/:id', () => api.del(`/api/users/${caixaB}`, { token: s['ceo.a'].token })],
    ['POST /users/:id/toggle-active', () => api.post(`/api/users/${caixaB}/toggle-active`, {}, { token: s['ceo.a'].token })],
    ['POST /users/:id/reset-password', () => api.post(`/api/users/${caixaB}/reset-password`, { newPassword: 'Xx!12345678a' }, { token: s['ceo.a'].token })],
    ['POST /users/:id/unlock', () => api.post(`/api/users/${caixaB}/unlock`, {}, { token: s['ceo.a'].token })],
    ['GET /users/:id/permissions', () => api.get(`/api/users/${caixaB}/permissions`, { token: s['ceo.a'].token })],
  ]) {
    const x = await call();
    check(`outra-empresa/CEO A em usuário da B: ${label} recusado`, x.status >= 400 && x.status < 500, `HTTP ${x.status} ${x.text?.slice(0, 120)}`);
  }
  const relog = await api.request('POST', '/api/auth/login', { body: { numericId: cred.users['caixa.b1'].numericId, password: cred.users['caixa.b1'].password }, idem: false });
  check('outra-empresa/usuário da B segue intacto (login ainda funciona)', relog.status === 200 && relog.body?.user?.name !== 'Invasor', `HTTP ${relog.status}`);

  // 6. Dados: customers/products — companyId forjado em corpo, query e cabeçalho
  const tag = `HMLPERF${Date.now()}`;
  const custA = await api.post('/api/customers', { name: `Cliente ${tag} A`, document: undefined }, { token: s['caixa.a1'].token });
  check('dados/Caixa A cadastra cliente (fluxo de balcão)', custA.status === 201, `HTTP ${custA.status} ${custA.text?.slice(0, 120)}`);
  const custAId = custA.body?.id;
  const forged = await api.post('/api/customers', { name: `Cliente ${tag} B forjado`, companyId: A.id }, { token: s['caixa.b1'].token, headers: { 'X-Company-Id': A.id, 'X-Branch-Id': A.branches[0].id } });
  check('dados/Caixa B com companyId+headers da A grava na B', forged.status === 201 && forged.body?.companyId === B.id, `HTTP ${forged.status} companyId=${forged.body?.companyId}`);
  const aList = await api.get(`/api/customers?search=${tag}`, { token: s['ceo.a'].token });
  check('dados/CEO A não enxerga o cliente forjado pela B', !JSON.stringify(aList.body).includes('B forjado'), '');
  const bQuery = await api.get(`/api/customers?companyId=${A.id}&search=${tag}`, { token: s['ceo.b'].token });
  check('dados/query companyId=A da B não devolve dados da A', !JSON.stringify(bQuery.body).includes(`${tag} A`), `HTTP ${bQuery.status}`);
  const bHeader = await api.get(`/api/customers?search=${tag}`, { token: s['ceo.b'].token, headers: { 'X-Company-Id': A.id } });
  check('dados/cabeçalho X-Company-Id=A com token da B não devolve dados da A', !JSON.stringify(bHeader.body).includes(`${tag} A`), `HTTP ${bHeader.status}`);
  const byId = await api.get(`/api/customers/${custAId}`, { token: s['ceo.b'].token });
  check('dados/GET direto por ID de cliente da A com token da B → 404/403', [403, 404].includes(byId.status), `HTTP ${byId.status}`);
  const ghost = await api.put('/api/customers/inexistente', { name: 'x' }, { token: s['ceo.b'].token });
  const putId = await api.put(`/api/customers/${custAId}`, { name: 'Sequestrado' }, { token: s['ceo.b'].token });
  check('dados/PUT direto por ID de cliente da A com token da B recusado, sem revelar que existe', putId.status >= 400 && putId.status < 500 && putId.status === ghost.status && putId.text === ghost.text, `HTTP ${putId.status} ${putId.text} | inexistente: ${ghost.status} ${ghost.text}`);
  const delId = await api.del(`/api/customers/${custAId}`, { token: s['ceo.b'].token });
  check('dados/DELETE direto por ID de cliente da A com token da B recusado, sem revelar que existe', delId.status >= 400 && delId.status < 500 && delId.text === ghost.text, `HTTP ${delId.status} ${delId.text}`);
  const still = await api.get(`/api/customers/${custAId}`, { token: s['ceo.a'].token });
  check('dados/cliente da A intacto após as tentativas da B', still.status === 200 && still.body?.name === `Cliente ${tag} A`, `HTTP ${still.status} ${still.body?.name}`);
  const sc = await api.get('/api/customers', { token: s.sa.token });
  check('dados/Super ADM TI sem contexto de empresa não lista dados de cliente (contexto obrigatório)', sc.status === 400, `HTTP ${sc.status}`);

  // 7. Filial: gerente preso à própria filial; branchId forjado
  const prod = await api.post('/api/products', { sku: `${tag}-P`, name: `Produto ${tag}`, costPrice: 10, salePrice: 25, unit: 'UN' }, { token: s['ceo.a'].token });
  check('filial/CEO A cadastra produto', prod.status === 201, `HTTP ${prod.status} ${prod.text?.slice(0, 160)}`);
  const pid = prod.body?.id || idOf(prod);
  const adj = (who, branchId, qty) => api.post('/api/stock/adjustment', { productId: pid, branchId, newQuantity: qty, reason: 'HML perfil' }, { token: s[who].token });
  r = await adj('gerente.a1', A.branches[0].id, 5);
  check('filial/Gerente A1 ajusta estoque da própria filial', r.status === 201, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  r = await adj('gerente.a1', A.branches[1].id, 77);
  check('filial/Gerente A1 NÃO ajusta estoque da filial 2 (branchId forjado)', r.status === 403, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  r = await adj('gerente.b1', A.branches[0].id, 99);
  check('filial/Gerente da empresa B NÃO ajusta filial da empresa A', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  r = await adj('gerente.a2', A.branches[1].id, 3);
  check('filial/Gerente A2 ajusta a própria filial 2', r.status === 201, `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  r = await adj('caixa.a1', A.branches[0].id, 1000);
  check('filial/Caixa NÃO ajusta estoque (sem permissão)', r.status === 403, `HTTP ${r.status}`);
  const lvl = async (who, branchId) => {
    const x = await api.get(`/api/stock/movements?productId=${pid}&branchId=${branchId}`, { token: s[who].token });
    return x;
  };
  r = await lvl('caixa.a1', A.branches[1].id);
  const rows = JSON.stringify(r.body);
  check('filial/Caixa A1 consultando movimentos da filial 2 por query não vê a filial 2', r.status !== 200 || !rows.includes(A.branches[1].id) || !rows.includes('HML perfil'), `HTTP ${r.status} ${rows.slice(0, 200)}`);
  r = await lvl('gerente.b1', A.branches[0].id);
  check('filial/Gerente B consultando movimentos da A não vê nada', r.status !== 200 || !JSON.stringify(r.body).includes('HML perfil'), `HTTP ${r.status}`);
  // transferência: MANAGER preso à filial 1 mexendo em estoque da filial 2
  r = await api.post('/api/stock/transfer', { productId: pid, fromBranchId: A.branches[1].id, toBranchId: A.branches[0].id, quantity: 1 }, { token: s['gerente.a1'].token });
  check('filial/Gerente A1 NÃO transfere SAINDO de estoque de outra filial (recusado)', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text?.slice(0, 200)}`);
  const lv2 = await api.get(`/api/stock/movements?productId=${pid}&branchId=${A.branches[1].id}`, { token: s['ceo.a'].token });
  const mv = lv2.body?.movements || [];
  const net = (Array.isArray(mv) ? mv : []).filter((m) => m.branchId === A.branches[1].id).length;
  check('filial/estoque da filial 2 só tem o ajuste legítimo do Gerente A2 (nenhuma saída forjada)', net === 1, `${net} movimentos na filial 2`);
  // CEO não cria filial em empresa alheia nem usa companyId forjado
  r = await api.post('/api/branches', { name: 'Filial forjada', companyId: B.id }, { token: s['ceo.a'].token });
  const bB = (await api.get('/api/branches', { token: s['ceo.b'].token })).body;
  check('tenant/CEO A não cria filial dentro da empresa B por companyId forjado', !JSON.stringify(bB).includes('Filial forjada'), `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  r = await api.post('/api/permissions', { name: 'hml:forjada', companyId: B.id }, { token: s['ceo.a'].token });
  const permsB = (await api.get('/api/permissions', { token: s['ceo.b'].token })).body;
  check('tenant/CEO A não cria permissão na empresa B por companyId forjado', !JSON.stringify(permsB).includes('hml:forjada'), `HTTP ${r.status} ${r.text?.slice(0, 160)}`);
  S.finish();
})().catch((e) => { console.error('ERRO NA SUÍTE:', e); process.exit(2); });
