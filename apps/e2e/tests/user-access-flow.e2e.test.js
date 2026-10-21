// Jornada de ACESSO no navegador real (Admin Web :3002 + API de desenvolvimento, empresa demo Alfa): o administrador cadastra um gerente com filial principal, concede uma
// filial adicional, o gerente entra com a SENHA TEMPORÁRIA e é obrigado a trocá-la (política de senha na tela), entra com a senha nova, troca a própria senha em
// Configurações › Segurança e é levado ao login; por fim o administrador retira a filial extra e o acesso cai na API. Usuários criados: "e2e-acesso-…@demo.local",
// removidos ao final por id e companyId (a trilha de auditoria, append-only, fica). Não cria venda nem registro financeiro.
const fs = require('fs');
const path = require('path');
const { URLS, requireServers, demoLogin, demoCredentials, adminToken } = require('../lib/env');
const { launchBrowser, watch, cleanupAccessUsers, disconnect } = require('../lib/fixtures');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-18-playwright/user-access');
const sink = { pageErrors: [], serverErrors: [] };
const stamp = Date.now();
const EMAIL = `e2e-acesso-${stamp}@demo.local`;
const NAME = `[e2e] Gerente Acesso ${stamp}`;
const TEMP = `Temp-e2e-${stamp}-x`;
const NEW1 = `Troca-E2e-${stamp}-ok`;
const NEW2 = `Segunda-E2e-${stamp}-ok`;
const state = {};
let browser, adminCtx, admin, mgrCtx, mgr;

