import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Conteúdo da auditoria em operações reais (HTTP + Postgres): rotas que respondem o objeto direto gravavam
 * newValue "null"/entityId nulo, e o pagamento de OS nem era auditado.
 */
describe('Auditoria registra o que aconteceu em operações reais de dinheiro (integração real)', () => {
  let world: World;
  let app: express.Express;
  let addSpy: jest.SpyInstance;

  const A = () => world.A;
  const auditCalls = () => addSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1]);

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    addSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 120000);

  afterAll(async () => {
    addSpy.mockRestore();
    if (world) {
      await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: A().companyId, referenceType: 'ServiceOrder' } }));
      await destroyWorld(world);
    }
  });

  beforeEach(() => addSpy.mockClear());

  it('pagamento em dinheiro: auditoria tem o id do pagamento e o valor (não "null")', async () => {
    const sale = await bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: A().companyId, branchId: A().branches[1].branchId, saleNumber: 9901, customerId: A().customerId,
          userId: A().branches[1].userId, cashRegisterId: A().branches[1].cashRegisterId, status: 'PENDING', subtotal: 20, totalAmount: 20,
        },
      })
    );
    const res = await request(app)
      .post('/api/payments')
      .set(bearer(tokenFor(A(), 1, 'OPERATOR')))
      .send({ saleId: sale.id, paymentMethod: 'CASH', amount: 20 });
    expect(res.status).toBeLessThan(300);

    const audit = auditCalls().find((a) => a.entity === 'Payment');
    expect(audit).toBeDefined();
    expect(audit.entityId).toBe(res.body.id);
    expect(audit.newValue).not.toBe('null');
    expect(JSON.parse(audit.newValue)).toMatchObject({ id: res.body.id, saleId: sale.id });
  });

  it('pagamento de OS agora é auditado', async () => {
    const os = await bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: A().companyId, branchId: A().branches[1].branchId, osNumber: 9902, customerId: A().customerId,
          motorcycleId: A().motorcycleId, entryDate: new Date(), entryKilometer: 1000, status: 'PRONTO', laborTotal: 50, finalTotal: 50,
        },
      })
    );
    const res = await request(app)
      .post(`/api/service-orders/${os.id}/payment`)
      .set({ ...bearer(tokenFor(A(), null, 'SUPER_ADMIN')), 'X-Company-Id': A().companyId })
      .send({ paymentMethod: 'CASH' });
    expect(res.status).toBeLessThan(300);

    const audit = auditCalls().find((a) => a.entity === 'ServiceOrder');
    expect(audit).toBeDefined();
    expect(audit.entityId).toBe(os.id);
    expect(JSON.parse(audit.newValue)).toMatchObject({ id: os.id, isPaid: true });
  });
});
