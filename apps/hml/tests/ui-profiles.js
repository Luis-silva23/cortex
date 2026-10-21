// Homologação pela INTERFACE REAL (Admin Web em http://localhost:3102 → API HML 3101), um perfil por vez, em sequência:
// login (com MFA quando houver), menu visível, URL direta de cada tela, ações seguras (abas, busca, abrir/fechar modal),
// logout. NÃO grava nada: não envia formulário. Um único Chrome, um contexto por perfil, tudo espaçado (limite geral de
// 100 req/min por usuário). Cada linha vai para .hml/results/ui-profiles.json.
const fs = require('fs');
const path = require('path');
const { suite } = require('../lib/harness');
const { readCredentials, totp } = require('../lib/api');
const { chromium } = require('../../../node_modules/playwright-core');

const ADMIN = 'http://localhost:3102';
const S = suite('ui-profiles');
const { check } = S;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));

const PAGES = [
  '/dashboard', '/dashboard/sales', '/dashboard/customers', '/dashboard/products', '/dashboard/inventory', '/dashboard/purchases',
  '/dashboard/financial', '/dashboard/fiscal', '/dashboard/service-orders', '/dashboard/quotes', '/dashboard/mechanics',
  '/dashboard/motorcycles', '/dashboard/post-sale', '/dashboard/damage', '/dashboard/suppliers', '/dashboard/discounts',
  '/dashboard/agreements', '/dashboard/reports', '/dashboard/settings', '/dashboard/branches', '/dashboard/users', '/dashboard/help',
];

// Espelho de ROLE_ROUTES (apps/admin-web/lib/navigation.ts): quem a TELA deixa entrar. A API continua sendo a autoridade.
const NON_MECHANIC = ['COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'];
const UI_RULES = {
  '/dashboard/sales': NON_MECHANIC, '/dashboard/purchases': NON_MECHANIC, '/dashboard/fiscal': NON_MECHANIC, '/dashboard/financial': NON_MECHANIC,
  '/dashboard/discounts': ['COMPANY_ADMIN', 'MANAGER'], '/dashboard/agreements': ['COMPANY_ADMIN', 'MANAGER'], '/dashboard/users': ['COMPANY_ADMIN'],
};

const PROFILES = [
  ['ceo.a', 'CEO', 'COMPANY_ADMIN'], ['gerente.a1', 'Gerente', 'MANAGER'], ['administrativo.a1', 'Administrativo', 'OPERATOR'],
  ['caixa.a1', 'Caixa', 'OPERATOR'], ['balcao.a1', 'Balcão', 'OPERATOR'], ['mecanico.a1', 'Mecânico', 'MECHANIC'], ['viewer.a1', 'Visualizador', 'VIEWER'],
];

async function login(page, u) {
  await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Em modo dev o React hidrata depois do DOM; clicar antes envia o formulário como GET nativo.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
  await sleep(2000);
  await page.fill('input[type="email"]', u.email);
  await page.fill('input[type="password"]', u.password);
  await page.click('button[type="submit"]');
  if (u.mfaSecret) {
    await page.waitForSelector('input[inputmode="numeric"]', { timeout: 30000 });
    await page.fill('input[inputmode="numeric"]', totp(u.mfaSecret));
    await page.click('button[type="submit"]');
  }
  await page.waitForURL(/\/dashboard/, { timeout: 60000 });
}

