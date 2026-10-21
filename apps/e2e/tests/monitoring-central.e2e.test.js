// Central de Monitoramento do Super Admin (Next.js :3000) no navegador real, contra a API de DESENVOLVIMENTO com a empresa demo.
// Cobre: renderização real da Central (KPIs, gráficos, backup em 3 níveis, definições), períodos/atualização, estados vazio/carregando/erro (por interceptação de rede),
// empresas (filtro, ordenação, detalhe), central de alertas (ciclo completo com histórico), funil (criar/mover/recusa sem motivo), serviços externos (pendentes sem credencial,
// ajuste de limites e reversão), permissões (empresa e anônimo recusados), isolamento por empresa, 390 px sem rolagem horizontal e acessibilidade básica.
// Tudo que o teste cria leva o prefixo "[e2e]" e é removido por id com escopo explícito. NÃO há envio real de e-mail nem de evento Sentry (nada está configurado).
// Evidências: docs/evidencias/2026-10-18-playwright/central-monitoramento/.
const fs = require('fs');
const path = require('path');
const { URLS, adminToken, superAdminSession, demoCredentials, requireServers } = require('../lib/env');
const { PREFIX, asPlatform, alfaCompanyId, launchBrowser, resetDevRateLimits, watch, disconnect } = require('../lib/fixtures');

jest.setTimeout(120000);

const EVIDENCE = path.resolve(__dirname, '../../../docs/evidencias/2026-10-18-playwright/central-monitoramento');
const sink = { pageErrors: [], serverErrors: [] };
// O índice único (empresa, filial, equipamento, tipo) só admite UM alerta aberto por tipo: cada teste usa o seu. O prefixo API_ERRORS dá a orientação de diagnóstico real e
// nenhum tipo real do avaliador (API_ERRORS sem sufixo) coincide, então o job de saúde nunca encerra nem altera estes alertas.
const ALERT_TYPE = 'API_ERRORS_E2E';
const ALERT_DETAIL = `${PREFIX} alerta de teste da Central`;
let browser, ctx, page, session;

// O console rola dentro do <main>, não na janela: para a captura mostrar a página inteira, a janela cresce até a altura do conteúdo e volta ao tamanho original.
async function shot(p, name) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const original = p.viewportSize();
  const height = await p.evaluate(() => {
    let max = document.documentElement.scrollHeight;
    document.querySelectorAll('main, div').forEach((e) => {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight) max = Math.max(max, e.scrollHeight + e.getBoundingClientRect().top);
    });
    return Math.ceil(max);
  });
  if (original && height > original.height) await p.setViewportSize({ width: original.width, height: Math.min(height + 40, 7000) });
  await p.waitForTimeout(400); // gráficos redimensionam
  await p.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
  if (original) await p.setViewportSize(original);
}

async function loginSession(context) {
  const p = await context.newPage();
  await p.goto(`${URLS.sa}/login`);
  await p.evaluate(([tok, u]) => { localStorage.setItem('accessToken', tok); localStorage.setItem('refreshToken', 'x'); localStorage.setItem('user', JSON.stringify(u)); }, [session.token, session.user]);
  return p;
}

