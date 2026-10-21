// Fixtures dos testes de navegador: tudo que o teste cria leva o prefixo "[e2e]" e é removido por id/prefixo com
// escopo EXPLÍCITO (companyId) — nenhum deleteMany sem escopo. As tabelas de suporte são FORCE RLS: a limpeza roda numa
// transação com o contexto da plataforma e devolve a contagem REAL (0 silencioso foi um defeito já visto aqui).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { chromePath, databaseUrl, demoCredentials } = require('./env');

const PREFIX = '[e2e]';

let prisma;
function db() {
  if (!prisma) {
    process.env.DATABASE_URL = databaseUrl();
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  }
  return prisma;
}

const alfaCompanyId = () => demoCredentials().companies.alfa.companyId;

// Contexto ASSINADO (decisão 151): com `app_ctx.settings.enforced` o banco só aceita empresa/papel acompanhados da assinatura feita com o segredo do ambiente
// (RLS_CONTEXT_SECRET, de apps/api/.env, lido aqui sem imprimir). `set_config` cru deixou de valer: sem isto as limpezas e leituras seriam NEGADAS em silêncio.
function signedPlatformContext(companyId) {
  const db_ = db(); // define DATABASE_URL antes de carregar o pacote do banco
  void db_;
  if (!process.env.RLS_CONTEXT_SECRET) {
    const env = fs.readFileSync(path.join(require('./env').API_DIR, '.env'), 'utf8');
    const secret = (env.match(/^RLS_CONTEXT_SECRET=(.*)$/m) || [])[1]?.replace(/^"|"$/g, '').trim();
    if (secret) process.env.RLS_CONTEXT_SECRET = secret;
  }
  const { CONTEXT_SET_CONFIG_SQL, contextSqlParams } = require('@ln-system/database');
  return { sql: CONTEXT_SET_CONFIG_SQL, params: contextSqlParams({ companyId: companyId ?? null, userType: 'SUPER_ADMIN', branchId: null }) };
}

async function asPlatform(companyId, fn, { purge = false } = {}) {
  const ctx = signedPlatformContext(companyId);
  return db().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(ctx.sql, ...ctx.params);
    if (purge) await tx.$executeRawUnsafe("select set_config('app.audit_purge','on', true)");
    return fn(tx);
  });
}

async function cleanup() {
  const companyId = alfaCompanyId();
  const ids = (await asPlatform(companyId, (tx) => tx.supportTicket.findMany({ where: { companyId, subject: { startsWith: PREFIX } }, select: { id: true } }))).map((t) => t.id);
  let tickets = 0;
  if (ids.length) {
    tickets = await asPlatform(companyId, async (tx) => {
      await tx.supportTicketEvent.deleteMany({ where: { companyId, ticketId: { in: ids } } });
      await tx.supportTicketMessage.deleteMany({ where: { companyId, ticketId: { in: ids } } });
      await tx.supportTicketAttachment.deleteMany({ where: { companyId, ticketId: { in: ids } } });
      return (await tx.supportTicket.deleteMany({ where: { companyId, id: { in: ids } } })).count;
    }, { purge: true });
  }
  const kb = await asPlatform(null, async (tx) => {
    const arts = await tx.supportKbArticle.findMany({ where: { title: { startsWith: PREFIX } }, select: { id: true } });
    const cats = await tx.supportKbCategory.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const a = arts.length ? (await tx.supportKbArticle.deleteMany({ where: { id: { in: arts.map((x) => x.id) }, title: { startsWith: PREFIX } } })).count : 0;
    const c = cats.length ? (await tx.supportKbCategory.deleteMany({ where: { id: { in: cats.map((x) => x.id) }, name: { startsWith: PREFIX } } })).count : 0;
    return { articles: a, categories: c };
  });
  return { tickets, ...kb };
}