(async () => {
  if (!CHROME) throw new Error('Chrome não encontrado');
  const cred = readCredentials();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const summary = {};
  try {
    for (const [key, label, userType] of PROFILES) {
      if (process.env.HML_UI_ONLY && !process.env.HML_UI_ONLY.split(',').includes(key)) continue;
      const u = cred.users[key];
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
      const page = await ctx.newPage();
      const pageErrors = [];
      let api = [];
      page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));
      page.on('response', (r) => { if (r.url().includes(':3101/api/')) api.push({ s: r.status(), m: r.request().method(), u: r.url().replace(/^.*:3101/, '').split('?')[0] }); });
      const tag = `ui/${label}`;
      try {
        await login(page, u);
        check(`${tag}: login pela tela`, /\/dashboard/.test(page.url()), page.url());
        await sleep(2500);
        const hrefs = new Set(await page.$$eval('a[href^="/dashboard"]', (as) => as.map((a) => a.getAttribute('href'))));
        const visible = PAGES.filter((p) => hrefs.has(p));
        summary[label] = { menu: [...hrefs].sort(), paginas: {} };
        for (const [p, roles] of Object.entries(UI_RULES)) {
          const allowed = roles.includes(userType);
          if (!allowed) check(`${tag}: menu NÃO mostra ${p}`, !hrefs.has(p), `menu=${hrefs.has(p)}`);
        }
        for (const p of process.env.HML_UI_LOGOUT_ONLY ? [] : PAGES) {
          api = [];
          const errs0 = pageErrors.length;
          let resp = null;
          try { resp = await page.goto(`${ADMIN}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); } catch (e) { check(`${tag}: abre ${p}`, false, String(e.message).slice(0, 120)); continue; }
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
          await sleep(1200);
          const restricted = await page.getByRole('heading', { name: 'Acesso restrito' }).count();
          const allowedByUi = !UI_RULES[p] || UI_RULES[p].includes(userType);
          const s5 = api.filter((x) => x.s >= 500), s403 = api.filter((x) => x.s === 403), s429 = api.filter((x) => x.s === 429), s4 = api.filter((x) => x.s >= 400 && x.s < 500 && x.s !== 403 && x.s !== 429 && x.s !== 401);
          summary[label].paginas[p] = { ui: allowedByUi ? (restricted ? 'RESTRITO(inesperado)' : 'abre') : (restricted ? 'RESTRITO' : 'ABRE(inesperado)'), api403: s403.length, api4xx: s4.length, api5xx: s5.length, api429: s429.length, erroPagina: pageErrors.length - errs0 };
          if (!allowedByUi) check(`${tag}: URL direta ${p} mostra "Acesso restrito"`, restricted > 0, `heading=${restricted}`);
          else {
            check(`${tag}: ${p} abre sem "Acesso restrito" indevido`, restricted === 0 && (!resp || resp.status() < 500), `http=${resp && resp.status()} restrito=${restricted}`);
            check(`${tag}: ${p} sem 5xx da API nem erro de JavaScript`, s5.length === 0 && pageErrors.length === errs0, `5xx=${JSON.stringify(s5.slice(0, 2))} js=${pageErrors.slice(errs0).join('|')}`);
          }
          await sleep(3500);
        }
        // Ações seguras em telas permitidas (sem enviar nada): busca, abas, abrir e fechar modal "Novo/Nova"
        for (const p of process.env.HML_UI_LOGOUT_ONLY ? [] : visible.slice(0, 5)) {
          if (UI_RULES[p] && !UI_RULES[p].includes(userType)) continue;
          const errs0 = pageErrors.length;
          await page.goto(`${ADMIN}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => undefined);
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
          const search = page.locator('input[placeholder*="uscar" i], input[placeholder*="esquis" i]').first();
          if (await search.count()) { await search.fill('a'); await sleep(800); await search.fill(''); }
          const tabs = page.getByRole('tab');
          for (let i = 0; i < Math.min(await tabs.count(), 4); i++) { await tabs.nth(i).click().catch(() => undefined); await sleep(500); }
          const novo = page.getByRole('button', { name: /^(Novo|Nova)\b/ }).first();
          let modal = 'sem botão Novo/Nova';
          if (await novo.count()) { await novo.click().catch(() => undefined); await sleep(600); modal = (await page.getByRole('dialog').count()) ? 'abre' : 'sem diálogo'; await page.keyboard.press('Escape'); await sleep(400); }
          summary[label].paginas[p].acoes = { busca: await search.count() ? 'ok' : 'n/a', abas: await tabs.count(), modal };
          check(`${tag}: ações seguras em ${p} sem erro de JavaScript`, pageErrors.length === errs0, pageErrors.slice(errs0).join('|'));
          await sleep(2500);
        }
        // Logout
        await page.goto(`${ADMIN}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
        await sleep(2500);
        const sair = page.locator('button[title="Sair"]').first();
        let out = false;
        if (await sair.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false)) {
          await sair.click().catch(() => undefined);
          out = await page.waitForURL(/\/login/, { timeout: 20000 }).then(() => true).catch(() => false);
        }
        check(`${tag}: logout volta para /login`, out, page.url());
        if (out) { await page.goto(`${ADMIN}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined); await sleep(1500); check(`${tag}: após o logout /dashboard exige login de novo`, /\/login/.test(page.url()), page.url()); }
      } catch (e) {
        check(`${tag}: fluxo completo sem exceção`, false, String(e.message).slice(0, 200));
      } finally {
        await ctx.close();
      }
      await sleep(2000);
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(__dirname, '..', '.hml', 'results', 'ui-profiles-resumo.json'), JSON.stringify(summary, null, 1));
  }
  S.finish();
})().catch((e) => { console.error(e); process.exit(2); });
