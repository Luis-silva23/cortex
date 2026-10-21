import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db, prisma, runWithRLSContext } from '@ln-system/database';
import monitoringService from '../../src/services/monitoring.service';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Limites do monitoramento configuráveis pelo Super Admin (global → empresa → filial, com teto por métrica e
 * histórico) e alertas (um aberto por tipo+alvo, encerra ao normalizar, reabre em vez de duplicar). Dados reais:
 * telemetria gravada no banco e o job de avaliação real.
 */
describe('Monitoramento: limites configuráveis e alertas (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let deviceId: string;
  let silentDeviceId: string;
  let collected = Date.now() - 60_000;
  const A = () => world.A;
  const A1 = () => world.A.branches[1];
  const A2 = () => world.A.branches[2];
  const sa = () => bearer(tokenFor(A(), null, 'SUPER_ADMIN'));
  const caA = () => bearer(tokenFor(A(), null, 'COMPANY_ADMIN'));
  const caB = () => bearer(tokenFor(world.B, null, 'COMPANY_ADMIN'));
  const put = (auth: Record<string, string>, body: object) => request(app).put('/api/monitoring/thresholds').set(auth).send(body);
  const telemetry = (diskUsedPct: number, cpuLoadPct = 40) =>
    bypass(() =>
      db.deviceTelemetry.create({
        data: {
          companyId: A().companyId, branchId: A1().branchId, deviceId, userId: A1().userId, collectedAt: new Date((collected += 1000)),
          cpuLoadPct, memUsedPct: 50, diskUsedPct, apiRttMs: 50, packetLossPct: 0,
        },
      })
    );
  const alertsOf = (type: string, extra: object = {}) =>
    bypass<any[]>(() => db.monitoringAlert.findMany({ where: { companyId: A().companyId, type, ...extra }, orderBy: { startedAt: 'asc' } }));

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const license = await bypass<any>(() => db.license.create({ data: { companyId: A().companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 5 } }));
    deviceId = (await bypass<any>(() => db.device.create({ data: { licenseId: license.id, deviceName: 'PDV A1-01', deviceType: 'POS', status: 'ACTIVE' } }))).id;
    silentDeviceId = (await bypass<any>(() =>
      db.device.create({ data: { licenseId: license.id, deviceName: 'PDV A1-02', deviceType: 'POS', status: 'ACTIVE', lastSeenAt: new Date(Date.now() - 10 * 60_000) } })
    )).id;
    await bypass(() => db.deviceSession.create({ data: { deviceId, userId: A1().userId, companyId: A().companyId, branchId: A1().branchId } }));
    await bypass(() => db.deviceSession.create({ data: { deviceId: silentDeviceId, userId: A2().userId, companyId: A().companyId, branchId: A1().branchId } }));
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) {
      for (const companyId of [world.A.companyId, world.B.companyId]) {
        await bypass(() => db.monitoringAlert.deleteMany({ where: { companyId } }));
        await bypass(() => db.monitoringThreshold.deleteMany({ where: { companyId } }));
        await bypass(() => db.monitoringThresholdChange.deleteMany({ where: { companyId } }));
        await bypass(() => db.healthIncident.deleteMany({ where: { companyId } }));
        await bypass(() => db.deviceTelemetry.deleteMany({ where: { companyId } }));
        await bypass(() => db.deviceSession.deleteMany({ where: { companyId } }));
      }
      await bypass(() => db.device.deleteMany({ where: { license: { companyId: world.A.companyId } } }));
      await bypass(() => db.license.deleteMany({ where: { companyId: world.A.companyId } }));
      // limite global usado no teste de precedência (marcado pelo autor e pelo motivo)
      await bypass(() => db.monitoringThreshold.deleteMany({ where: { companyId: null, metric: 'lossPct', updatedBy: world.A.fixture.userId } }));
      await bypass(() => db.monitoringThresholdChange.deleteMany({ where: { companyId: null, reason: 'teste de precedência (integração)' } }));
      await destroyWorld(world);
    }
  }, 120000);

  describe('limites', () => {
    it('leitura: COMPANY_ADMIN vê a própria empresa (padrões), não vê outra; operador não acessa', async () => {
      const own = await request(app).get('/api/monitoring/thresholds').set(caA());
      expect(own.status).toBe(200);
      expect(own.body.scope.companyId).toBe(A().companyId);
      expect(own.body.metrics.find((m: any) => m.metric === 'diskPct')).toMatchObject({ attention: 85, critical: 95, source: 'DEFAULT' });
      expect((await request(app).get(`/api/monitoring/thresholds?companyId=${world.B.companyId}`).set(caA())).status).toBe(403);
      expect((await request(app).get('/api/monitoring/thresholds').set(bearer(tokenFor(A(), 1, 'OPERATOR')))).status).toBe(403);
    });

    it('escrita só pelo SUPER_ADMIN: administrador da empresa e gerente recebem 403 e nada é gravado', async () => {
      const body = { companyId: A().companyId, metric: 'cpuPct', attention: 90, critical: 99, reason: 'tentativa sem permissão' };
      expect((await put(caA(), body)).status).toBe(403);
      expect((await put(bearer(tokenFor(A(), 1, 'MANAGER')), body)).status).toBe(403);
      expect(await bypass<number>(() => db.monitoringThreshold.count({ where: { companyId: A().companyId } }))).toBe(0);
    });

    it('RLS: mesmo contornando a API, um usuário da empresa não grava limite no banco', async () => {
      await expect(
        runWithRLSContext({ companyId: A().companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
          prisma.monitoringThreshold.create({ data: { companyId: A().companyId, metric: 'diskPct', attention: 97, critical: 98, updatedBy: A().fixture.userId } })
        )
      ).rejects.toThrow();
    });

    it.each([
      [{ metric: 'diskPct', attention: 90, critical: 99.5 }, /não pode passar de 98/],
      [{ metric: 'apiP95Ms', attention: 5000, critical: 60000 }, /não pode passar de 10000/],
      [{ metric: 'cpuPct', attention: 95, critical: 90 }, /menor que o crítico/],
      [{ metric: 'inventada', attention: 1, critical: 2 }, /Métrica desconhecida/],
    ])('limite inválido %p → 400', async (values, message) => {
      const res = await put(sa(), { companyId: A().companyId, reason: 'teste de validação', ...values });
      expect(res.status).toBe(400);
      expect(res.body.error ?? res.body.message).toMatch(message);
    });

    it('motivo obrigatório; filial de outra empresa → 404', async () => {
      expect((await put(sa(), { companyId: A().companyId, metric: 'cpuPct', attention: 70, critical: 90 })).status).toBe(400);
      expect((await put(sa(), { companyId: A().companyId, branchId: world.B.branches[1].branchId, metric: 'cpuPct', attention: 70, critical: 90, reason: 'escopo errado' })).status).toBe(404);
    });

    it('precedência filial > empresa > global, histórico com autor e motivo, e remoção volta ao escopo acima', async () => {
      expect((await put(sa(), { metric: 'lossPct', attention: 3, critical: 12, reason: 'teste de precedência (integração)' })).status).toBe(200);
      expect((await put(sa(), { companyId: A().companyId, metric: 'lossPct', attention: 4, critical: 15, reason: 'empresa A' })).status).toBe(200);
      expect((await put(sa(), { companyId: A().companyId, branchId: A1().branchId, metric: 'lossPct', attention: 1, critical: 5, reason: 'filial A1' })).status).toBe(200);
      const effective = async (companyId: string, branchId?: string) =>
        (await request(app).get(`/api/monitoring/thresholds?companyId=${companyId}${branchId ? `&branchId=${branchId}` : ''}`).set(sa())).body.metrics.find((m: any) => m.metric === 'lossPct');
      expect(await effective(A().companyId, A1().branchId)).toMatchObject({ attention: 1, critical: 5, source: 'BRANCH' });
      expect(await effective(A().companyId, A2().branchId)).toMatchObject({ attention: 4, critical: 15, source: 'COMPANY' });
      expect(await effective(world.B.companyId)).toMatchObject({ attention: 3, critical: 12, source: 'GLOBAL' });

      const del = await request(app).delete('/api/monitoring/thresholds').set(sa()).send({ companyId: A().companyId, branchId: A1().branchId, metric: 'lossPct', reason: 'volta ao da empresa' });
      expect(del.status).toBe(200);
      expect(await effective(A().companyId, A1().branchId)).toMatchObject({ attention: 4, critical: 15, source: 'COMPANY' });

      const history = await request(app).get(`/api/monitoring/thresholds/history?companyId=${A().companyId}`).set(caA());
      const branchChanges = history.body.changes.filter((c: any) => c.branchId === A1().branchId && c.metric === 'lossPct');
      expect(branchChanges.map((c: any) => [c.oldCritical, c.newCritical])).toEqual([[5, null], [null, 5]]);
      expect(branchChanges.every((c: any) => c.changedBy && c.reason)).toBe(true);
      expect(JSON.stringify(auditSpy.mock.calls)).toContain('MonitoringThreshold');
    });

    it('o limite configurado muda o estado calculado: CPU 65% é NORMAL no padrão e ATENÇÃO com limite de 60%', async () => {
      await telemetry(50, 65);
      // no contexto RLS da empresa, como a rota e o job fazem (fora dele o banco não devolve nada → "Sem dados")
      const health = () =>
        runWithRLSContext({ companyId: A().companyId, userType: 'SUPER_ADMIN', branchId: null }, () => monitoringService.branchHealth(A().companyId, A1().branchId));
      expect((await health()).host.status).toBe('NORMAL');
      await put(sa(), { companyId: A().companyId, branchId: A1().branchId, metric: 'cpuPct', attention: 60, critical: 90, reason: 'filial com máquina fraca' });
      const h = await health();
      expect(h.host.status).toBe('ATTENTION');
      expect(h.thresholds.cpuPct).toMatchObject({ attention: 60, source: 'BRANCH' });
      await request(app).delete('/api/monitoring/thresholds').set(sa()).send({ companyId: A().companyId, branchId: A1().branchId, metric: 'cpuPct', reason: 'fim do teste' });
    });
  });

  describe('alertas', () => {
    it('disco crítico abre UM alerta com empresa, filial, métrica, valor e limite; nova avaliação não duplica', async () => {
      await telemetry(96);
      await monitoringService.evaluateIncidents();
      await monitoringService.evaluateIncidents();
      const alerts = await alertsOf('HOST_DISK');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ source: 'BRANCH', branchId: A1().branchId, metric: 'diskPct', severity: 'CRITICAL', value: 96, threshold: 95, endedAt: null, occurrences: 1 });
    });

    it('normalizou → alerta encerrado (recuperação registrada)', async () => {
      await telemetry(50);
      await monitoringService.evaluateIncidents();
      const [alert] = await alertsOf('HOST_DISK');
      expect(alert.endedAt).not.toBeNull();
    });

    it('oscilação logo depois: o mesmo alerta é reaberto (occurrences 2), sem criar outro', async () => {
      await telemetry(97);
      await monitoringService.evaluateIncidents();
      const alerts = await alertsOf('HOST_DISK');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ endedAt: null, occurrences: 2, value: 97 });
    });

    it('equipamento sem contato (heartbeat parado): alerta de perda de comunicação com o equipamento; volta → encerra', async () => {
      await monitoringService.evaluateIncidents();
      const [offline] = await alertsOf('DEVICE_OFFLINE', { deviceId: silentDeviceId });
      expect(offline).toMatchObject({ source: 'DEVICE', severity: 'OFFLINE', endedAt: null });
      expect(offline.value).toBeGreaterThanOrEqual(9);
      expect((await alertsOf('DEVICE_OFFLINE', { deviceId })).filter((a) => !a.endedAt)).toHaveLength(0);

      await bypass(() => db.device.update({ where: { id: silentDeviceId }, data: { lastSeenAt: new Date() } }));
      await monitoringService.evaluateIncidents();
      expect((await alertsOf('DEVICE_OFFLINE', { deviceId: silentDeviceId }))[0].endedAt).not.toBeNull();
    });

    it('filial sem telemetria (Sem dados) não abre alerta de servidor/rede', async () => {
      await monitoringService.evaluateIncidents();
      const noData = await bypass<any[]>(() =>
        db.monitoringAlert.findMany({ where: { companyId: A().companyId, branchId: A2().branchId, type: { in: ['HOST_CPU', 'HOST_MEMORY', 'HOST_DISK', 'NETWORK_LATENCY', 'NETWORK_LOSS'] } } })
      );
      expect(noData).toHaveLength(0);
    });

    it('listagem: COMPANY_ADMIN vê os da própria empresa, não os de outra; alertas centrais só SUPER_ADMIN', async () => {
      const own = await request(app).get(`/api/monitoring/companies/${A().companyId}/alerts?open=true`).set(caA());
      expect(own.status).toBe(200);
      expect(own.body.alerts.some((a: any) => a.type === 'HOST_DISK')).toBe(true);
      expect((await request(app).get(`/api/monitoring/companies/${A().companyId}/alerts`).set(caB())).status).toBe(403);
      expect((await request(app).get('/api/monitoring/central/alerts').set(caA())).status).toBe(403);
      expect((await request(app).get('/api/monitoring/central/alerts').set(sa())).status).toBe(200);
    });
  });
});
