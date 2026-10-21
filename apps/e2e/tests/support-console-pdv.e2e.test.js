// Console de Suporte (categoria e artigo: criar, validar, editar, publicar) e "Relatar problema" no PDV web.
// Adversarial: script no corpo do artigo não executa na Ajuda da empresa; duplo clique no PDV não cria dois chamados;
// depois de recusa 4xx o reenvio usa chave nova (regressão do 422 de Idempotency-Key).
const { URLS, adminToken, superAdminSession, demoCredentials, requireServers } = require('../lib/env');
const { PREFIX, asPlatform, alfaCompanyId, cleanup, launchBrowser, watch, disconnect } = require('../lib/fixtures');

const CAT = `${PREFIX} Categoria de teste`;
const CAT2 = `${PREFIX} Categoria renomeada`;
const ART = `${PREFIX} Como conferir a maquininha`;
const PDV_SUBJECT = `${PREFIX} Maquininha sem resposta`;
const sink = { pageErrors: [], serverErrors: [] };
let browser, sa;

beforeAll(async () => {
  await requireServers(['api', 'admin', 'sa', 'pdv']);
  await cleanup();
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  sa = await ctx.newPage();
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

test('categoria: nome curto recusado, criar e renomear', async () => {
  await sa.goto(`${URLS.sa}/dashboard/support/categories`, { waitUntil: 'networkidle' });
  await sa.fill('[data-testid="category-name"]', 'x');
  await sa.click('[data-testid="category-create"]');
  expect(await sa.locator('body').innerText()).toMatch(/mínimo 2 caracteres/i);
  await sa.fill('[data-testid="category-name"]', CAT);
  await sa.click('[data-testid="category-create"]');
  await sa.waitForSelector(`text=${CAT}`, { timeout: 15000 });
  expect(await sa.locator('[data-testid="category-row"]', { hasText: CAT }).innerText()).toContain('Ativa');
  await sa.locator('[data-testid="category-row"]', { hasText: CAT }).getByRole('button', { name: 'Editar' }).click();
  await sa.locator('input[aria-label="Nome da categoria"]').fill(CAT2);
  await sa.getByRole('button', { name: 'Salvar', exact: true }).click();
  await sa.waitForSelector(`text=${CAT2}`, { timeout: 15000 });
});

test('artigo: validação, rascunho, edição, publicar e despublicar; a empresa só o encontra publicado', async () => {
  await sa.goto(`${URLS.sa}/dashboard/support/kb/new`, { waitUntil: 'networkidle' });
  await sa.fill('[data-testid="kb-title"]', ART);
  await sa.fill('[data-testid="kb-body"]', 'curto');
  await sa.click('[data-testid="kb-save"]');
  expect(await sa.locator('body').innerText()).toMatch(/Escolha a categoria|mínimo 10/i);
  await sa.selectOption('[data-testid="kb-category"]', { label: CAT2 });
  await sa.fill('[data-testid="kb-summary"]', 'Passo a passo para conferir se a maquininha está conectada.');
  await sa.fill('[data-testid="kb-body"]', 'Confira o cabo e a energia da maquininha.\n\n<script>window.__xss = 1</script>\n\n1. Reinicie o aparelho.\n2. Tente o pagamento de novo.');
  await sa.fill('[data-testid="kb-keywords"]', 'maquininha conectada pagamento');
  await sa.click('[data-testid="kb-save"]');
  await sa.waitForURL(/\/dashboard\/support\/kb$/, { timeout: 15000 });
  const row = sa.locator('[data-testid="kb-row"]', { hasText: ART });
  await row.waitFor({ timeout: 15000 });
  expect(await row.getAttribute('data-status')).toBe('DRAFT');

  const company = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const admin = await company.newPage();
  watch(admin, 'admin', sink);
  await admin.goto(`${URLS.admin}/login`);
  await admin.evaluate((tok) => localStorage.setItem('token', tok), adminToken('admin.alfa'));
  await admin.goto(`${URLS.admin}/dashboard/help`, { waitUntil: 'networkidle' });
  await admin.fill('[data-testid="help-search"]', 'maquininha conectada');
  await admin.waitForTimeout(2000);
  expect(await admin.locator('[data-testid="help-results"]').innerText().catch(() => '')).not.toContain('conferir a maquininha');

  await row.getByRole('link', { name: 'Editar' }).click();
  await sa.waitForSelector('[data-testid="kb-title"]');
  await sa.fill('[data-testid="kb-summary"]', 'Resumo editado pelo teste.');
  await sa.click('[data-testid="kb-save"]');
  await sa.waitForSelector('text=Artigo salvo.', { timeout: 15000 });

  await sa.goto(`${URLS.sa}/dashboard/support/kb`, { waitUntil: 'networkidle' });
  await sa.locator('[data-testid="kb-row"]', { hasText: ART }).locator('[data-testid="kb-publish-toggle"]').click();
  await sa.getByRole('button', { name: 'Publicar', exact: true }).last().click();
  await sa.waitForFunction((t) => [...document.querySelectorAll('[data-testid="kb-row"]')].some((r) => r.textContent.includes(t) && r.getAttribute('data-status') === 'PUBLISHED'), ART, { timeout: 15000 });

  await admin.goto(`${URLS.admin}/dashboard/help`, { waitUntil: 'networkidle' });
  await admin.fill('[data-testid="help-search"]', 'maquininha conectada');
  await admin.waitForSelector('[data-testid="help-results"] a', { timeout: 15000 });
  expect(await admin.locator('[data-testid="help-results"]').innerText()).toContain('conferir a maquininha');
  await admin.locator('[data-testid="help-results"] a', { hasText: 'conferir a maquininha' }).first().click();
  await admin.waitForSelector('[data-testid="help-article"]');
  await admin.waitForTimeout(800);
  expect(await admin.evaluate(() => window.__xss)).toBeUndefined();
  await company.close();

  await sa.goto(`${URLS.sa}/dashboard/support/kb`, { waitUntil: 'networkidle' });
  await sa.locator('[data-testid="kb-row"]', { hasText: ART }).locator('[data-testid="kb-publish-toggle"]').click();
  await sa.getByRole('button', { name: 'Despublicar', exact: true }).last().click();
  await sa.waitForFunction((t) => [...document.querySelectorAll('[data-testid="kb-row"]')].some((r) => r.textContent.includes(t) && r.getAttribute('data-status') === 'DRAFT'), ART, { timeout: 15000 });
});

test('PDV: texto curto e cartão recusados; duplo clique no envio cria um único chamado com origem PDV', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pdv = await ctx.newPage();
  watch(pdv, 'pdv', sink);
  // A sessão do PDV vive só na memória (nada é restaurado do localStorage desde 2026-10-14): login pela tela, como o operador.
  const creds = demoCredentials();
  const operator = creds.users['balcao.alfa.1'];
  await pdv.goto(`${URLS.pdv}/login`, { waitUntil: 'networkidle' });
  await pdv.locator('#numericId').fill(String(operator.numericId));
  await pdv.locator('#password').fill(creds.password);
  await pdv.getByRole('button', { name: 'Entrar' }).click();
  await pdv.waitForURL(/\/pos$/, { timeout: 20000 });
  await pdv.waitForLoadState('networkidle');
  await pdv.waitForTimeout(1500);
  const btn = pdv.getByRole('button', { name: /Relatar problema/ }).first();
  expect(await btn.isVisible()).toBe(true);
  await btn.click();
  await pdv.getByRole('dialog', { name: 'Relatar problema' }).waitFor();

  await pdv.fill('#report-subject', 'ab');
  await pdv.fill('#report-description', 'curto');
  await pdv.getByRole('button', { name: 'Enviar chamado' }).click();
  expect(await pdv.getByRole('alert').count()).toBeGreaterThan(0);

  await pdv.fill('#report-subject', PDV_SUBJECT);
  await pdv.fill('#report-description', 'Cartão 4111 1111 1111 1111 não passou.');
  await pdv.getByRole('button', { name: 'Enviar chamado' }).click();
  await pdv.getByRole('alert').filter({ hasText: /cartão, senha ou token/i }).waitFor({ timeout: 15000 });
  expect(await pdv.locator('[data-testid="report-success"]').count()).toBe(0);

  await pdv.fill('#report-description', 'A maquininha não respondeu ao finalizar o pagamento e o PDV ficou aguardando.');
  await pdv.getByRole('button', { name: 'Enviar chamado' }).dblclick();
  await pdv.waitForSelector('[data-testid="report-success"]', { timeout: 15000 });
  expect(await pdv.locator('[data-testid="report-success"]').innerText()).toMatch(/Chamado #\d+ aberto/);
  await ctx.close();

  const companyId = alfaCompanyId();
  const rows = await asPlatform(companyId, (tx) => tx.supportTicket.findMany({ where: { companyId, subject: { startsWith: PDV_SUBJECT } }, select: { source: true, module: true } }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ source: 'PDV', module: 'PDV' });
});

test('nenhum erro de página nem resposta 5xx durante o fluxo', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
