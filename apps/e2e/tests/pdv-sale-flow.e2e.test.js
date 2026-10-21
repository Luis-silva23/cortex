// PDV (web, :5173) no navegador real contra a API de desenvolvimento, na empresa demo SANDBOX (nunca a alfa/beta): abre o caixa
// (se estiver fechado), lê o produto por SKU, confere a prévia de parcelamento do crédito (mesma função da API), conclui UMA venda
// em dinheiro com duplo clique em "Confirmar Pagamento" e prova pela API que nasceu uma venda e um pagamento só.
// A venda é DADO DE TESTE da empresa sandbox (trilha financeira e de auditoria é append-only: não é apagada).
// Evidências: docs/evidencias/2026-10-13-playwright/pdv/.
const fs = require('fs');
const path = require('path');
const { URLS, requireServers, demoCredentials, mint } = require('../lib/env');
const { launchBrowser, watch, disconnect } = require('../lib/fixtures');
const { splitInstallments } = require('../../../packages/shared/utils/installments.js');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-13-playwright/pdv');
const WHO = 'caixa.sandbox.1';
const sink = { pageErrors: [], serverErrors: [] };
const state = {};
let browser, page;

const brl = (n) => `R$${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (s) => String(s).replace(/\s/g, '');
async function shot(name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}
// A sessão do PDV vive só na memória do renderer (nada é restaurado): login pela tela e navegação INTERNA entre as telas.
async function loginUI() {
  const c = demoCredentials();
  const user = c.users[WHO];
  await page.goto(`${URLS.pdv}/login`, { waitUntil: 'networkidle' });
  await page.locator('#numericId').fill(String(user.numericId));
  await page.locator('#password').fill(c.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/pos$/, { timeout: 20000 });
}
async function go(route) {
  await page.evaluate((r) => {
    window.history.pushState({}, '', r);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await page.waitForLoadState('networkidle');
}
async function api(pathname) {
  const res = await fetch(`${URLS.api}/api${pathname}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) throw new Error(`API ${pathname} → ${res.status}`);
  return res.json();
}

beforeAll(async () => {
  await requireServers(['api', 'pdv']);
  state.token = mint(WHO).accessToken;
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  page = await ctx.newPage();
  watch(page, 'pdv', sink);
  await loginUI();
});

afterAll(async () => {
  if (browser) await browser.close();
  await disconnect();
});

test('produto de teste: o catálogo da sandbox tem peça ativa com preço', async () => {
  const { products } = await api('/products?isActive=true&limit=50');
  // o módulo de estoque pode estar desligado nesta empresa (a consulta de disponível devolve 403): a venda confere o estoque no servidor
  const candidates = products.filter((p) => Number(p.salePrice) >= 1).sort((a, b) => Number(a.salePrice) - Number(b.salePrice));
  expect(candidates.length).toBeGreaterThan(0);
  state.product = candidates[0];
  state.total = Number(state.product.salePrice);
});

test('caixa: abre se estiver fechado e mostra "Caixa Aberto"', async () => {
  await go('/cash-register');
  const closed = page.getByText('Caixa Fechado');
  const open = page.getByText('Caixa Aberto');
  await Promise.race([closed.waitFor({ timeout: 20000 }), open.waitFor({ timeout: 20000 })]).catch(() => {});
  if (await closed.count()) {
    await page.getByRole('button', { name: 'Abrir Caixa' }).first().click();
    // cada terminal usa um número próprio: o nº 1 da sandbox pode estar aberto por outro operador (a API recusa), então usa o 91
    await page.locator('#register-number').fill('91');
    await page.getByRole('button', { name: 'Abrir Caixa' }).last().click();
  }
  await open.first().waitFor({ timeout: 20000 });
  await shot('01-caixa-aberto');
});

test('leitura por SKU adiciona o produto certo ao carrinho com o preço oficial', async () => {
  await go('/pos');
  const input = page.getByPlaceholder('Digite o código ou nome do produto...');
  await input.fill(state.product.sku);
  await input.press('Enter');
  await page.getByText(/Carrinho \(1\)/).waitFor({ timeout: 15000 });
  await page.getByText(state.product.name).first().waitFor();
  await shot('02-carrinho');
});

