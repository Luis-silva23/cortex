import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture, purgeNewDomainData } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * PARCELAMENTO EM CENTAVOS (packages/shared/utils/installments.ts) contra o PostgreSQL real: a API recusa parcelas inválidas e
 * valores com fração de centavo, e as parcelas que ficam gravadas (folha do convênio) somam EXATAMENTE o valor da venda, com o
 * centavo que sobra na última parcela (R$ 100,00 em 3x = 33,33 + 33,33 + 33,34).
 */
describe('Parcelamento em centavos (integração real)', () => {
  let A: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  let seq = 7700 + Math.floor(Math.random() * 1000);
  let cpfSeq = 0;
  const CPFS = ['52998224725', '11144477735', '39053344705', '15350946056', '71428793860', '86288366757', '12345678909', '98765432100', '45678912300', '32165498700'];

  const newSale = (total: number) =>
    bypass<any>(() =>
      db.sale.create({
        data: { companyId: A.companyId, branchId: A.branchId, saleNumber: ++seq, customerId: A.customerId, userId: A.userId, cashRegisterId: A.cashRegisterId, status: 'PENDING', subtotal: total, totalAmount: total },
      })
    );
  const pay = (body: object) => request(app).post('/api/payments').set('Authorization', `Bearer ${token}`).send(body);
  const setPolicy = async (key: string, value: unknown) => {
    await bypass(() => db.policySetting.deleteMany({ where: { companyId: A.companyId, branchId: null, key } }));
    await bypass(() => db.policySetting.create({ data: { companyId: A.companyId, branchId: null, key, value: value as any, updatedBy: 'test' } }));
  };
  const paymentsOf = (saleId: string) => bypass<any[]>(() => db.payment.findMany({ where: { saleId, companyId: A.companyId } }));
  const cents = (n: unknown) => Math.round(Number(n) * 100);

  beforeAll(async () => {
    A = await createFixture('instal');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    token = generateAccessToken({ userId: A.userId, email: 'op@test.local', companyId: A.companyId, branchId: A.branchId, userType: 'OPERATOR' });
    await bypass(() => db.installmentPolicy.create({ data: { companyId: A.companyId, branchId: null, paymentMethod: 'CREDIT_CARD', maxInstallments: 12, interestFreeInstallments: 12, isActive: true } as any }));
    await setPolicy('employeeAgreement.enabled', true);
    await setPolicy('employeeAgreement.limitType', 'FIXED');
    await setPolicy('employeeAgreement.limitValue', 300);
    await setPolicy('employeeAgreement.maxInstallments', 3);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    if (!A) return;
    await purgeNewDomainData(A.companyId);
    await bypass(() => db.installmentPolicy.deleteMany({ where: { companyId: A.companyId } }));
    await destroyFixture(A);
  });

  describe('cartão de crédito', () => {
    it.each([
      [100, 1],
      [100, 2],
      [100, 3],
      [10, 3],
      [123.45, 7],
    ])('R$ %p em %ix: aprovado e gravado com o valor e as parcelas exatos', async (amount, installments) => {
      const sale = await newSale(amount);
      const res = await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount, installments });
      expect(res.status).toBe(201);
      const [p] = await paymentsOf(sale.id);
      expect(cents(p.amount)).toBe(Math.round(amount * 100)); // sem erro de ponto flutuante na gravação
      expect(p.installments).toBe(installments);
    });

    it('quantidade de parcelas inválida (0, negativa, fracionária) → 400 e nenhum pagamento gravado', async () => {
      for (const installments of [0, -1, -3, 2.5]) {
        const sale = await newSale(100);
        const res = await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount: 100, installments });
        expect(res.status).toBe(400);
        expect(await paymentsOf(sale.id)).toHaveLength(0);
      }
    });

    it('acima do máximo da política (12x) → recusado; valor pequeno demais para o número de parcelas (R$ 0,01 em 2x) → 400 INSTALLMENTS_INVALID', async () => {
      const sale = await newSale(100);
      expect((await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount: 100, installments: 13 })).status).toBeGreaterThanOrEqual(400);
      const tiny = await newSale(0.01);
      const res = await pay({ saleId: tiny.id, paymentMethod: 'CREDIT_CARD', amount: 0.01, installments: 2 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INSTALLMENTS_INVALID');
      expect(await paymentsOf(tiny.id)).toHaveLength(0);
      const one = await pay({ saleId: tiny.id, paymentMethod: 'CREDIT_CARD', amount: 0.01, installments: 1 });
      expect(one.status).toBe(201); // R$ 0,01 à vista é válido
    });

    it('valor com fração de centavo (R$ 10,005) é recusado em qualquer forma de pagamento, sem arredondar em silêncio', async () => {
      for (const paymentMethod of ['CREDIT_CARD', 'CASH']) {
        const sale = await newSale(100);
        const res = await pay({ saleId: sale.id, paymentMethod, amount: 10.005 });
        expect(res.status).toBe(400);
        expect(await paymentsOf(sale.id)).toHaveLength(0);
      }
    });
  });

  describe('convênio de funcionário (parcelas em folha persistidas)', () => {
    const newEmployee = () => bypass<any>(() => db.employeeAgreement.create({ data: { companyId: A.companyId, name: 'Funcionário', cpf: CPFS[cpfSeq++], createdBy: 'test' } as any }));
    const deductionsOf = (paymentId: string) =>
      bypass<any[]>(() => db.employeePayrollDeduction.findMany({ where: { companyId: A.companyId, charge: { paymentId } }, orderBy: { installmentNumber: 'asc' } }));

    it.each([
      [100, 3, [33.33, 33.33, 33.34]],
      [10, 3, [3.33, 3.33, 3.34]],
      [100.01, 3, [33.33, 33.34, 33.34]],
      [100, 2, [50, 50]],
      [100, 1, [100]],
    ])('R$ %p em %ix grava as parcelas %p e a soma é exatamente o total', async (amount, installments, expected) => {
      const emp = await newEmployee();
      const sale = await newSale(amount);
      const res = await pay({ saleId: sale.id, paymentMethod: 'EMPLOYEE_AGREEMENT', amount, installments, employeeAgreementId: emp.id });
      expect(res.status).toBe(201);
      const deds = await deductionsOf(res.body.id);
      expect(deds.map((d) => Number(d.amount))).toEqual(expected);
      expect(deds.reduce((acc, d) => acc + cents(d.amount), 0)).toBe(Math.round(amount * 100));
    });

    it('convênio: parcelas inválidas e valor pequeno demais → 400 e nada gravado', async () => {
      const emp = await newEmployee();
      for (const installments of [0, -1, 2.5]) {
        const sale = await newSale(100);
        const res = await pay({ saleId: sale.id, paymentMethod: 'EMPLOYEE_AGREEMENT', amount: 100, installments, employeeAgreementId: emp.id });
        expect(res.status).toBe(400);
        expect(await paymentsOf(sale.id)).toHaveLength(0);
      }
      const tiny = await newSale(0.02);
      const res = await pay({ saleId: tiny.id, paymentMethod: 'EMPLOYEE_AGREEMENT', amount: 0.02, installments: 3, employeeAgreementId: emp.id });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INSTALLMENTS_INVALID');
      expect(await bypass<number>(() => db.employeePayrollDeduction.count({ where: { companyId: A.companyId, agreementId: emp.id } }))).toBe(0);
    });
  });
});
