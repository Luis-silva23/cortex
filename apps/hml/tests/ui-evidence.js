// Evidência VISUAL da homologação (screenshots), uma frente por execução: HML_EV=admin | sa | pdv.
// Cada frente exige o seu servidor de desenvolvimento apontando para a API HML (3101):
//   admin → Admin Web em 3002 (NEXT_PUBLIC_API_URL=http://localhost:3101/api)
//   sa    → Super Admin em 3000 (NEXT_PUBLIC_API_URL=http://localhost:3101)
//   pdv   → PDV web em 5173 (VITE_API_URL=http://localhost:3101)
// Um Chrome, um contexto por perfil, tudo em sequência e espaçado. Só grava PNG em docs/evidencias/2026-10-04-homologacao.
const fs = require('fs');
const path = require('path');
const { readCredentials, totp } = require('../lib/api');
const { chromium } = require('../../../node_modules/playwright-core');

// HML_OUT_DIR troca a pasta de saída (ex.: a homologação visual dos gráficos grava em docs/evidencias/2026-10-04-homologacao-graficos).
const OUT = process.env.HML_OUT_DIR
  ? path.resolve(process.env.HML_OUT_DIR)
  : path.join(__dirname, '..', '..', '..', 'docs', 'evidencias', '2026-10-04-homologacao');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const phase = process.env.HML_EV;
const notes = [];
// Evidência anterior nunca é sobrescrita: se o arquivo já existe, a captura nova sai com sufixo de execução.
const RUN = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const shot = async (page, name, note, opts = {}) => {
  let file = path.join(OUT, `${name}.png`);
  if (fs.existsSync(file)) file = path.join(OUT, `${name}__${RUN}.png`);
  // `opts.element` (Locator) captura só o elemento (ex.: o cartão de um gráfico); sem ele, a janela ou a página inteira.
  if (opts.element) await opts.element.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: Boolean(opts.fullPage) });
  notes.push(`${path.basename(file, '.png')}: ${note}`);
  console.log(`[shot] ${path.basename(file, '.png')} — ${note}`);
};
const settle = async (page, ms = 2000) => { await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined); await sleep(ms); };
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag} js: ${String(e.message).slice(0, 140)}`));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${tag} ${r.status()} ${r.url().slice(0, 100)}`); });
};

// Falha RÁPIDA: espera a condição, mas se a tela mostrar erro de login (credencial, bloqueio, banco indisponível) lança na hora
// com o texto da tela, em vez de esperar 120 s por um painel que não virá (visto em 2026-10-04, login 503 do Mecânico).
const LOGIN_ERROR = /Credenciais inválidas|Muitas tentativas|indispon|Não foi possível|Erro|erro ao|bloquead/i;
async function untilOrError(page, ok, what, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ok()) return;
    const texts = await page.locator('[role="alert"], [class*="danger"]').allTextContents().catch(() => []);
    const msg = texts.map((t) => t.trim()).find((t) => t && LOGIN_ERROR.test(t));
    if (msg) throw new Error(`${what}: a tela mostrou "${msg.slice(0, 140)}"`);
    await sleep(300);
  }
  throw new Error(`${what}: não concluiu em ${Math.round(ms / 1000)} s`);
}

// Painel pronto: sem os esqueletos de carregamento (`animate-pulse`) dos cartões; só então a captura sai.
async function dashboardLoaded(page) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
  const done = await page.waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 30000 }).then(() => true, () => false);
  if (!done) console.log('  [aviso] cartões ainda carregando após 30 s — a captura mostra o estado real');
  await sleep(500);
}

async function toDashboard(page, who) {
  await untilOrError(page, () => /\/dashboard/.test(page.url()), `login de ${who || 'usuário'} até o painel`);
  await dashboardLoaded(page);
}

async function adminLogin(page, base, u, name) {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await settle(page);
  if (name) await shot(page, `${name}-login`, 'tela de login');
  await page.fill('input[type="email"]', u.email);
  await page.fill('input[type="password"]', u.password);
  await page.click('button[type="submit"]');
  if (u.mfaSecret) {
    await untilOrError(page, async () => (await page.locator('input[inputmode="numeric"]').count()) > 0, `login de ${u.email} até o segundo fator`);
    if (name) await shot(page, `${name}-mfa`, 'segundo fator (código do autenticador)');
    await page.fill('input[inputmode="numeric"]', totp(u.mfaSecret));
    await page.click('button[type="submit"]');
  }
}