const api = (url, token = session.token, init = {}) => fetch(`${URLS.api}/api${url}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

// Remove só o que o teste criou: oportunidades "[e2e]" (com os eventos) e alertas de teste (com os eventos), por id explícito. A auditoria (append-only) fica.
async function cleanup() {
  const leads = await asPlatform(null, async (tx) => {
    const rows = await tx.commercialLead.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    await tx.commercialLeadEvent.deleteMany({ where: { leadId: { in: ids } } });
    return (await tx.commercialLead.deleteMany({ where: { id: { in: ids }, name: { startsWith: PREFIX } } })).count;
  }, { purge: true });
  const alerts = await asPlatform(null, async (tx) => {
    const rows = await tx.monitoringAlert.findMany({ where: { type: { startsWith: ALERT_TYPE }, detail: { startsWith: PREFIX } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    await tx.monitoringAlertEvent.deleteMany({ where: { alertId: { in: ids } } });
    return (await tx.monitoringAlert.deleteMany({ where: { id: { in: ids }, type: { startsWith: ALERT_TYPE } } })).count;
  }, { purge: true });
  return { leads, alerts };
}

async function seedAlert(suffix = '') {
  const companyId = alfaCompanyId();
  return asPlatform(companyId, (tx) => tx.monitoringAlert.create({ data: { source: 'e2e', companyId, type: `${ALERT_TYPE}${suffix}`, metric: 'e2e', severity: 'ATTENTION', value: 7, threshold: 5, detail: ALERT_DETAIL } }));
}

// Registra a espera pela resposta ANTES da ação que a dispara (senão a resposta rápida passa antes de o teste começar a esperar).
const afterClick = (p, urlRe, action) => Promise.all([p.waitForResponse((r) => urlRe.test(r.url()), { timeout: 20000 }), action()]).then(([r]) => r);

// Heurística de acessibilidade básica: nome acessível em botões/campos, título presente, tabelas com cabeçalho.
async function a11y(p) {
  return p.evaluate(() => {
    const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.innerText || el.getAttribute('title') || '').trim();
    const hasLabel = (el) => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
      return Boolean(el.closest('label'));
    };
    const unnamedButtons = [...document.querySelectorAll('button')].filter((b) => !name(b)).length;
    const unlabeled = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((el) => !hasLabel(el)).map((el) => el.getAttribute('data-testid') || el.name || el.tagName);
    const noHeaders = [...document.querySelectorAll('table')].filter((t) => t.querySelectorAll('th').length === 0).length;
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    return { unnamedButtons, unlabeled, noHeaders, duplicateIds, headings: document.querySelectorAll('h1, h2, h3').length };
  });
}

const noHorizontalScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const goto = async (p, route) => {
  await p.goto(`${URLS.sa}${route}`, { waitUntil: 'networkidle' });
  expect(await p.getByText(/Application error|Unhandled Runtime Error/i).count()).toBe(0);
};

beforeAll(async () => {
  await requireServers(['api', 'sa']);
  await cleanup();
  session = superAdminSession();
  browser = await launchBrowser();
  ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  page = await loginSession(ctx);
  watch(page, 'sa', sink);
});

afterAll(async () => {
  try { console.log('limpeza:', JSON.stringify(await cleanup())); } finally {
    if (browser) await browser.close();
    await disconnect();
  }
});

describe('Central (visão executiva)', () => {
  test('renderiza KPIs, gráficos, backup em 3 níveis e definições; ambiente local aparece como não validado', async () => {
    await goto(page, '/dashboard/observability/central');
    await page.locator('[data-testid="central-page"]').waitFor({ timeout: 30000 });
    for (const id of ['kpi-availability', 'kpi-latency', 'kpi-errors', 'kpi-companies', 'kpi-integrations', 'kpi-alerts', 'infra-database', 'infra-redis', 'infra-queues', 'infra-host']) {
      expect(await page.locator(`[data-testid="${id}"]`).count()).toBe(1);
    }
    for (const id of ['chart-availability', 'chart-latency', 'chart-errors', 'chart-volume', 'chart-host', 'chart-companies-active', 'chart-companies-new', 'chart-alerts']) {
      const card = page.locator(`[data-testid="${id}"]`);
      expect(await card.count()).toBe(1);
      expect(await card.innerText()).toMatch(/Unidade:|medido|período/i); // título + unidade/período sempre explícitos
    }
    expect(await page.locator('[data-testid="env-local"]').count()).toBe(1); // desenvolvimento = local, não validado
    const backup = await page.locator('[data-testid="backup-panel"]').innerText();
    expect(backup).toMatch(/criado/i);
    expect(backup).toMatch(/verificad/i);
    expect(backup).toMatch(/restaura/i);
    expect(await page.locator('[data-testid="freshness"]').first().innerText()).toMatch(/Atualizado às/);
    // disponibilidade jamais é inventada: ou é um percentual medido ou "sem dados"
    expect(await page.locator('[data-testid="kpi-availability-value"]').innerText()).toMatch(/^(\d+([.,]\d+)?\s?%|—|Sem dados)/i);
    await shot(page, '01-central-desktop');
  });

  test('períodos: trocar o período refaz a consulta com o intervalo escolhido; atualizar agora refaz a leitura', async () => {
    await goto(page, '/dashboard/observability/central');
    const seen = [];
    page.on('request', (r) => { if (/monitoring\/central\/(overview|series)/.test(r.url())) seen.push(r.url()); });
    await afterClick(page, /central\/overview\?.*range=7d/, () => page.locator('[data-testid="range-7d"]').click());
    expect(await page.locator('[data-testid="range-7d"]').getAttribute('aria-pressed')).toBe('true');
    expect(seen.some((u) => u.includes('range=7d'))).toBe(true);
    const before = seen.length;
    await afterClick(page, /central\/overview/, () => page.getByRole('button', { name: 'Atualizar agora' }).first().click());
    expect(seen.length).toBeGreaterThan(before);
  });

  test('estados: carregando (resposta lenta), erro com nova tentativa e vazio sem empresas', async () => {
    const p = await loginSession(ctx);
    // carregando
    await p.route('**/monitoring/central/overview**', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
    await p.goto(`${URLS.sa}/dashboard/observability/central`);
    await p.getByText(/Carregando/i).first().waitFor({ timeout: 8000 });
    await shot(p, '02-central-carregando');
    await p.unroute('**/monitoring/central/overview**');
    await p.locator('[data-testid="central-page"]').waitFor({ timeout: 30000 });
    // erro: a API recusa; a tela mostra o aviso e oferece tentar de novo (e recupera quando a API volta)
    await p.route('**/monitoring/central/overview**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'indisponível', code: 'E2E_DOWN' }) }));
    await p.reload({ waitUntil: 'networkidle' });
    await p.getByRole('alert').first().waitFor({ timeout: 15000 });
    await shot(p, '03-central-erro');
    await p.unroute('**/monitoring/central/overview**');
    await p.getByRole('button', { name: /Tentar novamente/ }).first().click();
    await p.locator('[data-testid="central-page"]').waitFor({ timeout: 30000 });
    // vazio: lista de empresas sem itens
    await p.route('**/monitoring/central/companies?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: new Date().toISOString(), range: '24h', items: [], total: 0, page: 1, limit: 20, definitions: { integrationHealth: 'x' } }) }));
    await p.goto(`${URLS.sa}/dashboard/observability/empresas`, { waitUntil: 'networkidle' });
    await p.getByText('Nenhuma empresa com estes filtros.').waitFor({ timeout: 15000 });
    await shot(p, '04-empresas-vazio');
    await p.close();
  });
});

describe('Dado desatualizado', () => {
  test('quando a coleta de amostras está atrasada a Central avisa com o selo "desatualizado" (resposta real alterada só no campo de frescor)', async () => {
    const p = await loginSession(ctx);
    await p.route('**/monitoring/central/overview**', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.freshness = { ...body.freshness, stale: true, sampling: true };
      await route.fulfill({ response: res, json: body });
    });
    await p.goto(`${URLS.sa}/dashboard/observability/central`, { waitUntil: 'networkidle' });
    await p.locator('[data-testid="stale-badge"]').waitFor({ timeout: 20000 });
    expect(await p.locator('[data-testid="stale-badge"]').innerText()).toMatch(/atrasada|desatualizad/i);
    await shot(p, '03a-central-desatualizado');
    await p.close();
  });
});

describe('Empresas', () => {
  test('lista com busca, ordenação e detalhe; só aparecem empresas reais da plataforma', async () => {
    await resetDevRateLimits();
    await goto(page, '/dashboard/observability/empresas');
    await page.locator('[data-testid="companies-table"]').waitFor({ timeout: 30000 });
    const alfa = demoCredentials().companies.alfa.companyId;
    expect(await page.locator(`[data-testid="company-row-${alfa}"]`).count()).toBe(1);
    // integrações: percentual só com dado verificado; sem verificação diz "Sem dados" (nunca 100% inventado)
    const cell = await page.locator(`[data-testid="company-integrations-${alfa}"]`).innerText();
    expect(cell).toMatch(/Sem dados|\d+([.,]\d+)?\s?%/);
    // ordenação: clicar em "Requisições" alterna aria-sort
    await afterClick(page, /central\/companies\?.*sort=requests/, () => page.locator('[data-testid="sort-requests"]').click());
    expect(await page.locator('th[aria-sort="descending"], th[aria-sort="ascending"]').count()).toBe(1);
    // busca por nome
    const nameCell = await page.locator(`[data-testid="company-link-${alfa}"]`).innerText();
    await afterClick(page, /central\/companies\?.*q=/, () => page.locator('[data-testid="filter-q"]').fill(nameCell.slice(0, 5)));
    expect(await page.locator(`[data-testid="company-row-${alfa}"]`).count()).toBe(1);
    await page.locator('[data-testid="filter-q"]').fill('zzz-nao-existe-e2e');
    await page.getByText('Nenhuma empresa com estes filtros.').waitFor({ timeout: 15000 });
    await shot(page, '05-empresas-busca-vazia');
    await page.locator('[data-testid="filter-q"]').fill('');
    await page.locator(`[data-testid="company-link-${alfa}"]`).waitFor({ timeout: 15000 });
    await shot(page, '06-empresas-comparacao');
    await page.locator(`[data-testid="company-link-${alfa}"]`).click();
    await page.waitForURL(new RegExp(`/empresas/${alfa}$`), { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    expect(await page.getByText(/Application error/i).count()).toBe(0);
    await shot(page, '07-empresa-detalhe');
  });

  test('isolamento: o detalhe e os alertas de uma empresa nunca trazem dados de outra (API)', async () => {
    const creds = demoCredentials();
    const alfa = creds.companies.alfa.companyId;
    const other = Object.entries(creds.companies).find(([k]) => k !== 'alfa')?.[1]?.companyId;
    const detail = await (await api(`/monitoring/central/companies/${alfa}?range=24h`)).json();
    expect(JSON.stringify(detail)).not.toContain(other ?? '__sem_outra_empresa__');
    const list = await (await api(`/monitoring/central/alert-center?companyId=${alfa}&limit=100`)).json();
    expect((list.items ?? []).every((a) => a.companyId === alfa)).toBe(true);
  });
});

describe('Central de alertas', () => {
  test('ciclo: reconhecer → tratar → resolver (exige nota) → reabrir, com histórico imutável e orientação', async () => {
    await resetDevRateLimits();
    const alert = await seedAlert();
    await goto(page, '/dashboard/observability/alertas');
    await page.locator('[data-testid="filter-q"]').fill(PREFIX);
    await page.locator(`[data-testid="alert-open-${alert.id}"]`).waitFor({ timeout: 30000 });
    await shot(page, '08-alertas-lista');
    await page.locator(`[data-testid="alert-open-${alert.id}"]`).click();
    await page.locator('[data-testid="alert-dialog"]').waitFor({ timeout: 15000 });
    expect(await page.locator('[data-testid="alert-guidance"]').innerText()).toMatch(/Veja|Compare|erro/i); // orientação existe para o tipo API_*
    await shot(page, '09-alerta-detalhe');
    const dialog = page.locator('[data-testid="alert-dialog"]');
    await page.locator('[data-testid="action-ACKNOWLEDGE"]').click();
    await dialog.getByText('Reconhecido').first().waitFor({ timeout: 15000 });
    await page.locator('[data-testid="action-START"]').click();
    await dialog.getByText('Em tratamento').first().waitFor({ timeout: 15000 });
    // resolver sem nota: botão desabilitado; com nota: resolve
    expect(await page.locator('[data-testid="action-RESOLVE"]').isDisabled()).toBe(true);
    await page.locator('[data-testid="alert-note"]').fill('Causa tratada no teste E2E');
    await page.locator('[data-testid="action-RESOLVE"]').click();
    await dialog.getByText('Resolvido').first().waitFor({ timeout: 15000 });
    await page.locator('[data-testid="action-REOPEN"]').click();
    await dialog.getByText('Aberto').first().waitFor({ timeout: 15000 });
    const history = await page.locator('[data-testid="alert-history"]').innerText();
    for (const w of [/reconhec/i, /tratamento|iniciad/i, /resolv/i, /reabert|reaberto/i]) expect(history).toMatch(w);
    await shot(page, '10-alerta-historico');
    // a API confirma a trilha (4+ eventos, em ordem) e nenhum segredo/PII no corpo
    const body = await (await api(`/monitoring/central/alert-center/${alert.id}`)).json();
    expect(body.events.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(body)).not.toMatch(/password|secret|token/i);
  });

  test('ação inválida é recusada pelo servidor (reconhecer alerta resolvido) sem alterar o estado', async () => {
    const alert = await seedAlert('_2');
    await api(`/monitoring/central/alert-center/${alert.id}/actions`, session.token, { method: 'POST', body: JSON.stringify({ action: 'RESOLVE', note: 'resolvido no teste' }) });
    const res = await api(`/monitoring/central/alert-center/${alert.id}/actions`, session.token, { method: 'POST', body: JSON.stringify({ action: 'ACKNOWLEDGE' }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const now = await (await api(`/monitoring/central/alert-center/${alert.id}`)).json();
    expect(now.status).toBe('RESOLVED');
  });
});

describe('Funil comercial', () => {
  test('sem nenhum registro comercial o funil mostra vazio e NENHUM número inventado (sem NaN, Infinity ou conversão fictícia)', async () => {
    await resetDevRateLimits();
    const before = await (await api('/monitoring/central/funnel')).json();
    expect(before.totals.leads).toBe(0); // o teste limpa as próprias oportunidades; se houver oportunidade real, ele para aqui em vez de mascarar
    await goto(page, '/dashboard/observability/funil');
    await page.locator('[data-testid="funnel-page"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="leads-empty"]').waitFor({ timeout: 15000 });
    const text = await page.locator('[data-testid="funnel-page"]').innerText();
    expect(text).not.toMatch(/NaN|Infinity|undefined|null/);
    expect(before.conversions.every((c) => c.pct === null || c.pct === undefined || (c.from === 0 ? c.pct === null : true))).toBe(true);
    await shot(page, '11a-funil-vazio');
  });

  test('registrar oportunidades, mover etapas, exigir motivo para cancelar, e ver o funil e a evolução', async () => {
    await resetDevRateLimits();
    await goto(page, '/dashboard/observability/funil');
    await page.locator('[data-testid="funnel-page"]').waitFor({ timeout: 30000 });
    expect(await page.locator('[data-testid="funnel-chart"]').count()).toBe(1);
    const name = `${PREFIX} Oficina Teste Funil`;
    await page.locator('[data-testid="lead-name"]').fill(name);
    await page.locator('[data-testid="lead-submit"]').click();
    const row = page.locator('tr', { hasText: name });
    await row.waitFor({ timeout: 20000 });
    expect(await row.innerText()).toContain('Interessado');
    await row.locator('select').first().selectOption({ label: 'Demonstração' });
    await row.getByRole('button', { name: 'Mover', exact: true }).click();
    await page.locator('tr', { hasText: name }).getByText('Demonstração').first().waitFor({ timeout: 15000 });
    // cancelar exige motivo: o botão fica desabilitado até digitar
    const row2 = page.locator('tr', { hasText: name });
    await row2.locator('select').first().selectOption({ label: 'Cancelado' });
    expect(await row2.getByRole('button', { name: 'Mover', exact: true }).isDisabled()).toBe(true);
    await row2.getByLabel('Motivo').fill('Desistiu no teste E2E');
    await row2.getByRole('button', { name: 'Mover', exact: true }).click();
    await page.locator('tr', { hasText: name }).getByText('Cancelado').first().waitFor({ timeout: 15000 });
    await shot(page, '11-funil');
    // a API tem o registro e o funil conta; nome curto é recusado pelo servidor (validação de entrada)
    const leads = await (await api(`/monitoring/central/funnel/leads?q=${encodeURIComponent(name)}`)).json();
    expect(leads.items.length).toBe(1);
    const funnel = await (await api('/monitoring/central/funnel')).json();
    expect(funnel.totals.leads).toBeGreaterThanOrEqual(1);
    const bad = await api('/monitoring/central/funnel/leads', session.token, { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(bad.status).toBe(400);
  });
});

describe('Serviços externos e custos', () => {
  test('sem credenciais: Sentry/Resend pendentes, Figma dependência externa, nada é declarado conectado', async () => {
    await resetDevRateLimits();
    await goto(page, '/dashboard/observability/externos');
    await page.locator('[data-testid="external-page"]').waitFor({ timeout: 30000 });
    expect(await page.locator('[data-testid="sentry-state"]').innerText()).toMatch(/Pendente de configuração/);
    expect(await page.locator('[data-testid="resend-state"]').innerText()).toMatch(/Pendente de configuração/);
    expect(await page.locator('[data-testid="figma-state"]').innerText()).toMatch(/pendente/i);
    expect(await page.locator('[data-testid="resend-check"]').isDisabled()).toBe(true); // sem chave não há o que verificar
    expect(await page.locator('[data-testid="card-domain"]').innerText()).toMatch(/Pendente/);
    expect(await page.locator('[data-testid="external-notice"]').innerText()).toMatch(/não que a conexão foi testada/);
    await shot(page, '12-externos');
  });

  test('ajustes só restringem: desliga a telemetria do Sentry, salva (auditado), reverte e confere', async () => {
    const t = page.locator('[data-testid="toggle-sentry"]');
    expect(await t.isChecked()).toBe(true);
    await t.uncheck();
    await page.locator('[data-testid="settings-save"]').click();
    await page.locator('[data-testid="settings-msg"]').getByText(/salvos/i).waitFor({ timeout: 15000 });
    expect((await (await api('/monitoring/central/settings')).json()).toggles.sentry).toBe(false);
    await page.locator('[data-testid="toggle-sentry"]').check();
    await page.locator('[data-testid="settings-save"]').click();
    await page.locator('[data-testid="settings-msg"]').getByText(/salvos/i).waitFor({ timeout: 15000 });
    expect((await (await api('/monitoring/central/settings')).json()).toggles.sentry).toBe(true);
    // limite acima do teto do ambiente não tem efeito
    const ceiling = (await (await api('/monitoring/central/settings')).json()).envCeilings.emailMaxPerHour;
    const res = await api('/monitoring/central/settings', session.token, { method: 'PUT', body: JSON.stringify({ limits: { emailMaxPerHour: ceiling + 1000 } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).limits.emailMaxPerHour).toBe(ceiling);
    await api('/monitoring/central/settings', session.token, { method: 'PUT', body: JSON.stringify({ limits: { emailMaxPerHour: null } }) });
    // chave desconhecida e valor inválido são recusados
    expect((await api('/monitoring/central/settings', session.token, { method: 'PUT', body: JSON.stringify({ limits: { naoExiste: 1 } }) })).status).toBe(400);
    expect((await api('/monitoring/central/settings', session.token, { method: 'PUT', body: JSON.stringify({ limits: { emailMaxPerHour: -1 } }) })).status).toBe(400);
  });

  test('provedor indisponível: a tela mostra o erro e continua navegável (falha externa não derruba o console)', async () => {
    const p = await loginSession(ctx);
    await p.route('**/monitoring/central/external', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: 'provedor fora' }) }));
    await p.goto(`${URLS.sa}/dashboard/observability/externos`, { waitUntil: 'networkidle' });
    await p.getByRole('alert').first().waitFor({ timeout: 15000 });
    await shot(p, '13-externos-erro');
    expect(await p.locator('nav a', { hasText: 'Central' }).count()).toBeGreaterThan(0); // navegação segue viva
    await p.close();
  });
});

describe('Permissões', () => {
  test('usuário de EMPRESA e anônimo não acessam nenhuma rota da Central', async () => {
    await resetDevRateLimits();
    const company = adminToken('admin.alfa');
    const routes = ['/monitoring/central/overview', '/monitoring/central/series', '/monitoring/central/companies', '/monitoring/central/alert-center', '/monitoring/central/funnel', '/monitoring/central/funnel/leads', '/monitoring/central/external', '/monitoring/central/settings', '/monitoring/central/meta'];
    for (const r of routes) {
      const asCompany = await api(r, company);
      expect([401, 403]).toContain(asCompany.status);
      const anon = await fetch(`${URLS.api}/api${r}`);
      expect(anon.status).toBe(401);
    }
    for (const [method, r] of [['PUT', '/monitoring/central/settings'], ['POST', '/monitoring/central/funnel/leads'], ['POST', '/monitoring/central/external/resend/check']]) {
      expect([401, 403]).toContain((await api(r, company, { method, body: '{}' })).status);
    }
  });

  test('o console da plataforma sem sessão volta ao login', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const p = await c.newPage();
    await p.goto(`${URLS.sa}/dashboard/observability/central`, { waitUntil: 'networkidle' });
    await p.waitForURL(/\/login/, { timeout: 20000 });
    await c.close();
  });
});

describe('Responsividade e acessibilidade', () => {
  const ROUTES = ['/dashboard/observability/central', '/dashboard/observability/empresas', '/dashboard/observability/alertas', '/dashboard/observability/funil', '/dashboard/observability/externos'];

  test('390 px: nenhuma página rola na horizontal e o conteúdo principal aparece', async () => {
    await resetDevRateLimits();
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR' });
    const p = await loginSession(c);
    watch(p, 'sa-390', sink);
    for (const route of ROUTES) {
      await goto(p, route);
      await p.locator('[data-testid]').first().waitFor({ timeout: 30000 });
      await p.waitForTimeout(500);
      expect({ route, ok: await noHorizontalScroll(p) }).toEqual({ route, ok: true });
      await shot(p, `14-390-${route.split('/').pop()}`);
    }
    await c.close();
  });

  test('acessibilidade básica: botões e campos com nome, tabelas com cabeçalho, ids únicos, foco por teclado', async () => {
    await resetDevRateLimits();
    for (const route of ROUTES) {
      await goto(page, route);
      await page.locator('[data-testid]').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(800);
      const r = await a11y(page);
      expect({ route, unnamedButtons: r.unnamedButtons, unlabeled: r.unlabeled, noHeaders: r.noHeaders, duplicateIds: r.duplicateIds }).toEqual({ route, unnamedButtons: 0, unlabeled: [], noHeaders: 0, duplicateIds: [] });
      expect(r.headings).toBeGreaterThan(0);
    }
    // teclado: o seletor de período recebe foco e Enter o aciona
    await goto(page, '/dashboard/observability/central');
    await page.locator('[data-testid="range-1h"]').focus();
    await afterClick(page, /central\/overview\?.*range=1h/, () => page.keyboard.press('Enter'));
    expect(await page.locator('[data-testid="range-1h"]').getAttribute('aria-pressed')).toBe('true');
  });
});

test('nenhum erro de página nem resposta 5xx no fluxo real', () => {
  expect(sink.pageErrors).toEqual([]);
  expect(sink.serverErrors).toEqual([]);
});
