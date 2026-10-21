// Fumaça LEVE e SEQUENCIAL do fluxo de autorização de equipamento contra uma API REAL já em pé (homologação/staging). Um processo, ~15
// requisições, sem carga. NÃO usa servidor falso e NÃO roda nos testes automáticos: é a prova que falta em infraestrutura adequada.
//
// O que prova (nessa ordem): API alcançável (health/ready) → equipamento novo se registra e fica PENDENTE → login com a senha certa é
// RECUSADO e dado protegido não abre → administrador autoriza (licença + filial) → login e consulta de produto FUNCIONAM → administrador
// revoga → o mesmo token para de valer na hora e o login é recusado de novo.
//
// Uso (credenciais SÓ por variável de ambiente; nada é gravado em arquivo):
//   SMOKE_API_URL=https://<dominio-da-homologacao> \
//   SMOKE_ADMIN_TOKEN=<access token do Super ADM TI, obtido pelo login com MFA> \
//   SMOKE_LICENSE_ID=<licença ativa da empresa de TESTE> SMOKE_BRANCH_ID=<filial dessa empresa> \
//   SMOKE_OPERATOR_EMAIL=<usuário da empresa de TESTE, sem MFA> SMOKE_OPERATOR_PASSWORD=<senha> \
//   node scripts/smoke-device-flow.js
// Use uma empresa de TESTE: o script cria 1 equipamento e o REVOGA no fim (não apaga nada). Sai com código 1 se algo falhar.
const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Falta a variável ${k} (ver o cabeçalho deste arquivo).`);
    process.exit(2);
  }
  return v;
};
const API = need('SMOKE_API_URL').replace(/\/+$/, '');
const ADMIN = need('SMOKE_ADMIN_TOKEN');
const LICENSE = need('SMOKE_LICENSE_ID');
const BRANCH = need('SMOKE_BRANCH_ID');
const EMAIL = need('SMOKE_OPERATOR_EMAIL');
const PASSWORD = need('SMOKE_OPERATOR_PASSWORD');

let failed = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'OK    ' : 'FALHOU'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed += 1;
};
const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // corpo vazio ou não-JSON
  }
  return { status: res.status, body: json };
};

(async () => {
  console.log(`Fumaça do fluxo de equipamento em ${API}`);
  if (!API.startsWith('https://')) console.log('AVISO  a URL não é https: em staging/produção o servidor deve exigir HTTPS (a fumaça segue só para ambiente interno).');

  const ready = await call('GET', '/api/health/ready');
  check(ready.status === 200, 'API pronta (health/ready)', `status ${ready.status}`);
  if (ready.status !== 200) process.exit(1);

  const enroll = await call('POST', '/api/device/enroll', { body: { deviceName: `fumaca-${Date.now()}`, deviceType: 'POS' } });
  check(enroll.status === 201 && enroll.body?.data?.status === 'PENDING', 'equipamento novo se registra e fica PENDENTE', `status ${enroll.status}`);
  const { deviceId, deviceKey, enrollmentCode } = enroll.body?.data ?? {};
  if (!deviceId) process.exit(1);
  console.log(`       código para conferência do administrador: ${enrollmentCode}`);

  const pendingStatus = await call('POST', '/api/device/status', { body: { deviceId, deviceKey } });
  check(pendingStatus.body?.data?.status === 'PENDING' && !pendingStatus.body?.data?.company, 'status PENDENTE sem dado de empresa');

  const deniedLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD, deviceId, deviceKey } });
  check(deniedLogin.status === 403 && !deniedLogin.body?.accessToken, 'login com senha certa em equipamento pendente é RECUSADO', `status ${deniedLogin.status} ${deniedLogin.body?.error ?? ''}`);
  const noToken = await call('GET', '/api/products');
  check(noToken.status === 401, 'dado protegido sem token = 401', `status ${noToken.status}`);

  const authorize = await call('POST', `/api/activations/enrollments/${deviceId}/authorize`, { token: ADMIN, body: { licenseId: LICENSE, branchId: BRANCH } });
  check(authorize.status === 200 && authorize.body?.data?.status === 'ACTIVE', 'administrador autoriza (licença + filial)', `status ${authorize.status}`);
  if (authorize.status !== 200) process.exit(1);

  const okLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD, deviceId, deviceKey } });
  check(okLogin.status === 200 && !!okLogin.body?.accessToken, 'login com equipamento autorizado FUNCIONA', `status ${okLogin.status}`);
  const token = okLogin.body?.accessToken;
  const products = token ? await call('GET', '/api/products?limit=1', { token }) : { status: 0 };
  check(products.status === 200, 'consulta de produto com a sessão do equipamento', `status ${products.status}`);

  const revoke = await call('POST', `/api/activations/devices/${deviceId}/revoke`, { token: ADMIN, body: { reason: 'fumaça do fluxo de equipamento' } });
  check(revoke.status === 200, 'administrador revoga o equipamento', `status ${revoke.status}`);
  const after = token ? await call('GET', '/api/products?limit=1', { token }) : { status: 0 };
  check(after.status === 401, 'o MESMO token para de valer na hora', `status ${after.status}`);
  const againLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD, deviceId, deviceKey } });
  check(againLogin.status === 403 && againLogin.body?.error === 'DEVICE_REVOKED', 'login depois da revogação é recusado (DEVICE_REVOKED)', `status ${againLogin.status}`);

  console.log(failed === 0 ? '\nFUMAÇA APROVADA' : `\nFUMAÇA REPROVADA (${failed} falha(s))`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('Erro na fumaça:', error.message);
  process.exit(1);
});
