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
 * Pedido de ativação de equipamento: recusas de regra de negócio (licença pendente/suspensa, limite de equipamentos)
 * respondiam 500 e eram logadas como erro crítico. Precisam ser 409 com a mensagem, sem criar Device nem Activation.
 */
describe('POST /api/activations/request — recusas de regra de negócio (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;

  const license = (status: 'ACTIVE' | 'PENDING_APPROVAL' | 'SUSPENDED', maxDevices = 5) =>
    bypass<any>(() => db.license.create({ data: { companyId: fixture.companyId, licenseType: 'BASIC', status, maxDevices } }));
  const ask = (licenseId: string) =>
    request(app)
      .post('/api/activations/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ licenseId, deviceName: 'PDV Teste', deviceType: 'POS', macAddress: '02:00:00:00:10:01' });
  const devicesOf = (licenseId: string) => bypass<number>(() => db.device.count({ where: { licenseId } }));
  const activationsOf = (licenseId: string) => bypass<number>(() => db.activation.count({ where: { licenseId } }));

  beforeAll(async () => {
    fixture = await createFixture('actreq');
    token = generateAccessToken({ userId: fixture.userId, email: 'actreq@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'COMPANY_ADMIN' });
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (!fixture?.companyId) return;
    const companyId = fixture.companyId;
    await bypass(() => db.activation.deleteMany({ where: { license: { companyId } } }));
    await bypass(() => db.device.deleteMany({ where: { license: { companyId } } }));
    await bypass(() => db.license.deleteMany({ where: { companyId } }));
    await destroyFixture(fixture);
  });

  it.each(['PENDING_APPROVAL', 'SUSPENDED'] as const)('licença %s: 409, nada criado', async (status) => {
    const lic = await license(status);
    const res = await ask(lic.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Licença não está ativa/);
    expect(await devicesOf(lic.id)).toBe(0);
    expect(await activationsOf(lic.id)).toBe(0);
  });

  it('limite de equipamentos atingido: 409, nenhum equipamento a mais', async () => {
    const lic = await license('ACTIVE', 1);
    expect((await ask(lic.id)).status).toBe(201);
    const res = await ask(lic.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Limite de dispositivos atingido/);
    expect(await devicesOf(lic.id)).toBe(1);
    expect(await activationsOf(lic.id)).toBe(1);
  });

  it('controle: licença ativa com vaga cria o pedido PENDING', async () => {
    const lic = await license('ACTIVE');
    const res = await ask(lic.id);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    expect(await devicesOf(lic.id)).toBe(1);
  });
});
