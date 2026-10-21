// Botões "Relatar problema" contextuais do Admin Web: OS (Oficina), garantia da OS, cobrança e Pós-venda › Garantias.
// Somente leitura: abre o formulário já com o contexto, não envia chamado. A garantia vem do `npm run demo:seed`.
const { URLS, adminToken, requireServers } = require('../lib/env');
const { alfaCompanyId, demoWarranty, launchBrowser, watch, disconnect, resetDevRateLimits } = require('../lib/fixtures');

const sink = { pageErrors: [], serverErrors: [] };
let browser, page, ids;

async function openAndClick(url, locator, { contextHas, module }) {
  await page.goto(url, { waitUntil: 'networkidle' });
  const btn = page.locator(locator).first();
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await page.waitForURL(/\/dashboard\/help\/tickets\/new/, { timeout: 15000 });
  await page.waitForSelector('[data-testid="ticket-context"]', { timeout: 15000 });
  const text = (await page.locator('[data-testid="ticket-context"]').innerText()).replace(/\s+/g, ' ');
  for (const frag of contextHas) expect(text).toContain(frag);
  expect(await page.locator('[data-testid="ticket-module"]').inputValue()).toBe(module);
  expect(await page.locator('[data-testid="ticket-submit"]').isDisabled()).toBe(true);
}

beforeAll(async () => {
  await requireServers(['api', 'admin']);
  // Este arquivo faz ~50 chamadas à API com o usuário admin.alfa; o balde geral é de 100/min por usuário e é compartilhado com as outras
  // suítes e com a execução anterior deste mesmo arquivo. Começar de um balde limpo evita o 429 (e o timeout enganoso que ele causa).
  await resetDevRateLimits();
  ids = await demoWarranty(alfaCompanyId());
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  page = await ctx.newPage();
  watch(page, 'admin', sink);
  await page.goto(`${URLS.admin}/login`);
  await page.evaluate((t) => localStorage.setItem('token', t), adminToken('admin.alfa'));
});

afterAll(async () => {
  if (browser) await browser.close();
  await disconnect();
});

test('os dados de demonstração têm OS e garantia (rode `npm run demo:seed` se falhar)', () => {
  expect(ids.os).toBeTruthy();
  expect(ids.warranty).toBeTruthy();
});

test('Oficina → OS: botão leva o contexto da OS', async () => {
  await openAndClick(`${URLS.admin}/dashboard/service-orders/${ids.os.id}`, '[data-testid="report-problem"]', { contextHas: ['Oficina'], module: 'OFICINA' });
});

test('OS → Garantia: botão do cartão de garantia leva o contexto da garantia', async () => {
  await openAndClick(
    `${URLS.admin}/dashboard/service-orders/${ids.warranty.serviceOrderId}`,
    `a[href*="entityType=WARRANTY"][href*="module=GARANTIAS"]`,
    { contextHas: ['Garantia'], module: 'GARANTIAS' }
  );
});

test('Financeiro → Cobrança (quando houver cobrança na demonstração)', async () => {
  if (!ids.receivable) return console.warn('sem cobrança na demonstração: verificação do botão de cobrança não executada');
  await openAndClick(`${URLS.admin}/dashboard/financial/receivables/${ids.receivable.id}`, '[data-testid="report-problem"]', { contextHas: ['Cobrança'], module: 'FINANCEIRO' });
});

test('Pós-venda › Garantias: botão por garantia leva o contexto da garantia', async () => {
  await page.goto(`${URLS.admin}/dashboard/post-sale`, { waitUntil: 'networkidle' });
  const tab = page.getByRole('tab', { name: /Garantias/ }).first();
  if (await tab.count()) await tab.click();
  const btn = page.locator('a[href*="entityType=WARRANTY"][href*="module=POS_VENDA"]').first();
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await page.waitForURL(/\/dashboard\/help\/tickets\/new/, { timeout: 15000 });
  await page.waitForSelector('[data-testid="ticket-context"]');
  expect(await page.locator('[data-testid="ticket-context"]').innerText()).toMatch(/Pós-venda/);
  expect(await page.locator('[data-testid="ticket-module"]').inputValue()).toBe('POS_VENDA');
});

test('nenhum erro de página, resposta 5xx nem recusa da API (429/401/403)', () => {
  console.warn(`support-contextual-buttons: ${sink.apiCalls} chamadas à API neste arquivo (limite geral da API: 100 por minuto por usuário)`);
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
  expect(sink.apiRefusals).toEqual([]);
});
