// Aplicativo Balcão no navegador real (Chrome) contra a API de desenvolvimento e a empresa demo: login pela tela, identificação de
// cliente, veículo, peça com disponível, orçamento (duplo clique), envio, aprovação, OS, histórico, ficha de encaminhamento e
// papel somente-leitura. Os dados criados levam "[e2e]" e são removidos ao final (clientes, veículos, orçamentos e OS).
// Evidências (screenshots) em docs/evidencias/2026-10-13-playwright/balcao/.
const fs = require('fs');
const path = require('path');
const { URLS, requireServers, demoLogin, mint } = require('../lib/env');
const { PREFIX, launchBrowser, watch, cleanupBalcao, disconnect } = require('../lib/fixtures');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-13-playwright/balcao');
const sink = { pageErrors: [], serverErrors: [], cspViolations: [] };
const state = {};
let browser, ctx, page;

const brl = (n) => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.replace(/\s/g, '');
const norm = (s) => String(s).replace(/\s/g, '');
async function shot(name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
// A sessão do Balcão vive só na memória da página: um `goto` (navegação completa) a encerra. Por isso: login pela tela e
// navegação INTERNA (history + popstate, que o react-router acompanha) para ir de uma tela a outra.
async function loginUI(p, who) {
  const { email, password } = demoLogin(who);
  await p.goto(`${URLS.balcao}/login`, { waitUntil: 'networkidle' });
  await p.getByLabel('E-mail ou ID').fill(email);
  await p.getByLabel('Senha').fill(password);
  await p.getByRole('button', { name: 'Entrar' }).click();
  await p.getByLabel('Buscar cliente ou veículo').waitFor({ timeout: 20000 });
}
async function go(p, route) {
  await p.evaluate((r) => {
    window.history.pushState({}, '', r);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await p.waitForLoadState('networkidle');
}
async function api(pathname, token = state.apiToken) {
  const res = await fetch(`${URLS.api}/api${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API ${pathname} → ${res.status}`);
  return res.json();
}

beforeAll(async () => {
  await requireServers(['api', 'balcao']);
  await cleanupBalcao(); // sobras de execução interrompida
  state.apiToken = mint('balcao.alfa.1').accessToken;
  browser = await launchBrowser();
  ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], locale: 'pt-BR' });
  page = await ctx.newPage();
  watch(page, 'balcao', sink);
  // com a CSP do nginx (E2E_BALCAO_URL apontando para a imagem/servidor com os cabeçalhos), qualquer bloqueio aparece aqui
  page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(m.text())) sink.cspViolations.push(m.text().slice(0, 200)); });
});

afterAll(async () => {
  if (browser) await browser.close();
  state.cleanup = await cleanupBalcao();
  console.log('[balcao-e2e] limpeza:', JSON.stringify(state.cleanup));
  await disconnect();
});