async function runAdmin(browser, cred) {
  const B = 'http://localhost:3002';
  const ctxFor = async () => { const c = await browser.newContext({ viewport: { width: 1366, height: 800 } }); const p = await c.newPage(); watch(p, 'admin'); return [c, p]; };

  let [c, p] = await ctxFor();
  await adminLogin(p, B, cred.users['ceo.a'], 'a01-ceo');
  await toDashboard(p);
  await shot(p, 'a02-ceo-dashboard', 'CEO: tela principal com todos os módulos no menu');
  await p.goto(`${B}/dashboard/users`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  await shot(p, 'a03-ceo-usuarios', 'CEO: administração de usuários (permitido)');
  await p.goto(`${B}/dashboard/help`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  await shot(p, 'a04-ceo-central-de-ajuda', 'CEO: Central de Ajuda');
  await c.close(); await sleep(2000);

  [c, p] = await ctxFor();
  await adminLogin(p, B, cred.users['viewer.a1']);
  await toDashboard(p);
  await shot(p, 'a05-visualizador-dashboard', 'Visualizador: tela principal, sem Usuários/Descontos/Convênios no menu');
  const posts = [];
  p.on('response', (r) => { if (r.request().method() === 'POST' && /\/api\/customers$/.test(r.url())) posts.push(r.status()); });
  await p.goto(`${B}/dashboard/customers`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  const novo = p.getByRole('button', { name: /^(Novo|Nova)\b/ }).first();
  if (await novo.count()) {
    await novo.click(); await sleep(800);
    const nome = p.getByRole('dialog').locator('input[type="text"], input:not([type])').first();
    if (await nome.count()) await nome.fill('[HML-STRESS] visualizador tenta criar');
    await shot(p, 'a06-visualizador-formulario-cliente', 'Visualizador: abre o formulário de novo cliente');
    const salvar = p.getByRole('dialog').getByRole('button', { name: /salvar|criar|cadastrar|confirmar/i }).first();
    if (await salvar.count()) { await salvar.click().catch(() => undefined); await sleep(2500); }
    await shot(p, 'a07-visualizador-escrita-bloqueada', `Visualizador: tentativa de gravar cliente — POST /api/customers respondeu ${posts.join(',') || 'sem chamada'} (esperado 403)`);
  } else {
    await shot(p, 'a06-visualizador-clientes-sem-botao-novo', 'Visualizador: tela de clientes sem botão de criar');
  }
  await c.close(); await sleep(2000);

  [c, p] = await ctxFor();
  await adminLogin(p, B, cred.users['mecanico.a1']);
  await toDashboard(p);
  await shot(p, 'a08-mecanico-dashboard', 'Mecânico: menu reduzido (sem vendas, compras, fiscal, financeiro)');
  await p.goto(`${B}/dashboard/financial`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  await shot(p, 'a09-mecanico-financeiro-acesso-restrito', 'Mecânico: URL direta do Financeiro mostra "Acesso restrito"');
  await p.goto(`${B}/dashboard/service-orders`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  await shot(p, 'a10-mecanico-ordens-de-servico', 'Mecânico: Ordens de Serviço (permitido)');
  await c.close(); await sleep(2000);

  [c, p] = await ctxFor();
  await adminLogin(p, B, cred.users['caixa.a1']);
  await toDashboard(p);
  await p.goto(`${B}/dashboard/users`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  await shot(p, 'a11-caixa-usuarios-acesso-restrito', 'Caixa: URL direta de Usuários mostra "Acesso restrito"');
  await c.close(); await sleep(2000);

  [c, p] = await ctxFor();
  await adminLogin(p, B, cred.users['gerente.a1'], 'a12-gerente');
  await toDashboard(p);
  await p.goto(`${B}/dashboard/users`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p);
  await shot(p, 'a13-gerente-usuarios-acesso-restrito', 'Gerente: Usuários é só do CEO — "Acesso restrito"');
  await c.close();
}

// Erro e bloqueio de login pela tela (Admin Web): 5 tentativas com senha errada para um e-mail que NÃO existe (nenhum usuário
// real é bloqueado), depois o login CORRETO do CEO com o IP já bloqueado. Só o balde de IP do Redis HML é afetado: reinicie o
// Redis HML depois (`node apps/hml/infra.js kill-redis` + `start-redis`). Cinco tentativas, não uma força bruta.
async function runErrors(browser, cred) {
  const B = 'http://localhost:3002';
  const c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const p = await c.newPage(); watch(p, 'errors');
  const tentar = async (email, senha) => {
    await p.goto(`${B}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p, 1000);
    await p.fill('input[type="email"]', email); await p.fill('input[type="password"]', senha);
    await p.click('button[type="submit"]'); await sleep(2500);
  };
  await tentar('inexistente@hml.local', 'senha-errada-1');
  await shot(p, 'e01-login-senha-errada', 'Login com senha errada: mensagem de credenciais inválidas (tentativa 1 de 5)');
  for (let i = 2; i <= 5; i += 1) { await tentar('inexistente@hml.local', `senha-errada-${i}`); await sleep(1500); }
  await shot(p, 'e02-login-ip-bloqueado', 'Após 5 falhas: a tela informa o bloqueio por tentativas (60 min, por IP)');
  const ceo = cred.users['ceo.a'];
  await tentar(ceo.email, ceo.password);
  await shot(p, 'e03-login-correto-com-ip-bloqueado', 'CEO com a senha CERTA, mas o IP já está bloqueado: o login também é recusado (decisões 47 e 48)');
  await c.close();
}

// Painel do Admin Web depois da correção visual: página inteira (os gráficos ficam abaixo da dobra), tema claro e escuro.
// Nomes próprios (d01…): nenhuma evidência anterior é tocada.
async function runDashboard(browser, cred, prefix = 'd') {
  const B = 'http://localhost:3002';
  const theme = async (page, mode) => {
    await page.evaluate((m) => localStorage.setItem('ln-theme', m), mode);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dashboardLoaded(page);
  };

  let c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  let p = await c.newPage(); watch(p, 'dashboard');
  await adminLogin(p, B, cred.users['ceo.a']);
  await toDashboard(p, 'CEO');
  await theme(p, 'light');
  await shot(p, `${prefix}01-ceo-dashboard-claro`, 'Painel do CEO, tema claro: evolução da receita em linha e formas de pagamento em barras de uma cor', { fullPage: true });
  await theme(p, 'dark');
  await shot(p, `${prefix}02-ceo-dashboard-escuro`, 'Painel do CEO, tema escuro: mesmos gráficos pelos tokens do tema', { fullPage: true });
  await c.close(); await sleep(2000);

  c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  p = await c.newPage(); watch(p, 'dashboard');
  await adminLogin(p, B, cred.users['gerente.a1'], undefined);
  await toDashboard(p, 'Gerente');
  await theme(p, 'light');
  await shot(p, `${prefix}03-gerente-dashboard-claro`, 'Painel do Gerente (filial): evolução da receita da filial em linha', { fullPage: true });
  await c.close();
}

// Alternância Linha | Colunas da evolução da receita: a troca NÃO pode chamar a API (conta as requisições /api/ antes e depois do
// clique, e o resultado vai para as notas) nem recarregar a página. Também confere os gráficos que ficam só em barras (formas de
// pagamento e filial, na mesma página) e os perfis sem gráfico de evolução. Nomes tg01…: nenhuma evidência anterior é tocada.
async function runDashboardToggle(browser, cred) {
  const B = 'http://localhost:3002';
  const track = (page) => {
    const urls = [];
    page.on('request', (r) => { if (/\/api\//.test(r.url())) urls.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}`); });
    return urls;
  };
  const clickMode = async (page, urls, label, tag) => {
    const before = urls.length;
    const marker = await page.evaluate(() => { window.__noReload = Math.random(); return window.__noReload; });
    await page.getByRole('button', { name: label, exact: true }).click();
    await sleep(900);
    const same = await page.evaluate((m) => window.__noReload === m, marker);
    const extra = urls.slice(before);
    notes.push(`[verificação] ${tag}: clique em "${label}" → ${extra.length} requisição(ões) à API, página ${same ? 'não recarregou' : 'RECARREGOU'}`);
    console.log(`  ${tag}: "${label}" → ${extra.length} requisição(ões) à API${extra.length ? ' ' + JSON.stringify(extra) : ''}; sem recarregar: ${same}`);
    if (extra.length || !same) errors.push(`toggle ${tag}: ${extra.length} requisição(ões), recarregou=${!same}`);
  };
  const theme = async (page, mode) => {
    await page.evaluate((m) => localStorage.setItem('ln-theme', m), mode);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dashboardLoaded(page);
  };

  let c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  let p = await c.newPage(); watch(p, 'toggle');
  let urls = track(p);
  await adminLogin(p, B, cred.users['ceo.a']);
  await toDashboard(p, 'CEO');
  await theme(p, 'light');
  await shot(p, 'tg01-ceo-linha-claro', 'CEO, tema claro, evolução da receita em LINHA (padrão)', { fullPage: true });
  await clickMode(p, urls, 'Colunas', 'CEO claro');
  await shot(p, 'tg02-ceo-colunas-claro', 'CEO, tema claro, MESMA série em COLUNAS (sem nova chamada à API); formas de pagamento e filial seguem só em barras', { fullPage: true });
  await clickMode(p, urls, 'Linha', 'CEO claro (volta)');
  await theme(p, 'dark');
  await clickMode(p, urls, 'Colunas', 'CEO escuro');
  await shot(p, 'tg03-ceo-colunas-escuro', 'CEO, tema escuro, evolução da receita em COLUNAS', { fullPage: true });
  await clickMode(p, urls, 'Linha', 'CEO escuro (volta)');
  await shot(p, 'tg04-ceo-linha-escuro', 'CEO, tema escuro, evolução da receita em LINHA', { fullPage: true });
  await c.close(); await sleep(2000);

  for (const [key, tag, desc, toggle] of [
    ['gerente.a1', 'tg05-gerente-colunas-claro', 'Gerente (filial), tema claro, evolução em COLUNAS', true],
    ['caixa.a1', 'tg06-operador-claro', 'Operador: sem evolução da receita; formas de pagamento de hoje só em barras', false],
    ['viewer.a1', 'tg07-visualizador-claro', 'Visualizador: mesmo painel mínimo do operador, só barras', false],
  ]) {
    c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    p = await c.newPage(); watch(p, 'toggle');
    urls = track(p);
    await adminLogin(p, B, cred.users[key]);
    await toDashboard(p, desc);
    await theme(p, 'light');
    if (toggle) await clickMode(p, urls, 'Colunas', desc);
    await shot(p, tag, desc, { fullPage: true });
    await c.close(); await sleep(2000);
  }
}

// HOMOLOGAÇÃO VISUAL DOS GRÁFICOS (Admin/CEO, Gerente e Super Admin, claro e escuro, Linha ↔ Colunas, tooltip, várias séries,
// responsivo, estados). Usa a empresa de demonstração do banco de DESENVOLVIMENTO (dados reais de jornadas; nada é criado) com a API na
// 3101, o Admin Web na 3002 e o Super Admin na 3000, todos em produção (`next start`). Um Chrome, um contexto por vez, sem laço e sem carga.
// Variável obrigatória: HML_BRANCH_ID (filial "Alfa — Matriz (A1)"). Cada verificação (modo, tooltip, requisições, recarga) vai para as notas.
async function runGraficos(browser) {
  const demo = require('../../api/.demo/credentials.json');
  const ADMIN = 'http://localhost:3002';
  const SA = 'http://localhost:3000';
  const COMPANY = typeof demo.companies.alfa === 'string' ? demo.companies.alfa : demo.companies.alfa.companyId;
  const BRANCH = process.env.HML_BRANCH_ID;
  if (!BRANCH) throw new Error('HML_BRANCH_ID (filial A1 da demonstração) é obrigatório');
  const userOf = (k) => ({ email: demo.users[k].email, password: demo.password });
  const saUser = { email: demo.users['sa.e2e'].email, password: demo.password, mfaSecret: demo.saMfaSecret };
  // Retomável: HML_SECTIONS escolhe as seções (admin, resp-admin, carregando, erro, sa, resp-sa) e HML_N0 continua a numeração das capturas.
  const only = new Set((process.env.HML_SECTIONS || 'admin,resp-admin,carregando,erro,sa,resp-sa').split(','));
  let n = Number(process.env.HML_N0 || 0);
  const nm = (s) => `grafico-${String(++n).padStart(2, '0')}-${s}`;
  const note = (s) => { notes.push(`[verificação] ${s}`); console.log('  ' + s); };

  const cardOf = (page, re) => page.getByRole('group', { name: re }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  const track = (page) => {
    const u = [];
    page.on('request', (r) => { if (['fetch', 'xhr'].includes(r.resourceType()) && /localhost:3101/.test(r.url())) u.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 70)}`); });
    return u;
  };
  const pressed = async (card, label) => (await card.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed')) === 'true';
  const modeOf = async (card) => ((await card.locator('.recharts-bar-rectangle').count()) > 0 ? 'colunas' : (await card.locator('.recharts-line-curve').count()) > 0 ? 'linha' : 'vazio');
  const hover = async (page, card, frac = 0.6) => {
    const box = await card.locator('.recharts-wrapper').first().boundingBox();
    if (!box) return '';
    // Dois movimentos curtos, como a mão de quem usa o mouse: a dica só é posicionada a partir do segundo evento (um único movimento
    // sintético a deixa sem posição; com o mouse real isso dura um quadro).
    await page.mouse.move(box.x + box.width * frac, box.y + box.height * 0.45);
    await sleep(120);
    await page.mouse.move(box.x + box.width * frac + 2, box.y + box.height * 0.45);
    await sleep(500);
    return (await card.locator('.recharts-tooltip-wrapper').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  };
  const setTheme = async (page, mode, waitSpinners = true) => {
    await page.evaluate((m) => localStorage.setItem('ln-theme', m), mode);
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (waitSpinners) await dashboardLoaded(page);
  };
  const switchMode = async (page, card, urls, label, tag) => {
    const before = urls.length;
    const marker = await page.evaluate(() => (window.__homolog = Math.random()));
    await card.getByRole('button', { name: label, exact: true }).click();
    await sleep(700);
    const same = await page.evaluate((m) => window.__homolog === m, marker);
    const extra = urls.length - before;
    note(`${tag}: clique em "${label}" → ${extra} requisição(ões) à API, ${same ? 'sem recarregar' : 'RECARREGOU'}; "${label}" ativo: ${await pressed(card, label)}; desenho: ${await modeOf(card)}`);
    if (extra || !same) errors.push(`${tag}: troca para ${label} gerou ${extra} requisição(ões), recarregou=${!same}`);
  };
  // Um gráfico temporal: Linha (padrão) → tooltip → Colunas → (tooltip) → de volta a Linha.
  const exercise = async (page, urls, card, tag, themeName, opts = {}) => {
    await card.scrollIntoViewIfNeeded();
    if ((await card.innerText()).includes('Sem dados coletados')) {
      note(`${tag} (${themeName}): estado SEM DADOS no período (dado real ausente, nada inventado)`);
      await shot(page, nm(`${tag}-sem-dados-${themeName}`), `${tag}: estado "sem dados" real`, { element: card });
      return false;
    }
    note(`${tag} (${themeName}): abre em ${await modeOf(card)}; "Linha" ativo: ${await pressed(card, 'Linha')}; "Colunas" ativo: ${await pressed(card, 'Colunas')}`);
    await shot(page, nm(`${tag}-linha-${themeName}`), `${tag}: Linha (padrão), tema ${themeName}`, { element: card });
    const t1 = await hover(page, card);
    note(`${tag} (${themeName}): tooltip em Linha → "${t1}"`);
    await shot(page, nm(`${tag}-tooltip-linha-${themeName}`), `${tag}: tooltip em Linha, tema ${themeName}: ${t1}`, { element: card });
    await page.mouse.move(0, 0);
    await switchMode(page, card, urls, 'Colunas', `${tag} ${themeName}`);
    await shot(page, nm(`${tag}-colunas-${themeName}`), `${tag}: Colunas, tema ${themeName}`, { element: card });
    if (opts.columnsTooltip) {
      const t2 = await hover(page, card);
      note(`${tag} (${themeName}): tooltip em Colunas → "${t2}"`);
      await shot(page, nm(`${tag}-tooltip-colunas-${themeName}`), `${tag}: tooltip em Colunas, tema ${themeName}: ${t2}`, { element: card });
      await page.mouse.move(0, 0);
    }
    await switchMode(page, card, urls, 'Linha', `${tag} ${themeName} (volta)`);
    return true;
  };

  // 1) Admin/CEO e Gerente — claro e escuro, painel completo.
  for (const [key, tag] of only.has('admin') ? [['admin.alfa', 'admin-ceo'], ['gerente.alfa.1', 'gerente']] : []) {
    const c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const p = await c.newPage(); watch(p, tag);
    const urls = track(p);
    await adminLogin(p, ADMIN, userOf(key));
    await toDashboard(p, tag);
    for (const [th, nome] of [['light', 'claro'], ['dark', 'escuro']]) {
      await setTheme(p, th);
      await exercise(p, urls, cardOf(p, /receita por dia/i), tag, nome, { columnsTooltip: true });
      await p.evaluate(() => window.scrollTo(0, 0));
      await shot(p, nm(`${tag}-dashboard-completo-${nome}`), `${tag}: painel completo, tema ${nome} (composição geral)`, { fullPage: true });
    }
    await c.close(); await sleep(1500);
  }

  // 2) Admin — responsivo (390 px).
  if (only.has('resp-admin')) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage(); watch(p, 'responsivo-admin');
    const urls = track(p);
    await adminLogin(p, ADMIN, userOf('admin.alfa'));
    await toDashboard(p, 'Admin 390');
    await setTheme(p, 'light');
    const card = cardOf(p, /receita por dia/i);
    await card.scrollIntoViewIfNeeded();
    await shot(p, nm('admin-responsivo-390-linha'), 'Admin a 390 px: Linha (padrão)', { element: card });
    await switchMode(p, card, urls, 'Colunas', 'admin 390');
    await shot(p, nm('admin-responsivo-390-colunas'), 'Admin a 390 px: Colunas', { element: card });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    note(`admin 390 px: rolagem horizontal da página = ${overflow} px (0 = sem estouro)`);
    await p.evaluate(() => window.scrollTo(0, 0));
    await shot(p, nm('admin-responsivo-390-pagina'), 'Admin a 390 px: página inteira', { fullPage: true });
    await c.close(); await sleep(1500);
  }

  // 3) Admin — estados: carregando (resposta atrasada no navegador) e erro (requisição cancelada no navegador). Só no cliente.
  if (only.has('carregando')) {
    const c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const p = await c.newPage(); watch(p, 'estado-carregando');
    await adminLogin(p, ADMIN, userOf('admin.alfa'));
    await toDashboard(p, 'Admin estado carregando');
    // O atraso é só do navegador; a requisição segue ao terminar a espera (se a página já saiu, o erro de rota é ignorado).
    await p.route('**/api/dashboard/sales**', async (route) => { await sleep(4000); await route.continue().catch(() => undefined); });
    await p.goto(`${ADMIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await shot(p, nm('admin-estado-carregando'), 'Admin: estado de carregamento (resposta de vendas atrasada 4 s no navegador)', { fullPage: true });
    await sleep(3500);
    await c.close(); await sleep(1500);
  }
  if (only.has('erro')) {
    const c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const p = await c.newPage(); watch(p, 'estado-erro');
    await adminLogin(p, ADMIN, userOf('admin.alfa'));
    await toDashboard(p, 'Admin estado erro');
    await p.route('**/api/dashboard/sales**', (route) => route.abort());
    await p.goto(`${ADMIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await shot(p, nm('admin-estado-erro'), 'Admin: estado de erro (requisição de vendas cancelada no navegador)', { fullPage: true });
    note(`admin erro: texto "Dados indisponíveis" visível = ${(await p.getByText('Dados indisponíveis').count()) > 0}`);
    await c.close(); await sleep(1500);
  }

  // 4) Super Admin — monitoramento da filial (4 gráficos, várias séries) e performance, claro e escuro.
  if (only.has('sa')) {
    const c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const p = await c.newPage(); watch(p, 'superadmin');
    const urls = track(p);
    await adminLogin(p, SA, saUser);
    await toDashboard(p, 'Super Admin');
    const openBranch = async (range) => {
      await p.goto(`${SA}/dashboard/companies/${COMPANY}/branches/${BRANCH}`, { waitUntil: 'domcontentloaded' });
      await p.getByText('Latência da API').first().waitFor({ timeout: 40000 });
      if (range) { await p.getByRole('button', { name: range, exact: true }).click(); await sleep(2500); }
    };
    const charts = [
      [/latência da api/i, 'sa-latencia'],
      [/requisições e erros/i, 'sa-requisicoes-erros'],
      [/cpu, ram e disco/i, 'sa-cpu-ram-disco'],
      [/rede: latência e perda/i, 'sa-rede'],
    ];
    // Retomável por partes: HML_SA_PARTS = filial, 1h, perf.
    const saParts = new Set((process.env.HML_SA_PARTS || 'filial,1h,perf').split(','));
    if (saParts.has('filial')) {
    await openBranch('30 dias');
    for (const [re, tag] of charts) await exercise(p, urls, cardOf(p, re), tag, 'claro', { columnsTooltip: true });
    await p.evaluate(() => window.scrollTo(0, 0));
    await shot(p, nm('sa-filial-completa-claro'), 'Super Admin › filial: página completa, tema claro, 30 dias', { fullPage: true });

    await setTheme(p, 'dark', false);
    await p.getByText('Latência da API').first().waitFor({ timeout: 40000 });
    await p.getByRole('button', { name: '30 dias', exact: true }).click(); await sleep(2500);
    for (const [re, tag] of [charts[0], charts[2]]) await exercise(p, urls, cardOf(p, re), tag, 'escuro', { columnsTooltip: true });
    await p.evaluate(() => window.scrollTo(0, 0));
    await shot(p, nm('sa-filial-completa-escuro'), 'Super Admin › filial: página completa, tema escuro, 30 dias', { fullPage: true });
    await setTheme(p, 'light', false);
    }

    // estado "sem dados" real: a última hora não tem coleta de telemetria nesta filial (o gráfico some e entra o aviso)
    if (saParts.has('1h')) {
      await openBranch('1 hora');
      await shot(p, nm('sa-estado-sem-dados-1h'), 'Super Admin › filial, última hora: estados vazios reais', { fullPage: true });
      note(`filial 1 hora: avisos "Sem dados coletados no período" = ${await p.getByText('Sem dados coletados no período').count()}`);
    }

    // observabilidade: requisições ao longo do tempo (24 h por hora; 7 dias por dia)
    if (saParts.has('perf')) {
    await p.goto(`${SA}/dashboard/observability/performance`, { waitUntil: 'domcontentloaded' });
    await p.getByText('Requisições ao longo do tempo').first().waitFor({ timeout: 40000 });
    await sleep(1500);
    const perf = () => cardOf(p, /requisições ao longo do tempo/i);
    await exercise(p, urls, perf(), 'sa-observabilidade-24h', 'claro', { columnsTooltip: true });
    const ticks24 = await perf().locator('.recharts-xAxis .recharts-cartesian-axis-tick-value').allInnerTexts();
    note(`observabilidade 24 h (agrupamento por HORA): rótulos do eixo = ${JSON.stringify(ticks24)}`);
    await p.getByRole('button', { name: 'Últimos 7 dias', exact: true }).click();
    await sleep(2500);
    await perf().scrollIntoViewIfNeeded();
    const ticks7 = await perf().locator('.recharts-xAxis .recharts-cartesian-axis-tick-value').allInnerTexts();
    const tt7 = await hover(p, perf());
    note(`observabilidade 7 dias (agrupamento por DIA em UTC, pendência conhecida): rótulos do eixo = ${JSON.stringify(ticks7)}; tooltip = "${tt7}"`);
    await shot(p, nm('sa-observabilidade-7dias-fuso'), `Super Admin › observabilidade, 7 dias: rótulos por dia (agrupamento UTC na API, pendente). Eixo: ${ticks7.join(' ')}`, { element: perf() });
    await p.mouse.move(0, 0);
    await setTheme(p, 'dark', false);
    await p.getByText('Requisições ao longo do tempo').first().waitFor({ timeout: 40000 });
    await sleep(2500);
    await exercise(p, urls, perf(), 'sa-observabilidade-24h', 'escuro', { columnsTooltip: false });
    }
    await c.close(); await sleep(1500);
  }

  // 4b) Super Admin — páginas inteiras. O layout do Super Admin rola dentro do próprio painel, então `fullPage` só pega a janela:
  // aqui a janela é alta o bastante para a página da filial caber toda (claro, escuro e o estado sem dados da última hora).
  if (only.has('sa-alto')) {
    const c = await browser.newContext({ viewport: { width: 1366, height: 2000 } });
    const p = await c.newPage(); watch(p, 'sa-alto');
    await adminLogin(p, SA, saUser);
    await toDashboard(p, 'Super Admin (janela alta)');
    const open = async (range) => {
      await p.goto(`${SA}/dashboard/companies/${COMPANY}/branches/${BRANCH}`, { waitUntil: 'domcontentloaded' });
      await p.getByText('Latência da API').first().waitFor({ timeout: 40000 });
      await p.getByRole('button', { name: range, exact: true }).click(); await sleep(2500);
    };
    await open('30 dias');
    await shot(p, nm('sa-filial-pagina-inteira-claro'), 'Super Admin › filial, 30 dias: página inteira (4 gráficos), tema claro');
    await setTheme(p, 'dark', false);
    await p.getByText('Latência da API').first().waitFor({ timeout: 40000 });
    await p.getByRole('button', { name: '30 dias', exact: true }).click(); await sleep(2500);
    await shot(p, nm('sa-filial-pagina-inteira-escuro'), 'Super Admin › filial, 30 dias: página inteira (4 gráficos), tema escuro');
    await setTheme(p, 'light', false);
    await open('1 hora');
    await shot(p, nm('sa-filial-pagina-inteira-sem-dados-1h'), 'Super Admin › filial, última hora: página inteira; CPU/RAM/disco e rede sem coleta (estado vazio real)');
    await c.close(); await sleep(1500);
  }

  // 5) Super Admin — responsivo (390 px).
  if (only.has('resp-sa')) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage(); watch(p, 'responsivo-sa');
    await adminLogin(p, SA, saUser);
    await toDashboard(p, 'Super Admin 390');
    await p.goto(`${SA}/dashboard/companies/${COMPANY}/branches/${BRANCH}`, { waitUntil: 'domcontentloaded' });
    await p.getByText('Latência da API').first().waitFor({ timeout: 40000 });
    await p.getByRole('button', { name: '30 dias', exact: true }).click(); await sleep(2500);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    note(`super admin 390 px: rolagem horizontal da página = ${overflow} px (0 = sem estouro)`);
    const card = cardOf(p, /cpu, ram e disco/i);
    await card.scrollIntoViewIfNeeded();
    await shot(p, nm('sa-responsivo-390-cpu-linha'), 'Super Admin a 390 px: CPU/RAM/disco em Linha (3 séries, legenda)', { element: card });
    await card.getByRole('button', { name: 'Colunas', exact: true }).click(); await sleep(700);
    await shot(p, nm('sa-responsivo-390-cpu-colunas'), 'Super Admin a 390 px: CPU/RAM/disco em Colunas', { element: card });
    await p.evaluate(() => window.scrollTo(0, 0));
    await shot(p, nm('sa-responsivo-390-pagina'), 'Super Admin a 390 px: página da filial (janela; o painel rola por dentro)', { fullPage: true });
    await c.close();
  }
  if (only.has('resp-sa-alto')) {
    // Página inteira a 390 px: janela alta, pelo mesmo motivo do layout com rolagem interna.
    const c2 =await browser.newContext({ viewport: { width: 390, height: 3200 } });
    const p2 = await c2.newPage(); watch(p2, 'responsivo-sa-alto');
    await adminLogin(p2, SA, saUser);
    await toDashboard(p2, 'Super Admin 390 alto');
    await p2.goto(`${SA}/dashboard/companies/${COMPANY}/branches/${BRANCH}`, { waitUntil: 'domcontentloaded' });
    await p2.getByText('Latência da API').first().waitFor({ timeout: 40000 });
    await p2.getByRole('button', { name: '30 dias', exact: true }).click(); await sleep(2500);
    await shot(p2, nm('sa-responsivo-390-pagina-inteira'), 'Super Admin a 390 px: página da filial inteira (4 gráficos)');
    await c2.close();
  }
}

async function runSa(browser, cred) {
  const B = 'http://localhost:3000';
  const sa = cred.sa || cred.users.sa;
  const c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const p = await c.newPage(); watch(p, 'sa');
  await adminLogin(p, B, sa, 's01-sa');
  await toDashboard(p);
  await shot(p, 's02-sa-dashboard', 'Super ADM: painel da plataforma');
  for (const [name, route, note] of [
    ['s03-sa-empresas', '/dashboard/companies', 'Super ADM: empresas (Alfa e Beta de homologação)'],
    ['s04-sa-suporte', '/dashboard/support', 'Super ADM: Console de Suporte'],
    ['s05-sa-observabilidade', '/dashboard/observability', 'Super ADM: observabilidade'],
    ['s06-sa-auditoria', '/dashboard/audit-logs', 'Super ADM: auditoria'],
  ]) {
    await p.goto(`${B}${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(p, 2500);
    await shot(p, name, note); await sleep(1500);
  }
  await c.close();
}

async function runPdv(browser, cred) {
  const B = 'http://localhost:5173';
  const pdvLogin = async (page, u, name) => {
    await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(page);
    if (name) await shot(page, `${name}-login`, 'PDV: tela de login (ID numérico + senha)');
    await page.fill('#numericId', String(u.numericId));
    await page.getByPlaceholder('Digite sua senha').fill(u.password);
    await page.getByRole('button', { name: /entrar/i }).first().click();
  };

  let c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  let p = await c.newPage(); watch(p, 'pdv');
  const sales = [];
  p.on('response', async (r) => { if (r.request().method() === 'POST' && /\/api\/(sales|payments)$/.test(r.url())) sales.push(`${r.url().split('/').pop()}:${r.status()}`); });
  await pdvLogin(p, cred.users['caixa.a1'], 'p01-caixa');
  await sleep(4000); await settle(p);
  await shot(p, 'p02-caixa-apos-login', `Caixa: depois do login (${new URL(p.url()).pathname})`);
  await p.goto(`${B}/cash-register`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined); await settle(p);
  const abrir = p.getByRole('button', { name: 'Abrir Caixa' });
  if (await abrir.count()) {
    await abrir.first().click(); await sleep(800);
    await p.locator('#register-number').fill('71');
    await p.locator('input[type="number"]').last().fill('100');
    await shot(p, 'p03-caixa-abrir', 'Caixa: abertura de caixa (nº 71, troco inicial R$ 100)');
    await p.getByRole('button', { name: 'Abrir Caixa' }).last().click(); await sleep(3000); await settle(p);
  }
  await p.goto(`${B}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined); await settle(p);
  const busca = p.getByPlaceholder('Digite o código ou nome do produto...');
  await busca.fill('carga 1'); await busca.press('Enter'); await sleep(2500);
  const linha = p.locator('table tbody tr, [role="listbox"] [role="option"], li').filter({ hasText: /carga 1/i }).first();
  if (await linha.count()) await linha.click().catch(() => undefined);
  await sleep(1500);
  await shot(p, 'p04-caixa-produto-na-venda', 'Caixa: busca e item adicionado à venda');
  await p.getByRole('button', { name: /Finalizar Venda/ }).click().catch(() => undefined); await sleep(2000);
  await shot(p, 'p05-caixa-pagamento', 'Caixa: modal de pagamento (Dinheiro)');
  await p.getByRole('button', { name: 'Confirmar Pagamento' }).click().catch(() => undefined); await sleep(4000);
  await shot(p, 'p06-caixa-venda-concluida', `Caixa: resultado da venda — chamadas ${sales.join(' ') || 'nenhuma'} (esperado sales:201 payments:201)`);
  await c.close(); await sleep(2000);

  for (const [key, tag, desc] of [['mecanico.a1', 'p07-mecanico', 'Mecânico'], ['viewer.a1', 'p08-visualizador', 'Visualizador']]) {
    c = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    p = await c.newPage(); watch(p, 'pdv');
    await pdvLogin(p, cred.users[key]);
    await sleep(4000); await settle(p);
    await shot(p, `${tag}-no-pdv`, `${desc}: tentativa de entrar no PDV (${new URL(p.url()).pathname})`);
    await c.close(); await sleep(2000);
  }
}

// Painel gerencial (2026-10-04): empresa de demonstração do banco de DESENVOLVIMENTO, API em 3101 e Admin Web em 3002 (build de produção).
// Capturas significativas, não centenas: painel completo, período (todos os recortes), comparação, Linha ↔ Colunas, métricas, origem,
// formas de pagamento, estados, escuro, 390 px, gerente e a tela de canais. Mede as chamadas à API: o mesmo período em todas e nenhuma
// nova chamada ao trocar Linha/Colunas ou a métrica. O estado multi-origem usa uma resposta SIMULADA no navegador (rótulo na nota):
// a empresa de demonstração não tem canal externo e o produto não inventa dado.
async function runGerencial(browser) {
  const demo = require('../../api/.demo/credentials.json');
  const ADMIN = 'http://localhost:3002';
  const API = /localhost:3101/;
  const user = (k) => ({ email: demo.users[k].email, password: demo.password });
  let n = Number(process.env.HML_N0 || 0);
  const nm = (s) => `gerencial-${String(++n).padStart(2, '0')}-${s}`;
  const note = (s) => { notes.push(`[verificação] ${s}`); console.log('  ' + s); };
  const track = (page) => {
    const calls = [];
    page.on('request', (r) => { if (['fetch', 'xhr'].includes(r.resourceType()) && API.test(r.url())) calls.push(r.url().replace(/^https?:\/\/[^/]+\/api/, '')); });
    return calls;
  };
  const ready = async (page) => {
    await page.waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 40000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
    await sleep(700);
  };
  const periodCalls = (calls) => calls.filter((c) => /dashboard\/(management|workshop)/.test(c)).map((c) => (/period=([^&]+)/.exec(c) || [])[1] + (/start=([^&]+)/.test(c) ? `:${/start=([^&]+)/.exec(c)[1]}→${/end=([^&]+)/.exec(c)[1]}` : ''));
  const card = (page, title) => page.getByText(title, { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  const choose = async (page, label) => { await page.getByRole('button', { name: /Últimos|Hoje|Ontem|Mês|Ano|Período personalizado/ }).first().click(); await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click(); await ready(page); };
  const hoverPoint = async (page, el, k = 2) => {
    const dots = el.locator('.recharts-line-dots circle');
    const total = await dots.count();
    if (!total) return '';
    const box = await dots.nth(Math.min(k, total - 1)).boundingBox();
    if (!box) return '';
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(120);
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await sleep(500);
    return (await el.locator('.recharts-tooltip-wrapper').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  };
  const theme = async (page, mode) => { await page.evaluate((m) => localStorage.setItem('ln-theme', m), mode); await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); };

  // ---------- Administrador, 1366 × 900, claro ----------
  let c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  let p = await c.newPage(); watch(p, 'gerencial-admin');
  let calls = track(p);
  await adminLogin(p, ADMIN, user('admin.alfa'));
  await toDashboard(p, 'Administrador');
  await ready(p);
  const first = calls.filter((x) => /dashboard\//.test(x));
  note(`abertura do painel (ADM): ${first.length} chamadas ao painel: ${first.map((x) => x.split('?')[0]).join(', ')}`);
  note(`período enviado nas chamadas gerenciais e da oficina: ${JSON.stringify(periodCalls(calls))}`);
  await shot(p, nm('painel-completo-claro-30-dias'), 'Painel gerencial do Administrador, padrão Últimos 30 dias, tema claro', { fullPage: true });
  await shot(p, nm('kpis-30-dias'), 'Seis KPIs com atual, anterior, diferença e %', { element: p.getByLabel('Indicadores do período') });

  const evo = card(p, 'Evolução');
  note(`evolução abre em Linha: ${await evo.getByRole('button', { name: 'Linha', exact: true }).getAttribute('aria-pressed')}`);
  await shot(p, nm('evolucao-linha-receita'), 'Evolução da receita em Linha (padrão), com o período anterior tracejado', { element: evo });
  const tip = await hoverPoint(p, evo, 21); // 27/09, o dia com mais vendas da demonstração
  note(`tooltip da evolução → "${tip}"`);
  await shot(p, nm('evolucao-tooltip-detalhe'), `Tooltip com data, valor e detalhe por forma de pagamento: ${tip}`, { element: evo });
  await p.mouse.move(0, 0);
  const before = calls.length;
  await evo.getByRole('button', { name: 'Colunas', exact: true }).click(); await sleep(600);
  await shot(p, nm('evolucao-colunas-receita'), 'Evolução da receita em Colunas', { element: evo });
  await evo.getByRole('button', { name: 'Vendas', exact: true }).click(); await sleep(600);
  await shot(p, nm('evolucao-colunas-vendas'), 'Evolução das vendas (quantidade) em Colunas', { element: evo });
  await evo.getByRole('button', { name: 'Ticket médio', exact: true }).click(); await sleep(600);
  await evo.getByRole('button', { name: 'Linha', exact: true }).click(); await sleep(600);
  await shot(p, nm('evolucao-linha-ticket-medio'), 'Evolução do ticket médio em Linha: dia sem venda não vira zero (a linha interrompe)', { element: evo });
  note(`trocas Linha/Colunas e Receita/Vendas/Ticket: ${calls.length - before} nova(s) chamada(s) à API (esperado 0)`);
  if (calls.length - before) errors.push(`gerencial: troca visual gerou ${calls.length - before} chamada(s)`);

  await p.getByRole('button', { name: 'Comparar com o período anterior' }).click(); await sleep(500);
  await shot(p, nm('kpis-sem-comparacao'), 'Comparação desligada: só o valor do período', { element: p.getByLabel('Indicadores do período') });
  await p.getByRole('button', { name: 'Comparar com o período anterior' }).click(); await sleep(300);

  await shot(p, nm('formas-de-pagamento'), 'Formas de pagamento: vendas distintas, valor, ticket e participação (dados reais)', { element: card(p, 'Formas de pagamento') });
  await shot(p, nm('origem-das-vendas-real'), 'Origem das vendas com os dados reais da demonstração: só a loja física (sem canal externo)', { element: card(p, 'Origem das vendas') });
  await shot(p, nm('caixa-e-saques'), 'Caixa e saques do período', { element: card(p, 'Caixa e saques') });

  // ---------- recortes de período ----------
  await p.getByRole('button', { name: /Últimos 30 dias/ }).first().click(); await sleep(300);
  await shot(p, nm('seletor-de-periodo-aberto'), 'Seletor de período aberto: recortes e intervalo personalizado');
  await p.keyboard.press('Escape');
  for (const [label, tag] of [['Hoje', 'hoje'], ['Ontem', 'ontem'], ['Últimos 7 dias', '7-dias'], ['Mês atual', 'mes-atual'], ['Mês anterior', 'mes-anterior'], ['Ano', 'ano']]) {
    calls.length = 0;
    await choose(p, label);
    const info = ((await p.locator('button[aria-haspopup="dialog"]').first().innerText().catch(() => '')) + ' | ' + (await p.locator('[aria-live="polite"]').first().innerText().catch(() => ''))).replace(/\s+/g, ' ');
    note(`período "${label}": ${info} | chamadas: ${JSON.stringify(periodCalls(calls))}`);
    await shot(p, nm(`periodo-${tag}`), `Período ${label}: ${info}`);
  }
  for (const [start, end, tag] of [['2026-01-01', '2026-12-31', 'personalizado-ano-2026'], ['2026-03-01', '2026-09-15', 'personalizado-mar-a-set']]) {
    calls.length = 0;
    await p.getByRole('button', { name: /Ano|Mês|Últimos|Hoje|Ontem|Período personalizado/ }).first().click();
    await p.getByLabel('Início').fill(start); await p.getByLabel('Fim').fill(end);
    await p.getByRole('button', { name: 'Aplicar' }).click(); await ready(p);
    const info = ((await p.locator('button[aria-haspopup="dialog"]').first().innerText().catch(() => '')) + ' | ' + (await p.locator('[aria-live="polite"]').first().innerText().catch(() => ''))).replace(/\s+/g, ' ');
    note(`personalizado ${start} → ${end}: ${info} | chamadas: ${JSON.stringify(periodCalls(calls))}`);
    await shot(p, nm(`periodo-${tag}`), `Personalizado ${start} → ${end}: ${info}`);
  }

  // ---------- escuro ----------
  await choose(p, 'Últimos 30 dias');
  await theme(p, 'dark');
  await shot(p, nm('painel-completo-escuro'), 'Painel gerencial no tema escuro', { fullPage: true });
  await theme(p, 'light');

  // ---------- estados ----------
  await p.route(/dashboard\/management\/summary/, async (route) => { await sleep(3500); await route.continue().catch(() => undefined); });
  await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
  await shot(p, nm('estado-carregando'), 'Estado de carregamento (resposta do resumo atrasada no navegador)');
  await ready(p);
  await p.unroute(/dashboard\/management\/summary/);
  await p.route(/dashboard\/management\/(summary|timeseries)/, (route) => route.abort());
  await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
  await shot(p, nm('estado-erro'), 'Estado de erro (chamadas gerenciais canceladas no navegador): mensagem e "Tentar novamente", sem número inventado');
  await p.unroute(/dashboard\/management\/(summary|timeseries)/);

  // ---------- multi-origem (resposta SIMULADA no navegador) ----------
  await p.route(/dashboard\/management\/summary/, async (route) => {
    const res = await route.fetch(); const j = await res.json();
    const store = j.origins.items[0];
    j.origins.items = [
      { ...store, revenue: 110000, sales: 412, share: 59.3 },
      { key: 'sim-ecom', name: 'E-commerce', type: 'SITE_PROPRIO', sales: 188, revenue: 52000, share: 28.0 },
      { key: 'sim-ifood', name: 'iFood', type: 'IFOOD', sales: 97, revenue: 23420, share: 12.7 },
    ];
    j.origins.totalRevenue = 185420; j.origins.totalSales = 697; j.origins.moduleEnabled = true;
    j.kpis.revenue.current = 185420;
    await route.fulfill({ response: res, json: j });
  });
  await p.route(/dashboard\/management\/timeseries/, async (route) => {
    const res = await route.fetch(); const j = await res.json();
    j.channels = [{ key: 'LOJA_FISICA', name: 'Loja física', type: 'LOJA_FISICA' }, { key: 'sim-ecom', name: 'E-commerce', type: 'SITE_PROPRIO' }, { key: 'sim-ifood', name: 'iFood', type: 'IFOOD' }];
    j.points = j.points.map((pt, i) => ({ ...pt, byChannel: { LOJA_FISICA: { sales: 3 + (i % 4), revenue: 3200 + (i % 5) * 400 }, 'sim-ecom': { sales: 1 + (i % 3), revenue: 1500 + (i % 4) * 300 }, 'sim-ifood': { sales: i % 2, revenue: (i % 2) * 700 } } }));
    await route.fulfill({ response: res, json: j });
  });
  await p.reload({ waitUntil: 'domcontentloaded' }); await ready(p);
  const origin = card(p, 'Origem das vendas');
  await shot(p, nm('origem-multicanal-simulada'), 'Origem com 3 canais ativos (E-commerce e iFood são RESPOSTA SIMULADA no navegador para mostrar o estado multicanal; a demonstração não tem canal externo): donut + tabela com valor, vendas e participação, e evolução por origem', { element: origin });
  const tipO = await hoverPoint(p, origin, 10);
  note(`tooltip da evolução por origem (simulada) → "${tipO}"`);
  await shot(p, nm('origem-tooltip-simulada'), `Tooltip por origem (simulada): ${tipO}`, { element: origin });
  await p.unroute(/dashboard\/management\/summary/); await p.unroute(/dashboard\/management\/timeseries/);
  await c.close(); await sleep(1500);

  // ---------- 390 px ----------
  c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  p = await c.newPage(); watch(p, 'gerencial-390');
  await adminLogin(p, ADMIN, user('admin.alfa')); await toDashboard(p, 'Administrador'); await ready(p);
  await shot(p, nm('mobile-390-topo'), 'Painel a 390 px (janela): período, KPIs em 2 colunas');
  await shot(p, nm('mobile-390-pagina'), 'Painel a 390 px, página inteira', { fullPage: true });
  note(`rolagem horizontal a 390 px: ${await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)} px`);
  await p.getByRole('button', { name: /Últimos 30 dias/ }).first().click(); await sleep(300);
  await shot(p, nm('mobile-390-seletor'), 'Seletor de período a 390 px');
  await c.close(); await sleep(1500);

  // ---------- Gerente ----------
  c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  p = await c.newPage(); watch(p, 'gerencial-gerente');
  calls = track(p);
  await adminLogin(p, ADMIN, user('gerente.alfa.1')); await toDashboard(p, 'Gerente'); await ready(p);
  note(`gerente: seletor de filial presente = ${await p.locator('#dash-branch').count()} (esperado 0); chamadas com branchId = ${calls.filter((x) => /branchId/.test(x)).length}`);
  await shot(p, nm('gerente-painel-completo'), 'Painel do Gerente (filial dele; sem seletor de filial)', { fullPage: true });
  await c.close(); await sleep(1500);

  // ---------- canais (módulo desativado → ativado → teste de conexão) ----------
  c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  p = await c.newPage(); watch(p, 'gerencial-canais');
  await adminLogin(p, ADMIN, user('admin.alfa')); await toDashboard(p, 'Administrador');
  await p.goto(`${ADMIN}/dashboard/channels`, { waitUntil: 'domcontentloaded' }); await sleep(2500);
  await shot(p, nm('canais-modulo-desativado'), 'Canais de venda com o módulo CANAIS desativado (padrão): "Módulo desativado"');
  const enabled = await p.evaluate(async () => {
    const t = localStorage.getItem('token');
    const r = await fetch('http://localhost:3101/api/module-settings/CANAIS', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ isEnabled: true, reason: 'homologação visual' }) });
    return r.status;
  });
  note(`módulo CANAIS ligado para a empresa de demonstração (POST /module-settings/CANAIS → ${enabled}); será desligado e os canais de teste removidos ao final`);
  await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
  await p.getByLabel('Nome exibido').first().fill('Vendas WhatsApp');
  await p.getByLabel('Tipo').selectOption('OUTRO');
  await p.getByRole('button', { name: 'Criar canal' }).click(); await sleep(2000);
  await p.getByLabel('Tipo').selectOption('IFOOD');
  await p.getByLabel('Nome exibido').first().fill('Delivery');
  await p.getByRole('button', { name: 'Criar canal' }).click(); await sleep(2000);
  await shot(p, nm('canais-lista'), 'Canais criados (desativados, sem conexão): origem manual e canal com integração', { fullPage: true });
  const delivery = p.locator('div.rounded-lg').filter({ hasText: 'Delivery' }).first();
  await delivery.getByRole('button', { name: 'Cadastrar credencial' }).click(); await sleep(300);
  await delivery.getByPlaceholder('Valor').first().fill('id-de-teste-123456');
  await delivery.getByPlaceholder('Valor').nth(1).fill('segredo-de-teste-9876543210');
  await delivery.getByRole('button', { name: 'Salvar credencial' }).click(); await sleep(1500);
  await delivery.getByRole('button', { name: 'Testar conexão' }).click(); await sleep(1500);
  await shot(p, nm('canais-teste-sem-provedor'), 'Credencial salva (só a dica ••••3210 aparece) e teste de conexão SEM provedor instalado: não conecta e explica o motivo', { element: delivery });
  note(`o texto da tela não contém o segredo: ${!(await p.locator('body').innerText()).includes('segredo-de-teste-9876543210')}`);
  await c.close();
}

(async () => {
  if (!CHROME) throw new Error('Chrome não encontrado');
  if (!['admin', 'sa', 'pdv', 'errors', 'dashboard', 'dashboard-demo', 'dashboard-toggle', 'graficos', 'gerencial'].includes(phase)) throw new Error('HML_EV deve ser admin, sa, pdv, errors, dashboard, dashboard-demo, dashboard-toggle, graficos ou gerencial');
  const cred = readCredentials();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    if (phase === 'admin') await runAdmin(browser, cred);
    if (phase === 'errors') await runErrors(browser, cred);
    if (phase === 'dashboard') await runDashboard(browser, cred);
    // Empresa de demonstração do banco de DESENVOLVIMENTO ("CÓRTEX Demo", usuários @demo.local; vendas reais de jornadas em
    // vários dias): a API de desenvolvimento precisa estar na porta 3101. Credenciais lidas de apps/api/.demo (gitignorado).
    if (phase === 'graficos') await runGraficos(browser);
    if (phase === 'gerencial') await runGerencial(browser);
    if (phase === 'dashboard-toggle') {
      const demo = require('../../api/.demo/credentials.json');
      const mk = (k) => ({ email: demo.users[k].email, password: demo.password });
      await runDashboardToggle(browser, { users: { 'ceo.a': mk('admin.alfa'), 'gerente.a1': mk('gerente.alfa.1'), 'caixa.a1': mk('caixa.alfa.1'), 'viewer.a1': mk('viewer.alfa.1') } });
    }
    if (phase === 'dashboard-demo') {
      const demo = require('../../api/.demo/credentials.json');
      const mk = (k) => ({ email: demo.users[k].email, password: demo.password });
      await runDashboard(browser, { users: { 'ceo.a': mk('admin.alfa'), 'gerente.a1': mk('gerente.alfa.1') } }, 'dd');
    }
    if (phase === 'sa') await runSa(browser, cred);
    if (phase === 'pdv') await runPdv(browser, cred);
  } finally {
    await browser.close();
    console.log(`[ui-evidence:${phase}] ${notes.length} capturas; erros de página/5xx: ${errors.length}`);
    errors.slice(0, 10).forEach((e) => console.log('  ' + e));
    const notesFile = path.join(OUT, `notas-${phase}.json`);
    fs.writeFileSync(fs.existsSync(notesFile) ? path.join(OUT, `notas-${phase}__${RUN}.json`) : notesFile, JSON.stringify({ notes, errors }, null, 1));
  }
})().catch((e) => { console.error(e); process.exit(2); });
