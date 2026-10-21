// Admin Web (Next.js, :3002) no navegador real: códigos de barras múltiplos na edição do produto (adicionar, conflito 409,
// desativar/reativar), mensagem padrão de falta de autorização (perfil de consulta) e Central de Ajuda (busca e artigo publicado).
// Produtos de teste têm SKU "E2E-…" e são removidos ao final (sem histórico de venda). Evidências:
// docs/evidencias/2026-10-13-playwright/catalogo-ajuda/.
const fs = require('fs');
const path = require('path');
const { URLS, requireServers, adminToken, mint } = require('../lib/env');
const { launchBrowser, watch, cleanupCatalog, disconnect } = require('../lib/fixtures');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-13-playwright/catalogo-ajuda');
const sink = { pageErrors: [], serverErrors: [] };
const state = {};
let browser, page;

async function shot(p, name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await p.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}
async function api(method, url, body, token = state.token) {
  const res = await fetch(`${URLS.api}/api${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
const NO_PERMISSION = 'Usuário sem autorização. Entre em contato com o administrador.';

beforeAll(async () => {
  await requireServers(['api', 'admin']);
  await cleanupCatalog();
  state.token = adminToken('admin.alfa');
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  page = await ctx.newPage();
  watch(page, 'admin', sink);
  await page.goto(`${URLS.admin}/login`);
  await page.evaluate((t) => localStorage.setItem('token', t), state.token);
});

afterAll(async () => {
  if (browser) await browser.close();
  console.log('[catalog-e2e] limpeza:', JSON.stringify(await cleanupCatalog()));
  await disconnect();
});

test('produto de teste com código de barras com zeros à esquerda (criado pela API)', async () => {
  const stamp = Date.now();
  const a = await api('POST', '/products', { sku: `E2E-${stamp}-A`, name: `[e2e] Produto A ${stamp}`, costPrice: 5, salePrice: 10, unit: 'UN', barcode: '0001234567890' });
  const b = await api('POST', '/products', { sku: `E2E-${stamp}-B`, name: `[e2e] Produto B ${stamp}`, costPrice: 5, salePrice: 10, unit: 'UN', barcode: '0009990001112' });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(a.body.barcode).toBe('0001234567890'); // texto preservado
  state.a = a.body;
  state.b = b.body;
});

test('edição do produto: lista o código principal; adiciona um segundo (com zeros) e ele passa a ler o MESMO produto', async () => {
  await page.goto(`${URLS.admin}/dashboard/products/${state.a.id}`, { waitUntil: 'networkidle' });
  const card = page.getByTestId('barcodes-card');
  await card.waitFor({ timeout: 30000 });
  await card.getByText('0001234567890').waitFor();
  await shot(page, '01-codigos-principal');
  await page.locator('#new-barcode').fill('0007891000100');
  await card.getByRole('button', { name: /Adicionar/ }).click();
  await card.getByText('0007891000100').waitFor({ timeout: 15000 });
  await shot(page, '02-codigo-adicionado');
  const read = await api('GET', `/products/search/${encodeURIComponent('0007891000100')}`);
  expect(read.status).toBe(200);
  expect(read.body.id).toBe(state.a.id);
});

test('código que já é de OUTRO produto: a tela mostra o motivo e nada é gravado', async () => {
  const card = page.getByTestId('barcodes-card');
  await page.locator('#new-barcode').fill('0009990001112');
  await card.getByRole('button', { name: /Adicionar/ }).click();
  await card.getByRole('alert').waitFor({ timeout: 15000 });
  expect(await card.getByRole('alert').innerText()).toMatch(/já pertence ao produto/);
  await shot(page, '03-codigo-conflito');
  const owner = await api('GET', `/products/search/${encodeURIComponent('0009990001112')}`);
  expect(owner.body.id).toBe(state.b.id); // continua do dono
});

test('desativar tira o código da leitura; reativar devolve', async () => {
  const card = page.getByTestId('barcodes-card');
  const row = card.getByTestId('barcode-row').filter({ hasText: '0007891000100' });
  await row.getByRole('button', { name: 'Desativar' }).click();
  await row.getByText('Inativo').waitFor({ timeout: 15000 });
  expect((await api('GET', `/products/search/${encodeURIComponent('0007891000100')}`)).status).toBe(404);
  await shot(page, '04-codigo-desativado');
  await row.getByRole('button', { name: 'Reativar' }).click();
  await row.getByRole('button', { name: 'Desativar' }).waitFor({ timeout: 15000 });
  expect((await api('GET', `/products/search/${encodeURIComponent('0007891000100')}`)).status).toBe(200);
});

test('perfil de CONSULTA: ao tentar adicionar código recebe a mensagem padrão de falta de autorização e nada muda', async () => {
  const viewerToken = mint('viewer.alfa.1').accessToken;
  const vctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  const vp = await vctx.newPage();
  watch(vp, 'admin-viewer', sink);
  await vp.goto(`${URLS.admin}/login`);
  await vp.evaluate((t) => localStorage.setItem('token', t), viewerToken);
  await vp.goto(`${URLS.admin}/dashboard/products/${state.a.id}`, { waitUntil: 'networkidle' });
  const card = vp.getByTestId('barcodes-card');
  await card.waitFor({ timeout: 30000 });
  await vp.locator('#new-barcode').fill('0005550005550');
  await card.getByRole('button', { name: /Adicionar/ }).click();
  await card.getByRole('alert').waitFor({ timeout: 15000 });
  expect(await card.getByRole('alert').innerText()).toContain(NO_PERMISSION);
  await shot(vp, '05-consulta-sem-autorizacao');
  expect((await api('GET', `/products/search/${encodeURIComponent('0005550005550')}`)).status).toBe(404);
  await vctx.close();
});

test('Central de Ajuda: a busca acha o artigo publicado de códigos de barras e o artigo abre', async () => {
  await page.goto(`${URLS.admin}/dashboard/help`, { waitUntil: 'networkidle' });
  await page.getByTestId('help-search').fill('códigos de barras');
  const results = page.getByTestId('help-results');
  await results.waitFor({ timeout: 20000 });
  const link = results.getByRole('link', { name: /Códigos de barras: vários por produto/ }).first();
  await link.waitFor({ timeout: 15000 });
  await shot(page, '06-ajuda-busca');
  await link.click();
  const article = page.getByTestId('help-article');
  await article.waitFor({ timeout: 20000 });
  expect(await article.innerText()).toMatch(/identifica um único produto/);
  await shot(page, '07-ajuda-artigo');
});

test('nenhum erro de página nem resposta 5xx', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
