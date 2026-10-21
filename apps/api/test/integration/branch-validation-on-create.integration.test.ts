import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * `branchId` do corpo em criações de OS, pedido de compra, abertura de caixa, contas a pagar/receber e
 * usuário ia direto para o banco quando quem criava era da empresa toda (COMPANY_ADMIN/SUPER_ADMIN): só
 * `users.branchId` tem FK, e nenhuma coluna confere se a filial é DA MESMA empresa. Uma filial da empresa B
 * (ou qualquer texto) passava — registro da empresa A pendurado na filial de outro tenant.
 * Regra (utils/branch-context.ts, a mesma de agenda/revisão/follow-up): filial tem de ser da própria empresa.
 */
describe('Filial informada na criação é validada contra a empresa (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = `bv-${Date.now()}`;

  const A = () => world.A;
  const B = () => world.B;
  const aAdmin = () => bearer(tokenFor(A(), null, 'COMPANY_ADMIN'));
  const aSuperAdmin = () => ({ ...bearer(tokenFor(A(), null, 'SUPER_ADMIN')), 'X-Company-Id': A().companyId });
  const foreignBranch = () => B().branches[1].branchId;
  const ownBranch = () => A().branches[1].branchId;

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
    if (world) {
      // OS, contas e usuários criados pelo teste saem no destroyWorld (expurgo por empresa guiado pelas FKs)
      await destroyWorld(world);
    }
  });

  const osBody = (branchId: string) => ({
    branchId,
    customerId: A().customerId,
    motorcycleId: A().motorcycleId,
    entryKilometer: 1000,
    entryNotes: `${stamp}-os`,
  });

  it('OS: filial de OUTRA empresa é recusada', async () => {
    const res = await request(app).post('/api/service-orders').set(aAdmin()).send(osBody(foreignBranch()));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Filial não encontrada/);
    const leaked = await bypass<any[]>(() => db.serviceOrder.findMany({ where: { branchId: foreignBranch(), companyId: A().companyId } }));
    expect(leaked).toHaveLength(0);
  });

  it('OS: filial da própria empresa continua funcionando', async () => {
    const res = await request(app).post('/api/service-orders').set(aAdmin()).send(osBody(ownBranch()));
    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(ownBranch());
  });

  it('abrir caixa em filial de outra empresa é recusado', async () => {
    const res = await request(app)
      .post('/api/cash-register/open')
      .set(aAdmin())
      .send({ branchId: foreignBranch(), registerNumber: 901, openingAmount: 10 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Filial não encontrada/);
  });

  it('pedido de compra em filial de outra empresa é recusado', async () => {
    const res = await request(app)
      .post('/api/purchase-orders')
      .set(aSuperAdmin())
      .send({ branchId: foreignBranch(), supplierId: A().supplierId, items: [{ productId: A().branches[1].productId, quantity: 1, unitCost: 5 }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Filial não encontrada/);
  });

  it('conta a pagar com filial de outra empresa é recusada', async () => {
    const res = await request(app)
      .post('/api/financial/payables')
      .set(aSuperAdmin())
      .send({ branchId: foreignBranch(), description: `${stamp}-cp`, amount: 10, dueDate: new Date().toISOString() });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Filial não encontrada/);
  });

  it('usuário novo com filial de outra empresa é recusado', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(aAdmin())
      .send({ name: 'Operador X', email: `${stamp}-u@test.local`, password: 'Senha-forte-1', userType: 'OPERATOR', branchId: foreignBranch() });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Filial não encontrada/);
  });
});
