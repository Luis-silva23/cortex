// Limites pequenos só para este arquivo (lidos no carregamento do módulo): provam o bloqueio por falhas de assinatura sem carga.
process.env.COMMERCE_RATE_LIMIT_PER_MIN = '600';
process.env.COMMERCE_AUTH_FAILURES_PER_MIN = '8';

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { prisma, prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import integrationsRoutes from '../../src/routes/integrations.routes';
import salesChannelsRoutes from '../../src/routes/sales-channels.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import moduleSettingsService from '../../src/services/module-settings.service';
import saleService from '../../src/services/sale.service';
import stockService from '../../src/services/stock.service';
import { gatewayBreaker, providerRegistry, signWebhook } from '../../src/services/sales-channels/gateway';
import { ProviderError } from '../../src/services/integrations/contract';
import { sandboxControl, sandboxProvider } from '../../src/services/integrations/sandbox.provider';
import { processDue } from '../../src/services/integrations/outbox.service';
import { sweepDeferred } from '../../src/services/integrations/inbound.service';
import { pollChannels } from '../../src/services/integrations/poller';
import { resetCommerceLimits } from '../../src/services/commerce/rate-limit';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * INTEGRATION GATEWAY (Fase 3) — prova REAL (HTTP + Postgres + Redis + RLS) com o provedor SIMULADO. Nenhum serviço externo, nenhuma
 * credencial real. Entrada: webhook assinado (assinatura, janela de tempo, repetição, idempotência, fora de ordem, esquema fechado,
 * duplicado sem segunda venda). Saída: caixa de saída (atomicidade, envio, retentativa, 429, 4xx, credencial recusada, prazo,
 * disjuntor) sem nunca tocar o caminho do PDV.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}
const db = prismaUnsafeBypassRLS as any;
const find = (model: string, where: any, extra: any = {}) => bypass<any>(() => db[model].findFirst({ where, ...extra }));
const findMany = (model: string, where: any, extra: any = {}) => bypass<any[]>(() => db[model].findMany({ where, ...extra }));
const count = (model: string, where: any) => bypass<number>(() => db[model].count({ where }));

const TEST_IP = '::ffff:127.0.0.1';

