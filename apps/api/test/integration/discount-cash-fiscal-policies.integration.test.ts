import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { hashPassword } from '@ln-system/shared/utils/password';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Regras do dono de 2026-09-27 (docs/CORTEX/policies/DESCONTO.md, CAIXA.md, FISCAL.md), Postgres/Redis reais:
 *  - desconto: 5% livre em produto/peça, 0% em serviço; acima, autorização de outra pessoa (gerente/admin) + motivo;
 *    todo desconto grava discount_events; desconto de OS por tipo, só antes do pagamento, com guarda de concorrência;
 *  - caixa: pendências bloqueiam o fechamento normal (409 com a lista); fechamento forçado com motivo e autorizador,
 *    sem esconder nada;
 *  - venda cancelada não recebe pagamento (409, venda intacta) e não gera documento fiscal; venda pendente também não.
 */
describe('Políticas: desconto, fechamento de caixa, venda cancelada e fiscal (integração real)', () => {
  let fx: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = `dcf-${Date.now()}`;
  const PASSWORD = 'IntegrationTest123!';
  let manager: { id: string; numericId: number };
  let operator2: { id: string; numericId: number };
  let operator3: { id: string; numericId: number };
  let operatorNumericId: number;
  let serviceOrderId: string;
  let saleSeq = 7000;

  const tok = (userId: string, userType: string, branchId: string | null) =>
    `Bearer ${generateAccessToken({ userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: branchId as any, userType })}`;
  const operator = () => tok(fx.userId, 'OPERATOR', fx.branchId);
  const managerTok = () => tok(manager.id, 'MANAGER', fx.branchId);
  // O limitador da segunda autorização (3 falhas / 5 min por usuário fora do modo de teste) conta cada recusa: cada
  // grupo de cenários usa o seu solicitante.
  const operator2Tok = () => tok(operator2.id, 'OPERATOR', fx.branchId);
  const admin = () => tok(manager.id, 'COMPANY_ADMIN', null);

  const saleBody = (itemDiscount: number, extra: Record<string, unknown> = {}) => ({
    branchId: fx.branchId,
    cashRegisterId: fx.cashRegisterId,
    notes: stamp,
    items: [{ productId: fx.productId, quantity: 10, unitPrice: 10, discountAmount: itemDiscount }],
    ...extra,
  });
  const salesCount = () => bypass<number>(() => db.sale.count({ where: { companyId: fx.companyId, notes: stamp } }));
  const eventsOf = (where: Record<string, unknown>) =>
    bypass<any[]>(() => db.discountEvent.findMany({ where: { companyId: fx.companyId, ...where }, orderBy: { createdAt: 'asc' } }));
  const newSale = (status: 'PAID' | 'PENDING' | 'CANCELLED' | 'RETURNED', total = 50) =>
    bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fx.companyId, branchId: fx.branchId, saleNumber: ++saleSeq, customerId: fx.customerId, userId: fx.userId,
          cashRegisterId: fx.cashRegisterId, status, subtotal: total, totalAmount: total, notes: `${stamp}-bypass`,
          ...(status === 'PAID' ? { paidAmount: total } : {}),
        },
      })
    );
  const setPolicy = (key: string, value: unknown, branchId: string | null = null) =>
    bypass(() => db.policySetting.create({ data: { companyId: fx.companyId, branchId, key, value: value as any, updatedBy: fx.userId } }));
  const clearPolicy = (key: string) => bypass(() => db.policySetting.deleteMany({ where: { companyId: fx.companyId, key } }));

  beforeAll(async () => {
    fx = await createFixture('dcf');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const hash = await hashPassword(PASSWORD);
    const mk = (userType: string, label: string) =>
      bypass<any>(() =>
        db.user.create({
          data: { companyId: fx.companyId, branchId: fx.branchId, name: `${label} ${stamp}`, email: `${label}-${stamp}@test.local`, password: hash, userType: userType as any, isActive: true },
        })
      );
    manager = await mk('MANAGER', 'gerente');
    operator2 = await mk('OPERATOR', 'operador2');
    operator3 = await mk('OPERATOR', 'operador3');
    operatorNumericId = (await bypass<any>(() => db.user.findUnique({ where: { id: fx.userId } }))).numericId;

    const os = await bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: fx.companyId, branchId: fx.branchId, osNumber: 9101, customerId: fx.customerId, motorcycleId: fx.motorcycleId,
          entryDate: new Date(), entryKilometer: 1000, status: 'PRONTO', laborTotal: 300, partsTotal: 100, finalTotal: 400,
          items: {
            create: [
              { itemType: 'SERVICE', description: 'Revisão', quantity: 1, unitPrice: 300, totalPrice: 300 },
              { itemType: 'PART', description: 'Filtro', quantity: 2, unitPrice: 50, totalPrice: 100 },
            ],
          },
        },
      })
    );
    serviceOrderId = os.id;
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (fx?.companyId) {
      const companyId = fx.companyId;
      await bypass(() => db.fiscalDocument.deleteMany({ where: { companyId } }));
      await bypass(() => db.serviceOrderItem.deleteMany({ where: { serviceOrder: { companyId } } }));
      await destroyFixture(fx);
    }
  }, 120000);

  // ---------------------------------------------------------------- desconto na venda
  describe('desconto na venda do PDV', () => {
    it('5% do subtotal de produtos: aceito sem autorização e registrado em discount_events', async () => {
      const res = await request(app).post('/api/sales').set('Authorization', operator()).send(saleBody(5));
      expect(res.status).toBe(201);
      const events = await eventsOf({ saleId: res.body.id });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ itemType: 'PRODUCT', requiredAuthorization: false, requestedBy: fx.userId, authorizedBy: null });
      expect(Number(events[0].discountPercent)).toBe(5);
      expect(Number(events[0].freeLimitPercent)).toBe(5);
      expect(Number(events[0].originalAmount)).toBe(100);
      expect(Number(events[0].finalAmount)).toBe(95);
    });

    it('10% sem autorizador: 409 DISCOUNT_AUTHORIZATION_REQUIRED com limite livre/percentual/tipo; nada gravado', async () => {
      const before = await salesCount();
      const res = await request(app).post('/api/sales').set('Authorization', operator()).send(saleBody(10));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DISCOUNT_AUTHORIZATION_REQUIRED');
      expect(res.body.details).toMatchObject({ freeLimitPercent: 5, requestedPercent: 10, itemType: 'PRODUCT' });
      expect(await salesCount()).toBe(before);
    });

    it('gerente pedindo 10% para si também precisa de OUTRA pessoa (409)', async () => {
      const res = await request(app).post('/api/sales').set('Authorization', managerTok()).send(saleBody(10));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DISCOUNT_AUTHORIZATION_REQUIRED');
    });

    it('autorizador = o próprio solicitante: recusado, nada gravado', async () => {
      const before = await salesCount();
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', operator())
        .send(saleBody(10, { discountReason: 'cliente antigo', discountAuthorizerNumericId: operatorNumericId, discountAuthorizerPassword: PASSWORD }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Quem solicita não pode autorizar/);
      expect(await salesCount()).toBe(before);
    });

    it('autorizador sem perfil (operador): recusado', async () => {
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', operator())
        .send(saleBody(10, { discountReason: 'cliente antigo', discountAuthorizerNumericId: operator2.numericId, discountAuthorizerPassword: PASSWORD }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/não tem perfil/);
    });

    it('com autorizador mas sem motivo: 400 DISCOUNT_REASON_REQUIRED', async () => {
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', operator())
        .send(saleBody(10, { discountAuthorizerNumericId: manager.numericId, discountAuthorizerPassword: PASSWORD }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DISCOUNT_REASON_REQUIRED');
    });

    it('gerente autoriza 10% (item 6 + geral 4) com motivo: 201 e eventos PRODUCT + ORDER com autorizador e motivo', async () => {
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', operator())
        .send(
          saleBody(6, { discountAmount: 4, discountReason: 'Cliente fiel há 10 anos', discountAuthorizerNumericId: manager.numericId, discountAuthorizerPassword: PASSWORD })
        );
      expect(res.status).toBe(201);
      expect(Number(res.body.totalAmount)).toBe(90);
      const events = await eventsOf({ saleId: res.body.id });
      expect(events.map((e) => e.itemType).sort()).toEqual(['ORDER', 'PRODUCT']);
      for (const e of events) {
        expect(e).toMatchObject({ requiredAuthorization: true, authorizedBy: manager.id, requestedBy: fx.userId, reason: 'Cliente fiel há 10 anos' });
      }
    });

    it('limite da filial (política) vale: com 12% na filial, 10% é livre', async () => {
      await setPolicy('discount.productFreePercent', 12, fx.branchId);
      try {
        const res = await request(app).post('/api/sales').set('Authorization', operator()).send(saleBody(10));
        expect(res.status).toBe(201);
        expect(Number((await eventsOf({ saleId: res.body.id }))[0].freeLimitPercent)).toBe(12);
      } finally {
        await clearPolicy('discount.productFreePercent');
      }
    });
  });

  // ---------------------------------------------------------------- desconto na OS
  describe('desconto na ordem de serviço', () => {
    const post = (body: object, auth = operator2Tok()) => request(app).post(`/api/service-orders/${serviceOrderId}/discount`).set('Authorization', auth).send(body);
    const osRow = () => bypass<any>(() => db.serviceOrder.findUnique({ where: { id: serviceOrderId } }));

    it('peças 5% (R$ 5 de R$ 100): livre; finalTotal recalculado; evento PART', async () => {
      const res = await post({ partsDiscount: 5, laborDiscount: 0 });
      expect(res.status).toBe(200);
      const os = await osRow();
      expect(Number(os.discountAmount)).toBe(5);
      expect(Number(os.finalTotal)).toBe(395);
      const events = await eventsOf({ serviceOrderId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ itemType: 'PART', requiredAuthorization: false });
    });

    it('qualquer desconto em mão de obra sem autorização: 409 com tipo SERVICE e limite 0; OS intacta', async () => {
      const res = await post({ partsDiscount: 5, laborDiscount: 10 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DISCOUNT_AUTHORIZATION_REQUIRED');
      expect(res.body.details).toMatchObject({ itemType: 'SERVICE', freeLimitPercent: 0 });
      expect(Number((await osRow()).finalTotal)).toBe(395);
    });

    it('desconto maior que o total do tipo: 400 DISCOUNT_EXCEEDS_TOTAL', async () => {
      const res = await post({ partsDiscount: 150, laborDiscount: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DISCOUNT_EXCEEDS_TOTAL');
    });

    it('mão de obra com gerente autorizando e motivo: aplicado; só o tipo alterado gera evento', async () => {
      const res = await post({ partsDiscount: 5, laborDiscount: 10, reason: 'Retorno de serviço', authorizerNumericId: manager.numericId, authorizerPassword: PASSWORD });
      expect(res.status).toBe(200);
      const os = await osRow();
      expect(Number(os.discountAmount)).toBe(15);
      expect(Number(os.finalTotal)).toBe(385);
      const events = await eventsOf({ serviceOrderId });
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ itemType: 'SERVICE', requiredAuthorization: true, authorizedBy: manager.id, reason: 'Retorno de serviço' });
      expect(Number(events[1].freeLimitPercent)).toBe(0);

      const split = await request(app).get(`/api/service-orders/${serviceOrderId}/discount`).set('Authorization', operator());
      expect(split.status).toBe(200);
      expect(split.body).toMatchObject({ partsDiscount: 5, laborDiscount: 10, discountAmount: 15, finalTotal: 385, editable: true });
    });

    it('descontos simultâneos na mesma OS: cada um que aplicou gerou exatamente um evento e o total da OS bate com o último', async () => {
      const before = (await eventsOf({ serviceOrderId })).length;
      const asOp3 = tok(operator3.id, 'OPERATOR', fx.branchId);
      // reduções de peças (não exigem autorização): 3 pedidos concorrentes lendo a mesma OS (o limitador da segunda
      // autorização conta recusas por usuário — mais de 3 recusas viraria 429)
      const results = await Promise.all([4, 3, 2].map((v) => post({ partsDiscount: v, laborDiscount: 10 }, asOp3)));
      const ok = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status !== 200);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of conflicts) expect({ status: r.status, body: r.body }).toMatchObject({ status: 409, body: { code: 'SERVICE_ORDER_CHANGED' } });
      const events = await eventsOf({ serviceOrderId });
      expect(events.length).toBe(before + ok.length);
      const os = await osRow();
      const lastPart = Number(events.filter((e) => e.itemType === 'PART').pop().discountAmount);
      expect(Number(os.discountAmount)).toBe(lastPart + 10);
      expect(Number(os.finalTotal)).toBe(400 - lastPart - 10);
    });

    it('consulta GET /discount-events: gerência vê (com nomes), operador não', async () => {
      const ok = await request(app).get(`/api/discount-events?serviceOrderId=${serviceOrderId}`).set('Authorization', managerTok());
      expect(ok.status).toBe(200);
      expect(ok.body.data.length).toBeGreaterThanOrEqual(3);
      expect(ok.body.data.some((e: any) => e.authorizedByName && e.authorizedByName.includes('gerente'))).toBe(true);
      expect((await request(app).get('/api/discount-events').set('Authorization', operator())).status).toBe(403);
    });

    it('OS paga não recebe desconto: 409 SERVICE_ORDER_ALREADY_PAID, nada muda', async () => {
      await bypass(() => db.serviceOrder.update({ where: { id: serviceOrderId }, data: { isPaid: true, paidAt: new Date() } }));
      const before = await osRow();
      const res = await post({ partsDiscount: 0, laborDiscount: 0 }, managerTok());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SERVICE_ORDER_ALREADY_PAID');
      expect(Number((await osRow()).finalTotal)).toBe(Number(before.finalTotal));
    });
  });

  // ---------------------------------------------------------------- venda cancelada e fiscal
  describe('venda cancelada/pendente: pagamento e fiscal', () => {
    it('POST /payments em venda CANCELADA: 409, sem pagamento e venda continua cancelada', async () => {
      const sale = await newSale('CANCELLED', 30);
      const res = await request(app).post('/api/payments').set('Authorization', operator()).send({ saleId: sale.id, paymentMethod: 'CASH', amount: 30, receivedAmount: 30 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SALE_CLOSED_FOR_PAYMENT');
      const row = await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id }, include: { payments: true } }));
      expect(row.status).toBe('CANCELLED');
      expect(row.payments).toHaveLength(0);
    });

    it('POST /payments em venda DEVOLVIDA: 409, venda não é reaberta', async () => {
      const sale = await newSale('RETURNED', 30);
      const res = await request(app).post('/api/payments').set('Authorization', operator()).send({ saleId: sale.id, paymentMethod: 'CASH', amount: 30, receivedAmount: 30 });
      expect(res.status).toBe(409);
      expect((await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }))).status).toBe('RETURNED');
    });

    const emit = (saleId: string) => request(app).post('/api/fiscal/documents').set('Authorization', admin()).send({ saleId, branchId: fx.branchId });
    const docsOf = (saleId: string) => bypass<number>(() => db.fiscalDocument.count({ where: { companyId: fx.companyId, saleId } }));

    it('fiscal: venda cancelada → 409 FISCAL_SALE_CANCELLED, nenhum documento', async () => {
      const sale = await newSale('CANCELLED');
      const res = await emit(sale.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FISCAL_SALE_CANCELLED');
      expect(await docsOf(sale.id)).toBe(0);
    });

    it('fiscal: venda pendente (pagamento não confirmado) → 409 FISCAL_SALE_NOT_COMPLETED', async () => {
      const sale = await newSale('PENDING');
      const res = await emit(sale.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FISCAL_SALE_NOT_COMPLETED');
      expect(await docsOf(sale.id)).toBe(0);
    });

    it('fiscal: venda paga emite; com SALE fora de fiscal.enabledOperations → 409 FISCAL_OPERATION_DISABLED', async () => {
      const paid = await newSale('PAID');
      expect((await emit(paid.id)).status).toBe(201);
      expect(await docsOf(paid.id)).toBe(1);

      await setPolicy('fiscal.enabledOperations', []);
      try {
        const other = await newSale('PAID');
        const res = await emit(other.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FISCAL_OPERATION_DISABLED');
        expect(await docsOf(other.id)).toBe(0);
      } finally {
        await clearPolicy('fiscal.enabledOperations');
      }
    });
  });

  // ---------------------------------------------------------------- reforço repetido (achado do agente PDV)
  describe('reforço de caixa com a mesma Idempotency-Key', () => {
    const deposits = (notes: string) =>
      bypass<number>(() => db.cashMovement.count({ where: { cashRegisterId: fx.cashRegisterId, movementType: 'DEPOSIT', notes } }));
    const deposit = (key: string, notes: string) =>
      request(app)
        .post('/api/cash-register/movement')
        .set('Authorization', operator())
        .set('Idempotency-Key', key)
        .send({ cashRegisterId: fx.cashRegisterId, movementType: 'DEPOSIT', amount: 25, notes });

    it('Enter repetido (mesma chave, em sequência): um único reforço e um único incremento no esperado', async () => {
      const notes = `${stamp}-seq`;
      const before = Number((await bypass<any>(() => db.cashRegister.findUnique({ where: { id: fx.cashRegisterId } }))).expectedAmount);
      const first = await deposit(`dep-seq-${stamp}`, notes);
      const second = await deposit(`dep-seq-${stamp}`, notes);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(await deposits(notes)).toBe(1);
      const after = Number((await bypass<any>(() => db.cashRegister.findUnique({ where: { id: fx.cashRegisterId } }))).expectedAmount);
      expect(after).toBe(before + 25);
    });

    it('dois envios simultâneos com a mesma chave: um único reforço', async () => {
      const notes = `${stamp}-par`;
      await Promise.all([deposit(`dep-par-${stamp}`, notes), deposit(`dep-par-${stamp}`, notes)]);
      expect(await deposits(notes)).toBe(1);
    });
  });

  // ---------------------------------------------------------------- fechamento de caixa
  describe('fechamento de caixa com pendências', () => {
    const register = () => bypass<any>(() => db.cashRegister.findUnique({ where: { id: fx.cashRegisterId }, include: { movements: true } }));
    let pendingPaymentId: string;
    let openSaleId: string;

    beforeAll(async () => {
      const sale = await newSale('PENDING', 40);
      openSaleId = sale.id;
      const payment = await bypass<any>(() =>
        db.payment.create({ data: { companyId: fx.companyId, saleId: sale.id, paymentMethod: 'PIX', status: 'PENDING', amount: 40, transactionId: `pix-${stamp}` } })
      );
      pendingPaymentId = payment.id;
      // movimentos que NUNCA podem sumir: reforço e sangria
      await bypass(() =>
        db.cashMovement.createMany({
          data: [
            { cashRegisterId: fx.cashRegisterId, movementType: 'OPENING', amount: 100, userId: fx.userId },
            { cashRegisterId: fx.cashRegisterId, movementType: 'DEPOSIT', amount: 50, userId: fx.userId },
            { cashRegisterId: fx.cashRegisterId, movementType: 'WITHDRAWAL', amount: 20, userId: fx.userId, requestedBy: fx.userId, authorizedBy: manager.id },
          ],
        })
      );
    });

    it('pendências antes de fechar: GET /pendencies mostra e diz que o normal está bloqueado', async () => {
      const res = await request(app).get(`/api/cash-register/${fx.cashRegisterId}/pendencies`).set('Authorization', operator());
      expect(res.status).toBe(200);
      expect(res.body.normalCloseAllowed).toBe(false);
      expect(res.body.pendingPayments.map((p: any) => p.paymentId)).toContain(pendingPaymentId);
      expect(res.body.openSales.map((s: any) => s.saleId)).toContain(openSaleId);
    });

    it('fechamento normal com pendências: 409 CASH_CLOSE_PENDING com lista e valores; caixa segue aberto', async () => {
      const res = await request(app).post(`/api/cash-register/${fx.cashRegisterId}/close`).set('Authorization', operator()).send({ actualAmount: 130 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CASH_CLOSE_PENDING');
      expect(res.body.details.blockedBy).toEqual(['PENDING_PAYMENTS', 'OPEN_SALES']);
      expect(res.body.details.totals.pendingPaymentsAmount).toBeGreaterThanOrEqual(40);
      expect(res.body.details.openSales.length).toBeGreaterThanOrEqual(1);
      const reg = await register();
      expect(reg.status).toBe('OPEN');
      expect(reg.movements.filter((m: any) => m.movementType === 'CLOSING')).toHaveLength(0);
    });

    it('forçado pelo operador sem credenciais de autorizador: 403 FORCE_CLOSE_AUTHORIZATION_REQUIRED', async () => {
      const res = await request(app)
        .post(`/api/cash-register/${fx.cashRegisterId}/force-close`)
        .set('Authorization', operator())
        .send({ actualAmount: 130, reason: 'Cliente foi embora sem pagar o PIX' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORCE_CLOSE_AUTHORIZATION_REQUIRED');
    });

    it('forçado com motivo curto: 400', async () => {
      const res = await request(app)
        .post(`/api/cash-register/${fx.cashRegisterId}/force-close`)
        .set('Authorization', managerTok())
        .send({ actualAmount: 130, reason: 'curto' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FORCE_CLOSE_REASON_REQUIRED');
    });

    it('forçado com autorizador sem perfil (outro operador): recusado, caixa aberto', async () => {
      const res = await request(app)
        .post(`/api/cash-register/${fx.cashRegisterId}/force-close`)
        .set('Authorization', operator())
        .send({ actualAmount: 130, reason: 'Cliente foi embora sem pagar o PIX', authorizerNumericId: operator2.numericId, authorizerPassword: PASSWORD });
      expect(res.status).toBe(400);
      expect((await register()).status).toBe('OPEN');
    });

    it('forçado com gerente autorizando: FORCED, motivo, fotografia das pendências; nada apagado nem alterado', async () => {
      const before = await register();
      const res = await request(app)
        .post(`/api/cash-register/${fx.cashRegisterId}/force-close`)
        .set('Authorization', operator())
        .send({ actualAmount: 180, reason: 'Cliente foi embora sem pagar o PIX', authorizerNumericId: manager.numericId, authorizerPassword: PASSWORD });
      expect(res.status).toBe(200);
      const reg = await register();
      expect(reg).toMatchObject({ status: 'CLOSED', closeType: 'FORCED', forcedReason: 'Cliente foi embora sem pagar o PIX', closedBy: fx.userId });
      const snap = reg.pendingSnapshot;
      expect(snap.authorizedBy.id).toBe(manager.id);
      expect(snap.operator.id).toBe(fx.userId);
      expect(snap.branch.id).toBe(fx.branchId);
      expect(snap.pendingPayments.map((p: any) => p.paymentId)).toContain(pendingPaymentId);
      expect(snap.openSales.map((s: any) => s.saleId)).toContain(openSaleId);
      // 50 do beforeAll + 2 × 25 dos testes de reforço idempotente (um por chave)
      expect(snap.movements.DEPOSIT).toEqual({ count: 3, total: 100 });
      expect(snap.movements.WITHDRAWAL).toEqual({ count: 1, total: 20 });
      // expected = 100 + 100 - 20 = 180 → diferença 0
      expect(Number(reg.expectedAmount)).toBe(180);
      expect(Number(reg.difference)).toBe(0);
      // nenhum movimento some; um CLOSING com quem pediu e quem autorizou
      expect(reg.movements.length).toBe(before.movements.length + 1);
      const closing = reg.movements.find((m: any) => m.movementType === 'CLOSING');
      expect(closing).toMatchObject({ requestedBy: fx.userId, authorizedBy: manager.id });
      // pendências continuam como estavam (não vira pago, não some)
      expect((await bypass<any>(() => db.payment.findUnique({ where: { id: pendingPaymentId } }))).status).toBe('PENDING');
      expect((await bypass<any>(() => db.sale.findUnique({ where: { id: openSaleId } }))).status).toBe('PENDING');

      const report = await request(app).get(`/api/cash-register/${fx.cashRegisterId}/closure-report`).set('Authorization', managerTok());
      expect(report.status).toBe(200);
      expect(report.body.summary).toMatchObject({ closeType: 'FORCED', forced: true, forcedReason: 'Cliente foi embora sem pagar o PIX' });
      expect(report.body.pendingAtClose.totals.openSalesCount).toBeGreaterThanOrEqual(1);
    });

    it('forçar de novo um caixa já fechado: recusado sem mexer no fechamento', async () => {
      const res = await request(app)
        .post(`/api/cash-register/${fx.cashRegisterId}/force-close`)
        .set('Authorization', managerTok())
        .send({ actualAmount: 1, reason: 'Tentativa de reescrever o fechamento' });
      expect(res.status).toBe(400);
      expect(Number((await register()).actualAmount)).toBe(180);
    });
  });
});
