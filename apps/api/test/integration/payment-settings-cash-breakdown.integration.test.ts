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
 * Controle de cédulas opcional (business-state-machines.md, "Pagamento em dinheiro"). Desligado (padrão): dinheiro
 * registra recebido/troco. Ligado na empresa (com override por filial): o dinheiro exige a composição das cédulas,
 * validada contra o Real e contra o valor recebido, e gravada no pagamento. Só administrador configura.
 */
describe('Configuração de pagamento e controle de cédulas (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let branch2: string;
  let seq = 9500;
  const token = (userType: string, branchId?: string) =>
    `Bearer ${generateAccessToken({ userId: fixture.userId, email: 'x@test.local', companyId: fixture.companyId, branchId, userType })}`;
  const admin = () => token('COMPANY_ADMIN');
  const operator = () => token('OPERATOR', fixture.branchId);

  const newSale = (total: number) =>
    bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, saleNumber: ++seq, customerId: fixture.customerId,
          userId: fixture.userId, cashRegisterId: fixture.cashRegisterId, status: 'PENDING', subtotal: total, totalAmount: total,
        },
      })
    );
  const pay = (body: object) => request(app).post('/api/payments').set('Authorization', operator()).send(body);
  const setting = (body: object) => request(app).put('/api/payment-settings').set('Authorization', admin()).send(body);

  beforeAll(async () => {
    fixture = await createFixture('cashnotes');
    branch2 = (await bypass<any>(() => db.branch.create({ data: { companyId: fixture.companyId, name: 'Filial 2', isActive: true } }))).id;
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) {
      await bypass(() => db.paymentSetting.deleteMany({ where: { companyId: fixture.companyId } }));
      await destroyFixture(fixture);
    }
  });

  it('padrão: controle desligado; dinheiro sem cédulas é aceito', async () => {
    const res = await request(app).get('/api/payment-settings').set('Authorization', operator());
    expect(res.body).toMatchObject({ cashDenominationControl: false, source: 'default' });
    const sale = await newSale(50);
    expect((await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 50 })).status).toBe(201);
  });

  it('operador não altera a configuração', async () => {
    const res = await request(app).put('/api/payment-settings').set('Authorization', operator()).send({ cashDenominationControl: true });
    expect(res.status).toBe(403);
  });

  it('ligado na empresa: dinheiro exige cédulas que somem o recebido; grava a composição', async () => {
    expect((await setting({ cashDenominationControl: true })).body).toMatchObject({ cashDenominationControl: true, source: 'company' });

    const sale = await newSale(150);
    expect((await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 170 })).status).toBe(400);
    expect((await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 170, cashBreakdown: [{ value: 100, quantity: 1 }, { value: 50, quantity: 1 }] })).status).toBe(400);
    expect((await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 170, cashBreakdown: [{ value: 85, quantity: 2 }] })).status).toBe(400);
    expect(await bypass<number>(() => db.payment.count({ where: { saleId: sale.id } }))).toBe(0);

    const ok = await pay({ saleId: sale.id, paymentMethod: 'CASH', amount: 170, cashBreakdown: [{ value: 20, quantity: 1 }, { value: 100, quantity: 1 }, { value: 50, quantity: 1 }] });
    expect(ok.status).toBe(201);
    const payment = await bypass<any>(() => db.payment.findUnique({ where: { id: ok.body.id } }));
    expect(payment.cashBreakdown).toEqual([{ value: 100, quantity: 1 }, { value: 50, quantity: 1 }, { value: 20, quantity: 1 }]);
    expect([Number(payment.amount), Number(payment.receivedAmount), Number(payment.changeAmount)]).toEqual([150, 170, 20]);
  });

  it('fechamento do caixa mostra a composição das cédulas recebidas e o troco', async () => {
    const res = await request(app).get(`/api/cash-register/${fixture.cashRegisterId}/closure-report`).set('Authorization', admin());
    expect(res.status).toBe(200);
    expect(res.body.cashReceived.notes).toEqual([{ value: 100, quantity: 1 }, { value: 50, quantity: 1 }, { value: 20, quantity: 1 }]);
    expect(res.body.cashReceived.paymentsWithBreakdown).toBe(1);
    expect(res.body.cashReceived.change).toBe(20);
    expect(res.body.cashReceived.received).toBe(50 + 170);
  });

  it('cédulas não se aplicam a cartão', async () => {
    const sale = await newSale(30);
    expect((await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 30, cashBreakdown: [{ value: 20, quantity: 1 }, { value: 10, quantity: 1 }] })).status).toBe(400);
  });

  it('override por filial: filial 2 desligada enquanto a empresa está ligada; remover o override volta a herdar', async () => {
    expect((await setting({ branchId: branch2, cashDenominationControl: false })).body).toMatchObject({ cashDenominationControl: false, source: 'branch' });
    expect((await request(app).get(`/api/payment-settings?branchId=${branch2}`).set('Authorization', admin())).body.source).toBe('branch');
    expect((await request(app).get('/api/payment-settings').set('Authorization', operator())).body).toMatchObject({ cashDenominationControl: true, source: 'company' });
    expect((await setting({ branchId: branch2, cashDenominationControl: null })).body).toMatchObject({ cashDenominationControl: true, source: 'company' });
  });

  it('filial que não é da empresa é recusada', async () => {
    const res = await setting({ branchId: '00000000-0000-4000-8000-000000000000', cashDenominationControl: true });
    expect(res.status).toBe(400);
  });
});
