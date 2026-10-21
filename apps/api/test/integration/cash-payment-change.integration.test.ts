import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Dinheiro com troco (business-state-machines.md, "Pagamento em dinheiro"). Venda de R$ 150, cliente entrega R$ 170:
 * o pagamento vale R$ 150 para a venda; R$ 170 recebido e R$ 20 de troco ficam registrados à parte. O caixa só ganha
 * R$ 150 (o troco saiu da gaveta). Antes: `amount` gravava 170, o caixa esperava +170 (sobra fantasma de 20 no
 * fechamento) e o estorno devolveria 170.
 */
describe('Pagamento em dinheiro: valor aplicado, recebido e troco (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  let seq = 9300;

  const newSale = (total: number) =>
    bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, saleNumber: ++seq, customerId: fixture.customerId,
          userId: fixture.userId, cashRegisterId: fixture.cashRegisterId, status: 'PENDING', subtotal: total, totalAmount: total,
        },
      })
    );
  const register = () => bypass<any>(() => db.cashRegister.findUnique({ where: { id: fixture.cashRegisterId } }));
  const pay = (body: object) => request(app).post('/api/payments').set('Authorization', `Bearer ${token}`).send(body);

  beforeAll(async () => {
    fixture = await createFixture('cashchange');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    token = generateAccessToken({ userId: fixture.userId, email: 'op@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'OPERATOR' });
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) await destroyFixture(fixture);
  });

  it('cliente entrega R$ 170 numa venda de R$ 150: aplica 150, registra 170 recebido e 20 de troco; caixa +150', async () => {
    const sale = await newSale(150);
    const before = Number((await register()).expectedAmount);

    const res = await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 170 });
    expect(res.status).toBe(201);

    const payment = await bypass<any>(() => db.payment.findUnique({ where: { id: res.body.id } }));
    expect(Number(payment.amount)).toBe(150);
    expect(Number(payment.receivedAmount)).toBe(170);
    expect(Number(payment.changeAmount)).toBe(20);

    const saleAfter = await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }));
    expect(saleAfter.status).toBe('PAID');
    expect(Number(saleAfter.paidAmount)).toBe(150);
    expect(Number(saleAfter.changeAmount)).toBe(20);

    const movement = await bypass<any>(() => db.cashMovement.findFirst({ where: { referenceType: 'Payment', referenceId: payment.id } }));
    expect(Number(movement.amount)).toBe(150);
    expect(Number((await register()).expectedAmount)).toBe(before + 150);
  });

  it('valor recebido informado à parte (R$ 200 para R$ 150): troco de 50', async () => {
    const sale = await newSale(150);
    const res = await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 150, receivedAmount: 200 });
    expect(res.status).toBe(201);
    const payment = await bypass<any>(() => db.payment.findUnique({ where: { id: res.body.id } }));
    expect([Number(payment.amount), Number(payment.receivedAmount), Number(payment.changeAmount)]).toEqual([150, 200, 50]);
  });

  it('valor recebido menor que o aplicado é recusado', async () => {
    const sale = await newSale(150);
    const res = await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 150, receivedAmount: 100 });
    expect(res.status).toBe(400);
    expect(await bypass<number>(() => db.payment.count({ where: { saleId: sale.id } }))).toBe(0);
  });

  it('pagamento parcial em dinheiro (R$ 100 de R$ 150) não gera troco', async () => {
    const sale = await newSale(150);
    const res = await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 100 });
    const payment = await bypass<any>(() => db.payment.findUnique({ where: { id: res.body.id } }));
    expect([Number(payment.amount), Number(payment.changeAmount)]).toEqual([100, 0]);
    expect((await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }))).status).toBe('PARTIALLY_PAID');
  });

  it('valor recebido só vale para dinheiro', async () => {
    const sale = await newSale(150);
    const res = await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 150, receivedAmount: 170 });
    expect(res.status).toBe(400);
  });
});
