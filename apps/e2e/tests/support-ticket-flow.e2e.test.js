// Central de Ajuda (Admin Web) + Console de Suporte (Super Admin): do artigo ao chamado encerrado, mais as tentativas
// de quebrar: HTML/script no texto, cartão no texto e empresa B abrindo o chamado da empresa A.
const { URLS, adminToken, superAdminSession, requireServers } = require('../lib/env');
const { PREFIX, alfaCompanyId, cleanup, launchBrowser, watch, disconnect } = require('../lib/fixtures');

const SUBJECT = `${PREFIX} Maquininha não responde <img src=x onerror=alert(1)>`;
const DESCRIPTION = 'Ao finalizar a venda a maquininha não responde e o PDV fica aguardando confirmação do pagamento.';
const sink = { pageErrors: [], serverErrors: [] };
let browser, admin, sa, adminCtx, saCtx, ticketId;
const dialogs = [];

beforeAll(async () => {
  await requireServers(['api', 'admin', 'sa']);
  alfaCompanyId();
  await cleanup();
  browser = await launchBrowser();
  adminCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  admin = await adminCtx.newPage();
  watch(admin, 'admin', sink);
  admin.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await admin.goto(`${URLS.admin}/login`);
  const t = adminToken('admin.alfa');
  await admin.evaluate((tok) => localStorage.setItem('token', tok), t);

  saCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  sa = await saCtx.newPage();
  watch(sa, 'sa', sink);
  const s = superAdminSession();
  await sa.goto(`${URLS.sa}/login`);
  await sa.evaluate(([tok, u]) => { localStorage.setItem('accessToken', tok); localStorage.setItem('refreshToken', 'x'); localStorage.setItem('user', JSON.stringify(u)); }, [s.token, s.user]);
});

afterAll(async () => {
  try { console.log('limpeza:', JSON.stringify(await cleanup())); } finally {
    if (browser) await browser.close();
    await disconnect();
  }
});

test('Central de Ajuda: menu, busca por texto e artigo', async () => {
  await admin.goto(`${URLS.admin}/dashboard/help`, { waitUntil: 'networkidle' });
  expect(await admin.getByRole('link', { name: /Ajuda e Suporte/ }).first().isVisible()).toBe(true);
  await admin.fill('[data-testid="help-search"]', 'pagamento');
  await admin.waitForSelector('[data-testid="help-results"] a', { timeout: 15000 });
  expect(await admin.locator('[data-testid="help-results"] a').count()).toBeGreaterThan(0);
  await admin.locator('[data-testid="help-results"] a').first().click();
  await admin.waitForSelector('[data-testid="help-article"]');
  expect((await admin.locator('[data-testid="help-article"]').innerText()).length).toBeGreaterThan(50);
});

test('novo chamado: contexto automático, botão desabilitado vazio, cartão recusado, envio com HTML no assunto', async () => {
  await admin.goto(`${URLS.admin}/dashboard/help/tickets/new?module=PDV&screen=${encodeURIComponent('PDV → Venda → Pagamento')}`, { waitUntil: 'networkidle' });
  expect(await admin.locator('[data-testid="ticket-context"]').isVisible()).toBe(true);
  expect(await admin.inputValue('[data-testid="ticket-module"]')).toBe('PDV');
  expect(await admin.isDisabled('[data-testid="ticket-submit"]')).toBe(true);

  await admin.fill('[data-testid="ticket-subject"]', SUBJECT);
  await admin.selectOption('[data-testid="ticket-type"]', 'PROBLEMA');
  await admin.fill('[data-testid="ticket-description"]', 'Cartão 4111 1111 1111 1111 não passou na maquininha de ontem.');
  await admin.click('[data-testid="ticket-submit"]');
  await admin.waitForFunction(() => /cartão, senha ou token/i.test(document.body.innerText), null, { timeout: 15000 });
  expect(admin.url()).toContain('/tickets/new');

  await admin.fill('[data-testid="ticket-description"]', DESCRIPTION);
  await admin.click('[data-testid="ticket-submit"]');
  await admin.waitForURL(/\/dashboard\/help\/tickets\/[0-9a-f-]{36}/, { timeout: 20000 });
  ticketId = admin.url().match(/tickets\/([0-9a-f-]{36})/)[1];
  await admin.waitForSelector('[data-testid="ticket-status"]');
  expect(await admin.locator('[data-testid="ticket-status"]').innerText()).toMatch(/aberto/i);
});

