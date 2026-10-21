// Perfis que a matriz principal (profiles.js) não cobria: MECÂNICO (MECHANIC), BALCÃO (OPERATOR sem perfil) e
// VISUALIZADOR (VIEWER). Direto na API — esconder botão na tela não prova nada. Corpo vazio/ID inexistente: 403 = barrado
// no gate; qualquer outro status (400/404) = passou do gate e foi recusado pela validação (nada é criado).
const { suite, sessions, idOf, api } = require('../lib/harness');

const S = suite('profiles-extra');
const { check } = S;

const WRITES = [
  ['POST', '/api/customers'], ['POST', '/api/products'], ['POST', '/api/categories'], ['POST', '/api/stock/movement'],
  ['POST', '/api/stock/adjustment'], ['POST', '/api/stock/transfer'], ['POST', '/api/damage'], ['POST', '/api/discount-rules'],
  ['POST', '/api/partners'], ['POST', '/api/installment-policies'], ['POST', '/api/transfers'], ['POST', '/api/commission-rules'],
  ['POST', '/api/sales'], ['POST', '/api/payments'], ['POST', '/api/cash-register/open'], ['POST', '/api/motorcycles'],
  ['POST', '/api/service-orders'], ['POST', '/api/suppliers'], ['POST', '/api/purchase-orders'], ['POST', '/api/quotes'],
  ['POST', '/api/financial/payables'], ['POST', '/api/financial/receivables'], ['POST', '/api/revisions'],
  ['POST', '/api/follow-ups'], ['POST', '/api/appointments'], ['PUT', '/api/business-hours'], ['POST', '/api/warranties/inexistente/claims'],
  ['POST', '/api/employee-agreements'], ['POST', '/api/agreement-companies'], ['POST', '/api/users'], ['POST', '/api/roles'],
  ['POST', '/api/branches'], ['PUT', '/api/policies/agenda.maxPerSlot'], ['PUT', '/api/company-profile'], ['PUT', '/api/payment-settings'],
  ['PUT', '/api/customers/inexistente'], ['DELETE', '/api/customers/inexistente'], ['DELETE', '/api/products/inexistente'],
  ['POST', '/api/import/customers'], ['POST', '/api/import/products'], ['POST', '/api/import/stock'],
];

