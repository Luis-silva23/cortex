// Admin Web (Next.js, :3002) no navegador real: MFA obrigatório do administrador da empresa (configuração pela tela, código que não vale
// duas vezes, código de recuperação, reinicialização pelo Super Admin), pedidos de titular (exportar e anonimizar) e imagem do produto.
// PRECISA da API iniciada com REQUIRE_MFA_COMPANY_ADMIN=true (dev). Dados de teste: usuário "e2e-mfa-…" (empresa demo alfa), cliente
// "[e2e]…" e produto "E2E-…" — removidos por id ao final. Capturas: docs/evidencias/2026-10-14-playwright/mfa-privacidade-imagem/,
// SEM segredo: o segredo TOTP, o QR e os códigos de recuperação são mascarados na tela ANTES de cada captura.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URLS, requireServers, adminToken, demoCredentials, mint } = require('../lib/env');
const { launchBrowser, watch, asPlatform, alfaCompanyId, resetDevRateLimits, disconnect } = require('../lib/fixtures');

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-14-playwright/mfa-privacidade-imagem');
const sink = { pageErrors: [], serverErrors: [] };
const stamp = Date.now();
const state = { backupCodes: [] };
let browser;

function validCpf(seed) {
  const d = String(seed).replace(/D/g, '').padStart(9, '0').slice(-9).split('').map(Number);
  if (new Set(d).size === 1) d[8] = (d[8] + 1) % 10;
  const dv = (arr) => { const sum = arr.reduce((a, n, i) => a + n * (arr.length + 1 - i), 0); const r = (sum * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(d); const d2 = dv([...d, d1]);
  return [...d, d1, d2].join('');
}

function totp(secretBase32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// PNG 2×2 montado aqui (blocos com CRC) — o servidor confere o CRC de verdade.
function tinyPng() {
  const zlib = require('zlib');
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length, 0); h.write(type, 4, 'latin1'); const t = Buffer.alloc(4); t.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), 0); return Buffer.concat([h, data, t]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.from([0, 200, 30, 30, 200, 30, 30]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND')]);
}

async function shot(p, name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await p.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}
async function mask(p) {
  await p.evaluate(() => {
    document.querySelectorAll('[data-testid=mfa-secret]').forEach((e) => (e.textContent = '••••••••••••'));
    document.querySelectorAll('img[alt^="QR"]').forEach((e) => (e.style.visibility = 'hidden'));
    document.querySelectorAll('ul[aria-label="Códigos de recuperação"] li').forEach((e) => (e.textContent = '••••••••••••••••'));
  });
}
async function api(method, url, body, token) {
  const res = await fetch(`${URLS.api}/api${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const email = `e2e-mfa-${stamp}@teste-cortex.local`;
const password = `E2e-${crypto.randomBytes(9).toString('base64url')}-Xk1!`; // gerada na hora; nunca impressa nem gravada
let adminId;
let adminCtx;
let secret;

async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  watch(page, 'admin', sink);
  return { ctx, page };
}
async function loginForm(page) {
  await page.goto(`${URLS.admin}/login`);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
const appAlert = (page) => page.locator('[role=alert]:not(#__next-route-announcer__)').first();
const codeInput = (page) => page.getByLabel(/Código de 6 dígitos do aplicativo autenticador/);

beforeAll(async () => {
  await requireServers(['api', 'admin']);
  await resetDevRateLimits(); // este arquivo erra código de propósito e gasta o limite do IP
  const { createRequire } = require('module');
  const { hashPassword } = createRequire(path.resolve(__dirname, '../../../packages/shared/package.json'))('./utils/password');
  const companyId = alfaCompanyId();
  const branchId = demoCredentials().companies.alfa.branches[0];
  const hash = await hashPassword(password);
  const user = await asPlatform(companyId, (tx) =>
    tx.user.create({ data: { companyId, branchId, name: 'E2E Administrador MFA', email, password: hash, userType: 'COMPANY_ADMIN', isActive: true } })
  );
  adminId = user.id;
  browser = await launchBrowser();
});

afterAll(async () => {
  if (browser) await browser.close();
  const companyId = alfaCompanyId();
  await asPlatform(companyId, async (tx) => {
    if (adminId) {
      await tx.refreshToken.deleteMany({ where: { userId: adminId, companyId } });
      await tx.user.deleteMany({ where: { id: adminId, companyId } });
    }
    if (state.customerId) {
      await tx.privacyRequest.deleteMany({ where: { companyId, subjectId: state.customerId } });
      await tx.customer.deleteMany({ where: { companyId, id: state.customerId } });
    }
    if (state.productId) {
      await tx.productImage.deleteMany({ where: { companyId, productId: state.productId } });
      await tx.productBarcode.deleteMany({ where: { companyId, productId: state.productId } });
      await tx.product.deleteMany({ where: { companyId, id: state.productId } });
    }
  }).catch((e) => console.log('[mfa-e2e] limpeza:', e.message));
  await disconnect();
});

test('administrador da empresa sem MFA: o login leva à configuração; código errado é recusado; o certo ativa e mostra os códigos de recuperação', async () => {
  const { ctx, page } = await freshPage();
  adminCtx = ctx;
  await loginForm(page);
  const panel = page.getByTestId('mfa-enrollment');
  await panel.waitFor({ timeout: 30000 });
  await Promise.race([page.locator('img[alt^="QR"]').waitFor({ timeout: 20000 }), appAlert(page).waitFor({ timeout: 20000 })]);
  if (await appAlert(page).isVisible().catch(() => false)) throw new Error(`a configuração não iniciou: ${await appAlert(page).innerText()}`);
  secret = (await page.getByTestId('mfa-secret').innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{20,}$/);
  await mask(page);
  await shot(page, '01-configuracao-mfa');

  await codeInput(page).fill('000000');
  await page.getByRole('button', { name: 'Ativar e entrar' }).click();
  await appAlert(page).waitFor({ timeout: 15000 });
  expect(await appAlert(page).innerText()).toMatch(/Código inválido/);
  await shot(page, '02-codigo-errado');

  await codeInput(page).fill(totp(secret));
  await page.getByRole('button', { name: 'Ativar e entrar' }).click();
  const codes = page.getByTestId('mfa-backup-codes');
  await codes.waitFor({ timeout: 20000 });
  state.backupCodes = (await page.locator('ul[aria-label="Códigos de recuperação"] li').allInnerTexts()).map((t) => t.trim());
  expect(state.backupCodes).toHaveLength(10);
  await mask(page);
  await shot(page, '03-codigos-de-recuperacao');
  await page.getByRole('button', { name: 'Continuar' }).isDisabled(); // só segue depois de marcar que guardou
  expect(await page.getByRole('button', { name: 'Continuar' }).isDisabled()).toBe(true);
  await page.getByLabel('Guardei os códigos em um lugar seguro.').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await shot(page, '04-dashboard-apos-configurar');
  await ctx.close();
});

test('próximo login pede o código; o MESMO código não vale duas vezes; o código de recuperação vale uma vez', async () => {
  const { ctx, page } = await freshPage();
  await loginForm(page);
  await codeInput(page).waitFor({ timeout: 30000 });
  // o passo atual já foi consumido na ativação: o do passo seguinte (janela de ±30 s) entra
  await codeInput(page).fill(totp(secret, Date.now() + 30000));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await ctx.close();

  const second = await freshPage();
  await loginForm(second.page);
  await codeInput(second.page).waitFor({ timeout: 30000 });
  await codeInput(second.page).fill(totp(secret, Date.now() + 30000)); // mesmo passo já usado
  await second.page.getByRole('button', { name: 'Confirmar' }).click();
  await appAlert(second.page).waitFor({ timeout: 15000 }).catch(() => undefined);
  expect(await second.page.locator('body').innerText()).toMatch(/já utilizado|Invalid Code|inválido/i);
  await mask(second.page);
  await shot(second.page, '05-codigo-repetido-recusado');

  await second.page.getByText('Perdi o aplicativo: usar um código de recuperação').click();
  await second.page.getByLabel(/Código de recuperação de 16 caracteres/).fill(state.backupCodes[0]);
  await second.page.getByRole('button', { name: 'Confirmar' }).click();
  await second.page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await second.ctx.close();

  const third = await freshPage();
  await loginForm(third.page);
  await codeInput(third.page).waitFor({ timeout: 30000 });
  await third.page.getByText('Perdi o aplicativo: usar um código de recuperação').click();
  await third.page.getByLabel(/Código de recuperação de 16 caracteres/).fill(state.backupCodes[0]); // já usado
  await third.page.getByRole('button', { name: 'Confirmar' }).click();
  await appAlert(third.page).waitFor({ timeout: 15000 }).catch(() => undefined);
  expect(third.page.url()).toMatch(/\/login/);
  await third.ctx.close();
});

test('o Super Admin reinicia o fator (senha própria + motivo): as sessões caem e o próximo login pede a configuração de novo', async () => {
  const saToken = mint('sa.e2e').accessToken;
  const wrong = await api('POST', `/users/${adminId}/mfa/reset`, { password: 'senha-errada-xyz', reason: 'teste e2e de recuperação' }, saToken);
  expect(wrong.status).toBe(401);
  const ok = await api('POST', `/users/${adminId}/mfa/reset`, { password: demoCredentials().password, reason: 'teste e2e: perda do aplicativo autenticador' }, saToken);
  expect(ok.status).toBe(200);
  const { ctx, page } = await freshPage();
  await loginForm(page);
  await page.getByTestId('mfa-enrollment').waitFor({ timeout: 30000 });
  await mask(page);
  await shot(page, '06-configuracao-apos-reinicio');
  await ctx.close();
});

test('pedidos de titular: exportar baixa o arquivo só do titular; anonimizar mostra o plano, exige confirmar e sobrescreve o cadastro', async () => {
  const token = adminToken('admin.alfa');
  const created = await api('POST', '/customers', { name: `[e2e] Titular ${stamp}`, email: `titular-${stamp}@pessoa-teste.invalid`, phone: '11988887777', document: validCpf(stamp) }, token);
  expect(created.status).toBe(201);
  state.customerId = created.body.id ?? created.body.customer?.id ?? created.body.data?.id;
  expect(state.customerId).toBeTruthy();

  const { ctx, page } = await freshPage();
  await page.goto(`${URLS.admin}/login`);
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.goto(`${URLS.admin}/dashboard/privacy`, { waitUntil: 'networkidle' });
  await page.getByTestId('privacy-page').waitFor({ timeout: 30000 });
  await page.getByLabel(/Buscar cliente/).fill(`[e2e] Titular ${stamp}`);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: new RegExp(`\\[e2e\\] Titular ${stamp}`) }).click();
  await page.getByLabel('Justificativa do pedido').fill('Pedido do titular, protocolo e2e-2026-0001');
  await page.getByLabel('Sua senha de administrador').fill(demoCredentials().password);
  await shot(page, '07-privacidade-titular-selecionado');

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: /Exportar os dados do titular/ }).click()]);
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(exported.schema).toBe('cortex.data-subject-export.v1');
  expect(exported.subject.id).toBe(state.customerId);
  expect(exported.customer.email).toBe(`titular-${stamp}@pessoa-teste.invalid`);
  await page.getByText(/Arquivo gerado e baixado/).waitFor();

  await page.getByLabel('Sua senha de administrador').fill(demoCredentials().password);
  await page.getByRole('button', { name: 'Planejar anonimização' }).click();
  const plan = page.getByTestId('anonymization-plan');
  await plan.waitFor({ timeout: 15000 });
  expect(await plan.innerText()).toMatch(/sobrescritos no banco/);
  await shot(page, '08-privacidade-plano-de-anonimizacao');
  await page.getByLabel('Sua senha de administrador').fill(demoCredentials().password);
  await page.getByRole('button', { name: 'Anonimizar definitivamente' }).isDisabled();
  expect(await page.getByRole('button', { name: 'Anonimizar definitivamente' }).isDisabled()).toBe(true); // falta confirmar que é irreversível
  await page.getByLabel('Entendo que a anonimização não pode ser desfeita.').check();
  await page.getByRole('button', { name: 'Anonimizar definitivamente' }).click();
  await page.getByText(/Anonimização: Concluído/).waitFor({ timeout: 20000 });
  await shot(page, '09-privacidade-anonimizado');
  await ctx.close();

  const after = await asPlatform(alfaCompanyId(), (tx) => tx.customer.findFirst({ where: { companyId: alfaCompanyId(), id: state.customerId } }));
  expect(after.name).toMatch(/^Titular anonimizado/);
  expect([after.email, after.phone, after.document]).toEqual([null, null, null]);
});

test('imagem do produto: enviar mostra a imagem, remover volta ao "sem imagem" e o produto funciona igual', async () => {
  const token = adminToken('admin.alfa');
  const created = await api('POST', '/products', { sku: `E2E-IMG-${stamp}`, name: `[e2e] Produto imagem ${stamp}`, costPrice: 5, salePrice: 10, unit: 'UN' }, token);
  expect(created.status).toBe(201);
  state.productId = created.body.id;

  const png = tinyPng();
  const { ctx, page } = await freshPage();
  await page.goto(`${URLS.admin}/login`);
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.goto(`${URLS.admin}/dashboard/products/${state.productId}`, { waitUntil: 'networkidle' });
  const card = page.getByTestId('image-card');
  await card.waitFor({ timeout: 30000 });
  await card.getByText(/não tem imagem/).waitFor();
  await shot(page, '10-produto-sem-imagem');
  await page.getByTestId('image-file').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await Promise.race([card.getByTestId('product-image').waitFor({ timeout: 20000 }), appAlert(card).waitFor({ timeout: 20000 })]);
  if (await appAlert(card).isVisible().catch(() => false)) throw new Error(`envio da imagem falhou na tela: ${await appAlert(card).innerText()}`);
  await shot(page, '11-produto-com-imagem');
  const meta = await api('GET', `/products/${state.productId}/image/meta`, null, token);
  expect(meta.body.image).toMatchObject({ mimeType: 'image/png', width: 2, height: 2 });
  await card.getByRole('button', { name: 'Remover' }).click();
  await card.getByText(/não tem imagem/).waitFor({ timeout: 15000 });
  expect((await api('GET', `/products/${state.productId}/image/meta`, null, token)).body.image).toBeNull();

  // arquivo que não é imagem: recusado com a mensagem da API, nada é guardado
  await page.getByTestId('image-file').setInputFiles({ name: 'falso.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  await appAlert(card).waitFor({ timeout: 15000 });
  expect(await appAlert(card).innerText()).toMatch(/PNG, JPEG ou WebP/);
  await shot(page, '12-imagem-recusada');
  await ctx.close();
});

test('nenhum erro de página nem resposta 5xx', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});