// Remove o que os testes do Balcão criaram: clientes "[e2e]" da empresa demo e, deles, veículos, orçamentos (versões/itens/eventos
// em cascata) e OS (itens/histórico em cascata). Tudo por id explícito com `companyId`; devolve as contagens REAIS.
// A trilha de auditoria (append-only) NÃO é apagada: ela registra o que o teste fez.
async function cleanupBalcao() {
  const companyId = alfaCompanyId();
  return asPlatform(companyId, async (tx) => {
    const customers = await tx.customer.findMany({ where: { companyId, name: { startsWith: PREFIX } }, select: { id: true } });
    const customerIds = customers.map((c) => c.id);
    if (customerIds.length === 0) return { customers: 0, motorcycles: 0, quotes: 0, serviceOrders: 0 };
    // Desde a revisão do banco (2026-10-15) itens e histórico da OS são RESTRICT/append-only: a limpeza de DADO SINTÉTICO (cliente "[e2e]" da empresa demo) apaga os filhos
    // por id explícito, com a sinalização de expurgo (`app.audit_purge`), e só então a OS. Nada de cliente real passa por aqui: o filtro é o prefixo + companyId.
    const orderIds = (await tx.serviceOrder.findMany({ where: { companyId, customerId: { in: customerIds } }, select: { id: true } })).map((o) => o.id);
    if (orderIds.length) {
      await tx.serviceOrderItem.deleteMany({ where: { serviceOrderId: { in: orderIds } } });
      await tx.serviceOrderStatusHistory.deleteMany({ where: { serviceOrderId: { in: orderIds } } });
    }
    const serviceOrders = (await tx.serviceOrder.deleteMany({ where: { companyId, id: { in: orderIds }, customerId: { in: customerIds } } })).count;
    const quoteIds = (await tx.quote.findMany({ where: { companyId, customerId: { in: customerIds } }, select: { id: true } })).map((q) => q.id);
    if (quoteIds.length) {
      const versionIds = (await tx.quoteVersion.findMany({ where: { quoteId: { in: quoteIds } }, select: { id: true } })).map((v) => v.id);
      await tx.discountEvent.deleteMany({ where: { companyId, quoteId: { in: quoteIds } } });
      await tx.quoteEvent.deleteMany({ where: { companyId, quoteId: { in: quoteIds } } });
      if (versionIds.length) await tx.quoteItem.deleteMany({ where: { quoteVersionId: { in: versionIds } } });
      await tx.quoteVersion.deleteMany({ where: { quoteId: { in: quoteIds } } });
    }
    const quotes = (await tx.quote.deleteMany({ where: { companyId, id: { in: quoteIds }, customerId: { in: customerIds } } })).count;
    const motorcycles = (await tx.motorcycle.deleteMany({ where: { companyId, customerId: { in: customerIds } } })).count;
    const removed = (await tx.customer.deleteMany({ where: { companyId, id: { in: customerIds }, name: { startsWith: PREFIX } } })).count;
    return { customers: removed, motorcycles, quotes, serviceOrders };
  }, { purge: true });
}

// Produtos de teste do catálogo (SKU "E2E-…") e seus códigos de barras: por id explícito, com companyId, só desta empresa demo.
// Nunca toca em produto com histórico (venda/estoque): os de teste são criados sem nenhum.
async function cleanupCatalog() {
  const companyId = alfaCompanyId();
  return asPlatform(companyId, async (tx) => {
    const products = await tx.product.findMany({ where: { companyId, sku: { startsWith: 'E2E-' } }, select: { id: true } });
    const ids = products.map((p) => p.id);
    if (ids.length === 0) return { products: 0, barcodes: 0 };
    const barcodes = (await tx.productBarcode.deleteMany({ where: { companyId, productId: { in: ids } } })).count;
    const removed = (await tx.product.deleteMany({ where: { companyId, id: { in: ids }, sku: { startsWith: 'E2E-' } } })).count;
    return { products: removed, barcodes };
  });
}

