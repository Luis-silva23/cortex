import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Caixa é do operador que o abriu (business-state-machines.md, "Caixa — quem opera"). Jornada real do PDV: outro
 * OPERATOR da mesma filial fechava (HTTP 200) o caixa do colega. OPERATOR só opera o próprio caixa; MANAGER opera os
 * da sua filial (supervisão); COMPANY_ADMIN/SUPER_ADMIN, os da empresa.
 */
describe('Caixa de outro operador (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let registerId: string;
  let intruder: string;
  let supervisor: string;
  const stamp = `cro-${Date.now()}`;
  const A = () => world.A;

  async function user(userType: 'OPERATOR' | 'MANAGER') {
    const u = await bypass<any>(() =>
      db.user.create({
        data: { companyId: A().companyId, branchId: A().branches[1].branchId, name: `${stamp} ${userType}`, email: `${stamp}-${userType}@test.local`, password: 'not-a-real-hash', userType, isActive: true },
      })
    );
    return generateAccessToken({ userId: u.id, email: u.email, companyId: A().companyId, branchId: A().branches[1].branchId, userType });
  }
  const register = () => bypass<any>(() => db.cashRegister.findUnique({ where: { id: registerId } }));
  const movements = (type: string) => bypass<any[]>(() => db.cashMovement.findMany({ where: { cashRegisterId: registerId, movementType: type as any } }));

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    registerId = A().fixture.cashRegisterId;
    intruder = await user('OPERATOR');
    supervisor = await user('MANAGER');
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) {
      await bypass(() => db.user.deleteMany({ where: { companyId: A().companyId, email: { startsWith: stamp } } }));
      await destroyWorld(world);
    }
  });

  it('OPERATOR não fecha o caixa de outro operador', async () => {
    const res = await request(app).post(`/api/cash-register/${registerId}/close`).set(bearer(intruder)).send({ actualAmount: 0 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await register()).status).toBe('OPEN');
  });

  it('OPERATOR não lança reforço no caixa de outro operador', async () => {
    const res = await request(app).post('/api/cash-register/movement').set(bearer(intruder)).send({ cashRegisterId: registerId, movementType: 'DEPOSIT', amount: 5, notes: 'intruso' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await movements('DEPOSIT')).toHaveLength(0);
  });

  it('OPERATOR não pede retirada do caixa de outro operador', async () => {
    const res = await request(app).post(`/api/cash-register/${registerId}/withdrawal`).set(bearer(intruder)).send({ amount: 5, reason: 'intruso', authorizerNumericId: 1, authorizerPassword: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/outro operador/);
    expect(await movements('WITHDRAWAL')).toHaveLength(0);
  });

  it('OPERATOR não vende no caixa de outro operador', async () => {
    const res = await request(app).post('/api/sales').set(bearer(intruder)).send({
      branchId: A().branches[1].branchId, cashRegisterId: registerId,
      items: [{ productId: A().branches[1].productId, quantity: 1, unitPrice: 10 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/outro operador/);
  });

  it('o dono lança reforço no próprio caixa', async () => {
    const res = await request(app).post('/api/cash-register/movement').set(bearer(tokenFor(A(), 1, 'OPERATOR'))).send({ cashRegisterId: registerId, movementType: 'DEPOSIT', amount: 5, notes: 'troco' });
    expect(res.status).toBe(201);
  });

  it('MANAGER da filial fecha o caixa esquecido do operador (supervisão)', async () => {
    // Informado ≠ esperado: desde 2026-09-28 a divergência exige motivo (política cash.requireDifferenceReason).
    const res = await request(app)
      .post(`/api/cash-register/${registerId}/close`)
      .set(bearer(supervisor))
      .send({ actualAmount: 105, differenceReason: 'Caixa esquecido aberto; contagem da supervisão' });
    expect(res.status).toBe(200);
    expect((await register()).status).toBe('CLOSED');
  });
});