const shot = async (p, name) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await p.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
};
const api = async (pathname, token, init = {}) => {
  const res = await fetch(`${URLS.api}/api${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const login = async (page, email, password) => {
  await page.goto(`${URLS.admin}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
};

beforeAll(async () => {
  await requireServers(['api', 'admin']);
  await cleanupAccessUsers(); // sobras de uma execução interrompida
  const alfa = demoCredentials().companies.alfa;
  state.a1 = alfa.branches[0];
  state.a2 = alfa.branches[1];
  state.adminApiToken = adminToken('admin.alfa');
  const branches = (await api('/branches', state.adminApiToken)).body.data;
  state.names = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  browser = await launchBrowser();
  adminCtx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  admin = await adminCtx.newPage();
  watch(admin, 'admin', sink);
}, 120000);

afterAll(async () => {
  if (browser) await browser.close();
  console.log('[user-access-e2e] limpeza:', JSON.stringify(await cleanupAccessUsers()));
  await disconnect();
});

test('o administrador entra e cadastra um gerente: sem filial principal o cadastro é recusado na tela; com ela o gerente aparece com a filial', async () => {
  const { email, password } = demoLogin('admin.alfa');
  await login(admin, email, password);
  await admin.waitForURL(/\/dashboard/, { timeout: 30000 });
  await admin.goto(`${URLS.admin}/dashboard/users`, { waitUntil: 'networkidle' });
  await admin.getByRole('button', { name: 'Novo Usuário' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Novo Usuário' });
  const fields = dialog.locator('input:not([type=checkbox])');
  await fields.nth(0).fill(NAME);
  await fields.nth(1).fill(EMAIL);
  await fields.nth(2).fill(TEMP);
  await dialog.locator('select').nth(0).selectOption('MANAGER');
  // exigir troca de senha vem LIGADO por padrão
  expect(await dialog.getByLabel('Exigir troca de senha no primeiro acesso').isChecked()).toBe(true);
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await dialog.getByText(/Escolha a filial principal/).waitFor({ timeout: 10000 });
  await shot(admin, '01-filial-obrigatoria');
  await dialog.locator('select').nth(1).selectOption(state.a1);
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  const row = admin.locator('tr', { hasText: EMAIL });
  await row.waitFor({ timeout: 20000 });
  expect(await row.innerText()).toContain(state.names[state.a1]);
  state.userId = (await api('/users?limit=100', state.adminApiToken)).body.data.find((u) => u.email === EMAIL).id;
  await shot(admin, '02-gerente-criado');
});

test('"Filiais": o administrador concede uma segunda filial e a API passa a listar A1 + A2', async () => {
  const row = admin.locator('tr', { hasText: EMAIL });
  await row.getByRole('button', { name: 'Filiais' }).click();
  const dialog = admin.getByRole('dialog', { name: /Filiais de/ });
  const primary = dialog.getByLabel(`Filial ${state.names[state.a1]}`);
  expect(await primary.isChecked()).toBe(true);
  expect(await primary.isDisabled()).toBe(true); // a principal não se desmarca por aqui
  await dialog.getByLabel(`Filial ${state.names[state.a2]}`).check();
  await shot(admin, '03-filiais-marcadas');
  await dialog.getByRole('button', { name: 'Salvar filiais' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
  const links = (await api(`/users/${state.userId}/branches`, state.adminApiToken)).body.data;
  expect(links.branchIds.sort()).toEqual([state.a1, state.a2].sort());
});

test('primeiro acesso do gerente: a senha temporária abre a troca de senha (política na tela) e só então entra', async () => {
  mgrCtx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  mgr = await mgrCtx.newPage();
  watch(mgr, 'gerente', sink);
  await login(mgr, EMAIL, TEMP);
  await mgr.getByTestId('password-change').waitFor({ timeout: 20000 });
  expect(await mgr.evaluate(() => localStorage.getItem('token'))).toBeNull(); // nenhuma sessão antes da troca
  await shot(mgr, '04-troca-obrigatoria');

  await mgr.getByLabel('Senha temporária').fill(TEMP);
  await mgr.getByLabel('Nova senha', { exact: true }).fill('curta1');
  await mgr.getByLabel('Repita a nova senha').fill('curta1');
  await mgr.getByRole('button', { name: 'Trocar senha' }).click();
  await mgr.getByRole('alert').getByText(/pelo menos 10 caracteres/).waitFor({ timeout: 15000 });
  await shot(mgr, '05-senha-fraca-recusada');

  await mgr.getByLabel('Nova senha', { exact: true }).fill(NEW1);
  await mgr.getByLabel('Repita a nova senha').fill(`${NEW1}-diferente`);
  expect(await mgr.getByRole('button', { name: 'Trocar senha' }).isDisabled()).toBe(true); // confirmação diferente não envia
  await mgr.getByLabel('Repita a nova senha').fill(NEW1);
  await mgr.getByRole('button', { name: 'Trocar senha' }).click();
  await mgr.getByTestId('login-notice').waitFor({ timeout: 20000 });
  expect(await mgr.getByTestId('login-notice').innerText()).toMatch(/Senha trocada/);
  await shot(mgr, '06-login-apos-troca');
});

test('com a senha nova o gerente entra e a API mostra A1 e A2 (e recusa a senha temporária)', async () => {
  await mgr.getByLabel('Email').fill(EMAIL);
  await mgr.getByLabel('Senha').fill(TEMP);
  await mgr.getByRole('button', { name: 'Entrar' }).click();
  await mgr.locator('form .text-danger').first().waitFor({ timeout: 15000 }); // a temporária não vale mais
  await mgr.getByLabel('Senha').fill(NEW1);
  await mgr.getByRole('button', { name: 'Entrar' }).click();
  await mgr.waitForURL(/\/dashboard/, { timeout: 30000 });
  state.mgrToken = await mgr.evaluate(() => localStorage.getItem('token'));
  expect(state.mgrToken).toBeTruthy();
  for (const branch of [state.a1, state.a2]) {
    expect((await api(`/dashboard/management/summary?period=30d&branchId=${branch}`, state.mgrToken)).status).toBe(200);
  }
  await shot(mgr, '07-gerente-no-painel');
});

test('troca voluntária em Configurações › Segurança: encerra a sessão, leva ao login, e a senha antiga para de valer', async () => {
  await mgr.goto(`${URLS.admin}/dashboard/settings`, { waitUntil: 'networkidle' });
  await mgr.getByRole('button', { name: /Segurança/ }).click();
  const form = mgr.getByTestId('change-password-form');
  await form.waitFor({ timeout: 15000 });
  expect(await form.locator('input[disabled]').count()).toBe(0); // os campos são reais, não ilustrativos
  await shot(mgr, '08-seguranca');
  await form.getByLabel('Senha atual').fill(NEW1);
  await form.getByLabel('Nova senha', { exact: true }).fill(NEW2);
  await form.getByLabel('Confirmar nova senha').fill(NEW2);
  await form.getByRole('button', { name: 'Trocar senha' }).click();
  await mgr.waitForURL(/\/login/, { timeout: 30000 });
  expect((await api('/auth/me', state.mgrToken)).status).toBe(401); // a sessão antiga foi revogada
  await login(mgr, EMAIL, NEW1);
  await mgr.locator('form .text-danger').first().waitFor({ timeout: 15000 });
  await mgr.getByLabel('Senha').fill(NEW2);
  await mgr.getByRole('button', { name: 'Entrar' }).click();
  await mgr.waitForURL(/\/dashboard/, { timeout: 30000 });
  state.mgrToken2 = await mgr.evaluate(() => localStorage.getItem('token'));
});

test('o administrador retira a filial extra: o gerente perde A2 na API com a mesma sessão (403) e segue com A1', async () => {
  const row = admin.locator('tr', { hasText: EMAIL });
  await admin.reload({ waitUntil: 'networkidle' });
  await admin.locator('tr', { hasText: EMAIL }).getByRole('button', { name: 'Filiais' }).click();
  const dialog = admin.getByRole('dialog', { name: /Filiais de/ });
  await dialog.getByLabel(`Filial ${state.names[state.a2]}`).uncheck();
  await dialog.getByRole('button', { name: 'Salvar filiais' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
  void row;
  const denied = await api(`/dashboard/management/summary?period=30d&branchId=${state.a2}`, state.mgrToken2);
  expect(denied.status).toBe(403);
  expect(denied.body.code || denied.body.error).toMatch(/BRANCH_FORBIDDEN/);
  expect((await api(`/dashboard/management/summary?period=30d&branchId=${state.a1}`, state.mgrToken2)).status).toBe(200);
  await shot(admin, '09-filial-retirada');
});

test('nenhum erro de página nem resposta 5xx durante a jornada', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
