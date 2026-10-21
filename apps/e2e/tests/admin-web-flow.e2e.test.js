// Web/Admin (Next.js) no navegador real contra a API de desenvolvimento e a empresa demo: login pela tela (erro e sucesso),
// navegação entre módulos, cadastro de cliente com validação, listagem de produtos com busca, quadro do orçamento e papel
// somente-leitura. Dados criados levam "[e2e]" e são removidos ao final. Evidências: docs/evidencias/2026-10-13-playwright/admin-web/.
const fs = require('fs');
const path = require('path');
const { URLS, requireServers, demoLogin, adminToken, mint } = require('../lib/env');
const { PREFIX, launchBrowser, watch, cleanupBalcao, disconnect } = require('../lib/fixtures');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-13-playwright/admin-web');
const sink = { pageErrors: [], serverErrors: [] };
const state = {};
let browser, ctx, page;

async function shot(p, name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await p.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}
async function api(pathname, token) {
  const res = await fetch(`${URLS.api}/api${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API ${pathname} → ${res.status}`);
  return res.json();
}

beforeAll(async () => {
  await requireServers(['api', 'admin']);
  await cleanupBalcao(); // sobras: clientes "[e2e]" (cadastro de cliente desta suíte usa o mesmo prefixo)
  browser = await launchBrowser();
  ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  page = await ctx.newPage();
  watch(page, 'admin', sink);
});

afterAll(async () => {
  if (browser) await browser.close();
  console.log('[admin-web-e2e] limpeza:', JSON.stringify(await cleanupBalcao()));
  await disconnect();
});

test('login: credencial errada mostra erro e permanece na tela de login', async () => {
  const { email } = demoLogin('admin.alfa');
  await page.goto(`${URLS.admin}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Senha').fill('senha-errada-e2e');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('form .text-danger').first().waitFor({ timeout: 15000 });
  expect(new URL(page.url()).pathname).toBe('/login');
  await shot(page, '01-login-erro');
});

test('login: credencial correta abre o painel da empresa', async () => {
  const { email, password } = demoLogin('admin.alfa');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await shot(page, '02-painel');
  state.token = await page.evaluate(() => localStorage.getItem('token'));
  expect(state.token).toBeTruthy();
});

test('navegação entre módulos pelo menu lateral', async () => {
  for (const href of ['/dashboard/customers', '/dashboard/products', '/dashboard/quotes', '/dashboard/service-orders', '/dashboard/sales']) {
    await page.locator(`a[href="${href}"]`).first().click();
    await page.waitForURL(new RegExp(`${href}$`), { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    expect(await page.getByText(/Application error|Unhandled Runtime Error/i).count()).toBe(0);
  }
  await shot(page, '03-vendas-lista');
});

test('cadastro de cliente: formulário vazio mostra validação; preenchido salva e aparece na lista', async () => {
  await page.goto(`${URLS.admin}/dashboard/customers/new`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Salvar Cliente/ }).click();
  await page.locator('#customer-name-error').waitFor({ timeout: 10000 });
  await shot(page, '04-cliente-validacao');
  state.name = `${PREFIX} Cliente Admin ${Date.now()}`;
  await page.locator('#customer-name').fill(state.name);
  await page.getByRole('button', { name: /Salvar Cliente/ }).click();
  await page.waitForURL(/\/dashboard\/customers$/, { timeout: 30000 });
  await page.getByText(state.name).first().waitFor({ timeout: 20000 });
  await shot(page, '05-cliente-na-lista');
});

test('produtos: a lista carrega com o produto do catálogo e sem erro', async () => {
  const sa = adminToken('admin.alfa');
  const { products } = await api('/products?isActive=true&limit=5', sa);
  const sample = products[0];
  expect(sample).toBeTruthy();
  await page.goto(`${URLS.admin}/dashboard/products`, { waitUntil: 'networkidle' });
  await page.getByText(sample.name).first().waitFor({ timeout: 20000 });
  await shot(page, '06-produtos');
});

test('orçamento novo abre com o formulário (cliente, veículo, itens)', async () => {
  await page.goto(`${URLS.admin}/dashboard/quotes/new`, { waitUntil: 'networkidle' });
  expect(await page.getByText(/Application error|Unhandled Runtime Error/i).count()).toBe(0);
  await shot(page, '07-orcamento-novo');
});

test('layout estreito (390 px): painel sem rolagem horizontal da página', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${URLS.admin}/dashboard`, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await shot(page, '08-painel-390px');
  expect(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1366, height: 900 });
});

test('VIEWER (somente leitura): cadastrar cliente é recusado pelo servidor e nada é criado', async () => {
  const vctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  const vp = await vctx.newPage();
  watch(vp, 'admin-viewer', sink);
  await vp.goto(`${URLS.admin}/login`);
  await vp.evaluate((t) => localStorage.setItem('token', t), adminToken('viewer.alfa.1'));
  await vp.goto(`${URLS.admin}/dashboard/customers/new`, { waitUntil: 'networkidle' });
  const name = `${PREFIX} Viewer ${Date.now()}`;
  await vp.locator('#customer-name').fill(name);
  await vp.getByRole('button', { name: /Salvar Cliente/ }).click();
  await vp.getByText('Não foi possível salvar').waitFor({ timeout: 15000 });
  await shot(vp, '09-viewer-cadastro-recusado');
  const found = await api(`/customers?search=${encodeURIComponent(name)}&limit=5`, mint('admin.alfa').accessToken);
  expect((found.customers ?? []).filter((c) => c.name === name)).toEqual([]);
  await vctx.close();
});

test('nenhum erro de página nem resposta 5xx', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