(async () => {
  const keys = ['balcao.a1', 'mecanico.a1', 'viewer.a1', 'ceo.b', 'ceo.a'];
  const s = await sessions(keys);
  const { cred } = s;
  const A = cred.companies.A, B = cred.companies.B;

  // 0. Contexto real: tipo, empresa e filial; sem papel granular extra
  for (const [k, tipo] of [['balcao.a1', 'OPERATOR'], ['mecanico.a1', 'MECHANIC'], ['viewer.a1', 'VIEWER']]) {
    const u = s[k].user || {};
    check(`ctx/${k}: tipo ${tipo}`, u.userType === tipo, u.userType);
    check(`ctx/${k}: empresa A e filial Matriz`, u.companyId === A.id && u.branchId === A.branches[0].id, `${u.companyId} ${u.branchId}`);
    check(`ctx/${k}: sem papel granular (permissões extras = 0)`, !(cred.users[k].role), String(cred.users[k].role));
  }

  // 1. VISUALIZADOR: somente leitura — toda escrita deve ser 403
  for (const [m, p] of WRITES) {
    const r = await api.request(m, p, { token: s['viewer.a1'].token, body: m === 'DELETE' ? undefined : {} });
    check(`viewer NÃO PODE ${m} ${p}`, r.status === 403, `HTTP ${r.status} ${r.text?.slice(0, 100)}`);
  }
  for (const p of ['/api/customers', '/api/products', '/api/sales', '/api/service-orders', '/api/appointments']) {
    const r = await api.get(p, { token: s['viewer.a1'].token });
    check(`viewer PODE ler GET ${p}`, r.status === 200, `HTTP ${r.status}`);
  }

  // 2. MECÂNICO: oficina sim; caixa, financeiro, vendas, administração não
  const mecDeny = [
    ['GET', '/api/cash-register/current?branchId=' + A.branches[0].id], ['POST', '/api/cash-register/open'], ['POST', '/api/sales'], ['POST', '/api/payments'],
    ['GET', '/api/financial/payables'], ['POST', '/api/financial/payables'], ['POST', '/api/financial/receivables'], ['POST', '/api/purchase-orders'],
    ['POST', '/api/stock/adjustment'], ['POST', '/api/users'], ['POST', '/api/roles'], ['POST', '/api/branches'], ['GET', '/api/audit-logs'],
    ['GET', '/api/policies'], ['GET', '/api/companies'], ['GET', '/api/backup'], ['GET', '/api/observability/summary'],
  ];
  for (const [m, p] of mecDeny) {
    const r = await api.request(m, p, { token: s['mecanico.a1'].token, body: m === 'GET' ? undefined : {} });
    check(`mecânico NÃO PODE ${m} ${p.split('?')[0]}`, r.status === 403, `HTTP ${r.status} ${r.text?.slice(0, 100)}`);
  }
  for (const p of ['/api/service-orders', '/api/appointments', '/api/products']) {
    const r = await api.get(p, { token: s['mecanico.a1'].token });
    check(`mecânico PODE ler GET ${p}`, r.status === 200, `HTTP ${r.status}`);
  }

  // 3. BALCÃO (= OPERATOR sem perfil, igual ao Caixa): atendimento sim; administração e gestão não
  const balDeny = [
    ['POST', '/api/users'], ['POST', '/api/roles'], ['POST', '/api/permissions'], ['POST', '/api/branches'], ['GET', '/api/roles'],
    ['GET', '/api/audit-logs'], ['GET', '/api/policies'], ['GET', '/api/companies'], ['GET', '/api/backup'], ['GET', '/api/observability/summary'],
    ['POST', '/api/stock/adjustment'], ['POST', '/api/stock/transfer'], ['POST', '/api/financial/payables'], ['POST', '/api/financial/receivables'],
    ['POST', '/api/purchase-orders'], ['POST', '/api/payments/inexistente/cancel'],
  ];
  for (const [m, p] of balDeny) {
    const r = await api.request(m, p, { token: s['balcao.a1'].token, body: m === 'GET' ? undefined : {} });
    check(`balcão NÃO PODE ${m} ${p}`, r.status === 403, `HTTP ${r.status} ${r.text?.slice(0, 100)}`);
  }
  for (const p of ['/api/customers', '/api/products', '/api/sales', '/api/service-orders']) {
    const r = await api.get(p, { token: s['balcao.a1'].token });
    check(`balcão PODE ler GET ${p}`, r.status === 200, `HTTP ${r.status}`);
  }

  // 4. Isolamento entre empresas para os três: registro da empresa B, companyId/branchId forjados
  const tag = `[HML-STRESS] isolamento ${Date.now()}`;
  const custB = await api.post('/api/customers', { name: tag }, { token: s['ceo.b'].token });
  const idB = idOf(custB);
  check('setup: cliente da empresa B criado pelo CEO B', custB.status === 201 && !!idB, `HTTP ${custB.status}`);
  const bBranch = B.branches[0].id;
  for (const k of ['balcao.a1', 'mecanico.a1', 'viewer.a1']) {
    const t = s[k].token;
    let r = await api.get(`/api/customers/${idB}`, { token: t });
    check(`outra-empresa/${k}: GET /customers/<id da empresa B> não devolve o registro`, r.status !== 200 && !String(r.text).includes(tag), `HTTP ${r.status}`);
    r = await api.get(`/api/customers?companyId=${B.id}&branchId=${bBranch}&limit=200`, { token: t });
    check(`outra-empresa/${k}: ?companyId=B&branchId=B forjados não trazem dados da empresa B`, !String(r.text).includes(tag) && !String(r.text).includes(B.id), `HTTP ${r.status}`);
    r = await api.request('GET', '/api/customers?limit=200', { token: t, headers: { 'X-Company-Id': B.id, 'X-Branch-Id': bBranch } });
    check(`outra-empresa/${k}: cabeçalhos X-Company-Id/X-Branch-Id forjados não trazem dados da empresa B`, !String(r.text).includes(tag), `HTTP ${r.status}`);
    r = await api.request('PUT', `/api/customers/${idB}`, { token: t, body: { name: 'invadido' } });
    check(`outra-empresa/${k}: PUT em cliente da empresa B não altera`, r.status >= 400, `HTTP ${r.status}`);
    r = await api.request('DELETE', `/api/customers/${idB}`, { token: t });
    check(`outra-empresa/${k}: DELETE em cliente da empresa B não apaga`, r.status >= 400, `HTTP ${r.status}`);
    r = await api.get(`/api/branches/${bBranch}`, { token: t });
    check(`outra-empresa/${k}: filial da empresa B não é lida`, r.status !== 200, `HTTP ${r.status}`);
  }
  const still = await api.get(`/api/customers/${idB}`, { token: s['ceo.b'].token });
  check('outra-empresa: cliente da empresa B segue íntegro (nome original)', still.status === 200 && String(still.text).includes(tag), `HTTP ${still.status}`);

  // 5. Escalada: nenhum dos três altera o próprio tipo nem atribui perfil
  for (const k of ['balcao.a1', 'mecanico.a1', 'viewer.a1']) {
    const me = s[k].user.id;
    let r = await api.request('PUT', `/api/users/${me}`, { token: s[k].token, body: { userType: 'COMPANY_ADMIN' } });
    check(`escalada/${k}: não vira COMPANY_ADMIN`, r.status === 403, `HTTP ${r.status}`);
    r = await api.request('POST', `/api/users/${me}/roles`, { token: s[k].token, body: { roleId: 'inexistente' } });
    check(`escalada/${k}: não atribui perfil a si mesmo`, r.status === 403, `HTTP ${r.status}`);
  }

  S.finish();
})().catch((e) => { console.error(e); process.exit(2); });
