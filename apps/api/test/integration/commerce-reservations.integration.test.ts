// Limites do /commerce/v1 só para este arquivo (lidos no carregamento do módulo): folga para a suíte, sem carga.
process.env.COMMERCE_RATE_LIMIT_PER_MIN = '600';
process.env.COMMERCE_AUTH_FAILURES_PER_MIN = '60';

import express from 'express';
import request from 'supertest';
import { prisma, prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { hashPassword } from '@ln-system/shared/utils/password';
import commerceRoutes from '../../src/routes/commerce.routes';
import salesChannelsRoutes from '../../src/routes/sales-channels.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import moduleSettingsService from '../../src/services/module-settings.service';
import saleService from '../../src/services/sale.service';
import stockService from '../../src/services/stock.service';
import reservationService from '../../src/services/commerce/reservation.service';
import { signRequest } from '../../src/services/commerce/signature';
import { resetCommerceLimits } from '../../src/services/commerce/rate-limit';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * RESERVA DE ESTOQUE + CONVERSÃO PEDIDO → VENDA (Fase 2) — prova REAL (HTTP + Postgres + Redis + RLS), sem provedor real:
 * o aceite reserva (tudo ou nada, com prazo configurado), o balcão não vende o reservado, a conversão cria venda de canal sem
 * caixa físico e é idempotente, a reserva vencida deixa de contar na hora, e as saídas concorrentes nunca passam do estoque.
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
const PASSWORD = 'Autoriza-123!';
const POLICY = { reservationTtlMinutes: 30 };

describe('Fase 2 — reserva de estoque e conversão de pedido em venda (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let channelA: string;
  let channelB: string;
  let cred: { keyId: string; secret: string };
  let manager: any;
  let sku = 0;

  const token = (fx: IntegrationFixture, userType: string) =>
    generateAccessToken({ userId: fx.userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: (userType === 'COMPANY_ADMIN' ? undefined : fx.branchId) as any, userType });
  const as = (fx: IntegrationFixture, userType: string) => ({ Authorization: `Bearer ${token(fx, userType)}` });
  const adminCtx = <T>(fx: IntegrationFixture, fn: () => Promise<T>) => runWithRLSContext({ companyId: fx.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
  const setModule = (fx: IntegrationFixture, isEnabled: boolean) =>
    adminCtx(fx, () => moduleSettingsService.setEnabled({ companyId: fx.companyId, module: 'CANAIS', isEnabled, actorId: fx.userId, reason: 'teste' } as any));

  function call(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const headers = { 'X-Cortex-Key': cred.keyId, 'X-Cortex-Timestamp': String(ts), 'X-Cortex-Signature': signRequest(cred.secret, { timestampSec: ts, method, path, rawBody: raw }) };
    let r: any = (request(app) as any)[method.toLowerCase()](path).set(headers).set(extra);
    if (raw) r = r.set('Content-Type', 'application/json').send(raw);
    return r;
  }
  let keyCounter = 0;
  const idem = () => ({ 'Idempotency-Key': `res-${Date.now()}-${++keyCounter}` });

  const setPolicy = (config: Record<string, unknown> | null) =>
    request(app).patch(`/sales-channels/${channelA}`).set(as(A, 'COMPANY_ADMIN')).send({ config });

  /** Produto novo da filial A (cada cenário usa o seu: testes independentes), com saldo no livro, publicado no canal. */
  async function product(price: number, stock: number) {
    const code = `RS-${Date.now().toString(36)}-${++sku}`;
    const p = await adminCtx(A, async () => {
      const created = await prisma.product.create({ data: { companyId: A.companyId, branchId: A.branchId, sku: code, name: `Produto ${code}`, costPrice: 1, salePrice: price, isActive: true } as any });
      if (stock > 0) await prisma.stockMovement.create({ data: { companyId: A.companyId, branchId: A.branchId, productId: created.id, movementType: 'PURCHASE', quantity: stock, userId: A.userId } });
      return created;
    });
    const pub = await request(app).put(`/sales-channels/${channelA}/products`).set(as(A, 'COMPANY_ADMIN')).send({ skus: [code], published: true });
    expect(pub.status).toBe(200);
    return { id: p.id as string, sku: code, price };
  }
  const balanceOf = (productId: string) => adminCtx(A, async () => (await stockService.getBalance(productId, A.companyId, A.branchId)).balance);

  type Line = { p: { id: string; sku: string; price: number }; qty: number };
  const totalOf = (lines: Line[]) => Math.round(lines.reduce((s, l) => s + l.p.price * l.qty * 100, 0)) / 100;
  /** Cria o pedido pela Commerce API; devolve o id externo e o id interno (CÓRTEX). */
  async function place(externalId: string, lines: Line[]) {
    const r = await call('POST', '/commerce/v1/orders', { externalOrderId: externalId, items: lines.map((l) => ({ sku: l.p.sku, quantity: l.qty, unitPrice: l.p.price })), total: totalOf(lines) }, idem());
    expect(r.status).toBe(201);
    return { ext: externalId, id: r.body.data.cortexOrderId as string, total: totalOf(lines) };
  }
  const accept = (id: string) => request(app).post(`/sales-channels/${channelA}/orders/${id}/accept`).set(as(A, 'COMPANY_ADMIN')).send({});
  const convert = (id: string) => request(app).post(`/sales-channels/${channelA}/orders/${id}/convert`).set(as(A, 'COMPANY_ADMIN')).send({});
  const pay = (ext: string, amount: number, status: 'PENDING' | 'CONFIRMED' | 'REFUNDED' = 'CONFIRMED', ref = `P-${ext}`, eventId = `ev-${ext}-${status}`) =>
    call('POST', `/commerce/v1/orders/${ext}/payment-events`, { eventId, providerRef: ref, status, amount, method: 'PIX' });
  const pdv = (items: Array<{ productId: string; quantity: number; unitPrice: number }>) =>
    runWithRLSContext({ companyId: A.companyId, userType: 'OPERATOR', branchId: A.branchId }, () =>
      saleService.createSale({ companyId: A.companyId, branchId: A.branchId, userId: A.userId, userType: 'OPERATOR', cashRegisterId: A.cashRegisterId, items })
    );
  const reservations = (orderId: string) => findMany('stockReservation', { orderId }, { orderBy: { productId: 'asc' } });

  beforeAll(async () => {
    [A, B] = await Promise.all([createFixture('rsA'), createFixture('rsB')]);
    await Promise.all([setModule(A, true), setModule(B, true)]);
    app = express();
    app.use('/commerce/v1', commerceRoutes);
    app.use('/sales-channels', express.json(), salesChannelsRoutes);
    app.use(errorHandler);

    const mk = async (fx: IntegrationFixture, name: string) => {
      const c = await request(app).post('/sales-channels').set(as(fx, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO', displayName: name, branchId: fx.branchId });
      expect(c.status).toBe(201);
      expect((await request(app).patch(`/sales-channels/${c.body.id}`).set(as(fx, 'COMPANY_ADMIN')).send({ isActive: true })).status).toBe(200);
      return c.body.id as string;
    };
    channelA = await mk(A, 'Loja Reservas A');
    channelB = await mk(B, 'Loja Reservas B');
    const r = await request(app).post(`/sales-channels/${channelA}/api-credentials`).set(as(A, 'COMPANY_ADMIN')).send({ label: 'reservas', scopes: ['CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE'] });
    expect(r.status).toBe(201);
    cred = { keyId: r.body.credential.keyId, secret: r.body.secret };

    const hashed = await hashPassword(PASSWORD);
    manager = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Gerente Reservas', email: `mgr-res-${Date.now()}@test.local`, password: hashed, userType: 'MANAGER', isActive: true } })
    );
  }, 90000);

  afterEach(async () => {
    await resetCommerceLimits({ ip: TEST_IP });
    if (cred) await resetCommerceLimits({ keyId: cred.keyId });
  });

  afterAll(async () => {
    const ids = [A.companyId, B.companyId];
    await bypass(() => db.idempotencyKey.deleteMany({ where: { companyId: { in: ids } } }));
    await bypass(() => db.channelEvent.deleteMany({ where: { companyId: { in: ids } } }));
    await Promise.all([destroyFixture(A), destroyFixture(B)]);
  }, 60000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('aceite = reserva de estoque', () => {
    it('sem prazo configurado no canal o aceite é recusado (o prazo é decisão comercial) e nada é reservado', async () => {
      const p = await product(10, 5);
      const o = await place('RS-NOTTL', [{ p, qty: 1 }]);
      const r = await accept(o.id);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RESERVATION_TTL_NOT_CONFIGURED');
      expect(await reservations(o.id)).toHaveLength(0);
      expect((await find('externalOrder', { id: o.id })).status).toBe('RECEIVED');
    });

    it('com prazo configurado reserva todas as linhas; repetir o aceite não duplica a reserva', async () => {
      expect((await setPolicy(POLICY)).status).toBe(200);
      const p1 = await product(10, 5);
      const p2 = await product(20, 3);
      const o = await place('RS-ACC1', [{ p: p1, qty: 2 }, { p: p2, qty: 1 }]);
      const r = await accept(o.id);
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('ACCEPTED');
      expect(r.body.replayed).toBe(false);
      const rows = await reservations(o.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((x) => x.status === 'ACTIVE')).toBe(true);
      const again = await accept(o.id);
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(await reservations(o.id)).toHaveLength(2);
      // reservar NÃO mexe no livro: nenhum movimento de estoque, nenhuma venda
      expect(await balanceOf(p1.id)).toBe(5);
      expect(await count('sale', { companyId: A.companyId })).toBe(0);
    });

    it('sem estoque disponível para QUALQUER linha: nada é reservado (tudo ou nada) e o motivo fica registrado', async () => {
      const ok = await product(10, 5);
      const scarce = await product(30, 1);
      const o = await place('RS-AON', [{ p: ok, qty: 2 }, { p: scarce, qty: 2 }]);
      const r = await accept(o.id);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('INSUFFICIENT_STOCK');
      expect(await reservations(o.id)).toHaveLength(0);
      expect((await find('externalOrder', { id: o.id })).status).toBe('RECEIVED');
      const ev = await findMany('channelEvent', { channelId: channelA, type: 'ORDER_ACCEPT_FAILED' });
      expect(ev.some((e) => e.data?.orderId === o.id)).toBe(true);
    });

    it('o disponível é saldo − reservas: o balcão (PDV) não vende o que foi prometido ao canal, e vende o resto', async () => {
      const p = await product(10, 5);
      const o = await place('RS-PDV', [{ p, qty: 2 }]);
      expect((await accept(o.id)).status).toBe(200);
      await expect(pdv([{ productId: p.id, quantity: 4, unitPrice: 10 }])).rejects.toThrow(/Insufficient stock/);
      expect(await balanceOf(p.id)).toBe(5); // a venda recusada não gravou nada
      const ok = await pdv([{ productId: p.id, quantity: 3, unitPrice: 10 }]);
      expect(ok?.status).toBeDefined();
      expect(await balanceOf(p.id)).toBe(2);
      await expect(pdv([{ productId: p.id, quantity: 1, unitPrice: 10 }])).rejects.toThrow(/Insufficient stock/);
    });

    it('aceite e venda do balcão disputando a ÚLTIMA unidade: exatamente um vence, o saldo nunca fica negativo', async () => {
      const p = await product(10, 1);
      const o = await place('RS-LAST', [{ p, qty: 1 }]);
      const [acc, sale] = await Promise.allSettled([accept(o.id), pdv([{ productId: p.id, quantity: 1, unitPrice: 10 }])]);
      const accepted = acc.status === 'fulfilled' && acc.value.status === 200;
      const sold = sale.status === 'fulfilled';
      expect([accepted, sold].filter(Boolean)).toHaveLength(1);
      expect(await balanceOf(p.id)).toBe(sold ? 0 : 1);
      expect(await reservations(o.id)).toHaveLength(accepted ? 1 : 0);
    });

    it('dois aceites disputando a última unidade: só um reserva', async () => {
      const p = await product(10, 1);
      const o1 = await place('RS-L1', [{ p, qty: 1 }]);
      const o2 = await place('RS-L2', [{ p, qty: 1 }]);
      const res = await Promise.all([accept(o1.id), accept(o2.id)]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await findMany('stockReservation', { productId: p.id, status: 'ACTIVE' })).length).toBe(1);
    });

    it('vendas simultâneas com os mesmos produtos em ordem oposta não travam uma à outra (ordem fixa de trava) e respeitam o estoque', async () => {
      const a = await product(10, 10);
      const b = await product(20, 10);
      const jobs = [0, 1, 2, 3].map((i) =>
        pdv(i % 2 === 0 ? [{ productId: a.id, quantity: 1, unitPrice: 10 }, { productId: b.id, quantity: 1, unitPrice: 20 }] : [{ productId: b.id, quantity: 1, unitPrice: 20 }, { productId: a.id, quantity: 1, unitPrice: 10 }])
      );
      const out = await Promise.allSettled(jobs);
      expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await balanceOf(a.id)).toBe(6);
      expect(await balanceOf(b.id)).toBe(6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('conversão em venda (ConvertOrder)', () => {
    it('sem pagamento confirmado não vira venda e deixa o motivo registrado', async () => {
      const p = await product(10, 5);
      const o = await place('RS-NOPAY', [{ p, qty: 1 }]);
      await accept(o.id);
      const sales = await count('sale', { companyId: A.companyId });
      const r = await convert(o.id);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PAYMENT_NOT_CONFIRMED');
      expect(await count('sale', { companyId: A.companyId })).toBe(sales);
      expect((await find('externalOrder', { id: o.id })).status).toBe('ACCEPTED');
      const ev = await findMany('channelEvent', { channelId: channelA, type: 'ORDER_CONVERT_FAILED' });
      expect(ev.some((e) => e.data?.orderId === o.id)).toBe(true);
    });

    it('pagamento parcial (valor menor que o total) também não converte', async () => {
      const p = await product(10, 5);
      const o = await place('RS-PART', [{ p, qty: 2 }]);
      await accept(o.id);
      await pay(o.ext, 5);
      expect((await convert(o.id)).status).toBe(409);
    });

    it('pedido pago e reservado vira venda PAID de canal: sem caixa físico, sem operador presumido, pagamento externo, saída SALE, reserva consumida, entrega PENDING', async () => {
      const p1 = await product(10, 5);
      const p2 = await product(20, 3);
      const o = await place('RS-CONV', [{ p: p1, qty: 2 }, { p: p2, qty: 1 }]);
      await accept(o.id);
      await pay(o.ext, o.total);
      const cashBefore = await find('cashRegister', { id: A.cashRegisterId });
      const cashMoves = await count('cashMovement', { cashRegisterId: A.cashRegisterId });

      const r = await convert(o.id);
      expect(r.status).toBe(201);
      expect(r.body.replayed).toBe(false);
      expect(r.body.data.status).toBe('CONVERTED');
      const sale = await find('sale', { id: r.body.sale.id }, { include: { items: true, payments: true } });
      expect(sale).toMatchObject({ status: 'PAID', channelId: channelA, userId: null, cashRegisterId: null });
      expect(Number(sale.totalAmount)).toBe(o.total);
      expect(Number(sale.paidAmount)).toBe(o.total);
      expect(sale.items.map((i: any) => [i.productSku, Number(i.quantity), Number(i.unitPrice)]).sort()).toEqual([[p1.sku, 2, 10], [p2.sku, 1, 20]].sort());
      expect(sale.payments).toHaveLength(1);
      expect(sale.payments[0]).toMatchObject({ status: 'APPROVED', paymentMethod: 'PIX' });
      expect(sale.payments[0].transactionId).toBe(`ext:${channelA}:P-${o.ext}`);

      // estoque: uma saída SALE por item, ligada à venda
      const moves = await findMany('stockMovement', { referenceType: 'Sale', referenceId: sale.id });
      expect(moves.map((m) => [m.productId, m.movementType, Number(m.quantity)]).sort()).toEqual([[p1.id, 'SALE', -2], [p2.id, 'SALE', -1]].sort());
      expect(await balanceOf(p1.id)).toBe(3);
      expect(await balanceOf(p2.id)).toBe(2);
      expect((await reservations(o.id)).every((x) => x.status === 'CONSUMED')).toBe(true);

      // o caixa físico não muda: nem movimento, nem valor esperado
      expect(await count('cashMovement', { cashRegisterId: A.cashRegisterId })).toBe(cashMoves);
      const cashAfter = await find('cashRegister', { id: A.cashRegisterId });
      expect(Number(cashAfter.expectedAmount)).toBe(Number(cashBefore.expectedAmount));

      const order = await find('externalOrder', { id: o.id });
      expect(order).toMatchObject({ status: 'CONVERTED', saleId: sale.id });
      expect(await find('fulfillment', { orderId: o.id })).toMatchObject({ status: 'PENDING', saleId: sale.id });
    });

    it('converter de novo devolve a MESMA venda (idempotente) e nada é duplicado', async () => {
      const p = await product(10, 5);
      const o = await place('RS-IDEM', [{ p, qty: 1 }]);
      await accept(o.id);
      await pay(o.ext, o.total);
      const first = await convert(o.id);
      const sales = await count('sale', { companyId: A.companyId });
      const moves = await count('stockMovement', { productId: p.id });
      const second = await convert(o.id);
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.sale.id).toBe(first.body.sale.id);
      expect(await count('sale', { companyId: A.companyId })).toBe(sales);
      expect(await count('stockMovement', { productId: p.id })).toBe(moves);
    });

    it('conversões simultâneas do mesmo pedido: uma só venda, uma só baixa', async () => {
      const p = await product(10, 5);
      const o = await place('RS-CONC', [{ p, qty: 2 }]);
      await accept(o.id);
      await pay(o.ext, o.total);
      const res = await Promise.all([convert(o.id), convert(o.id), convert(o.id)]);
      expect(res.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(res.map((r) => r.body.sale.id)).size).toBe(1);
      expect(await count('stockMovement', { productId: p.id, movementType: 'SALE' })).toBe(1);
      expect(await balanceOf(p.id)).toBe(3);
    });

    it('evento de pagamento repetido (webhook duplicado) não cria segunda venda nem segunda baixa', async () => {
      expect((await setPolicy({ ...POLICY, autoConvertOnPaymentConfirmed: true })).status).toBe(200);
      try {
        const p = await product(10, 5);
        const o = await place('RS-DUP', [{ p, qty: 1 }]);
        await accept(o.id);
        const first = await pay(o.ext, o.total);
        expect([200, 201]).toContain(first.status);
        expect((await find('externalOrder', { id: o.id })).status).toBe('CONVERTED'); // conversão automática, ligada por política
        const sales = await count('sale', { companyId: A.companyId });
        const moves = await count('stockMovement', { productId: p.id });
        const dup = await pay(o.ext, o.total);
        expect(dup.body.data.outcome).toBe('DUPLICATE');
        expect(await count('sale', { companyId: A.companyId })).toBe(sales);
        expect(await count('stockMovement', { productId: p.id })).toBe(moves);
      } finally {
        await setPolicy(POLICY);
      }
    });

    it('conversão de pedido de outra empresa/canal: 404 (isolamento)', async () => {
      const p = await product(10, 5);
      const o = await place('RS-ISO', [{ p, qty: 1 }]);
      await accept(o.id);
      const r = await request(app).post(`/sales-channels/${channelB}/orders/${o.id}/convert`).set(as(B, 'COMPANY_ADMIN')).send({});
      expect(r.status).toBe(404);
      // (com o prazo do canal B configurado: sem ele a recusa seria RESERVATION_TTL_NOT_CONFIGURED, antes de procurar o pedido)
      await request(app).patch(`/sales-channels/${channelB}`).set(as(B, 'COMPANY_ADMIN')).send({ config: POLICY });
      const acc = await request(app).post(`/sales-channels/${channelB}/orders/${o.id}/accept`).set(as(B, 'COMPANY_ADMIN')).send({});
      expect(acc.status).toBe(404);
    });

    it('a venda de canal pode ser cancelada pelo fluxo normal (sem caixa físico): estoque volta e nenhum dinheiro do balcão é inventado', async () => {
      const p = await product(10, 5);
      const o = await place('RS-CANCELSALE', [{ p, qty: 2 }]);
      await accept(o.id);
      await pay(o.ext, o.total);
      const conv = await convert(o.id);
      expect(await balanceOf(p.id)).toBe(3);
      const cashMoves = await count('cashMovement', { cashRegisterId: A.cashRegisterId });
      await runWithRLSContext({ companyId: A.companyId, userType: 'OPERATOR', branchId: A.branchId }, () =>
        saleService.cancelSale({ id: conv.body.sale.id, companyId: A.companyId, requesterId: A.userId, reason: 'cliente desistiu da compra', authorizerNumericId: manager.numericId, authorizerPassword: PASSWORD })
      );
      expect((await find('sale', { id: conv.body.sale.id })).status).toBe('CANCELLED');
      expect(await balanceOf(p.id)).toBe(5);
      expect(await count('cashMovement', { cashRegisterId: A.cashRegisterId })).toBe(cashMoves);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('cancelamento, expiração e reserva perdida', () => {
    it('cancelar um pedido aceito libera a reserva e devolve o disponível', async () => {
      const p = await product(10, 2);
      const o = await place('RS-CANCEL', [{ p, qty: 2 }]);
      await accept(o.id);
      await expect(pdv([{ productId: p.id, quantity: 1, unitPrice: 10 }])).rejects.toThrow(/Insufficient stock/);
      const c = await call('POST', `/commerce/v1/orders/${o.ext}/cancel`, { reason: 'desistiu' }, idem());
      expect(c.status).toBe(200);
      expect((await reservations(o.id)).every((x) => x.status === 'RELEASED')).toBe(true);
      expect((await pdv([{ productId: p.id, quantity: 2, unitPrice: 10 }]))?.status).toBeDefined();
    });

    it('reserva vencida deixa de contar NA HORA (sem esperar a rotina); a rotina marca EXPIRED, expira o pedido e é idempotente', async () => {
      const p = await product(10, 2);
      const o = await place('RS-EXP', [{ p, qty: 2 }]);
      await accept(o.id);
      await bypass(() => db.stockReservation.updateMany({ where: { companyId: A.companyId, orderId: o.id }, data: { expiresAt: new Date(Date.now() - 60_000) } }));
      // ainda ACTIVE no banco, mas já não segura estoque
      expect((await reservations(o.id))[0].status).toBe('ACTIVE');
      expect((await pdv([{ productId: p.id, quantity: 2, unitPrice: 10 }]))?.status).toBeDefined();

      const swept = await reservationService.expireDue();
      expect(swept.failures).toBe(0);
      expect((await reservations(o.id)).every((x) => x.status === 'EXPIRED')).toBe(true);
      expect((await find('externalOrder', { id: o.id })).status).toBe('EXPIRED');
      const ev = await findMany('channelEvent', { channelId: channelA, type: 'RESERVATION_EXPIRED' });
      expect(ev.length).toBeGreaterThan(0);
      const again = await reservationService.expireDue();
      expect(again.failures).toBe(0);
      expect((await reservations(o.id)).every((x) => x.status === 'EXPIRED')).toBe(true);
    });

    it('pagamento confirmado depois que a reserva venceu: se ainda há estoque, converte reservando de novo', async () => {
      const p = await product(10, 3);
      const o = await place('RS-LATE', [{ p, qty: 2 }]);
      await accept(o.id);
      await bypass(() => db.stockReservation.updateMany({ where: { companyId: A.companyId, orderId: o.id }, data: { expiresAt: new Date(Date.now() - 60_000) } }));
      await reservationService.expireDue();
      await pay(o.ext, o.total);
      const r = await convert(o.id);
      expect(r.status).toBe(201);
      expect((await find('externalOrder', { id: o.id })).status).toBe('CONVERTED');
      expect(await balanceOf(p.id)).toBe(1);
    });

    it('pagamento confirmado depois que a reserva venceu e o estoque foi vendido: NÃO cria venda nem deixa saldo negativo; fica o alerta', async () => {
      const p = await product(10, 2);
      const o = await place('RS-LOST', [{ p, qty: 2 }]);
      await accept(o.id);
      await bypass(() => db.stockReservation.updateMany({ where: { companyId: A.companyId, orderId: o.id }, data: { expiresAt: new Date(Date.now() - 60_000) } }));
      await reservationService.expireDue();
      await pdv([{ productId: p.id, quantity: 2, unitPrice: 10 }]); // o balcão vendeu o que voltou a ficar disponível
      await pay(o.ext, o.total);
      const sales = await count('sale', { companyId: A.companyId });
      const r = await convert(o.id);
      expect(r.status).toBe(409);
      expect(['RESERVATION_LOST_NO_STOCK', 'INSUFFICIENT_PHYSICAL_STOCK']).toContain(r.body.code);
      expect(await count('sale', { companyId: A.companyId })).toBe(sales);
      expect(await balanceOf(p.id)).toBe(0);
      const warn = await findMany('channelEvent', { channelId: channelA, type: 'ORDER_CONVERT_FAILED' });
      expect(warn.some((e) => e.data?.orderId === o.id)).toBe(true);
    });

    it('baixa física (ajuste) NÃO é bloqueada pela reserva: a verdade física vence, a sobra sem lastro é sinalizada e a conversão não cria saldo negativo', async () => {
      const p = await product(10, 2);
      const o = await place('RS-PHYS', [{ p, qty: 2 }]);
      await accept(o.id);
      await adminCtx(A, () => stockService.adjustStock({ companyId: A.companyId, branchId: A.branchId, productId: p.id, newQuantity: 0, reason: 'contagem', userId: A.userId } as any));
      expect(await balanceOf(p.id)).toBe(0);
      const short = await reservationService.flagShortfalls(A.companyId, A.branchId);
      expect(short.some((s) => s.productId === p.id && s.reserved === 2 && s.balance === 0)).toBe(true);
      await pay(o.ext, o.total);
      const r = await convert(o.id);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('INSUFFICIENT_PHYSICAL_STOCK');
      expect(await balanceOf(p.id)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('entrega (fulfillment) mínima', () => {
    const patch = (orderId: string, body: Record<string, unknown>) => request(app).patch(`/sales-channels/${channelA}/orders/${orderId}/fulfillment`).set(as(A, 'COMPANY_ADMIN')).send(body);

    it('antes de virar venda não há entrega para acompanhar', async () => {
      const p = await product(10, 2);
      const o = await place('RS-F0', [{ p, qty: 1 }]);
      const r = await patch(o.id, { status: 'READY' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('INVALID_FULFILLMENT_TRANSITION');
    });

    it('transições seguras: exige tipo para enviar, não pula estados e estados finais não voltam', async () => {
      const p = await product(10, 2);
      const o = await place('RS-F1', [{ p, qty: 1 }]);
      await accept(o.id);
      await pay(o.ext, o.total);
      await convert(o.id);
      expect((await patch(o.id, { status: 'DELIVERED' })).status).toBe(409); // PENDING → DELIVERED: não pula
      expect((await patch(o.id, { status: 'READY' })).status).toBe(200);
      expect((await patch(o.id, { status: 'IN_TRANSIT' })).status).toBe(409); // sem tipo de entrega
      expect((await patch(o.id, { status: 'IN_TRANSIT', type: 'OWN_DELIVERY' })).status).toBe(200);
      expect((await patch(o.id, { status: 'PICKED_UP' })).status).toBe(409);
      expect((await patch(o.id, { status: 'DELIVERED' })).status).toBe(200);
      expect((await patch(o.id, { status: 'READY' })).status).toBe(409); // final
      expect((await patch(o.id, { status: 'DELIVERED' })).status).toBe(200); // repetir é inofensivo
      expect((await find('fulfillment', { orderId: o.id })).status).toBe('DELIVERED');
    });

    it('só o administrador da empresa muda a entrega; outra empresa recebe 404', async () => {
      const p = await product(10, 2);
      const o = await place('RS-F2', [{ p, qty: 1 }]);
      await accept(o.id);
      await pay(o.ext, o.total);
      await convert(o.id);
      for (const t of ['MANAGER', 'OPERATOR', 'VIEWER']) {
        const r = await request(app).patch(`/sales-channels/${channelA}/orders/${o.id}/fulfillment`).set(as(A, t)).send({ status: 'READY' });
        expect(r.status).toBe(403);
      }
      const other = await request(app).patch(`/sales-channels/${channelB}/orders/${o.id}/fulfillment`).set(as(B, 'COMPANY_ADMIN')).send({ status: 'READY' });
      expect(other.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('isolamento (RLS) das novas tabelas', () => {
    it('empresa B não enxerga reservas, entregas nem pedidos da empresa A; e A tem linhas', async () => {
      expect(await count('stockReservation', { companyId: A.companyId })).toBeGreaterThan(0);
      const ctxB = { companyId: B.companyId, userType: 'COMPANY_ADMIN', branchId: null } as const;
      expect(await runWithRLSContext(ctxB, () => prisma.stockReservation.count())).toBe(0);
      expect(await runWithRLSContext(ctxB, () => (prisma as any).fulfillment.count())).toBe(0);
      expect(await runWithRLSContext(ctxB, () => prisma.externalOrder.count())).toBe(0);
    });

    it('com o contexto de uma filial de outra empresa não há vazamento mesmo consultando pelo id', async () => {
      const any = await find('stockReservation', { companyId: A.companyId });
      const ctxB = { companyId: B.companyId, userType: 'OPERATOR', branchId: B.branchId } as const;
      expect(await runWithRLSContext(ctxB, () => prisma.stockReservation.findUnique({ where: { id: any.id } }))).toBeNull();
    });
  });
});