// Usuários criados pelo E2E de acesso (e-mail "e2e-acesso-…@demo.local"): remove as sessões e os usuários por id explícito com `companyId`; os vínculos de
// filial saem em cascata. A trilha de auditoria (append-only) NÃO é apagada. Devolve as contagens REAIS.
async function cleanupAccessUsers() {
  const companyId = alfaCompanyId();
  return asPlatform(companyId, async (tx) => {
    const users = await tx.user.findMany({ where: { companyId, email: { startsWith: 'e2e-acesso-' } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return { users: 0, sessions: 0 };
    const sessions = (await tx.refreshToken.deleteMany({ where: { companyId, userId: { in: ids } } })).count;
    const removed = (await tx.user.deleteMany({ where: { companyId, id: { in: ids }, email: { startsWith: 'e2e-acesso-' } } })).count;
    return { users: removed, sessions };
  });
}

const findTicketBySubject = (companyId, subject) =>
  asPlatform(companyId, (tx) => tx.supportTicket.findFirst({ where: { companyId, subject: { startsWith: subject } }, select: { id: true, source: true, module: true, context: true, status: true } }));

const demoWarranty = (companyId) =>
  asPlatform(companyId, async (tx) => ({
    warranty: await tx.serviceOrderWarranty.findFirst({ where: { companyId }, select: { id: true, serviceOrderId: true } }),
    receivable: await tx.accountsReceivable.findFirst({ where: { companyId }, select: { id: true } }),
    os: await tx.serviceOrder.findFirst({ where: { companyId }, select: { id: true } }),
  }));

// Todo arquivo de navegador começa de um balde de requisições limpo (ver resetDevRateLimits): sem isso, a ORDEM em que o jest roda os arquivos
// decide quem leva 429 — `catalog-and-help` falhava logo depois de `admin-web-flow` e passava sozinho.
async function launchBrowser() {
  await resetDevRateLimits();
  return chromium.launch({ executablePath: chromePath(), headless: true });
}

// Registra erro de página e resposta 5xx de cada página: o teste falha se houver qualquer um.
// Também conta as chamadas à API e guarda as RECUSAS que não são 5xx (429 = limite de requisições; 401/403 = sessão/permissão): sem isso, uma tela
// que perde dados por um 429 só aparece como "elemento não encontrado" depois do timeout, e a causa real some.
function watch(page, label, sink) {
  sink.apiCalls = sink.apiCalls || 0;
  sink.apiRefusals = sink.apiRefusals || [];
  page.on('pageerror', (e) => sink.pageErrors.push(`${label}: ${e.message}`));
  page.on('response', (r) => {
    const status = r.status();
    if (status >= 500) sink.serverErrors.push(`${label}: ${status} ${r.url()}`);
    if (/\/api\//.test(r.url())) {
      sink.apiCalls += 1;
      if (status === 401 || status === 403 || status === 429) sink.apiRefusals.push(`${label}: ${status} ${new URL(r.url()).pathname}`);
    }
  });
}

// Zera os contadores de tentativa de login/MFA do Redis de DESENVOLVIMENTO (só estas chaves: `ratelimit_mfa|auth|authorizer|general*`). Os testes
// que erram código de propósito gastam o limite do IP (5 falhas → bloqueio de 30 min) e, repetidos, travariam a próxima execução. O balde
// `general` (100 requisições por minuto POR USUÁRIO) é compartilhado por todos os arquivos que usam o mesmo usuário de demonstração: duas
// execuções seguidas de `support-contextual-buttons` (≈50 chamadas cada) estouram o balde e a API responde 429 por 60 s — a tela perde
// dados e o teste falha por timeout (causa da falha intermitente, reproduzida em 2026-10-14). O limitador do produto NÃO é alterado.
async function resetDevRateLimits() {
  if (process.env.NODE_ENV === 'production') throw new Error('recusado em produção');
  const Redis = require('ioredis');
  const env = fs.readFileSync(path.join(require('./env').API_DIR, '.env'), 'utf8');
  const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.replace(/^"|"$/g, '').trim();
  const redis = new Redis({ host: get('REDIS_HOST') || 'localhost', port: Number(get('REDIS_PORT') || 6379), password: get('REDIS_PASSWORD') || undefined, db: Number(get('REDIS_DB') || 0), lazyConnect: false });
  try {
    const keys = (await redis.keys('ratelimit_*')).filter((k) => /^ratelimit_(mfa|auth|authorizer|general)/.test(k));
    if (keys.length) await redis.del(...keys);
    return keys.length;
  } finally {
    await redis.quit();
  }
}

async function disconnect() {
  if (prisma) await prisma.$disconnect();
  prisma = undefined;
}

module.exports = { PREFIX, db, alfaCompanyId, asPlatform, cleanup, cleanupBalcao, cleanupCatalog, cleanupAccessUsers, resetDevRateLimits, findTicketBySubject, demoWarranty, launchBrowser, watch, disconnect };