describe('Integration Gateway — integração real (provedor simulado)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let seq = 0;

  const token = (fx: IntegrationFixture, userType: string) =>
    generateAccessToken({ userId: fx.userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: (userType === 'COMPANY_ADMIN' ? undefined : fx.branchId) as any, userType });
  const as = (fx: IntegrationFixture, userType: string) => ({ Authorization: `Bearer ${token(fx, userType)}` });
  const adminCtx = <T>(fx: IntegrationFixture, fn: () => Promise<T>) => runWithRLSContext({ companyId: fx.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
  const setModule = (fx: IntegrationFixture, isEnabled: boolean) =>
    adminCtx(fx, () => moduleSettingsService.setEnabled({ companyId: fx.companyId, module: 'CANAIS', isEnabled, actorId: fx.userId, reason: 'teste' } as any));

  type Ch = { id: string; secret: string; fx: IntegrationFixture };

  /** Canal MARKETPLACE com o provedor simulado: credencial, teste de conexão real, política do pedido e ativação. */
  async function mkChannel(fx: IntegrationFixture, name: string, config: Record<string, unknown> | null = { reservationTtlMinutes: 30 }): Promise<Ch> {
    const created = await request(app).post('/sales-channels').set(as(fx, 'COMPANY_ADMIN')).send({ type: 'MARKETPLACE', displayName: `${name} ${++seq}`, branchId: fx.branchId, provider: 'sandbox' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
    expect((await request(app).put(`/sales-channels/${id}/credentials`).set(as(fx, 'COMPANY_ADMIN')).send({ credentials: { apiKey: 'key-test-123', webhookSecret: secret } })).status).toBe(200);
    const test = await request(app).post(`/sales-channels/${id}/test-connection`).set(as(fx, 'COMPANY_ADMIN')).send({});
    expect(test.body.ok).toBe(true);
    const act = await request(app).patch(`/sales-channels/${id}`).set(as(fx, 'COMPANY_ADMIN')).send({ isActive: true, ...(config ? { config } : {}) });
    expect(act.status).toBe(200);
    return { id, secret, fx };
  }

  async function product(fx: IntegrationFixture, ch: Ch, price: number, stock: number) {
    const code = `GW-${Date.now().toString(36)}-${++seq}`;
    const p = await adminCtx(fx, async () => {
      const created = await prisma.product.create({ data: { companyId: fx.companyId, branchId: fx.branchId, sku: code, name: `Produto ${code}`, costPrice: 1, salePrice: price, isActive: true } as any });
      if (stock > 0) await prisma.stockMovement.create({ data: { companyId: fx.companyId, branchId: fx.branchId, productId: created.id, movementType: 'PURCHASE', quantity: stock, userId: fx.userId } });
      return created;
    });
    expect((await request(app).put(`/sales-channels/${ch.id}/products`).set(as(fx, 'COMPANY_ADMIN')).send({ skus: [code], published: true })).status).toBe(200);
    return { id: p.id as string, sku: code, price };
  }
  type P = Awaited<ReturnType<typeof product>>;
  const balanceOf = (fx: IntegrationFixture, productId: string) => adminCtx(fx, async () => (await stockService.getBalance(productId, fx.companyId, fx.branchId)).balance);

  // ---------- webhook ----------
  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
  function hook(ch: Pick<Ch, 'id' | 'secret'>, body: unknown, over: { tsOffsetSec?: number; secret?: string; headers?: Record<string, string>; omitSignature?: boolean; channelId?: string } = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000) + (over.tsOffsetSec ?? 0);
    let r: any = request(app).post(`/integrations/v1/webhooks/${over.channelId ?? ch.id}`).set('Content-Type', 'application/json');
    if (!over.omitSignature) r = r.set('x-sandbox-signature', signWebhook(over.secret ?? ch.secret, raw, ts));
    return r.set(over.headers ?? {}).send(raw);
  }
  const events = (...evs: unknown[]) => ({ events: evs });
  const orderEv = (eventId: string, ext: string, lines: Array<{ p: P; qty: number; price?: number }>, total?: number) => ({
    type: 'ORDER_CREATED',
    eventId,
    occurredAt: iso(),
    order: {
      externalOrderId: ext,
      items: lines.map((l) => ({ sku: l.p.sku, quantity: l.qty, unitPrice: l.price ?? l.p.price })),
      total: total ?? Math.round(lines.reduce((s, l) => s + l.p.price * l.qty * 100, 0)) / 100,
    },
  });
  const payEv = (eventId: string, ext: string, amount: number, status = 'CONFIRMED', ref = `R-${ext}`, occurredAt = iso()) => ({ type: 'PAYMENT', eventId, occurredAt, externalOrderId: ext, payment: { providerRef: ref, status, amount, method: 'PIX' } });
  const cancelEv = (eventId: string, ext: string) => ({ type: 'ORDER_CANCELLED', eventId, occurredAt: iso(), externalOrderId: ext, reason: 'cliente desistiu' });
  const orderRow = (ch: Ch, ext: string) => find('externalOrder', { channelId: ch.id, externalOrderId: ext });
  const outcomes = (res: any) => (res.body.results ?? []).map((r: any) => r.outcome);

  beforeAll(async () => {
    providerRegistry.register(sandboxProvider);
    [A, B] = await Promise.all([createFixture('gwA'), createFixture('gwB')]);
    await Promise.all([setModule(A, true), setModule(B, true)]);
    app = express();
    app.use('/integrations/v1', integrationsRoutes);
    app.use('/sales-channels', express.json(), salesChannelsRoutes);
    app.use(errorHandler);
  }, 90000);

  beforeEach(() => sandboxControl.reset());

  afterEach(async () => {
    await resetCommerceLimits({ ip: `wh:${TEST_IP}` });
    // nada devido sobra para o teste seguinte (a rotina é global: não pode consumir a falha programada de outro cenário)
    await bypass(() => db.channelOutbox.updateMany({ where: { companyId: { in: [A.companyId, B.companyId] }, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'CANCELLED' } }));
  });

  afterAll(async () => {
    providerRegistry.clear();
    const ids = [A.companyId, B.companyId];
    await bypass(() => db.idempotencyKey.deleteMany({ where: { companyId: { in: ids } } }));
    await bypass(() => db.channelEvent.deleteMany({ where: { companyId: { in: ids } } }));
    await bypass(() => db.channelInboundEvent.deleteMany({ where: { companyId: { in: ids } } }));
    await Promise.all([destroyFixture(A), destroyFixture(B)]);
  }, 60000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('escolha do provedor e conexão', () => {
    it('provedor desconhecido, ou para tipo que não usa provedor, é recusado; o canal só ativa depois do teste de conexão real', async () => {
      const bad = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'MARKETPLACE', displayName: 'Sem provedor', provider: 'ifood' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('PROVIDER_NOT_AVAILABLE');
      const site = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO', displayName: 'Site com provedor', provider: 'sandbox' });
      expect(site.status).toBe(400);
      expect(site.body.code).toBe('PROVIDER_NOT_APPLICABLE');
      const ok = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'MARKETPLACE', displayName: 'Provedor simulado', branchId: A.branchId, provider: 'sandbox' });
      expect(ok.status).toBe(201);
      const early = await request(app).patch(`/sales-channels/${ok.body.id}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: true });
      expect(early.status).toBe(409);
      // credencial recusada pelo provedor: o canal vai a ERROR e não ativa
      await request(app).put(`/sales-channels/${ok.body.id}/credentials`).set(as(A, 'COMPANY_ADMIN')).send({ credentials: { apiKey: 'invalid', webhookSecret: 'x'.repeat(20) } });
      const test = await request(app).post(`/sales-channels/${ok.body.id}/test-connection`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(test.body.ok).toBe(false);
      expect(test.body.channel.connectionStatus).toBe('ERROR');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('webhook — autenticação, assinatura e repetição', () => {
    let ch: Ch;
    let p: P;
    beforeAll(async () => {
      ch = await mkChannel(A, 'Webhook auth');
      p = await product(A, ch, 10, 20);
    });

    it('sem assinatura, com segredo errado, corpo adulterado, carimbo vencido ou formato inválido: o MESMO 401, e nada é gravado', async () => {
      const body = events(orderEv('au-1', 'AU-1', [{ p, qty: 1 }]));
      const before = await count('channelInboundEvent', { channelId: ch.id });
      const res = [
        await hook(ch, body, { omitSignature: true }),
        await hook(ch, body, { secret: 'whsec_errado' }),
        await hook(ch, body, { tsOffsetSec: -4000 }), // fora da janela de 300 s
        await hook(ch, body, { tsOffsetSec: 4000 }),
        await hook(ch, body, { headers: { 'x-sandbox-signature': 't=abc,v1=zz' } }),
        await hook(ch, body, { channelId: crypto.randomUUID() }), // canal que não existe
        await hook(ch, body, { channelId: 'nao-e-uuid' }),
      ];
      for (const r of res) {
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('UNAUTHORIZED');
      }
      expect(new Set(res.map((r) => r.body.error.message)).size).toBe(1); // não diz qual foi o motivo nem se o canal existe
      // corpo adulterado depois de assinado
      const raw = JSON.stringify(body);
      const ts = Math.floor(Date.now() / 1000);
      const tampered = await request(app).post(`/integrations/v1/webhooks/${ch.id}`).set('Content-Type', 'application/json').set('x-sandbox-signature', signWebhook(ch.secret, raw, ts)).send(raw.replace('AU-1', 'AU-9'));
      expect(tampered.status).toBe(401);
      expect(await count('channelInboundEvent', { channelId: ch.id })).toBe(before);
      expect(await count('externalOrder', { channelId: ch.id })).toBe(0);
    });

    it('o segredo é POR canal: o segredo do canal da outra empresa não vale', async () => {
      const chB = await mkChannel(B, 'Webhook auth B');
      const r = await hook(ch, events(orderEv('au-x', 'AU-X', [{ p, qty: 1 }])), { secret: chB.secret });
      expect(r.status).toBe(401);
    });

    it('falhas repetidas de assinatura bloqueiam o IP (429) e o bloqueio não depende do corpo', async () => {
      const body = events(orderEv('rl-1', 'RL-1', [{ p, qty: 1 }]));
      for (let i = 0; i < 8; i += 1) expect((await hook(ch, body, { secret: 'errado' })).status).toBe(401);
      const blocked = await hook(ch, body);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });

    it('assinatura válida mas corpo que não é JSON do provedor: 400 sem detalhe técnico', async () => {
      const r = await hook(ch, 'isto nao e json');
      expect([400]).toContain(r.status);
      expect(['INVALID_JSON', 'INVALID_REQUEST']).toContain(r.body.error.code);
      expect(JSON.stringify(r.body)).not.toMatch(/Unexpected|at \w+\.|node_modules/);
    });

    it('canal desativado: mesmo com assinatura válida o evento NÃO é processado (403) e nada é gravado', async () => {
      const off = await mkChannel(A, 'Webhook desativado');
      await request(app).patch(`/sales-channels/${off.id}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: false });
      const q = await product(A, off, 10, 5);
      const r = await hook(off, events(orderEv('off-1', 'OFF-1', [{ p: q, qty: 1 }])));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('CHANNEL_DISABLED');
      expect(await count('externalOrder', { channelId: off.id })).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('webhook — pedido, idempotência e anti-repetição', () => {
    let ch: Ch;
    let p: P;
    beforeAll(async () => {
      ch = await mkChannel(A, 'Webhook pedidos');
      p = await product(A, ch, 12.5, 50);
    });

    it('pedido válido: criado como RECEIVED (não é venda), origem WEBHOOK, preço oficial, correlação guardada; a mesma entrega repetida é DUPLICATE', async () => {
      const body = events(orderEv('o-1', 'W-1', [{ p, qty: 2 }]));
      const first = await hook(ch, body, { headers: { 'X-Request-Id': 'corr-gw-0001' } });
      expect(first.status).toBe(200);
      expect(first.headers['x-request-id']).toBe('corr-gw-0001');
      expect(first.body.results[0]).toMatchObject({ eventId: 'o-1', type: 'ORDER_CREATED', outcome: 'APPLIED', code: 'CREATED' });
      const order = await orderRow(ch, 'W-1');
      expect(order).toMatchObject({ status: 'RECEIVED', source: 'WEBHOOK', saleId: null, correlationId: 'corr-gw-0001' });
      expect(Number(order.totalAmount)).toBe(25);
      const inbox = await find('channelInboundEvent', { channelId: ch.id, externalEventId: 'o-1' });
      expect(inbox).toMatchObject({ outcome: 'APPLIED', correlationId: 'corr-gw-0001', operation: 'GW:ORDER_CREATED', orderRef: 'W-1' });
      const ev = await findMany('channelEvent', { channelId: ch.id, correlationId: 'corr-gw-0001' });
      expect(ev.length).toBeGreaterThan(0);

      const sales = await count('sale', { companyId: A.companyId });
      const again = await hook(ch, body);
      expect(again.status).toBe(200);
      expect(outcomes(again)).toEqual(['DUPLICATE']);
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: 'W-1' })).toBe(1);
      expect(await count('sale', { companyId: A.companyId })).toBe(sales); // pedido recebido nunca vira venda sozinho
    });

    it('a MESMA requisição reenviada byte a byte (assinatura e carimbo iguais) é idempotente; uma assinatura antiga não vale mais', async () => {
      const raw = JSON.stringify(events(orderEv('o-2', 'W-2', [{ p, qty: 1 }])));
      const ts = Math.floor(Date.now() / 1000);
      const sig = signWebhook(ch.secret, raw, ts);
      const send = () => request(app).post(`/integrations/v1/webhooks/${ch.id}`).set('Content-Type', 'application/json').set('x-sandbox-signature', sig).send(raw);
      expect(outcomes(await send())).toEqual(['APPLIED']);
      expect(outcomes(await send())).toEqual(['DUPLICATE']);
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: 'W-2' })).toBe(1);
      // captura antiga reenviada depois da janela
      const old = request(app).post(`/integrations/v1/webhooks/${ch.id}`).set('Content-Type', 'application/json').set('x-sandbox-signature', signWebhook(ch.secret, raw, ts - 3600)).send(raw);
      expect((await old).status).toBe(401);
    });

    it('mesmo pedido com NOVO eventId e o mesmo conteúdo: ORDER_EXISTS (não duplica); com conteúdo diferente: recusado por conflito', async () => {
      const r1 = await hook(ch, events(orderEv('o-3a', 'W-3', [{ p, qty: 1 }])));
      expect(r1.body.results[0].code).toBe('CREATED');
      const r2 = await hook(ch, events(orderEv('o-3b', 'W-3', [{ p, qty: 1 }])));
      expect(r2.body.results[0]).toMatchObject({ outcome: 'APPLIED', code: 'ORDER_EXISTS' });
      const r3 = await hook(ch, events(orderEv('o-3c', 'W-3', [{ p, qty: 3 }])));
      expect(r3.body.results[0]).toMatchObject({ outcome: 'REJECTED', code: 'ORDER_CONFLICT' });
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: 'W-3' })).toBe(1);
    });

    it('dado externo é NÃO confiável: preço diferente, total errado, SKU não publicado, campo desconhecido e companyId no corpo são recusados', async () => {
      const wrongPrice = await hook(ch, events(orderEv('v-1', 'V-1', [{ p, qty: 1, price: 1 }], 1)));
      expect(wrongPrice.body.results[0]).toMatchObject({ outcome: 'REJECTED', code: 'PRICE_MISMATCH' });
      const wrongTotal = await hook(ch, events(orderEv('v-2', 'V-2', [{ p, qty: 1 }], 999)));
      expect(wrongTotal.body.results[0]).toMatchObject({ outcome: 'REJECTED', code: 'TOTAL_MISMATCH' });
      const ghost = await hook(ch, events({ ...orderEv('v-3', 'V-3', [{ p, qty: 1 }]), order: { externalOrderId: 'V-3', items: [{ sku: 'NAO-PUBLICADO', quantity: 1, unitPrice: 1 }], total: 1 } }));
      expect(ghost.body.results[0]).toMatchObject({ outcome: 'REJECTED', code: 'PRODUCT_UNAVAILABLE' });
      const extra = await hook(ch, events({ ...orderEv('v-4', 'V-4', [{ p, qty: 1 }]), companyId: B.companyId }));
      expect(extra.body.results[0].outcome).toBe('INVALID');
      const extraOrder = orderEv('v-5', 'V-5', [{ p, qty: 1 }]);
      (extraOrder.order as any).branchId = 'outra-filial';
      expect((await hook(ch, events(extraOrder))).body.results[0].outcome).toBe('INVALID');
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: { in: ['V-1', 'V-2', 'V-3', 'V-4', 'V-5'] } })).toBe(0);
      const warn = await findMany('channelEvent', { channelId: ch.id, type: 'INBOUND_EVENT_REJECTED' });
      expect(warn.length).toBeGreaterThanOrEqual(3);
    });

    it('lote misto: o evento inválido não impede os válidos; cada um tem o seu resultado', async () => {
      const r = await hook(ch, events(orderEv('m-1', 'M-1', [{ p, qty: 1 }]), { type: 'ALGO_DESCONHECIDO', eventId: 'm-2' }, orderEv('m-3', 'M-3', [{ p, qty: 1 }])));
      expect(r.status).toBe(200);
      expect(outcomes(r)).toEqual(['APPLIED', 'INVALID', 'APPLIED']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('webhook — fora de ordem e pagamento', () => {
    let ch: Ch;
    let p: P;
    beforeAll(async () => {
      ch = await mkChannel(A, 'Webhook ordem');
      p = await product(A, ch, 20, 50);
    });

    it('pagamento chega ANTES do pedido: fica guardado (DEFERRED) e é aplicado quando o pedido chega', async () => {
      const early = await hook(ch, events(payEv('p-1', 'OO-1', 20, 'CONFIRMED', 'REF-OO-1')));
      expect(outcomes(early)).toEqual(['DEFERRED']);
      expect(await count('externalPayment', { channelId: ch.id })).toBe(0);
      expect((await find('channelInboundEvent', { channelId: ch.id, externalEventId: 'p-1', operation: 'GW:PAYMENT' })).outcome).toBe('DEFERRED');

      expect(outcomes(await hook(ch, events(orderEv('o-oo1', 'OO-1', [{ p, qty: 1 }]))))).toEqual(['APPLIED']);
      const order = await orderRow(ch, 'OO-1');
      expect(order.paymentStatus).toBe('CONFIRMED'); // o pagamento guardado foi aplicado
      expect((await find('channelInboundEvent', { channelId: ch.id, externalEventId: 'p-1', operation: 'GW:PAYMENT' })).outcome).toBe('APPLIED');
      expect(await count('externalPayment', { orderId: order.id })).toBe(1);
      expect(await count('sale', { companyId: A.companyId })).toBe(0); // pagamento confirmado não vira venda sozinho
    });

    it('cancelamento chega antes do pedido: aplicado quando o pedido chega (pedido nasce e fica CANCELLED)', async () => {
      expect(outcomes(await hook(ch, events(cancelEv('c-1', 'OO-2'))))).toEqual(['DEFERRED']);
      await hook(ch, events(orderEv('o-oo2', 'OO-2', [{ p, qty: 1 }])));
      expect((await orderRow(ch, 'OO-2')).status).toBe('CANCELLED');
    });

    it('vários eventos fora de ordem do mesmo pedido são aplicados na ordem em que ocorreram', async () => {
      const t = Date.now();
      // chegam: confirmação (mais nova), depois pendente (mais antiga) — e só então o pedido
      await hook(ch, events(payEv('q-2', 'OO-3', 20, 'CONFIRMED', 'REF-OO-3', new Date(t - 1000).toISOString())));
      await hook(ch, events(payEv('q-1', 'OO-3', 20, 'PENDING', 'REF-OO-3', new Date(t - 5000).toISOString())));
      await hook(ch, events(orderEv('o-oo3', 'OO-3', [{ p, qty: 1 }])));
      expect((await orderRow(ch, 'OO-3')).paymentStatus).toBe('CONFIRMED'); // PENDING (mais antigo) primeiro, CONFIRMED depois
    });

    it('evento de pagamento atrasado (mais antigo que o último aplicado) é descartado como STALE; regressão de estado é ignorada', async () => {
      await hook(ch, events(orderEv('o-oo4', 'OO-4', [{ p, qty: 1 }])));
      await hook(ch, events(payEv('s-1', 'OO-4', 20, 'CONFIRMED', 'REF-OO-4', iso())));
      const stale = await hook(ch, events(payEv('s-2', 'OO-4', 20, 'REFUNDED', 'REF-OO-4', iso(-3_600_000))));
      expect(stale.body.results[0].code).toBe('STALE');
      const regress = await hook(ch, events(payEv('s-3', 'OO-4', 20, 'PENDING', 'REF-OO-4', iso(1000))));
      expect(regress.body.results[0].code).toBe('IGNORED');
      expect((await orderRow(ch, 'OO-4')).paymentStatus).toBe('CONFIRMED');
    });

    it('evento guardado cujo pedido nunca chega vence em 24 h e deixa um alerta (a rotina é idempotente)', async () => {
      await hook(ch, events(payEv('orf-1', 'OO-ORFAO', 20, 'CONFIRMED', 'REF-ORF')));
      await bypass(() => db.channelInboundEvent.updateMany({ where: { companyId: A.companyId, externalEventId: 'orf-1' }, data: { receivedAt: new Date(Date.now() - 25 * 3_600_000) } }));
      const r = await sweepDeferred();
      expect(r.expired).toBeGreaterThanOrEqual(1);
      expect((await find('channelInboundEvent', { channelId: ch.id, externalEventId: 'orf-1', operation: 'GW:PAYMENT' })).outcome).toBe('FAILED');
      expect((await findMany('channelEvent', { channelId: ch.id, type: 'INBOUND_EVENT_ORPHAN' })).length).toBe(1);
      expect((await sweepDeferred()).expired).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('webhook duplicado NUNCA cria segunda venda, segunda cobrança nem segundo movimento de estoque', () => {
    it('aceite e conversão automáticos ligados: o pagamento confirmado converte UMA vez, mesmo reenviado e com outro eventId', async () => {
      const ch = await mkChannel(A, 'Webhook automático', { reservationTtlMinutes: 30, autoAcceptOrders: true, autoConvertOnPaymentConfirmed: true });
      const p = await product(A, ch, 30, 10);
      const cashMoves = await count('cashMovement', { cashRegisterId: A.cashRegisterId });

      expect(outcomes(await hook(ch, events(orderEv('d-o', 'DUP-1', [{ p, qty: 2 }]))))).toEqual(['APPLIED']);
      expect((await orderRow(ch, 'DUP-1')).status).toBe('ACCEPTED'); // aceite automático reservou o estoque
      const pay = payEv('d-p', 'DUP-1', 60, 'CONFIRMED', 'REF-DUP-1');
      const first = await hook(ch, events(pay));
      expect(first.body.results[0]).toMatchObject({ outcome: 'APPLIED' });
      const order = await orderRow(ch, 'DUP-1');
      expect(order.status).toBe('CONVERTED');
      const snapshot = async () => ({
        sales: await count('sale', { channelId: ch.id }),
        payments: await count('payment', { sale: { channelId: ch.id } }),
        extPayments: await count('externalPayment', { channelId: ch.id }),
        stock: await count('stockMovement', { productId: p.id, movementType: 'SALE' }),
      });
      const before = await snapshot();
      expect(before).toEqual({ sales: 1, payments: 1, extPayments: 1, stock: 1 });

      // 1) o mesmo webhook, byte a byte, várias vezes e em paralelo
      const same = await Promise.all([hook(ch, events(pay)), hook(ch, events(pay)), hook(ch, events(pay))]);
      for (const r of same) expect(outcomes(r)).toEqual(['DUPLICATE']);
      // 2) o provedor reenvia o MESMO pagamento com outro eventId (retentativa dele)
      const other = await hook(ch, events(payEv('d-p2', 'DUP-1', 60, 'CONFIRMED', 'REF-DUP-1')));
      expect(other.status).toBe(200);
      // 3) o pedido de novo
      expect(outcomes(await hook(ch, events(orderEv('d-o', 'DUP-1', [{ p, qty: 2 }]))))).toEqual(['DUPLICATE']);
      expect(outcomes(await hook(ch, events(orderEv('d-o2', 'DUP-1', [{ p, qty: 2 }]))))).toEqual(['APPLIED']); // ORDER_EXISTS
      expect(await snapshot()).toEqual(before);
      expect(await balanceOf(A, p.id)).toBe(8);
      expect(await count('cashMovement', { cashRegisterId: A.cashRegisterId })).toBe(cashMoves); // dinheiro de canal não passa pelo caixa
      const sale = await find('sale', { channelId: ch.id });
      expect(sale).toMatchObject({ status: 'PAID', userId: null, cashRegisterId: null });
    });

    it('entregas simultâneas do mesmo evento: uma só é aplicada', async () => {
      const ch = await mkChannel(A, 'Webhook corrida');
      const p = await product(A, ch, 10, 10);
      const body = events(orderEv('race-1', 'RACE-1', [{ p, qty: 1 }]));
      const res = await Promise.all([hook(ch, body), hook(ch, body), hook(ch, body), hook(ch, body)]);
      const all = res.flatMap(outcomes);
      expect(all.filter((o: string) => o === 'APPLIED')).toHaveLength(1);
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: 'RACE-1' })).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('consulta periódica (webhook que não chegou)', () => {
    it('os eventos da consulta passam pelo mesmo caminho: pedido criado, cursor avança e o repetido não duplica', async () => {
      const ch = await mkChannel(A, 'Consulta');
      const p = await product(A, ch, 15, 10);
      const ev = orderEv('poll-1', 'POLL-1', [{ p, qty: 1 }]) as any;
      sandboxControl.pollQueue.push(ev);
      const r = await pollChannels(50, new Date(), ch.id);
      expect(r.failures).toBe(0);
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: 'POLL-1' })).toBe(1);
      const channel = await find('salesChannel', { id: ch.id });
      expect(channel.inboundCursor).toBe('1');
      expect(channel.lastSyncAt).not.toBeNull();
      // o mesmo evento volta (pelo webhook, por exemplo): duplicado
      expect(outcomes(await hook(ch, events(ev)))).toEqual(['DUPLICATE']);
      sandboxControl.pollQueue.push(ev);
      await pollChannels(50, new Date(), ch.id);
      expect(await count('externalOrder', { channelId: ch.id, externalOrderId: 'POLL-1' })).toBe(1);
    });

    it('credencial recusada na consulta leva o canal a ERROR e para de consultar', async () => {
      const ch = await mkChannel(A, 'Consulta auth');
      const orig = sandboxProvider.pollEvents;
      sandboxProvider.pollEvents = async () => {
        throw new ProviderError('AUTH', 'recusado', 401);
      };
      try {
        await pollChannels(50, new Date(), ch.id);
      } finally {
        sandboxProvider.pollEvents = orig;
      }
      const row = await find('salesChannel', { id: ch.id });
      expect(row).toMatchObject({ connectionStatus: 'ERROR', isActive: false });
      expect((await findMany('channelEvent', { channelId: ch.id, type: 'PROVIDER_AUTH_FAILED' })).length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('caixa de saída — atomicidade e envio', () => {
    let ch: Ch;
    let p: P;
    beforeAll(async () => {
      ch = await mkChannel(A, 'Saída');
      p = await product(A, ch, 25, 40);
    });
    const outbox = (where: Record<string, unknown> = {}) => findMany('channelOutbox', { channelId: ch.id, ...where }, { orderBy: { createdAt: 'asc' } });

    async function placeAndAccept(ext: string, qty = 1) {
      await hook(ch, events(orderEv(`out-${ext}`, ext, [{ p, qty }])));
      const order = await orderRow(ch, ext);
      const acc = await request(app).post(`/sales-channels/${ch.id}/orders/${order.id}/accept`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(acc.status).toBe(200);
      return order;
    }

    it('aceitar o pedido grava o aviso na caixa (mesma transação); nada é enviado na hora; repetir o aceite não duplica', async () => {
      const order = await placeAndAccept('OB-1');
      const rows = await outbox({ type: 'ORDER_STATUS' });
      const mine = rows.filter((r) => r.payload.externalOrderId === 'OB-1');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ status: 'PENDING', attempts: 0, dedupeKey: `ORDER_STATUS:${order.id}:ACCEPTED` });
      expect(mine[0].payload).toEqual({ externalOrderId: 'OB-1', status: 'ACCEPTED' });
      expect(sandboxControl.attempts).toBe(0); // nenhuma chamada externa no caminho do aceite
      await request(app).post(`/sales-channels/${ch.id}/orders/${order.id}/accept`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect((await outbox({ type: 'ORDER_STATUS' })).filter((r) => r.payload.externalOrderId === 'OB-1')).toHaveLength(1);
    });

    it('a rotina envia ao provedor com a chave de idempotência da linha; reexecutar não reenvia', async () => {
      await placeAndAccept('OB-1b');
      const row = (await outbox({ type: 'ORDER_STATUS' })).find((r) => r.payload.externalOrderId === 'OB-1b')!;
      const r1 = await processDue();
      expect(r1.sent).toBeGreaterThanOrEqual(1);
      expect(sandboxControl.received.filter((x) => x.idempotencyKey === row.id)).toEqual([{ op: 'notifyOrderStatus', idempotencyKey: row.id, payload: { externalOrderId: 'OB-1b', status: 'ACCEPTED' } }]);
      expect(await find('channelOutbox', { id: row.id })).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
      const attempts = sandboxControl.attempts;
      await processDue();
      expect(sandboxControl.attempts).toBe(attempts);
      expect((await find('salesChannel', { id: ch.id })).lastSyncAt).not.toBeNull();
    });

    it('converter e mudar a entrega enfileiram CONVERTED e FULFILLMENT_STATUS; cancelar pelo canal NÃO devolve eco ao provedor', async () => {
      const order = await placeAndAccept('OB-2');
      await hook(ch, events(payEv('out-pay-2', 'OB-2', 25)));
      const conv = await request(app).post(`/sales-channels/${ch.id}/orders/${order.id}/convert`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(conv.status).toBe(201);
      expect((await request(app).patch(`/sales-channels/${ch.id}/orders/${order.id}/fulfillment`).set(as(A, 'COMPANY_ADMIN')).send({ status: 'READY' })).status).toBe(200);
      const keys = (await outbox()).map((r) => r.dedupeKey);
      expect(keys).toEqual(expect.arrayContaining([`ORDER_STATUS:${order.id}:ACCEPTED`, `ORDER_STATUS:${order.id}:CONVERTED`, `FULFILLMENT:${order.id}:READY`]));

      const o3 = await placeAndAccept('OB-3');
      await hook(ch, events(cancelEv('out-can-3', 'OB-3')));
      expect((await orderRow(ch, 'OB-3')).status).toBe('CANCELLED');
      expect((await outbox()).map((r) => r.dedupeKey)).not.toContain(`ORDER_STATUS:${o3.id}:CANCELLED`);
      // já cancelado pelo CÓRTEX (pessoa autorizada): o provedor é avisado
      const o4 = await placeAndAccept('OB-4');
      expect((await request(app).post(`/sales-channels/${ch.id}/orders/${o4.id}/cancel`).set(as(A, 'COMPANY_ADMIN')).send({ reason: 'sem condição' })).status).toBe(200);
      expect((await outbox()).map((r) => r.dedupeKey)).toContain(`ORDER_STATUS:${o4.id}:CANCELLED`);
    });

    it('o PDV e a conversão seguem funcionando com o provedor FORA do ar: nenhuma chamada externa no caminho da venda', async () => {
      sandboxControl.failures.push(...Array.from({ length: 20 }, () => new ProviderError('SERVER', 'fora do ar', 503)));
      const q = await product(A, ch, 10, 5);
      const sale = await runWithRLSContext({ companyId: A.companyId, userType: 'OPERATOR', branchId: A.branchId }, () =>
        saleService.createSale({ companyId: A.companyId, branchId: A.branchId, userId: A.userId, userType: 'OPERATOR', cashRegisterId: A.cashRegisterId, items: [{ productId: q.id, quantity: 1, unitPrice: 10 }] })
      );
      expect(sale?.id).toBeDefined();
      const order = await placeAndAccept('OB-5');
      await hook(ch, events(payEv('out-pay-5', 'OB-5', 25)));
      expect((await request(app).post(`/sales-channels/${ch.id}/orders/${order.id}/convert`).set(as(A, 'COMPANY_ADMIN')).send({})).status).toBe(201);
      expect(sandboxControl.attempts).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('caixa de saída — falhas, retentativa e proteção do provedor', () => {
    let ch: Ch;
    let p: P;
    beforeAll(async () => {
      ch = await mkChannel(A, 'Falhas', { reservationTtlMinutes: 30 });
      p = await product(A, ch, 10, 100);
    });
    beforeEach(() => gatewayBreaker.success(ch.id));

    async function enqueueOne(): Promise<string> {
      const ext = `F-${++seq}`;
      await hook(ch, events(orderEv(`f-${ext}`, ext, [{ p, qty: 1 }])));
      const order = await find('externalOrder', { channelId: ch.id, externalOrderId: ext });
      await request(app).post(`/sales-channels/${ch.id}/orders/${order.id}/accept`).set(as(A, 'COMPANY_ADMIN')).send({});
      return (await find('channelOutbox', { channelId: ch.id, dedupeKey: `ORDER_STATUS:${order.id}:ACCEPTED` })).id;
    }
    const row = (id: string) => find('channelOutbox', { id });
    const later = (ms: number) => new Date(Date.now() + ms);

    it('5xx: espera crescente e NOVA tentativa com a MESMA chave de idempotência; o provedor só registra uma vez', async () => {
      const id = await enqueueOne();
      sandboxControl.failures.push(new ProviderError('SERVER', 'indisponível', 503));
      await processDue();
      let r = await row(id);
      expect(r).toMatchObject({ status: 'PENDING', attempts: 1, lastErrorKind: 'SERVER' });
      expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // ~30 s de espera
      expect(sandboxControl.received.filter((x) => x.idempotencyKey === id)).toHaveLength(0);
      await processDue(); // ainda não venceu: não chama
      expect(sandboxControl.attempts).toBe(1);
      await processDue(later(60_000));
      r = await row(id);
      expect(r).toMatchObject({ status: 'SENT', attempts: 2 });
      expect(sandboxControl.received.filter((x) => x.idempotencyKey === id)).toHaveLength(1);
    });

    it('timeout: tratado como falha transitória (resultado incerto): repete com segurança', async () => {
      const id = await enqueueOne();
      sandboxControl.failures.push(new ProviderError('TIMEOUT', 'passou do prazo'));
      await processDue();
      expect(await row(id)).toMatchObject({ status: 'PENDING', lastErrorKind: 'TIMEOUT' });
      await processDue(later(120_000));
      expect((await row(id)).status).toBe('SENT');
    });

    it('429 respeita o Retry-After e NÃO conta para o disjuntor', async () => {
      const ids = [await enqueueOne(), await enqueueOne(), await enqueueOne(), await enqueueOne(), await enqueueOne(), await enqueueOne()];
      for (let i = 0; i < ids.length; i += 1) sandboxControl.failures.push(new ProviderError('RATE_LIMIT', 'devagar', 429, 120));
      await processDue(new Date(), 50);
      for (const id of ids) {
        const r = await row(id);
        expect(r).toMatchObject({ status: 'PENDING', lastErrorKind: 'RATE_LIMIT' });
        expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
      }
      expect(gatewayBreaker.isOpen(ch.id)).toBe(false); // 6 × 429 não abrem o disjuntor
    });

    it('4xx (erro do que foi enviado) NÃO é repetido: a linha vira DEAD com alerta; a pessoa autorizada pode reenviar', async () => {
      const id = await enqueueOne();
      sandboxControl.failures.push(new ProviderError('CLIENT', 'pedido inválido', 422));
      await processDue();
      expect(await row(id)).toMatchObject({ status: 'DEAD', attempts: 1, lastErrorKind: 'CLIENT' });
      expect((await findMany('channelEvent', { channelId: ch.id, type: 'OUTBOX_DEAD' })).some((e) => e.data?.outboxId === id)).toBe(true);
      // só administrador da empresa trata
      expect((await request(app).post(`/sales-channels/${ch.id}/outbox/${id}/retry`).set(as(A, 'MANAGER')).send({})).status).toBe(403);
      expect((await request(app).post(`/sales-channels/${ch.id}/outbox/${id}/retry`).set(as(B, 'COMPANY_ADMIN')).send({})).status).toBe(404);
      expect((await request(app).post(`/sales-channels/${ch.id}/outbox/${id}/retry`).set(as(A, 'COMPANY_ADMIN')).send({})).status).toBe(200);
      expect(await row(id)).toMatchObject({ status: 'PENDING', attempts: 0 });
      await processDue();
      expect((await row(id)).status).toBe('SENT');
    });

    it('credencial recusada (401/403): o canal vai a ERROR e desativa, a linha espera SEM gastar tentativa e nada mais é enviado', async () => {
      const authCh = await mkChannel(A, 'Falha de credencial');
      const q = await product(A, authCh, 10, 5);
      await hook(authCh, events(orderEv('auth-o', 'AUTH-1', [{ p: q, qty: 1 }])));
      const order = await find('externalOrder', { channelId: authCh.id, externalOrderId: 'AUTH-1' });
      await request(app).post(`/sales-channels/${authCh.id}/orders/${order.id}/accept`).set(as(A, 'COMPANY_ADMIN')).send({});
      const outboxRow = await find('channelOutbox', { channelId: authCh.id });
      sandboxControl.failures.push(new ProviderError('AUTH', 'token inválido', 401));
      await processDue();
      expect(await find('salesChannel', { id: authCh.id })).toMatchObject({ connectionStatus: 'ERROR', isActive: false });
      expect(await find('channelOutbox', { id: outboxRow.id })).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect((await findMany('channelEvent', { channelId: authCh.id, type: 'PROVIDER_AUTH_FAILED' })).length).toBe(1);
      const attempts = sandboxControl.attempts;
      await processDue(later(10 * 60_000));
      expect(sandboxControl.attempts).toBe(attempts); // canal em erro: pausado, o provedor não é chamado
      expect(JSON.stringify(await findMany('channelEvent', { channelId: authCh.id }))).not.toContain('token inválido');
    });

    it('depois de 8 falhas a linha vira DEAD (limite de tentativas); o prazo máximo na caixa também a encerra', async () => {
      const id = await enqueueOne();
      await bypass(() => db.channelOutbox.update({ where: { id }, data: { maxAttempts: 2 } }));
      sandboxControl.failures.push(new ProviderError('SERVER', 'a', 500), new ProviderError('SERVER', 'b', 500));
      await processDue();
      await processDue(later(10 * 60_000));
      expect(await row(id)).toMatchObject({ status: 'DEAD', attempts: 2 });
      expect((await find('channelOutbox', { id }))?.lastError).toBeTruthy();

      const old = await enqueueOne();
      await bypass(() => db.channelOutbox.update({ where: { id: old }, data: { deadlineAt: new Date(Date.now() - 1000) } }));
      const attempts = sandboxControl.attempts;
      await processDue();
      expect(await row(old)).toMatchObject({ status: 'DEAD', lastErrorKind: 'DEADLINE' });
      expect(sandboxControl.attempts).toBe(attempts);
    });

    it('disjuntor: depois de 5 falhas seguidas o canal é pausado (o provedor não é chamado) e a fila espera sem perder nada', async () => {
      const ids = [await enqueueOne(), await enqueueOne(), await enqueueOne(), await enqueueOne(), await enqueueOne(), await enqueueOne()];
      for (let i = 0; i < 5; i += 1) sandboxControl.failures.push(new ProviderError('SERVER', 'caiu', 502));
      await processDue(new Date(), 50);
      expect(gatewayBreaker.isOpen(ch.id)).toBe(true);
      const attempts = sandboxControl.attempts;
      expect(attempts).toBe(5);
      const rows = await Promise.all(ids.map(row));
      expect(rows.filter((r) => r.status === 'PENDING')).toHaveLength(6); // nenhuma perdida
      await processDue(later(45_000), 50);
      expect(sandboxControl.attempts).toBe(attempts); // disjuntor aberto: não chama
      gatewayBreaker.success(ch.id);
    });

    it('linha presa em PROCESSING (instância que caiu) é retomada depois do prazo da trava', async () => {
      const id = await enqueueOne();
      await bypass(() => db.channelOutbox.update({ where: { id }, data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - 10 * 60_000), attempts: 1 } }));
      await processDue();
      expect(await row(id)).toMatchObject({ status: 'SENT', attempts: 2 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('sincronização de estoque, preço e catálogo (o CÓRTEX é o mestre)', () => {
    it('o estoque enviado é o DISPONÍVEL (saldo − reservas, menos margem e cota); repetir no mesmo minuto não enfileira de novo', async () => {
      const ch = await mkChannel(A, 'Sync', { reservationTtlMinutes: 30, stockSafetyMargin: 1 });
      const p = await product(A, ch, 40, 10);
      await hook(ch, events(orderEv('sy-o', 'SY-1', [{ p, qty: 3 }])));
      const order = await find('externalOrder', { channelId: ch.id, externalOrderId: 'SY-1' });
      await request(app).post(`/sales-channels/${ch.id}/orders/${order.id}/accept`).set(as(A, 'COMPANY_ADMIN')).send({});

      const r = await request(app).post(`/sales-channels/${ch.id}/sync/inventory`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(r.status).toBe(202);
      expect(r.body.data).toMatchObject({ items: 1, batches: 1, enqueued: 1 });
      const again = await request(app).post(`/sales-channels/${ch.id}/sync/inventory`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(again.body.data.enqueued).toBe(0);

      await processDue();
      const sent = sandboxControl.received.find((x) => x.op === 'syncInventory')!;
      expect(sent.payload).toEqual([{ sku: p.sku, quantity: 6 }]); // 10 − 3 reservados − 1 de margem
      // preço e catálogo: sem custo e sem id interno
      await request(app).post(`/sales-channels/${ch.id}/sync/price`).set(as(A, 'COMPANY_ADMIN')).send({});
      await request(app).post(`/sales-channels/${ch.id}/sync/catalog`).set(as(A, 'COMPANY_ADMIN')).send({});
      await processDue();
      const price = sandboxControl.received.find((x) => x.op === 'syncPrices')!;
      const catalog = sandboxControl.received.find((x) => x.op === 'syncCatalog')!;
      expect(price.payload).toEqual([{ sku: p.sku, price: 40 }]);
      expect(Object.keys((catalog.payload as any[])[0]).sort()).toEqual(['brand', 'category', 'description', 'name', 'sku', 'unit']);
      expect(JSON.stringify(catalog.payload)).not.toMatch(/costPrice|"id"/);
      expect((await request(app).post(`/sales-channels/${ch.id}/sync/xpto`).set(as(A, 'COMPANY_ADMIN')).send({})).status).toBe(400);
      expect((await request(app).post(`/sales-channels/${ch.id}/sync/inventory`).set(as(A, 'OPERATOR')).send({})).status).toBe(403);
    });

    it('canal SEM provedor (site próprio) não gera caixa de saída nem aceita sincronização; o outro lado não enxerga a caixa', async () => {
      const site = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO', displayName: `Site ${++seq}`, branchId: A.branchId });
      expect(site.status).toBe(201);
      const r = await request(app).post(`/sales-channels/${site.body.id}/sync/inventory`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(r.status).toBe(409);
      expect(await count('channelOutbox', { channelId: site.body.id })).toBe(0);
      const ch = await mkChannel(A, 'Isolamento');
      expect((await request(app).get(`/sales-channels/${ch.id}/outbox`).set(as(B, 'COMPANY_ADMIN'))).status).toBe(404);
      const list = await request(app).get(`/sales-channels/${ch.id}/outbox`).set(as(A, 'COMPANY_ADMIN'));
      expect(list.status).toBe(200);
      expect(list.body).toHaveProperty('counts');
      expect((await request(app).get(`/sales-channels/${ch.id}/outbox`).set(as(A, 'VIEWER'))).status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('segredos e isolamento', () => {
    it('nenhum segredo (credencial, segredo do webhook, assinatura) aparece em eventos do canal, caixa de entrada ou caixa de saída', async () => {
      const secrets = new Set<string>();
      const ch = await mkChannel(A, 'Sem segredo');
      secrets.add(ch.secret);
      secrets.add('key-test-123');
      const p = await product(A, ch, 10, 5);
      const body = events(orderEv('sec-1', 'SEC-1', [{ p, qty: 1 }]), { type: 'PAYMENT', eventId: 'sec-bad', externalOrderId: 'SEC-1', payment: { providerRef: 'R', status: 'CONFIRMED', amount: 'x' } });
      const raw = JSON.stringify(body);
      const sig = signWebhook(ch.secret, raw, Math.floor(Date.now() / 1000));
      await request(app).post(`/integrations/v1/webhooks/${ch.id}`).set('Content-Type', 'application/json').set('x-sandbox-signature', sig).send(raw);
      const dump = JSON.stringify([
        await findMany('channelEvent', { companyId: A.companyId }),
        await findMany('channelInboundEvent', { companyId: A.companyId }),
        await findMany('channelOutbox', { companyId: A.companyId }),
      ]);
      for (const s of secrets) expect(dump).not.toContain(s);
      expect(dump).not.toContain(sig);
    });

    it('a empresa B não enxerga a caixa de entrada nem a de saída da empresa A (RLS)', async () => {
      expect(await count('channelInboundEvent', { companyId: A.companyId })).toBeGreaterThan(0);
      expect(await count('channelOutbox', { companyId: A.companyId })).toBeGreaterThan(0);
      const ctxB = { companyId: B.companyId, userType: 'COMPANY_ADMIN', branchId: null } as const;
      expect(await runWithRLSContext(ctxB, () => prisma.channelInboundEvent.count())).toBe(0);
      expect(await runWithRLSContext(ctxB, () => (prisma as any).channelOutbox.count())).toBe(0);
    });
  });
});
