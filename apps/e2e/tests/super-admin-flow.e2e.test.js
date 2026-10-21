// Super Admin (Next.js, :3000) no navegador real: login pela tela com MFA (código TOTP do usuário de E2E), navegação pelos módulos
// da plataforma e controle de acesso (um usuário de EMPRESA não entra no console). Somente leitura: nada é criado.
// Evidências: docs/evidencias/2026-10-13-playwright/super-admin/.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { URLS, API_DIR, requireServers, demoLogin, demoCredentials, adminToken } = require('../lib/env');
const { launchBrowser, watch, disconnect } = require('../lib/fixtures');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-13-playwright/super-admin');
const sink = { pageErrors: [], serverErrors: [] };
let browser, page;

const totp = () => execSync('npm run -s demo:tools -- totp', { cwd: API_DIR, encoding: 'utf8' }).match(/\d{6}/)[0];
async function shot(p, name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await p.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}

beforeAll(async () => {
  await requireServers(['api', 'sa']);
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  page = await ctx.newPage();
  watch(page, 'sa', sink);
});

afterAll(async () => {
  if (browser) await browser.close();
  await disconnect();
});

test('login: senha errada é recusada e fica na tela de login', async () => {
  const { email } = demoLogin('sa.e2e');
  await page.goto(`${URLS.sa}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Senha').fill('senha-errada-e2e');
  await page.getByRole('button', { name: /Entrar/ }).click();
  await page.locator('form .text-danger, form [role="alert"], form .text-red-600').first().waitFor({ timeout: 15000 });
  expect(new URL(page.url()).pathname).toBe('/login');
  await shot(page, '01-login-erro');
});

test('login: senha correta pede o segundo fator; o código TOTP abre o console da plataforma', async () => {
  const { email, password } = demoLogin('sa.e2e');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: /Entrar/ }).click();
  await page.locator('#mfa-code').waitFor({ timeout: 20000 });
  await shot(page, '02-mfa');
  await page.locator('#mfa-code').fill(totp());
  await page.getByRole('button', { name: /Confirmar|Verificar/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await shot(page, '03-painel-plataforma');
});

test('navegação pelos módulos da plataforma sem erro de página', async () => {
  const routes = ['/dashboard/companies', '/dashboard/licenses', '/dashboard/devices', '/dashboard/users', '/dashboard/audit-logs', '/dashboard/backup', '/dashboard/observability/central', '/dashboard/support'];
  for (const href of routes) {
    await page.locator(`a[href="${href}"]`).first().click();
    await page.waitForURL(new RegExp(`${href}$`), { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    expect(await page.getByText(/Application error|Unhandled Runtime Error/i).count()).toBe(0);
    await page.waitForTimeout(700); // respeita o limite de 100 requisições/min do usuário
  }
  await shot(page, '04-suporte');
});

test('sair encerra a sessão: tela interna volta ao login', async () => {
  await page.locator('[aria-label*="Sair"], button:has-text("Sair")').first().click();
  await page.waitForURL(/\/login/, { timeout: 20000 });
  await page.goto(`${URLS.sa}/dashboard/companies`, { waitUntil: 'networkidle' });
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('usuário de EMPRESA não opera o console da plataforma: empresas/backup recusados; licença só a da própria empresa', async () => {
  const token = adminToken('admin.alfa');
  const get = (url) => fetch(`${URLS.api}${url}`, { headers: { Authorization: `Bearer ${token}` } });
  const alfa = demoCredentials().companies.alfa.companyId;
  for (const url of ['/api/companies', `/api/companies/${alfa}`, '/api/backup/status']) {
    expect([401, 403]).toContain((await get(url)).status);
  }
  const lic = await get('/api/licenses');
  expect(lic.status).toBe(200);
  const body = await lic.json();
  const rows = body.data ?? body.licenses ?? [];
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((l) => l.companyId === alfa)).toBe(true);
});

test('nenhum erro de página nem resposta 5xx', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
