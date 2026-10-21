import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import cashRegisterRoutes from '../../src/routes/cash-register.routes';
import salesRoutes from '../../src/routes/sales.routes';
import paymentsRoutes from '../../src/routes/payments.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Trava de papel nas escritas do PDV — prova REAL (HTTP + Postgres/RLS +
 * Redis, sem nenhum mock; JWT assinado com o segredo real do .env).
 *
 * ACHADO DE AUDITORIA: cash-register/sales/payments não tinham trava de
 * papel nos writes — VIEWER (e MECHANIC) conseguiam abrir/fechar caixa,
 * criar venda e registrar pagamento. Estes testes conferem no BANCO que a
 * tentativa bloqueada não deixou rastro, e que o operador de verdade
 * continua vendendo e recebendo de ponta a ponta.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Trava de papel nas escritas do PDV — integração real', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;

  const tokenFor = (userType: string, userId: string) =>
    generateAccessToken({
      userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType,
    });

  const countRegisters = () => bypass<number>(() => prismaUnsafeBypassRLS.cashRegister.count({ where: { companyId: fixture.companyId } }));
  const countSales = () => bypass<number>(() => prismaUnsafeBypassRLS.sale.count({ where: { companyId: fixture.companyId } }));
  const countPayments = () => bypass<number>(() => prismaUnsafeBypassRLS.payment.count({ where: { companyId: fixture.companyId } }));

  beforeAll(async () => {
    fixture = await createFixture('write-gates');
    app = express();
    app.use(express.json());
    app.use('/api/cash-register', cashRegisterRoutes);
    app.use('/api/sales', salesRoutes);
    app.use('/api/payments', paymentsRoutes);
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  describe.each(['VIEWER', 'MECHANIC'])('%s', (userType) => {
    const someUserId = '11111111-1111-4111-8111-111111111111';

    it('não abre caixa (403) e nenhum caixa novo é criado', async () => {
      const before = await countRegisters();

      const res = await request(app)
        .post('/api/cash-register/open')
        .set('Authorization', `Bearer ${tokenFor(userType, someUserId)}`)
        .send({ branchId: fixture.branchId, registerNumber: 2, openingAmount: 50 });

      expect(res.status).toBe(403);
      expect(await countRegisters()).toBe(before);
    });

    it('não fecha o caixa aberto de outra pessoa (403) e ele continua OPEN', async () => {
      const res = await request(app)
        .post(`/api/cash-register/${fixture.cashRegisterId}/close`)
        .set('Authorization', `Bearer ${tokenFor(userType, someUserId)}`)
        .send({ actualAmount: 100 });

      expect(res.status).toBe(403);
      const register = await bypass<any>(() => prismaUnsafeBypassRLS.cashRegister.findFirst({ where: { id: fixture.cashRegisterId } }));
      expect(register.status).toBe('OPEN');
    });

    it('não cria venda nem pagamento (403) e nada é gravado', async () => {
      const salesBefore = await countSales();
      const paymentsBefore = await countPayments();

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tokenFor(userType, someUserId)}`)
        .send({ branchId: fixture.branchId, cashRegisterId: fixture.cashRegisterId, items: [{ productId: fixture.productId, quantity: 1, unitPrice: 10 }] });
      expect(sale.status).toBe(403);

      const payment = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tokenFor(userType, someUserId)}`)
        .send({ saleId: '22222222-2222-4222-8222-222222222222', amount: 10, paymentMethod: 'CASH' });
      expect(payment.status).toBe(403);

      expect(await countSales()).toBe(salesBefore);
      expect(await countPayments()).toBe(paymentsBefore);
    });

    // VIEWER é o papel de leitura: continua lendo caixa e vendas. MECHANIC (oficina)
    // deixou de ler dados de dinheiro — decisão deliberada, provada em
    // mechanic-read-scope.integration.test.ts.
    const expectedReadStatus = userType === 'MECHANIC' ? 403 : 200;
    it(`leitura de caixa e vendas: ${userType === 'MECHANIC' ? 'bloqueada (403) para a oficina' : 'continua aberta (200)'}`, async () => {
      const current = await request(app)
        .get('/api/cash-register/history')
        .set('Authorization', `Bearer ${tokenFor(userType, someUserId)}`);
      expect(current.status).toBe(expectedReadStatus);

      const sales = await request(app).get('/api/sales').set('Authorization', `Bearer ${tokenFor(userType, someUserId)}`);
      expect(sales.status).toBe(expectedReadStatus);
    });
  });

  describe('OPERATOR (usuário real do PDV)', () => {
    let saleId: string;
    let paymentId: string;

    it('vende e recebe de ponta a ponta: reforço de caixa, venda e pagamento em dinheiro', async () => {
      const token = tokenFor('OPERATOR', fixture.userId);

      const movement = await request(app)
        .post('/api/cash-register/movement')
        .set('Authorization', `Bearer ${token}`)
        .send({ cashRegisterId: fixture.cashRegisterId, movementType: 'DEPOSIT', amount: 5 });
      expect(movement.status).toBe(201);

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ branchId: fixture.branchId, cashRegisterId: fixture.cashRegisterId, items: [{ productId: fixture.productId, quantity: 1, unitPrice: 10 }] });
      expect(sale.status).toBe(201);
      saleId = sale.body.id;

      const payment = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${token}`)
        .send({ saleId, amount: Number(sale.body.totalAmount), paymentMethod: 'CASH' });
      expect(payment.status).toBe(201);
      expect(payment.body.status).toBe('APPROVED');
      paymentId = payment.body.id;

      expect(await countSales()).toBe(1);
      expect(await countPayments()).toBe(1);
    });

    it('não reconcilia pagamento (só Gerência+): 403 e o pagamento não muda', async () => {
      const before = await bypass<any>(() => prismaUnsafeBypassRLS.payment.findFirst({ where: { id: paymentId } }));

      const res = await request(app)
        .post(`/api/payments/${paymentId}/reconcile`)
        .set('Authorization', `Bearer ${tokenFor('OPERATOR', fixture.userId)}`);
      expect(res.status).toBe(403);

      const after = await bypass<any>(() => prismaUnsafeBypassRLS.payment.findFirst({ where: { id: paymentId } }));
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });
});