test('HTML/script no assunto aparece como texto, sem executar e sem criar elemento', async () => {
  await admin.goto(`${URLS.admin}/dashboard/help/tickets/${ticketId}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('[data-testid="ticket-status"]');
  expect(await admin.locator('body').innerText()).toContain('<img src=x onerror=alert(1)>');
  expect(await admin.locator('img[src="x"]').count()).toBe(0);
  await admin.goto(`${URLS.admin}/dashboard/help/tickets`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('[data-testid="ticket-row"]');
  expect(await admin.locator('[data-testid="ticket-list"]').innerText()).toContain(PREFIX);
  expect(await admin.locator('img[src="x"]').count()).toBe(0);
  expect(dialogs).toEqual([]);
});

test('empresa B não abre o chamado da empresa A (nem pela tela nem pela API)', async () => {
  const betaToken = adminToken('admin.beta');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const apiRes = await ctx.request.get(`${URLS.api}/api/support/tickets/${ticketId}`, { headers: { Authorization: `Bearer ${betaToken}` } });
  expect([403, 404]).toContain(apiRes.status());
  expect(await apiRes.text()).not.toContain(PREFIX);
  const beta = await ctx.newPage();
  watch(beta, 'beta', sink);
  await beta.goto(`${URLS.admin}/login`);
  await beta.evaluate((tok) => localStorage.setItem('token', tok), betaToken);
  await beta.goto(`${URLS.admin}/dashboard/help/tickets/${ticketId}`, { waitUntil: 'networkidle' });
  await beta.waitForTimeout(1500);
  const body = await beta.locator('body').innerText();
  expect(body).not.toContain(PREFIX);
  expect(body).not.toContain(DESCRIPTION);
  await ctx.close();
});

test('Console de Suporte: painel, páginas sem 404, chamado da empresa visível e resposta', async () => {
  await sa.goto(`${URLS.sa}/dashboard/support`, { waitUntil: 'networkidle' });
  expect(await sa.locator('body').innerText()).toContain('Console de Suporte');
  for (const [p, expected] of [['tickets', 'Chamados'], ['kb', 'Base de conhecimento'], ['categories', 'Categorias'], ['agents', 'Responsáveis'], ['kb/new', 'Novo artigo']]) {
    await sa.goto(`${URLS.sa}/dashboard/support/${p}`, { waitUntil: 'networkidle' });
    const t = await sa.locator('body').innerText();
    expect(t).toContain(expected);
    expect(t).not.toMatch(/could not be found/i);
  }
  await sa.goto(`${URLS.sa}/dashboard/support/tickets/${ticketId}`, { waitUntil: 'networkidle' });
  await sa.waitForFunction((p) => document.body.innerText.includes(p), PREFIX, { timeout: 15000 });
  expect(await sa.locator('body').innerText()).toMatch(/PDV/);
  expect(await sa.locator('img[src="x"]').count()).toBe(0);
  await sa.locator('textarea').first().fill('Pode informar o número do caixa e o horário aproximado do erro?');
  await sa.getByRole('button', { name: /enviar|responder/i }).first().click();
  await sa.waitForTimeout(2000);
});

test('empresa vê o aviso, responde e encerra; encerrado não aceita mensagem', async () => {
  await admin.goto(`${URLS.admin}/dashboard/help/tickets`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('[data-testid="support-unread-badge"]', { timeout: 15000 });
  await admin.goto(`${URLS.admin}/dashboard/help/tickets/${ticketId}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('[data-testid="ticket-messages"]');
  expect(await admin.locator('[data-testid="ticket-messages"]').innerText()).toContain('número do caixa');
  await admin.fill('[data-testid="ticket-reply"]', 'Caixa 2, por volta das 14h.');
  await admin.click('[data-testid="ticket-reply-send"]');
  await admin.waitForFunction(() => document.querySelector('[data-testid="ticket-messages"]')?.innerText.includes('Caixa 2'), null, { timeout: 15000 });
  await admin.click('[data-testid="ticket-close"]');
  await admin.click('[data-testid="ticket-close-confirm"]');
  await admin.waitForFunction(() => /encerrado/i.test(document.querySelector('[data-testid="ticket-status"]')?.innerText ?? ''), null, { timeout: 15000 });
  expect(await admin.locator('[data-testid="ticket-reply"]').count()).toBe(0);
  expect((await admin.locator('[data-testid="ticket-history"]').innerText()).length).toBeGreaterThan(20);
});

test('Ajuda em 390 px sem rolagem horizontal', async () => {
  await admin.setViewportSize({ width: 390, height: 800 });
  await admin.goto(`${URLS.admin}/dashboard/help`, { waitUntil: 'networkidle' });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test('nenhum erro de página nem resposta 5xx durante o fluxo', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
