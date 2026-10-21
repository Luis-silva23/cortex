import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * Login do PDV desktop com a identificação do equipamento. O Electron envia o MAC da máquina como `deviceId`, mas a
 * sessão de dispositivo aponta para `Device.id` (UUID): o MAC violava a chave estrangeira e o login do PDV quebrava.
 * Regra: o identificador de hardware (equipamento legado, sem chave) é resolvido para o equipamento cadastrado da empresa;
 * equipamento ativo abre a sessão; revogado/bloqueado/desconhecido/de outra empresa é RECUSADO (403) — equipamento não
 * autorizado não usa o sistema (antes, o desconhecido seguia sem sessão de equipamento e o login passava).
 * O fluxo novo (enrolamento + chave) tem o seu teste em device-authorization.integration.test.ts.
 */
describe('Login do PDV com identificação do equipamento (integração real)', () => {
  let fixture: IntegrationFixture;
  let other: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const PASSWORD = 'Senha-Pdv-123!';
  const stamp = `pdl-${Date.now()}`;
  let email: string;
  let activeDeviceId: string;

  const device = async (companyId: string, mac: string, status: 'ACTIVE' | 'REVOKED') => {
    const license = await bypass<any>(() => db.license.create({ data: { companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 5 } }));
    return bypass<any>(() => db.device.create({ data: { licenseId: license.id, deviceName: `PDV ${mac}`, deviceType: 'POS', status, macAddress: mac, createdAt: new Date('2026-09-01T12:00:00Z') } }));
  };
  const login = (deviceId: string) => request(app).post('/api/auth/login').send({ email, password: PASSWORD, deviceId });
  const sessions = () => bypass<any[]>(() => db.deviceSession.findMany({ where: { companyId: fixture.companyId } }));

  beforeAll(async () => {
    await resetAuthLimits();
    fixture = await createFixture('pdvlogin');
    other = await createFixture('pdvlogin-other');
    email = `${stamp}@test.local`;
    const hashed = await hashPassword(PASSWORD);
    await bypass(() => db.user.update({ where: { id: fixture.userId }, data: { email, password: hashed } }));
    activeDeviceId = (await device(fixture.companyId, '02:00:00:00:00:01', 'ACTIVE')).id;
    await device(fixture.companyId, '02:00:00:00:00:02', 'REVOKED');
    await device(other.companyId, '02:00:00:00:00:03', 'ACTIVE');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    for (const f of [fixture, other]) {
      if (!f) continue;
      await bypass(() => db.deviceSession.deleteMany({ where: { companyId: f.companyId } }));
      await destroyFixture(f);
    }
  });

  const endSessions = () => bypass(() => db.deviceSession.deleteMany({ where: { companyId: fixture.companyId } }));

  it('MAC desconhecido: login RECUSADO (403 DEVICE_UNKNOWN) — equipamento não autorizado não usa o sistema; sem sessão nem token', async () => {
    const res = await login('02:00:00:00:00:99');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEVICE_UNKNOWN');
    expect(res.body.accessToken).toBeUndefined();
    expect(await sessions()).toHaveLength(0);
  });

  it('MAC de equipamento ativo da empresa: login abre a sessão no equipamento cadastrado', async () => {
    const res = await login('02:00:00:00:00:01');
    expect(res.status).toBe(200);
    const s = await sessions();
    expect(s.map((x) => x.deviceId)).toEqual([activeDeviceId]);
    await endSessions();
  });

  it('MAC de equipamento revogado: login recusado', async () => {
    const res = await login('02:00:00:00:00:02');
    expect([401, 403]).toContain(res.status);
    expect(await sessions()).toHaveLength(0);
  });

  it('MAC de equipamento de outra empresa: tratado como desconhecido (403 DEVICE_UNKNOWN, sem revelar que existe)', async () => {
    const res = await login('02:00:00:00:00:03');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEVICE_UNKNOWN');
    expect(await sessions()).toHaveLength(0);
  });

  it('heartbeat de equipamento de outra empresa é recusado e não marca o equipamento como online', async () => {
    const before = await bypass<any>(() => db.device.findUnique({ where: { id: activeDeviceId } }));
    const intruder = generateAccessToken({ userId: other.userId, email: 'x@test.local', companyId: other.companyId, branchId: other.branchId, userType: 'OPERATOR' });
    const res = await request(app).post(`/api/activations/devices/${activeDeviceId}/heartbeat`).set('Authorization', `Bearer ${intruder}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await bypass<any>(() => db.device.findUnique({ where: { id: activeDeviceId } }));
    expect(after.lastSeenAt).toEqual(before.lastSeenAt);
  });
});