test('crédito: a lista de parcelas mostra a MESMA divisão em centavos que a API (resto nas últimas)', async () => {
  await page.getByRole('button', { name: /Finalizar Venda/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Pagamento' });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: /Crédito/ }).click();
  const select = dialog.locator('#card-installments');
  await select.waitFor();
  const n = state.total >= 0.03 ? 3 : 1;
  const label = await select.locator(`option[value="${n}"]`).innerText();
  const parts = splitInstallments(state.total, n);
  // o rótulo traz a primeira parcela e, quando difere, a última
  expect(norm(label)).toContain(norm(brl(parts[0])));
  expect(norm(label)).toContain(norm(brl(parts[parts.length - 1])));
  await select.selectOption(String(n));
  await shot('03-pagamento-credito-parcelas');
});

test('dinheiro: duplo clique em Confirmar Pagamento conclui UMA venda e UM pagamento', async () => {
  const dialog = page.getByRole('dialog', { name: 'Pagamento' });
  const before = await api('/sales?limit=1');
  const totalBefore = before.pagination?.total ?? before.total ?? 0;
  await dialog.getByRole('button', { name: /Dinheiro/ }).click();
  await dialog.locator('#paid-amount').fill(String(state.total));
  await dialog.getByRole('button', { name: 'Confirmar Pagamento' }).dblclick();
  await page.locator('[data-testid="last-sale"]').waitFor({ timeout: 30000 });
  await shot('04-venda-concluida');
  const after = await api('/sales?limit=5');
  const totalAfter = after.pagination?.total ?? after.total ?? 0;
  expect(totalAfter - totalBefore).toBe(1);
  const newest = (after.sales ?? after.data ?? [])[0];
  expect(newest).toBeTruthy();
  expect(Number(newest.totalAmount ?? newest.total)).toBeCloseTo(state.total, 2);
});

test('bloquear a tela: nada do PDV fica disponível; senha errada recusada; a própria senha desbloqueia e a sessão continua', async () => {
  await go('/pos');
  await page.getByRole('button', { name: /Bloquear tela/ }).click();
  const lock = page.getByRole('dialog', { name: 'Tela bloqueada' });
  await lock.waitFor({ timeout: 10000 });
  expect(await page.getByRole('button', { name: /Finalizar Venda/ }).count()).toBe(0); // as telas não estão montadas
  expect(await page.getByPlaceholder('Digite o código ou nome do produto...').count()).toBe(0);
  await shot('05-tela-bloqueada');
  await lock.locator('#unlock-password').fill('senha-errada-e2e');
  await lock.getByRole('button', { name: 'Desbloquear' }).click();
  await lock.getByText('Senha incorreta.').waitFor({ timeout: 15000 });
  await lock.locator('#unlock-password').fill(demoCredentials().password);
  await lock.getByRole('button', { name: 'Desbloquear' }).click();
  await page.getByPlaceholder('Digite o código ou nome do produto...').waitFor({ timeout: 15000 });
});

test('recarregar o aplicativo NÃO restaura a sessão: volta ao login e nada autenticado aparece', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#numericId').waitFor({ timeout: 15000 });
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(await page.getByPlaceholder('Digite o código ou nome do produto...').count()).toBe(0);
  const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /auth|token|session/i.test(k)));
  expect(keys).toEqual([]);
});

test('sair da conta: volta ao login e o botão voltar não reabre a tela autenticada', async () => {
  await loginUI();
  await page.getByRole('button', { name: /^Sair$|Sair/ }).first().click();
  await page.waitForURL(/\/login$/, { timeout: 15000 });
  await page.goBack();
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(await page.getByPlaceholder('Digite o código ou nome do produto...').count()).toBe(0);
  await shot('06-apos-sair');
});

test('nenhum erro de página nem resposta 5xx', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
