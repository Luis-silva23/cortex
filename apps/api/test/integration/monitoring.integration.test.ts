import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import monitoringService from '../../src/services/monitoring.service';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Monitoramento Empresa → Filial com dados reais (request_logs + telemetria do equipamento). Prova a ingestão protegida
 * (identidade vem da sessão do equipamento; replay/duplicata/frequência), os estados calculados, a autorização
 * (SUPER_ADMIN qualquer empresa, COMPANY_ADMIN só a própria), as séries agregadas, o detalhamento por endpoint e o
 * ciclo de incidente (abre ao degradar, encerra ao normalizar).
 */
describe('Monitoramento por empresa e filial (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let deviceId: string;
  const A = () => world.A;
  const A1 = () => world.A.branches[1];
  const operatorA1 = () => bearer(tokenFor(A(), 1, 'OPERATOR'));
  const superAdmin = () => bearer(tokenFor(A(), null, 'SUPER_ADMIN'));
  const telemetry = (body: object, auth = operatorA1()) => request(app).post('/api/telemetry').set(auth).send(body);
  const base = { cpuLoadPct: 50, memUsedPct: 60, diskUsedPct: 90, apiRttMs: 120, packetLossPct: 0, appVersion: '1.0.0', runtimeVersion: 'electron 28.3.3 · node 18.18.2 · chrome 120', uptimeSec: 3600 };

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const license = await bypass<any>(() => db.license.create({ data: { companyId: A().companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 5 } }));
    deviceId = (await bypass<any>(() => db.device.create({ data: { licenseId: license.id, deviceName: 'PDV A1-01', deviceType: 'POS', status: 'ACTIVE' } }))).id;
    await bypass(() => db.deviceSession.create({ data: { deviceId, userId: A1().userId, companyId: A().companyId, branchId: A1().branchId } }));

    // 50 requisições reais da filial A1 nos últimos minutos: 1 erro 5xx (2% → ATENÇÃO), latência baixa
    const now = Date.now();
    await bypass(() =>
      db.requestLog.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({
          requestId: randomUUID(), method: 'GET', route: i % 2 ? '/api/sales' : '/api/products', statusCode: i === 0 ? 500 : 200,
          durationMs: 80 + i, companyId: A().companyId, branchId: A1().branchId, createdAt: new Date(now - (i % 10) * 60_000),
        })),
      })
    );
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) {
      for (const companyId of [world.A.companyId, world.B.companyId]) {
        await bypass(() => db.requestLog.deleteMany({ where: { companyId } }));
        await bypass(() => db.deviceTelemetry.deleteMany({ where: { companyId } }));
        await bypass(() => db.healthIncident.deleteMany({ where: { companyId } }));
        await bypass(() => db.deviceSession.deleteMany({ where: { companyId } }));
      }
      await destroyWorld(world);
    }
  }, 120000);

  describe('ingestão', () => {
    it('grava a telemetria na empresa/filial/equipamento da sessão, ignorando o que vier no corpo', async () => {
      const res = await telemetry({ ...base, collectedAt: new Date().toISOString(), companyId: world.B.companyId, branchId: world.B.branches[1].branchId, deviceId: randomUUID() });
      expect(res.status).toBe(201);
      const rows = await bypass<any[]>(() => db.deviceTelemetry.findMany({ where: { deviceId } }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ companyId: A().companyId, branchId: A1().branchId, userId: A1().userId, diskUsedPct: 90 });
    });

    it('replay com horário antigo é recusado; mesma coleta é ignorada; outra coleta em menos de 30 s é recusada', async () => {
      expect((await telemetry({ ...base, collectedAt: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(400);
      const last = await bypass<any>(() => db.deviceTelemetry.findFirst({ where: { deviceId }, orderBy: { collectedAt: 'desc' } }));
      const dup = await telemetry({ ...base, collectedAt: new Date(last.collectedAt).toISOString() });
      expect([dup.status, dup.body.duplicate]).toEqual([200, true]);
      expect((await telemetry({ ...base, collectedAt: new Date(new Date(last.collectedAt).getTime() + 5_000).toISOString() })).status).toBe(429);
    });

    it('usuário sem equipamento ativo não envia telemetria', async () => {
      // Usuário da empresa sem filial: as requisições deste arquivo viram request_logs reais, e a filial A2 precisa
      // continuar sem tráfego para o caso "sem dados" abaixo.
      // (o escopo vem do banco: precisa ser outro usuário REAL da empresa, na filial A1, que nunca teve sessão de equipamento)
      const semEquipamento = await bypass<any>(() =>
        db.user.create({ data: { companyId: A().companyId, branchId: A1().branchId, name: 'Operador sem equipamento', email: `op-sem-eq-${Date.now()}@test.local`, password: 'not-a-real-hash', userType: 'OPERATOR', isActive: true } })
      );
      const token = bearer(generateAccessToken({ userId: semEquipamento.id, email: 'op@test.local', companyId: A().companyId, branchId: A1().branchId, userType: 'OPERATOR' } as any));
      expect((await telemetry({ ...base, collectedAt: new Date().toISOString() }, token)).status).toBe(409);
    });
  });

  describe('saúde', () => {
    it('empresa: filial A1 com API em atenção (2% de 5xx), servidor em atenção (disco 90%), rede normal, 1/1 equipamento; A2 sem dados', async () => {
      const res = await request(app).get(`/api/monitoring/companies/${A().companyId}/health`).set(superAdmin());
      expect(res.status).toBe(200);
      const a1 = res.body.branches.find((b: any) => b.id === A1().branchId);
      const a2 = res.body.branches.find((b: any) => b.id === A().branches[2].branchId);
      expect(a1).toMatchObject({ api: 'ATTENTION', host: 'ATTENTION', network: 'NORMAL', devices: { status: 'NORMAL', online: 1, total: 1 }, status: 'ATTENTION' });
      expect(a2).toMatchObject({ api: 'NO_DATA', host: 'NO_DATA', network: 'NO_DATA', status: 'NO_DATA' });
      expect(res.body.central.database.status).not.toBe('OFFLINE');
      expect(res.body.central.redis.status).not.toBe('OFFLINE');
    });

    it('filial: detalhe com números reais', async () => {
      const res = await request(app).get(`/api/monitoring/companies/${A().companyId}/branches/${A1().branchId}/health`).set(superAdmin());
      // as 50 requisições semeadas + as chamadas deste próprio teste (também registradas em request_logs)
      expect(res.body.api.requests).toBeGreaterThanOrEqual(50);
      expect(res.body.api.errorRatePct).toBeGreaterThanOrEqual(1);
      expect(res.body.api.errorRatePct).toBeLessThanOrEqual(2);
      expect(res.body.host).toMatchObject({ cpuPct: 50, memPct: 60, diskPct: 90 });
      expect(res.body.network).toMatchObject({ rttMs: 120, lossPct: 0 });
      // versão do app e do runtime separadas (o PDV não empacotado reportava a versão do Electron como a do app)
      expect(res.body.devices.list[0]).toMatchObject({ id: deviceId, online: true, appVersion: '1.0.0', runtimeVersion: 'electron 28.3.3 · node 18.18.2 · chrome 120' });
    });

    it('séries agregadas e endpoints', async () => {
      const series = await request(app).get(`/api/monitoring/companies/${A().companyId}/branches/${A1().branchId}/series?range=1h`).set(superAdmin());
      expect(series.body.bucketSec).toBe(60);
      expect(series.body.api.reduce((acc: number, p: any) => acc + p.requests, 0)).toBeGreaterThanOrEqual(50);
      expect(series.body.telemetry[0]).toMatchObject({ cpuPct: 50, devices: 1 });
      const endpoints = await request(app).get(`/api/monitoring/companies/${A().companyId}/branches/${A1().branchId}/endpoints?range=1h`).set(superAdmin());
      expect(endpoints.body.endpoints.map((e: any) => e.route)).toEqual(expect.arrayContaining(['/api/products', '/api/sales']));
    });
  });

  describe('autorização', () => {
    it('COMPANY_ADMIN vê a própria empresa e não vê outra; operador e gerente não acessam', async () => {
      expect((await request(app).get(`/api/monitoring/companies/${A().companyId}/health`).set(bearer(tokenFor(A(), null, 'COMPANY_ADMIN')))).status).toBe(200);
      expect((await request(app).get(`/api/monitoring/companies/${world.B.companyId}/health`).set(bearer(tokenFor(A(), null, 'COMPANY_ADMIN')))).status).toBe(403);
      expect((await request(app).get(`/api/monitoring/companies/${A().companyId}/health`).set(operatorA1())).status).toBe(403);
      expect((await request(app).get(`/api/monitoring/companies/${A().companyId}/health`).set(bearer(tokenFor(A(), 1, 'MANAGER')))).status).toBe(403);
    });

    it('filial de outra empresa no caminho → 404', async () => {
      const res = await request(app).get(`/api/monitoring/companies/${A().companyId}/branches/${world.B.branches[1].branchId}/health`).set(superAdmin());
      expect(res.status).toBe(404);
    });
  });

  it('incidentes: abrem ao degradar e encerram quando o componente normaliza', async () => {
    await monitoringService.evaluateIncidents();
    const open = await bypass<any[]>(() => db.healthIncident.findMany({ where: { companyId: A().companyId, branchId: A1().branchId, endedAt: null } }));
    expect(open.map((i) => i.component).sort()).toEqual(['API', 'HOST']);

    await bypass(() => db.deviceTelemetry.create({
      data: { companyId: A().companyId, branchId: A1().branchId, deviceId, userId: A1().userId, collectedAt: new Date(Date.now() + 1000), cpuLoadPct: 40, memUsedPct: 50, diskUsedPct: 50, apiRttMs: 100, packetLossPct: 0 },
    }));
    await monitoringService.evaluateIncidents();
    const host = await bypass<any>(() => db.healthIncident.findFirst({ where: { companyId: A().companyId, branchId: A1().branchId, component: 'HOST' } }));
    expect(host.endedAt).not.toBeNull();
    const list = await request(app).get(`/api/monitoring/companies/${A().companyId}/incidents?branchId=${A1().branchId}`).set(superAdmin());
    expect(list.body.incidents.length).toBeGreaterThanOrEqual(2);
  });
});
