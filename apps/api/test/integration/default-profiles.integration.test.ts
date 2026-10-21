import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Perfis padrão (permission-matrix.md, "Perfis padrão"): sem seed de perfis e sem poder atribuir perfil a si mesmo,
 * o COMPANY_ADMIN não pagava OS nem recebia conta, embora pudesse conceder essas permissões a qualquer funcionário.
 * COMPANY_ADMIN tem o catálogo administrativo da própria empresa (lista enumerada); os demais papéis só com perfil.
 */
describe('Perfis padrão: COMPANY_ADMIN administra a empresa, os demais só com perfil (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = `dp-${Date.now()}`;
  const A = () => world.A;

  const receivable = (key: string) =>
    bypass<any>(() =>
      db.accountsReceivable.create({
        data: { companyId: A().companyId, branchId: A().branches[1].branchId, description: `${stamp}-${key}`, amount: 10, dueDate: new Date(Date.now() + 86_400_000) },
      })
    );

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) await destroyWorld(world);
  });

  it('COMPANY_ADMIN sem perfil nenhum recebe conta a receber', async () => {
    const r = await receivable('ca');
    const res = await request(app).post(`/api/financial/receivables/${r.id}/receive`).set(bearer(tokenFor(A(), null, 'COMPANY_ADMIN')));
    expect(res.status).toBe(200);
  });

  it('COMPANY_ADMIN sem perfil nenhum registra o pagamento da OS pronta', async () => {
    const os = await bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: A().companyId, branchId: A().branches[1].branchId, osNumber: 9950, customerId: A().customerId,
          motorcycleId: A().motorcycleId, entryDate: new Date(), entryKilometer: 1000, status: 'PRONTO', laborTotal: 50, finalTotal: 50,
        },
      })
    );
    const res = await request(app).post(`/api/service-orders/${os.id}/payment`).set(bearer(tokenFor(A(), null, 'COMPANY_ADMIN'))).send({ paymentMethod: 'CASH' });
    expect(res.status).toBe(200);
  });

  it('COMPANY_ADMIN não recebe conta de outra empresa', async () => {
    const other = await bypass<any>(() =>
      db.accountsReceivable.create({
        data: { companyId: world.B.companyId, branchId: world.B.branches[1].branchId, description: `${stamp}-b`, amount: 10, dueDate: new Date(Date.now() + 86_400_000) },
      })
    );
    const res = await request(app).post(`/api/financial/receivables/${other.id}/receive`).set(bearer(tokenFor(A(), null, 'COMPANY_ADMIN')));
    expect(res.status).toBeGreaterThanOrEqual(400); // rota responde 400 para "não encontrada" no escopo do token
    const after = await bypass<any>(() => db.accountsReceivable.findUnique({ where: { id: other.id } }));
    expect(after.status).not.toBe('PAID');
  });

  it.each(['MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'])('%s sem perfil continua sem receber (menor privilégio)', async (role) => {
    const r = await receivable(role);
    const res = await request(app).post(`/api/financial/receivables/${r.id}/receive`).set(bearer(tokenFor(A(), 1, role)));
    expect(res.status).toBe(403);
  });
});
