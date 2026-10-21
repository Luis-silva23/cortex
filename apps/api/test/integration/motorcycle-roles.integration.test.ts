import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Moto é cadastro do cliente (permission-matrix.md, "Motos"): mesma regra de Clientes — quem recebe o cliente no
 * balcão/oficina cadastra a moto; editar/excluir fica com a gerência. Jornada real do balcão: OPERATOR criava o
 * cliente e abria OS, mas a moto dava 403 e a OS de cliente novo não saía.
 */
describe('Cadastro de moto por papel (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const A = () => world.A;
  const body = (plate: string) => ({ customerId: A().customerId, brand: 'Honda', model: 'CG 160', year: 2023, licensePlate: plate, kilometerReading: 0 });

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
      await bypass(() => db.motorcycle.deleteMany({ where: { companyId: A().companyId, licensePlate: { startsWith: 'MRL' } } }));
      await destroyWorld(world);
    }
  });

  it.each([['OPERATOR', 'MRL1A11'], ['MECHANIC', 'MRL1A12']])('%s cadastra a moto do cliente', async (role, plate) => {
    const res = await request(app).post('/api/motorcycles').set(bearer(tokenFor(A(), 1, role))).send(body(plate));
    expect(res.status).toBe(201);
  });

  it('VIEWER não cadastra moto', async () => {
    const res = await request(app).post('/api/motorcycles').set(bearer(tokenFor(A(), 1, 'VIEWER'))).send(body('MRL1A13'));
    expect(res.status).toBe(403);
  });

  it('OPERATOR não edita nem exclui moto', async () => {
    const put = await request(app).put(`/api/motorcycles/${A().motorcycleId}`).set(bearer(tokenFor(A(), 1, 'OPERATOR'))).send({ color: 'Azul' });
    const del = await request(app).delete(`/api/motorcycles/${A().motorcycleId}`).set(bearer(tokenFor(A(), 1, 'OPERATOR')));
    expect(put.status).toBe(403);
    expect(del.status).toBe(403);
  });

  it('moto não é vinculada a cliente de outra empresa', async () => {
    const res = await request(app).post('/api/motorcycles').set(bearer(tokenFor(A(), 1, 'OPERATOR'))).send({ ...body('MRL1A14'), customerId: world.B.customerId });
    expect(res.status).toBe(400);
  });
});
