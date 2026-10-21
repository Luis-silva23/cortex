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
 * Regra definitiva do dono (2026-09-28, docs/CORTEX/policies/CAIXA.md): o fechamento considera TODO o movimento
 * financeiro do caixa — dinheiro, cartão, PIX, convênios — e confronta esperado × informado, por forma de pagamento,
 * registrando esperado, informado, diferença, operador, período, vendas, formas e o motivo da divergência.
 *
 * Caixa de referência (o exemplo do dono, com fundo de troco, reforço, sangria e estornos):
 *   abertura 100 · dinheiro 1.000 · cartão 2.000 · PIX 1.200 · convênio funcionário 500 · convênio empresa 300
 *   reforço 50 · sangria 30 · cancelamento da venda X (paga 100 dinheiro + 100 PIX) 200 · estorno de pagamento de cartão 50
 *   esperado: dinheiro 1.120 (100 fundo + 1.100 vendas + 50 reforço − 30 sangria − 100 estorno) · cartão 2.000 · PIX 1.200 ·
 *   convênio funcionário 500 · convênio empresa 300 = 5.120 (as vendas líquidas do exemplo, 5.000, + o fundo de troco)
 */
describe('Fechamento de caixa por forma de pagamento (integração real)', () => {
  let fx: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = `ccm-${Date.now()}`;
  const PASSWORD = 'IntegrationTest123!';
  let manager: { id: string; numericId: number };
  let saleSeq = 8100;
  let registerSeq = 60;

  const tok = (userId: string, userType: string, branchId: string | null) =>
    `Bearer ${generateAccessToken({ userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: branchId as any, userType })}`;

  const mkUser = async (userType: string, label: string) => {
    const hash = await hashPassword(PASSWORD);
    return bypass<any>(() =>
      db.user.create({
        data: { companyId: fx.companyId, branchId: fx.branchId, name: `${label} ${stamp}`, email: `${label}-${Math.random().toString(36).slice(2)}-${stamp}@test.local`, password: hash, userType: userType as any, isActive: true },
      })
    );
  };

  /** Caixa aberto do operador com o movimento de referência; devolve id do caixa. */
  async function referenceRegister(operatorId: string) {
    const register = await bypass<any>(() =>
      db.cashRegister.create({
        data: { companyId: fx.companyId, branchId: fx.branchId, userId: operatorId, registerNumber: ++registerSeq, status: 'OPEN', openingAmount: 100, expectedAmount: 0 },
      })
    );
    const sale = (status: 'PAID' | 'CANCELLED', total: number) =>
      bypass<any>(() =>
        db.sale.create({
          data: {
            companyId: fx.companyId, branchId: fx.branchId, saleNumber: ++saleSeq, customerId: fx.customerId, userId: operatorId,
            cashRegisterId: register.id, status, subtotal: total, totalAmount: total, paidAmount: status === 'PAID' ? total : 0, notes: stamp,
          },
        })
      );
    const payment = (saleId: string, method: string, amount: number, status = 'APPROVED') =>
      bypass<any>(() => db.payment.create({ data: { companyId: fx.companyId, saleId, paymentMethod: method as any, status: status as any, amount } }));

    const paid = await sale('PAID', 5000);
    const pCash = await payment(paid.id, 'CASH', 1000);
    const pCard = await payment(paid.id, 'CREDIT_CARD', 2000);
    const pPix = await payment(paid.id, 'PIX', 1200);
    const pEmp = await payment(paid.id, 'EMPLOYEE_AGREEMENT', 500);
    const pCo = await payment(paid.id, 'COMPANY_AGREEMENT', 300);
    const cancelled = await sale('CANCELLED', 200);
    const cCash = await payment(cancelled.id, 'CASH', 100, 'REFUNDED');
    const cPix = await payment(cancelled.id, 'PIX', 100, 'REFUNDED');
    const reversedCard = await payment(paid.id, 'CREDIT_CARD', 50, 'REFUNDED');

    const sold = (p: any, method: string, amount: number) => ({
      cashRegisterId: register.id, movementType: 'SALE' as const, amount, paymentMethod: method as any, referenceType: 'Payment', referenceId: p.id, userId: operatorId,
    });
    await bypass(() =>
      db.cashMovement.createMany({
        data: [
          { cashRegisterId: register.id, movementType: 'OPENING', amount: 100, userId: operatorId },
          sold(pCash, 'CASH', 1000),
          sold(pCard, 'CREDIT_CARD', 2000),
          sold(pPix, 'PIX', 1200),
          sold(pEmp, 'EMPLOYEE_AGREEMENT', 500),
          sold(pCo, 'COMPANY_AGREEMENT', 300),
          sold(cCash, 'CASH', 100),
          sold(cPix, 'PIX', 100),
          sold(reversedCard, 'CREDIT_CARD', 50),
          { cashRegisterId: register.id, movementType: 'DEPOSIT', amount: 50, userId: operatorId },
          { cashRegisterId: register.id, movementType: 'WITHDRAWAL', amount: 30, userId: operatorId, requestedBy: operatorId, authorizedBy: manager.id },
          // cancelamento da venda: estorna 200 sem forma de pagamento no movimento (como o serviço grava)
          { cashRegisterId: register.id, movementType: 'CANCELLATION', amount: 200, referenceType: 'SaleCancellation', referenceId: cancelled.id, userId: operatorId },
          // estorno de um pagamento de cartão
          { cashRegisterId: register.id, movementType: 'CANCELLATION', amount: 50, referenceType: 'PaymentReversal', referenceId: reversedCard.id, userId: operatorId },
        ],
      })
    );
    return { registerId: register.id, paidSaleId: paid.id, paidSaleNumber: paid.saleNumber, cancelledSaleId: cancelled.id };
  }

  const EXPECTED = { CASH: 1120, CREDIT_CARD: 2000, PIX: 1200, EMPLOYEE_AGREEMENT: 500, COMPANY_AGREEMENT: 300 };
  const EXPECTED_TOTAL = 5120;
  const byMethod = (rows: Array<{ method: string; expected: number }>) => Object.fromEntries(rows.map((r) => [r.method, r.expected]));
  const register = (id: string) => bypass<any>(() => db.cashRegister.findUnique({ where: { id }, include: { movements: true } }));

  beforeAll(async () => {
    fx = await createFixture('ccm');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    manager = await mkUser('MANAGER', 'gerente');
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (fx?.companyId) await destroyFixture(fx);
  }, 120000);

  it('prévia do fechamento: esperado por forma de pagamento soma TODO o movimento (dinheiro, cartão, PIX, convênios)', async () => {
    const op = await mkUser('OPERATOR', 'op-previa');
    const { registerId } = await referenceRegister(op.id);
    const res = await request(app).get(`/api/cash-register/${registerId}/pendencies`).set('Authorization', tok(op.id, 'OPERATOR', fx.branchId));
    expect(res.status).toBe(200);
    expect(res.body.expected.total).toBe(EXPECTED_TOTAL);
    expect(byMethod(res.body.expected.byMethod)).toEqual(EXPECTED);
    // o dinheiro mostra de onde vem (fundo de troco, reforço, sangria, vendas, estornos)
    const cash = res.body.expected.byMethod.find((r: any) => r.method === 'CASH');
    expect(cash).toMatchObject({ sales: 1100, refunds: 100, opening: 100, deposits: 50, withdrawals: 30 });
  });

  it('informado por forma igual ao esperado: fecha sem motivo e registra esperado, informado, diferença, período, operador e vendas', async () => {
    const op = await mkUser('OPERATOR', 'op-igual');
    const { registerId, paidSaleId, paidSaleNumber } = await referenceRegister(op.id);
    const res = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: EXPECTED_TOTAL, declaredByMethod: EXPECTED });
    expect(res.status).toBe(200);
    const reg = await register(registerId);
    expect(reg.status).toBe('CLOSED');
    expect(Number(reg.expectedAmount)).toBe(EXPECTED_TOTAL);
    expect(Number(reg.difference)).toBe(0);
    const s = reg.closingSummary;
    expect(s.closeType).toBe('NORMAL');
    expect(s.expected.total).toBe(EXPECTED_TOTAL);
    expect(byMethod(s.expected.byMethod)).toEqual(EXPECTED);
    expect(s.declared.byMethod).toEqual(EXPECTED);
    expect(s.difference.total).toBe(0);
    expect(Object.values(s.difference.byMethod).every((v) => v === 0)).toBe(true);
    expect(s.operator.id).toBe(op.id);
    expect(s.closedBy.id).toBe(op.id);
    expect(s.period.openedAt).toBeTruthy();
    expect(s.period.closedAt).toBeTruthy();
    expect(s.sales.count).toBe(2);
    expect(s.sales.items.map((i: any) => i.saleId)).toContain(paidSaleId);
    expect(s.sales.items.find((i: any) => i.saleId === paidSaleId).saleNumber).toBe(paidSaleNumber);

    const report = await request(app).get(`/api/cash-register/${registerId}/closure-report`).set('Authorization', tok(manager.id, 'MANAGER', fx.branchId));
    expect(report.status).toBe(200);
    expect(report.body.closingSummary.expected.total).toBe(EXPECTED_TOTAL);
  });

  it('com diferença e sem motivo: 400 DIFFERENCE_REASON_REQUIRED em PT-BR com esperado/informado/diferença; caixa segue aberto', async () => {
    const op = await mkUser('OPERATOR', 'op-sem-motivo');
    const { registerId } = await referenceRegister(op.id);
    const res = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: 5050, declaredByMethod: { ...EXPECTED, CASH: 1050 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DIFFERENCE_REASON_REQUIRED');
    expect(res.body.error).toMatch(/diferença/i);
    expect(res.body.details).toMatchObject({ expected: EXPECTED_TOTAL, informed: 5050, difference: -70 });
    expect(res.body.details.differenceByMethod.CASH).toBe(-70);
    const reg = await register(registerId);
    expect(reg.status).toBe('OPEN');
    expect(reg.movements.filter((m: any) => m.movementType === 'CLOSING')).toHaveLength(0);
  });

  it('com diferença e motivo: fecha e guarda o motivo e a diferença por forma', async () => {
    const op = await mkUser('OPERATOR', 'op-com-motivo');
    const { registerId } = await referenceRegister(op.id);
    const res = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: 5050, declaredByMethod: { ...EXPECTED, CASH: 1050 }, differenceReason: 'Troco dado a mais em duas vendas' });
    expect(res.status).toBe(200);
    const reg = await register(registerId);
    expect(reg.differenceReason).toBe('Troco dado a mais em duas vendas');
    expect(Number(reg.difference)).toBe(-70);
    expect(reg.closingSummary.difference).toMatchObject({ total: -70, byMethod: { CASH: -70, CREDIT_CARD: 0 } });
    expect(reg.closingSummary.differenceReason).toBe('Troco dado a mais em duas vendas');
  });

  it('informado por forma que não soma o total informado: 400 DECLARED_TOTAL_MISMATCH; forma desconhecida: 400', async () => {
    const op = await mkUser('OPERATOR', 'op-soma');
    const { registerId } = await referenceRegister(op.id);
    const a = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: 4000, declaredByMethod: EXPECTED });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe('DECLARED_TOTAL_MISMATCH');
    const b = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: 10, declaredByMethod: { BITCOIN: 10 } });
    expect(b.status).toBe(400);
    expect((await register(registerId)).status).toBe('OPEN');
  });

  it('sem informar por forma (só o total) continua funcionando e compara com o esperado de todas as formas', async () => {
    const op = await mkUser('OPERATOR', 'op-total');
    const { registerId } = await referenceRegister(op.id);
    const res = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: EXPECTED_TOTAL });
    expect(res.status).toBe(200);
    const reg = await register(registerId);
    expect(reg.closingSummary.declared).toMatchObject({ total: EXPECTED_TOTAL, byMethod: null });
    expect(reg.closingSummary.difference).toMatchObject({ total: 0, byMethod: null });
  });

  it('política cash.requireDifferenceReason desligada: diferença sem motivo é aceita (e registrada)', async () => {
    const op = await mkUser('OPERATOR', 'op-politica');
    const { registerId } = await referenceRegister(op.id);
    await bypass(() => db.policySetting.create({ data: { companyId: fx.companyId, branchId: null, key: 'cash.requireDifferenceReason', value: false as any, updatedBy: fx.userId } }));
    try {
      const res = await request(app)
        .post(`/api/cash-register/${registerId}/close`)
        .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
        .send({ actualAmount: 5110 });
      expect(res.status).toBe(200);
      expect(Number((await register(registerId)).difference)).toBe(-10);
    } finally {
      await bypass(() => db.policySetting.deleteMany({ where: { companyId: fx.companyId, key: 'cash.requireDifferenceReason' } }));
    }
  });

  it('fechamento forçado também registra o resumo por forma, com autorizador e o motivo como motivo da divergência', async () => {
    const op = await mkUser('OPERATOR', 'op-forcado');
    const { registerId } = await referenceRegister(op.id);
    // pendência que bloqueia o normal: pagamento PIX pendente numa venda em aberto deste caixa
    const pendingSale = await bypass<any>(() =>
      db.sale.create({
        data: { companyId: fx.companyId, branchId: fx.branchId, saleNumber: ++saleSeq, customerId: fx.customerId, userId: op.id, cashRegisterId: registerId, status: 'PENDING', subtotal: 40, totalAmount: 40, notes: stamp },
      })
    );
    await bypass(() => db.payment.create({ data: { companyId: fx.companyId, saleId: pendingSale.id, paymentMethod: 'PIX', status: 'PENDING', amount: 40 } }));
    const blocked = await request(app).post(`/api/cash-register/${registerId}/close`).set('Authorization', tok(op.id, 'OPERATOR', fx.branchId)).send({ actualAmount: EXPECTED_TOTAL });
    expect(blocked.status).toBe(409);

    const res = await request(app)
      .post(`/api/cash-register/${registerId}/force-close`)
      .set('Authorization', tok(op.id, 'OPERATOR', fx.branchId))
      .send({ actualAmount: 5110, declaredByMethod: { ...EXPECTED, CASH: 1110 }, reason: 'PIX do cliente não confirmou até o fim do turno', authorizerNumericId: manager.numericId, authorizerPassword: PASSWORD });
    expect(res.status).toBe(200);
    const reg = await register(registerId);
    expect(reg.closeType).toBe('FORCED');
    const s = reg.closingSummary;
    expect(s.closeType).toBe('FORCED');
    expect(s.authorizedBy.id).toBe(manager.id);
    expect(byMethod(s.expected.byMethod)).toEqual(EXPECTED);
    expect(s.difference).toMatchObject({ total: -10, byMethod: { CASH: -10 } });
    expect(s.differenceReason).toBe('PIX do cliente não confirmou até o fim do turno');
    // a pendência continua pendente (não vira paga nem some)
    expect((await bypass<any>(() => db.sale.findUnique({ where: { id: pendingSale.id } }))).status).toBe('PENDING');
  });
});