test('login: credencial errada mostra erro em português e não entra', async () => {
  const { email } = demoLogin('balcao.alfa.1');
  await page.goto(`${URLS.balcao}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('E-mail ou ID').fill(email);
  await page.getByLabel('Senha').fill('senha-errada-e2e');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('[role="alert"]').first().waitFor({ timeout: 15000 });
  expect(page.url()).toMatch(/\/login$/);
  await shot('01-login-erro');
});

test('login: credencial correta entra no atendimento', async () => {
  const { email, password } = demoLogin('balcao.alfa.1');
  await page.getByLabel('E-mail ou ID').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Buscar cliente ou veículo').waitFor({ timeout: 20000 });
  expect(new URL(page.url()).pathname).toBe('/');
  // a sessão não é gravada em nenhum armazenamento do navegador (nada para o navegador restaurar)
  const stored = await page.evaluate(() => [...Object.keys(sessionStorage), ...Object.keys(localStorage)].filter((k) => /auth|token|session/i.test(k)));
  expect(stored).toEqual([]);
  await shot('02-atendimento-inicial');
});

test('busca sem resultado oferece cadastro; cadastra o cliente e abre a ficha', async () => {
  state.customerName = `${PREFIX} Cliente Balcão ${Date.now()}`;
  await page.getByLabel('Buscar cliente ou veículo').fill(state.customerName);
  await page.getByText('Nada encontrado').waitFor({ timeout: 15000 });
  await shot('03-busca-vazia-cadastro');
  await page.getByLabel('Nome do novo cliente').fill(state.customerName);
  await page.getByLabel('Telefone do novo cliente').fill('11999990000');
  await page.getByRole('button', { name: 'Cadastrar e atender' }).click();
  await page.waitForURL(/\/clientes\/[0-9a-f-]{36}/, { timeout: 15000 });
  state.customerId = page.url().match(/clientes\/([0-9a-f-]{36})/)[1];
  await page.getByRole('heading', { name: state.customerName }).waitFor();
  await shot('04-cliente-cadastrado');
});

test('cadastra o veículo e abre o novo orçamento dele', async () => {
  await page.getByRole('button', { name: 'Novo veículo' }).click();
  await page.getByLabel('Marca').fill('Honda');
  await page.getByLabel('Modelo').fill('CG 160 e2e');
  await page.getByLabel('Placa').fill(`E2E${String(Date.now()).slice(-4)}`);
  await page.getByLabel('Quilometragem').fill('12000');
  await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
  const link = page.locator('a[href^="/orcamentos/novo?customerId="]').first();
  await link.waitFor({ timeout: 15000 });
  state.motorcycleId = (await link.getAttribute('href')).match(/motorcycleId=([0-9a-f-]{36})/)[1];
  await shot('05-veiculo-cadastrado');
  await link.click();
  await page.getByRole('heading', { name: 'Novo orçamento' }).waitFor({ timeout: 15000 });
});

test('peça: a busca mostra preço e DISPONÍVEL do servidor; serviço entra como item; duplo clique cria UM orçamento', async () => {
  const { products } = await api('/products?isActive=true&limit=50');
  const ids = products.map((p) => p.id);
  const { items } = await api(`/stock/availability?productIds=${ids.join(',')}`);
  const withStock = items.find((a) => a.available >= 1);
  expect(withStock).toBeTruthy(); // a demonstração tem peça com estoque
  state.product = products.find((p) => p.id === withStock.productId);
  state.available = withStock.available;
  expect(Object.prototype.hasOwnProperty.call(state.product, 'costPrice')).toBe(false); // custo não chega ao atendente

  await page.getByLabel('Buscar peça').fill(state.product.sku);
  const row = page.locator('ul button', { hasText: state.product.sku }).first();
  await row.waitFor({ timeout: 15000 });
  expect(await row.innerText()).toMatch(/disp\./);
  await shot('06-peca-com-disponivel');
  await row.click();

  await page.getByRole('tab', { name: 'Serviço' }).click();
  await page.getByLabel('Descrição do serviço').fill(`${PREFIX} Revisão completa`);
  await page.getByLabel('Valor do serviço').fill('150,50');
  await page.getByRole('button', { name: 'Adicionar' }).click();
  await page.getByText('Prévia do total').waitFor();
  await shot('07-itens-previa');

  await page.getByRole('button', { name: 'Salvar orçamento' }).dblclick(); // proteção contra duplo envio
  await page.waitForURL(/\/orcamentos\/[0-9a-f-]{36}$/, { timeout: 20000 });
  state.quoteId = page.url().match(/orcamentos\/([0-9a-f-]{36})/)[1];
  await page.getByText(/Orçamento #\d+/).first().waitFor();

  const { quotes } = await api(`/quotes?customerId=${state.customerId}`);
  expect(quotes.length).toBe(1);
  await shot('08-orcamento-criado');
});

const quoteOf = async () => {
  const body = await api(`/quotes/${state.quoteId}`);
  return body.quote ?? body;
};

test('o total exibido é o OFICIAL do servidor (preço do catálogo × quantidade + serviço)', async () => {
  const quote = await quoteOf();
  const latest = quote.versions[quote.versions.length - 1];
  const expected = Math.round((Number(state.product.salePrice) + 150.5) * 100) / 100;
  expect(Number(latest.totalAmount)).toBe(expected);
  const cell = page.locator('tfoot tr.font-bold td').last();
  expect(norm(await cell.innerText())).toBe(brl(latest.totalAmount));
});

test('enviar → aprovar → abrir OS; a ficha de encaminhamento traz o total oficial e não cobra', async () => {
  await page.getByRole('button', { name: /Enviar ao cliente/ }).click();
  await page.getByRole('button', { name: /Cliente aprovou/ }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Cliente aprovou/ }).click();
  await page.getByLabel('Quilometragem de entrada').waitFor({ timeout: 15000 });
  await page.getByText('Encaminhar ao caixa').waitFor();
  const ficha = await page.locator('pre.print-area').innerText();
  const quote = await quoteOf();
  const total = quote.versions[quote.versions.length - 1].totalAmount;
  expect(norm(ficha)).toContain(norm(`TOTAL:${brl(total)}`));
  expect(ficha).toMatch(/Pagamento: no CAIXA \(PDV\)/);
  await shot('09-aprovado-ficha-caixa');

  await page.getByLabel('Quilometragem de entrada').fill('12050');
  await page.getByRole('button', { name: /Abrir OS/ }).click();
  await page.waitForURL(/\/os\/[0-9a-f-]{36}$/, { timeout: 20000 }); // o app leva direto à OS criada
  state.osId = page.url().match(/os\/([0-9a-f-]{36})/)[1];
  await page.getByText(/OS #\d+/).first().waitFor();
  await shot('10-os-aberta');
});

test('histórico do cliente lista o orçamento e a OS; a OS filtra por cliente e por veículo na API', async () => {
  await go(page, `/clientes/${state.customerId}`);
  await page.getByText('Ordens de serviço').first().waitFor();
  // navegação interna: o carregamento das listas acontece depois; espera pelos elos, não por "networkidle"
  await page.locator(`a[href="/orcamentos/${state.quoteId}"]`).first().waitFor({ timeout: 15000 });
  await page.locator(`a[href="/os/${state.osId}"]`).first().waitFor({ timeout: 15000 });
  await shot('11-historico-cliente');
  const list = (b) => b.serviceOrders ?? b.orders ?? b.data ?? [];
  expect(list(await api(`/service-orders?customerId=${state.customerId}`)).length).toBe(1);
  expect(list(await api(`/service-orders?motorcycleId=${state.motorcycleId}`)).length).toBe(1);
});

test('layout estreito (390 px): orçamento legível, sem rolagem horizontal da página', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, `/orcamentos/${state.quoteId}`);
  await page.getByText(/Orçamento #\d+/).first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shot('12-orcamento-390px');
  await page.setViewportSize({ width: 1366, height: 900 });
});

test('perfil VIEWER só consulta: sem cadastro nem criação de orçamento', async () => {
  const viewerCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const vp = await viewerCtx.newPage();
  watch(vp, 'balcao-viewer', sink);
  await loginUI(vp, 'viewer.alfa.1');
  await go(vp, `/clientes/${state.customerId}`);
  await vp.getByRole('heading', { name: state.customerName }).waitFor({ timeout: 15000 });
  expect(await vp.getByRole('button', { name: 'Novo veículo' }).count()).toBe(0);
  expect(await vp.locator('a[href^="/orcamentos/novo"]').count()).toBe(0);
  await go(vp, `/orcamentos/novo?customerId=${state.customerId}&motorcycleId=${state.motorcycleId}`);
  await vp.getByText(/só consulta/).waitFor({ timeout: 15000 });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await vp.screenshot({ path: path.join(EVIDENCE, '13-viewer-somente-leitura.png'), fullPage: true });
  await viewerCtx.close();
});

test('sair encerra a sessão; a página recarregada ou um endereço interno digitado NÃO restauram nada', async () => {
  await go(page, '/');
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.waitForURL(/\/login$/, { timeout: 15000 });
  await page.goto(`${URLS.balcao}/orcamentos`, { waitUntil: 'networkidle' });
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('a sessão não sobrevive a recarregar a página (nem ao navegador restaurar a aba): volta ao login', async () => {
  await loginUI(page, 'balcao.alfa.1');
  await page.reload({ waitUntil: 'networkidle' });
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(await page.getByLabel('Buscar cliente ou veículo').count()).toBe(0);
});

test('nenhum erro de página nem resposta 5xx', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
  expect(sink.cspViolations).toEqual([]);
});
