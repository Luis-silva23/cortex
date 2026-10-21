import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { advancedRateLimiter } from '../../src/middlewares/advancedRateLimit';
import { prismaUnsafeBypassRLS as db, runInTransaction, runWithRLSContext, prisma } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import monitoringService from '../../src/services/monitoring.service';
import { __resetSampler, runCentralEvaluation } from '../../src/services/monitoring-central/sampler.service';
import { __resetSettingsCache } from '../../src/services/monitoring-central/settings.service';
import { __resetDeliveryCache } from '../../src/services/monitoring-central/deliveries';
import { __resetResendBreaker } from '../../src/services/monitoring-central/resend.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * CENTRAL DE MONITORAMENTO (Super Admin) — Postgres e Redis reais, papel real de execução, empresas sintéticas "Integration Test Co".
 * Prova: (1) SÓ o Super Admin chega às rotas da Central (administrador, gerente e operador recebem 403 em TODAS, inclusive as de escrita) e as rotas antigas de
 * monitoramento continuam como eram; (2) a visão executiva, a comparação entre empresas e o detalhe de uma empresa trazem dado REAL e nenhuma empresa vê a outra (integrações,
 * alertas, usos); (3) o percentual de saúde das integrações segue a fórmula e fica `null` (não 100%) sem integração verificada; (4) o ciclo do alerta (reconhecer, assumir, tratar,
 * resolver com justificativa, reabrir, anotar) grava histórico imutável e recusa transição inválida; (5) a reincidência reabre o alerta e zera o tratamento; (6) o aviso por e-mail
 * respeita deduplicação e só sai com provedor configurado (rede SIMULADA — nenhum e-mail real); (7) o funil comercial registra etapas e calcula conversão; (8) as 6 tabelas
 * novas são negadas, por RLS, a qualquer papel de empresa; (9) ajustes só restringem; (10) o coletor grava amostras no intervalo, respeita o teto diário e avalia backup.
 */
const SA_CONTEXT = { companyId: null, userType: 'SUPER_ADMIN', branchId: null } as const;
const asPlatform = <T>(fn: () => Promise<T>) => runWithRLSContext(SA_CONTEXT as any, async () => await fn());
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null } as any, async () => await fn());
/** Expurgo sinalizado (histórico append-only): só dados SINTÉTICOS deste teste. */
const purge = <T>(fn: (tx: any) => Promise<T>) =>
  asPlatform(() =>
    runInTransaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
      return fn(tx);
    })
  );

const stamp = Date.now();
const UUID0 = '00000000-0000-4000-8000-000000000000';
const CENTRAL = '/api/monitoring/central';

describe('Central de Monitoramento', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let C: IntegrationFixture;
  let app: express.Express;
  let saId: string;
  let saToken: string;
  let adminA: string;
  let managerA: string;
  let operatorA: string;
  let auditSpy: jest.SpyInstance;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (p: string, t = saToken) => request(app).get(`${CENTRAL}${p}`).set(bearer(t));
  const post = (p: string, body: object = {}, t = saToken) => request(app).post(`${CENTRAL}${p}`).set(bearer(t)).send(body);
  const resetGeneralLimit = async () => {
    for (const ip of ['::ffff:127.0.0.1', '::1', '127.0.0.1']) await advancedRateLimiter.reset('general', ip);
  };
  const state: Record<string, any> = {};
  const alertIds = new Set<string>();
  const leadIds = new Set<string>();
  const syntheticNow = new Date(Date.UTC(2020, 0, 1, 12, 0, 0) + (stamp % 1_000_000) * 1000);
  const envBackup = { ...process.env };
  let tmpDir: string;

  const platformAlert = (over: Record<string, unknown> = {}) => ({
    source: 'COMPANY' as const,
    companyId: A.companyId,
    branchId: null,
    deviceId: null,
    type: 'INTEGRATION_HEALTH',
    metric: 'integrationHealth',
    value: 0,
    threshold: null,
    status: 'CRITICAL' as const,
    detail: 'Canal de teste: o último teste de conexão falhou',
    ...over,
  });
  const openAlert = async (cond = platformAlert(), when = new Date()) => {
    await asPlatform(() => monitoringService.applyAlert(cond as any, when));
    const row = await bypass<any>(() => db.monitoringAlert.findFirst({ where: { type: cond.type, companyId: cond.companyId as string | null, endedAt: null } }));
    alertIds.add(row.id);
    return row.id as string;
  };

  beforeAll(async () => {
    A = await createFixture(`mc${stamp}a`);
    B = await createFixture(`mc${stamp}b`);
    C = await createFixture(`mc${stamp}c`);
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const hash = await hashPassword(`Sa-${stamp}-Forte1`);
    const sa = await bypass<any>(() => db.user.create({ data: { companyId: null, name: 'SA central', email: `mc-sa-${stamp}@teste-cortex.local`, password: hash, userType: 'SUPER_ADMIN', isActive: true } }));
    saId = sa.id;
    saToken = generateAccessToken({ userId: sa.id, email: sa.email, userType: 'SUPER_ADMIN' } as any);
    const forA = (userType: string, branchId?: string) => generateAccessToken({ userId: A.userId, email: `${userType.toLowerCase()}@test.local`, companyId: A.companyId, branchId: branchId as any, userType } as any);
    adminA = forA('COMPANY_ADMIN');
    managerA = forA('MANAGER', A.branchId);
    operatorA = forA('OPERATOR', A.branchId);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mc-'));

    // canais: A com ERRO, B conectado e sem entregas esgotadas, C sem canal algum
    await bypass(() => db.salesChannel.create({ data: { companyId: A.companyId, type: 'OUTRO', displayName: `Canal ERRO ${stamp}`, isActive: true, provider: 'sandbox', connectionStatus: 'ERROR', createdBy: A.userId } }));
    await bypass(() => db.salesChannel.create({ data: { companyId: B.companyId, type: 'OUTRO', displayName: `Canal SAUDAVEL ${stamp}`, isActive: true, provider: 'sandbox', connectionStatus: 'CONNECTED', createdBy: B.userId } }));
    // requisições: A (4 em vendas, 1 delas 500; 2 em produtos), B (3)
    const rl = (i: number, companyId: string, route: string, statusCode: number, durationMs: number) => ({ requestId: `mc-${stamp}-${i}`, method: 'GET', route, statusCode, durationMs, companyId });
    await bypass(() =>
      db.requestLog.createMany({
        data: [
          rl(1, A.companyId, '/api/sales/', 200, 100), rl(2, A.companyId, '/api/sales/', 200, 120), rl(3, A.companyId, '/api/sales/:id', 200, 140), rl(4, A.companyId, '/api/sales/', 500, 900),
          rl(5, A.companyId, '/api/products/:id', 200, 80), rl(6, A.companyId, '/api/products/:id', 200, 90),
          rl(7, B.companyId, '/api/sales/', 200, 60), rl(8, B.companyId, '/api/sales/', 200, 70), rl(9, B.companyId, '/api/inventory/:id', 200, 50),
        ],
      })
    );
    await resetGeneralLimit();
  }, 120000);

  beforeEach(async () => {
    await resetGeneralLimit();
  });

  afterAll(async () => {
    Object.assign(process.env, envBackup);
    for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
    jest.restoreAllMocks();
    auditSpy?.mockRestore();
    __resetSettingsCache();
    // alertas e histórico criados aqui: por id (e os do coletor, marcados pelo instante sintético)
    const synthetic = await bypass<any[]>(() => db.monitoringAlert.findMany({ where: { startedAt: syntheticNow }, select: { id: true } }));
    for (const s of synthetic) alertIds.add(s.id);
    const ids = [...alertIds];
    if (ids.length) {
      await purge((tx) => tx.$executeRaw`DELETE FROM monitoring_alert_events WHERE "alertId" = ANY(${ids}::text[])`);
      await purge((tx) => tx.monitoringAlert.deleteMany({ where: { id: { in: ids } } }));
    }
    await purge((tx) => tx.serviceHealthSample.deleteMany({ where: { id: { not: '' }, sampledAt: syntheticNow } }));
    const leads = [...leadIds];
    if (leads.length) {
      await purge((tx) => tx.commercialLeadEvent.deleteMany({ where: { id: { not: '' }, leadId: { in: leads } } }));
      await purge((tx) => tx.commercialLead.deleteMany({ where: { id: { in: leads } } }));
    }
    await purge((tx) => tx.externalDelivery.deleteMany({ where: { id: { not: '' }, dedupeKey: { startsWith: `alert:INTEGRATION_HEALTH:${B.companyId}` } } }));
    await purge((tx) => tx.$executeRaw`DELETE FROM monitoring_settings WHERE key = 'config'`);
    await bypass(() => db.requestLog.deleteMany({ where: { id: { not: '' }, companyId: { in: [A.companyId, B.companyId, C.companyId] }, requestId: { startsWith: `mc-${stamp}-` } } }));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (saId) {
      await bypass(() => db.refreshToken.deleteMany({ where: { userId: saId, companyId: null } }));
      await bypass(() => db.user.deleteMany({ where: { id: saId, companyId: null } }));
    }
    for (const f of [A, B, C]) if (f?.companyId) await destroyFixture(f);
  }, 120000);

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('acesso: só o Super Admin', () => {
    // linhas SEMPRE com 3 elementos: com menos, o jest entende o 3º parâmetro como o callback `done` e o teste nunca termina
    const endpoints: Array<[string, string, object]> = [
      ['get', '/overview', {}],
      ['get', '/series', {}],
      ['get', '/meta', {}],
      ['get', '/companies', {}],
      ['get', `/companies/${UUID0}`, {}],
      ['get', '/alert-center', {}],
      ['get', '/alert-center/assignees', {}],
      ['get', `/alert-center/${UUID0}`, {}],
      ['post', `/alert-center/${UUID0}/actions`, { action: 'ACKNOWLEDGE' }],
      ['get', '/funnel', {}],
      ['get', '/funnel/leads', {}],
      ['post', '/funnel/leads', { name: 'Intruso' }],
      ['post', `/funnel/leads/${UUID0}/move`, { stage: 'DEMO' }],
      ['post', `/funnel/leads/${UUID0}/link-company`, { companyId: UUID0 }],
      ['get', '/external', {}],
      ['post', '/external/resend/check', {}],
      ['get', '/settings', {}],
      ['put', '/settings', { toggles: { sentry: false } }],
    ];

    it.each(endpoints)('sem token: %s %s → 401', async (method, p, body) => {
      const res = await (request(app) as any)[method](`${CENTRAL}${p}`).send(body ?? {});
      expect(res.status).toBe(401);
    });

    for (const [label, token] of [['administrador da empresa', () => adminA], ['gerente', () => managerA], ['operador', () => operatorA]] as const) {
      it.each(endpoints)(`${label}: %s %s → 403`, async (method, p, body) => {
        const res = await (request(app) as any)[method](`${CENTRAL}${p}`).set(bearer(token())).send(body ?? {});
        expect(res.status).toBe(403);
      });
    }

    it('as rotas ANTIGAS de monitoramento seguem como eram: o administrador vê a PRÓPRIA empresa e não a de outra; o alerta central continua só do Super Admin', async () => {
      const own = await request(app).get(`/api/monitoring/companies/${A.companyId}/health`).set(bearer(adminA));
      expect(own.status).toBe(200);
      const other = await request(app).get(`/api/monitoring/companies/${B.companyId}/health`).set(bearer(adminA));
      expect(other.status).toBe(403);
      expect((await request(app).get('/api/monitoring/central/alerts').set(bearer(saToken))).status).toBe(200);
      expect((await request(app).get('/api/monitoring/central/alerts').set(bearer(adminA))).status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('visão executiva, séries e comparação entre empresas', () => {
    it('a visão executiva traz as definições, o frescor da coleta e os blocos (sem inventar o que falta)', async () => {
      delete process.env.BACKUP_PUBLIC_DIR;
      const res = await get('/overview?range=24h');
      expect(res.status).toBe(200);
      expect(res.body.range).toBe('24h');
      expect(typeof res.body.generatedAt).toBe('string');
      expect(res.body.definitions.availability).toMatch(/lacuna/);
      expect(res.body.definitions.integrationHealth).toMatch(/nunca 100%/);
      expect(res.body.freshness).toHaveProperty('stale');
      expect(res.body.companies.total).toBeGreaterThanOrEqual(3);
      expect(res.body.api.requests).toBeGreaterThanOrEqual(9);
      expect(res.body.backup).toMatchObject({ configured: false, status: 'NO_DATA', level: 'NONE' });
      expect(res.body.backup.restoreTested.recorded).toBe(false);
      expect(res.body.infra.database).toMatchObject({ status: expect.any(String) });
      expect(res.body.environment.local).toBe(true);
    });

    it('período inválido cai no padrão e a série traz as requisições reais (p95 e 5xx) por balde', async () => {
      expect((await get('/overview?range=xyz')).body.range).toBe('24h');
      const res = await get('/series?range=24h');
      expect(res.status).toBe(200);
      expect(res.body.bucketSeconds).toBeGreaterThan(0);
      const total = res.body.api.reduce((s: number, p: any) => s + p.requests, 0);
      const errors = res.body.api.reduce((s: number, p: any) => s + p.errors, 0);
      expect(total).toBeGreaterThanOrEqual(9);
      expect(errors).toBeGreaterThanOrEqual(1);
      expect(res.body.api.every((p: any) => typeof p.t === 'number')).toBe(true);
      expect(res.body.companies.coverage.note).toMatch(/a partir do início da coleta/);
    });

    it('REGRESSÃO da tela Performance: percentis e série de requisições da observabilidade vêm do banco (antes o SQL cru perdia o contexto de RLS e devolvia p95 = 0 e série vazia)', async () => {
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const res = await request(app).get(`/api/observability/metrics?startDate=${encodeURIComponent(since)}`).set(bearer(saToken));
      expect(res.status).toBe(200);
      expect(res.body.requestCount).toBeGreaterThanOrEqual(9);
      expect(res.body.p95).toBeGreaterThan(0);
      expect(res.body.p50).toBeGreaterThan(0);
      expect(res.body.requestsOverTime.length).toBeGreaterThan(0);
    });

    it('comparação: A tem integração com ERRO (0%), B saudável (100%) e C sem integração verificada (null — não 100%)', async () => {
      const res = await get(`/companies?range=24h&q=mc${stamp}&limit=50&sort=name`);
      expect(res.status).toBe(200);
      const by = (f: IntegrationFixture) => res.body.items.find((i: any) => i.id === f.companyId);
      expect(res.body.total).toBe(3);
      // as próprias chamadas de teste do administrador de A (403) também são requisições registradas dele: o mínimo são as 6 semeadas; 5xx continua sendo só o semeado
      expect(by(A)).toMatchObject({ integrationHealthPct: 0, errors: 1, integrations: { error: 1, verified: 1 } });
      expect(by(A).requests).toBeGreaterThanOrEqual(6);
      expect(by(A).errorPct).toBe(Math.round((1 / by(A).requests) * 1000) / 10);
      expect(by(B)).toMatchObject({ integrationHealthPct: 100, requests: 3, errors: 0, integrations: { verified: 1, error: 0 } });
      expect(by(C).integrationHealthPct).toBeNull();
      expect(by(C).integrations.verified).toBe(0);
      expect(by(C).integrations.notConfigured).toBeGreaterThanOrEqual(2); // fiscal e pagamento sempre listados
      expect(by(A).lastActivityAt).not.toBeNull();
      expect(by(C).lastActivityAt).toBeNull();
    });

    it('filtros e ordenação: por situação, por gravidade de alerta e ordem por erros (sem dado vai para o fim)', async () => {
      const sorted = await get(`/companies?range=24h&q=mc${stamp}&sort=errorPct&dir=desc`);
      expect(sorted.body.items.map((i: any) => i.id)).toEqual([A.companyId, B.companyId, C.companyId]);
      const none = await get(`/companies?range=24h&q=mc${stamp}&severity=CRITICAL`);
      expect(none.body.items.every((i: any) => i.openAlerts.CRITICAL > 0)).toBe(true);
      expect((await get('/companies?lifecycle=NAOEXISTE')).status).toBe(400);
      expect((await get('/companies?severity=NAOEXISTE')).status).toBe(400);
      const page = await get(`/companies?range=24h&q=mc${stamp}&limit=2&page=2`);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.total).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('detalhe de uma empresa: isolamento entre empresas', () => {
    it('A enxerga só os próprios dados (canais, uso, alertas); nada de B ou C vaza', async () => {
      state.alertA = await openAlert(); // alerta CRITICAL de A
      const res = await get(`/companies/${A.companyId}?range=24h`);
      expect(res.status).toBe(200);
      expect(res.body.company.id).toBe(A.companyId);
      const text = JSON.stringify(res.body);
      for (const other of [B, C]) expect(text).not.toContain(other.companyId);
      expect(text).not.toContain(`Canal SAUDAVEL ${stamp}`);
      expect(res.body.integrations.items.find((i: any) => i.kind === 'CHANNEL')).toMatchObject({ state: 'ERROR' });
      expect(res.body.integrations.summary).toMatchObject({ healthPct: 0, error: 1 });
      expect(res.body.usage.errors).toBe(1);
      expect(res.body.usage.requests).toBeGreaterThanOrEqual(6);
      expect(res.body.usage.activeUsers).toBeGreaterThanOrEqual(0);
      expect(res.body.modules.map((m: any) => m.module)).toEqual(expect.arrayContaining(['ESTOQUE', 'VENDAS', 'OFICINA', 'CANAIS']));
      expect(res.body.modules.find((m: any) => m.module === 'CANAIS').enabled).toBe(false); // nasce desativado
      expect(res.body.alerts.every((a: any) => a.type && a.status)).toBe(true);
      expect(res.body.alerts.map((a: any) => a.id)).toContain(state.alertA);
      expect(res.body.integrationErrors.note).toMatch(/não têm integração automática/);
    });

    it('filtro por módulo restringe o uso pelas rotas do módulo; filtro por gravidade restringe os alertas', async () => {
      expect((await get(`/companies/${A.companyId}?range=24h&module=VENDAS`)).body.usage.requests).toBe(4);
      expect((await get(`/companies/${A.companyId}?range=24h&module=ESTOQUE`)).body.usage.requests).toBe(2);
      expect((await get(`/companies/${A.companyId}?range=24h&module=OFICINA`)).body.usage.requests).toBe(0);
      expect((await get(`/companies/${A.companyId}?range=24h&severity=ATTENTION`)).body.alerts).toHaveLength(0);
      expect((await get(`/companies/${A.companyId}?range=24h&severity=CRITICAL`)).body.alerts.length).toBeGreaterThanOrEqual(1);
      expect((await get(`/companies/${A.companyId}?module=INVENTADO`)).status).toBe(400);
    });

    it('id malformado é 400 e empresa inexistente é 404', async () => {
      expect((await get('/companies/nao-e-uuid')).status).toBe(400);
      expect((await get(`/companies/${UUID0}`)).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('central de alertas: ciclo de tratamento', () => {
    const act = (id: string, body: object) => post(`/alert-center/${id}/actions`, body);

    it('lista com filtros, resumo por gravidade e orientação objetiva', async () => {
      const id = state.alertA as string;
      const res = await get(`/alert-center?companyId=${A.companyId}&status=OPEN`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((a: any) => a.id)).toContain(id);
      const item = res.body.items.find((a: any) => a.id === id);
      expect(item).toMatchObject({ category: 'INTEGRATION', severity: 'CRITICAL', status: 'OPEN', companyName: expect.stringContaining('Integration Test Co') });
      expect(item.guidance).toMatch(/Integração com erro/);
      expect(res.body.summary.bySeverity.CRITICAL).toBeGreaterThanOrEqual(1);
      expect((await get('/alert-center?status=INVALIDO')).status).toBe(400);
      expect((await get('/alert-center?scope=outro')).status).toBe(400);
      expect((await get('/alert-center?companyId=xx')).status).toBe(400);
    });

    it('reconhecer → assumir → iniciar tratamento → anotar → resolver (exige justificativa) → reabrir, com histórico imutável', async () => {
      const id = state.alertA as string;
      expect((await act(id, { action: 'ACKNOWLEDGE' })).body.status).toBe('ACKNOWLEDGED');
      expect((await act(id, { action: 'ACKNOWLEDGE' })).status).toBe(409); // já reconhecido

      const assigned = await act(id, { action: 'ASSIGN', assigneeId: saId, note: 'plantão' });
      expect(assigned.status).toBe(200);
      expect(assigned.body.assignedTo).toBe(saId);
      expect((await act(id, { action: 'ASSIGN', assigneeId: A.userId })).status).toBe(400); // responsável tem de ser Super Admin ativo

      expect((await act(id, { action: 'START' })).body.status).toBe('IN_PROGRESS');
      expect((await act(id, { action: 'START' })).status).toBe(409);
      expect((await act(id, { action: 'NOTE', note: 'cliente avisado' })).status).toBe(200);
      expect((await act(id, { action: 'NOTE', note: '' })).status).toBe(400);

      expect((await act(id, { action: 'RESOLVE' })).status).toBe(400); // sem justificativa
      const resolved = await act(id, { action: 'RESOLVE', note: 'credencial do canal renovada' });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolvedBy: saId, resolutionNote: 'credencial do canal renovada' });
      expect((await act(id, { action: 'ACKNOWLEDGE' })).status).toBe(409); // resolvido não se trata: reabre
      expect((await act(id, { action: 'RESOLVE', note: 'de novo' })).status).toBe(409);

      const reopened = await act(id, { action: 'REOPEN' });
      expect(reopened.body).toMatchObject({ status: 'OPEN', resolvedBy: null, resolutionNote: null });
      expect((await act(id, { action: 'REOPEN' })).status).toBe(409);
      expect((await act(id, { action: 'APAGAR' })).status).toBe(400);

      const detail = await get(`/alert-center/${id}`);
      const kinds = detail.body.events.map((e: any) => e.kind);
      expect(kinds).toEqual(['OPENED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'NOTE', 'RESOLVED', 'REOPENED']);
      expect(detail.body.events.find((e: any) => e.kind === 'RESOLVED').actorName).toBe('SA central');
      expect(detail.body.events[0].actorName).toBe('sistema');
      // a ação foi auditada (sem o conteúdo da anotação)
      const audited = auditSpy.mock.calls.filter((c) => c[0] === 'audit-log' && (c[1] as any).entity === 'MonitoringAlert');
      expect(audited.length).toBeGreaterThanOrEqual(5);
    });

    it('o histórico é append-only: papel de empresa não lê, não grava e não apaga; nem o Super Admin edita linha existente', async () => {
      const id = state.alertA as string;
      const row = await bypass<any>(() => db.monitoringAlertEvent.findFirst({ where: { alertId: id } }));
      expect(await asCompany(A.companyId, () => prisma.monitoringAlertEvent.findMany({ where: { alertId: id } }))).toEqual([]);
      await expect(asCompany(A.companyId, () => prisma.monitoringAlertEvent.create({ data: { alertId: id, kind: 'NOTE', note: 'forjado' } }))).rejects.toThrow();
      // UPDATE e DELETE sem policy: afetam 0 linhas (Super Admin sem o expurgo sinalizado também)
      expect((await asPlatform(() => prisma.monitoringAlertEvent.updateMany({ where: { id: row.id }, data: { note: 'adulterado' } }))).count).toBe(0);
      expect((await asPlatform(() => prisma.monitoringAlertEvent.deleteMany({ where: { id: row.id } }))).count).toBe(0);
      expect((await bypass<any>(() => db.monitoringAlertEvent.findUnique({ where: { id: row.id } }))).note).not.toBe('adulterado');
    });

    it('REINCIDÊNCIA: o problema volta logo após resolvido → reabre o MESMO alerta, zera reconhecimento e registra REOPENED', async () => {
      const id = await openAlert(platformAlert({ companyId: C.companyId, type: 'INTEGRATION_HEALTH' }));
      await act(id, { action: 'ACKNOWLEDGE' });
      await act(id, { action: 'RESOLVE', note: 'tratado agora' });
      const outcome = await asPlatform(() => monitoringService.applyAlert(platformAlert({ companyId: C.companyId }) as any, new Date()));
      expect(outcome).toBe('reopened');
      const detail = await get(`/alert-center/${id}`);
      expect(detail.body).toMatchObject({ status: 'OPEN', occurrences: 2, acknowledgedBy: null, resolvedBy: null });
      expect(detail.body.events.map((e: any) => e.kind)).toEqual(['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REOPENED']);
    });

    it('a condição que volta ao normal encerra sozinha (AUTO_RESOLVED) e a gravidade que muda fica no histórico', async () => {
      const id = await openAlert(platformAlert({ companyId: C.companyId, type: 'API_ERRORS', status: 'ATTENTION', source: 'BRANCH' }));
      await asPlatform(() => monitoringService.applyAlert(platformAlert({ companyId: C.companyId, type: 'API_ERRORS', status: 'CRITICAL', source: 'BRANCH' }) as any, new Date()));
      await asPlatform(() => monitoringService.applyAlert(platformAlert({ companyId: C.companyId, type: 'API_ERRORS', status: 'NORMAL', source: 'BRANCH' }) as any, new Date()));
      const detail = await get(`/alert-center/${id}`);
      expect(detail.body.status).toBe('RESOLVED');
      expect(detail.body.events.map((e: any) => e.kind)).toEqual(['OPENED', 'SEVERITY_CHANGED', 'AUTO_RESOLVED']);
      expect(detail.body.events[1].note).toBe('ATTENTION → CRITICAL');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('aviso por e-mail (provedor SIMULADO: nenhum e-mail real)', () => {
    const FULL = { RESEND_API_KEY: 're_chave_de_teste_123456', ALERT_EMAIL_FROM: 'CÓRTEX <alertas@exemplo.test>', ALERT_EMAIL_TO: 'operacao@exemplo.test', RESEND_DOMAIN_VERIFIED: 'true' };
    let fetchSpy: jest.SpyInstance;
    const waitFor = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 60; i++) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    const emailRows = () => bypass<any[]>(() => db.externalDelivery.findMany({ where: { channel: 'EMAIL', dedupeKey: { startsWith: `alert:INTEGRATION_HEALTH:${B.companyId}` } } }));

    beforeAll(() => {
      Object.assign(process.env, FULL);
      __resetResendBreaker();
      __resetDeliveryCache();
      __resetSettingsCache();
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    });
    afterAll(() => {
      fetchSpy.mockRestore();
      for (const k of Object.keys(FULL)) delete process.env[k];
      __resetDeliveryCache();
    });

    it('alerta crítico aberto com provedor configurado: UM e-mail para a operação, sem segredo, e o histórico do alerta registra o aviso', async () => {
      const id = await openAlert(platformAlert({ companyId: B.companyId }));
      expect(await waitFor(async () => (await emailRows()).some((r) => r.status === 'SENT'))).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
      expect(url).toBe('https://api.resend.com/emails');
      const body = JSON.parse(init.body);
      expect(body.to).toEqual(['operacao@exemplo.test']);
      expect(body.subject).toContain('CRITICAL');
      expect(body.text).toContain('Integration Test Co');
      expect(init.body).not.toContain('re_chave_de_teste');
      const rows = await emailRows();
      expect(JSON.stringify(rows)).not.toContain('re_chave_de_teste');
      expect(rows[0].error).toBeNull();
      expect(await waitFor(async () => (await get(`/alert-center/${id}`)).body.events.some((e: any) => e.kind === 'NOTIFIED'))).toBe(true);
      state.mailAlert = id;
    });

    it('atualizar o mesmo alerta não reenvia; reincidência dentro da janela de deduplicação é SUPRIMIDA e fica registrada', async () => {
      const id = state.mailAlert as string;
      await asPlatform(() => monitoringService.applyAlert(platformAlert({ companyId: B.companyId, value: 1 }) as any, new Date()));
      await new Promise((r) => setTimeout(r, 400));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await post(`/alert-center/${id}/actions`, { action: 'RESOLVE', note: 'teste da deduplicação' });
      expect(await asPlatform(() => monitoringService.applyAlert(platformAlert({ companyId: B.companyId }) as any, new Date()))).toBe('reopened');
      expect(await waitFor(async () => (await get(`/alert-center/${id}`)).body.events.some((e: any) => e.kind === 'NOTIFICATION_SUPPRESSED'))).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // nenhum segundo e-mail
      const suppressed = (await get(`/alert-center/${id}`)).body.events.find((e: any) => e.kind === 'NOTIFICATION_SUPPRESSED');
      expect(suppressed.note).toBe('DEDUPE');
    });

    it('gravidade abaixo do mínimo (atenção) não avisa', async () => {
      const before = fetchSpy.mock.calls.length;
      await openAlert(platformAlert({ companyId: B.companyId, type: 'API_LATENCY', status: 'ATTENTION', source: 'BRANCH' }));
      await new Promise((r) => setTimeout(r, 400));
      expect(fetchSpy.mock.calls.length).toBe(before);
    });

    it('a tela de serviços externos mostra o estado SEM nenhum segredo', async () => {
      const res = await get('/external');
      expect(res.status).toBe(200);
      expect(res.body.resend).toMatchObject({ configured: true, state: 'ACTIVE', senderDomain: 'exemplo.test', recipients: 1 });
      expect(res.body.resend.consumption.sent.month).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(res.body)).not.toContain('re_chave_de_teste');
    });
  });

  describe('serviços externos NÃO configurados', () => {
    it('Sentry e Resend aparecem como PENDENTES de configuração; a verificação do provedor não chama a rede sem chave', async () => {
      for (const k of ['SENTRY_DSN', 'RESEND_API_KEY', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO', 'RESEND_DOMAIN_VERIFIED', 'RESEND_TRANSACTIONAL']) delete process.env[k];
      const res = await get('/external');
      expect(res.body.sentry).toMatchObject({ configured: false, state: 'PENDING_CONFIGURATION', enabled: true });
      expect(res.body.resend).toMatchObject({ configured: false, state: 'PENDING_CONFIGURATION' });
      expect(res.body.resend.missing).toEqual(expect.arrayContaining(['RESEND_API_KEY', 'RESEND_DOMAIN_VERIFIED=true']));
      expect(res.body.figma.configured).toBe(false);
      expect(res.body.domain.productionReady).toBe(false);
      expect(res.body.costControls.limits.emailMaxPerDay).toBeLessThan(100);
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const check = await post('/external/resend/check');
      expect(check.body.checked).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('funil comercial', () => {
    const lead = (body: object) => post('/funnel/leads', body);
    const move = (id: string, stage: string, note?: string) => post(`/funnel/leads/${id}/move`, { stage, note });

    it('vazio não inventa nada: sem oportunidade, conversão e tempos ficam sem dado e a cobertura diz o que falta', async () => {
      const f = await get('/funnel');
      expect(f.status).toBe(200);
      expect(f.body.definition).toMatch(/Conversão entre etapas/);
      const testLeads = f.body.totals.leads; // pode haver oportunidades reais no banco: o contrato é a nota de cobertura
      expect(f.body.coverage.companiesTotal).toBeGreaterThanOrEqual(3);
      expect(f.body.stages.map((s: any) => s.stage)).toEqual(['INTERESTED', 'DEMO', 'PROPOSAL', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED']);
      if (testLeads === 0) expect(f.body.coverage.notes.join(' ')).toMatch(/Nenhuma oportunidade registrada/);
    });

    it('registra oportunidades, avança etapas com histórico e calcula contagens e conversão', async () => {
      const before = await get('/funnel');
      const reached = (r: any, s: string) => r.body.stages.find((x: any) => x.stage === s).reached;
      const l1 = await lead({ name: `Oficina Alfa ${stamp}`, contact: 'contato@exemplo.test', source: 'indicação' });
      const l2 = await lead({ name: `Oficina Beta ${stamp}` });
      expect(l1.status).toBe(201);
      leadIds.add(l1.body.id);
      leadIds.add(l2.body.id);
      for (const stage of ['DEMO', 'PROPOSAL', 'ONBOARDING', 'ACTIVE']) expect((await move(l1.body.id, stage)).status).toBe(200);
      await move(l2.body.id, 'DEMO');
      const after = await get('/funnel');
      expect(reached(after, 'INTERESTED') - reached(before, 'INTERESTED')).toBe(2);
      expect(reached(after, 'DEMO') - reached(before, 'DEMO')).toBe(2);
      expect(reached(after, 'ACTIVE') - reached(before, 'ACTIVE')).toBe(1);
      expect(after.body.conversions).toHaveLength(4);
      expect(after.body.conversions[0]).toMatchObject({ from: 'INTERESTED', to: 'DEMO', fromLabel: 'Interessado', toLabel: 'Demonstração' });
      expect(after.body.stages.find((s: any) => s.stage === 'INTERESTED').avgDaysInStage).not.toBeNull();
      const month = new Date().toISOString().slice(0, 7);
      expect(after.body.evolution.activationsPerMonth.find((m: any) => m.month === month).count).toBeGreaterThanOrEqual(1);
      const list = await get(`/funnel/leads?q=${encodeURIComponent(`Oficina Alfa ${stamp}`)}`);
      expect(list.body.items[0]).toMatchObject({ stage: 'ACTIVE', stageLabel: 'Cliente ativo' });
      const events = await bypass<any[]>(() => db.commercialLeadEvent.findMany({ where: { leadId: l1.body.id }, orderBy: { createdAt: 'asc' } }));
      expect(events.map((e) => e.toStage)).toEqual(['INTERESTED', 'DEMO', 'PROPOSAL', 'ONBOARDING', 'ACTIVE']);
    });

    it('recusa etapa inválida, repetida e suspensão/cancelamento sem motivo; vincula uma empresa uma única vez', async () => {
      const l = await lead({ name: `Oficina Gama ${stamp}` });
      leadIds.add(l.body.id);
      expect((await move(l.body.id, 'NAO_EXISTE')).status).toBe(400);
      expect((await move(l.body.id, 'INTERESTED')).status).toBe(409);
      expect((await move(l.body.id, 'CANCELLED')).status).toBe(400);
      expect((await move(l.body.id, 'CANCELLED', 'desistiu da compra')).body.closedReason).toBe('desistiu da compra');
      expect((await lead({ name: 'x' })).status).toBe(400);
      expect((await lead({ name: `Oficina Delta ${stamp}`, stage: 'XX' })).status).toBe(400);
      expect((await move(UUID0, 'DEMO')).status).toBe(404);

      const link = await post(`/funnel/leads/${l.body.id}/link-company`, { companyId: C.companyId });
      expect(link.status).toBe(200);
      expect(link.body.companyId).toBe(C.companyId);
      const other = await lead({ name: `Oficina Épsilon ${stamp}` });
      leadIds.add(other.body.id);
      expect((await post(`/funnel/leads/${other.body.id}/link-company`, { companyId: C.companyId })).status).toBe(409);
      expect((await post(`/funnel/leads/${other.body.id}/link-company`, { companyId: UUID0 })).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('RLS: as tabelas novas são de plataforma', () => {
    it('papel de empresa não lê nem grava em nenhuma das 6 tabelas (negado pelo banco, não só pela API)', async () => {
      await asPlatform(() => prisma.monitoringSetting.upsert({ where: { key: 'config' }, create: { key: 'config', value: {}, updatedBy: saId }, update: {} }));
      const reads = await asCompany(A.companyId, () =>
        Promise.all([
          prisma.serviceHealthSample.findMany({ take: 5 }),
          prisma.commercialLead.findMany({ take: 5 }),
          prisma.commercialLeadEvent.findMany({ take: 5 }),
          prisma.externalDelivery.findMany({ take: 5 }),
          prisma.monitoringSetting.findMany({ take: 5 }),
          prisma.monitoringAlertEvent.findMany({ take: 5 }),
        ])
      );
      for (const rows of reads) expect(rows).toEqual([]);
      await expect(asCompany(A.companyId, () => prisma.serviceHealthSample.create({ data: { service: 'API', status: 'NORMAL' } }))).rejects.toThrow();
      await expect(asCompany(A.companyId, () => prisma.commercialLead.create({ data: { name: 'forjado', createdBy: A.userId } }))).rejects.toThrow();
      await expect(asCompany(A.companyId, () => prisma.externalDelivery.create({ data: { channel: 'EMAIL', status: 'SENT' } }))).rejects.toThrow();
      await expect(asCompany(A.companyId, () => prisma.monitoringSetting.create({ data: { key: 'forjado', value: {}, updatedBy: A.userId } }))).rejects.toThrow();
      // o alerta da PRÓPRIA empresa continua legível por ela (política antiga, inalterada); o de outra empresa não
      const own = await asCompany(A.companyId, () => prisma.monitoringAlert.findMany({ where: { companyId: A.companyId } }));
      expect(own.length).toBeGreaterThan(0);
      const foreign = await asCompany(A.companyId, () => prisma.monitoringAlert.findMany({ where: { companyId: B.companyId } }));
      expect(foreign).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('ajustes e custos: só restringem', () => {
    it('baixar limite e desligar notificação vale; subir acima do ambiente não surte efeito; chave desconhecida e valor ruim são recusados; é auditado', async () => {
      const base = (await get('/settings')).body;
      expect(base.toggles).toEqual({ emailNotifications: true, sentry: true, sampling: true });
      const lowered = await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({ toggles: { sentry: false }, limits: { emailMaxPerHour: 1, emailMaxPerDay: 99999 } });
      expect(lowered.status).toBe(200);
      expect(lowered.body.toggles.sentry).toBe(false);
      expect(lowered.body.limits.emailMaxPerHour).toBe(1);
      expect(lowered.body.limits.emailMaxPerDay).toBe(base.limits.emailMaxPerDay);
      expect(lowered.body.overridden).toEqual(expect.arrayContaining(['sentry', 'emailMaxPerHour']));
      expect((await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({ limits: { naoExiste: 1 } })).status).toBe(400);
      expect((await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({ limits: { emailMaxPerHour: -3 } })).status).toBe(400);
      expect((await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({})).status).toBe(400);
      expect(auditSpy.mock.calls.some((c) => c[0] === 'audit-log' && (c[1] as any).entity === 'MonitoringSetting')).toBe(true);
      const restored = await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({ toggles: { sentry: null }, limits: { emailMaxPerHour: null } });
      expect(restored.body.overridden).toEqual([]);
      expect(restored.body.limits.emailMaxPerHour).toBe(base.limits.emailMaxPerHour);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('coletor (amostras e alertas centrais)', () => {
    it('grava amostras no intervalo, não repete antes da hora, avalia o backup (criado × verificado) e respeita o teto diário e o interruptor', async () => {
      __resetSampler();
      __resetSettingsCache();
      process.env.BACKUP_PUBLIC_DIR = tmpDir;
      process.env.BACKUP_MAX_AGE_HOURS = '30';
      const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      // backup de 80 h atrás (acima do dobro do limite) e a última verificação FALHOU
      fs.writeFileSync(path.join(tmpDir, 'cortex-x.dump.enc.manifest'), `arquivo=cortex-x.dump.enc\nbytes=10\ncifrado=sim\ncriado_em=${stampOf(new Date(syntheticNow.getTime() - 80 * 3_600_000))}\n`);
      fs.writeFileSync(path.join(tmpDir, 'verify.txt'), `estado=falha\nquando=${syntheticNow.toISOString()}\ndetalhe=hash divergente\n`);

      const first = await runCentralEvaluation(syntheticNow);
      expect(first.skipped).toBeNull();
      expect(first).toMatchObject({ samples: expect.any(Number), capped: false });
      const samples = await bypass<any[]>(() => db.serviceHealthSample.findMany({ where: { sampledAt: syntheticNow } }));
      const services = samples.map((s) => s.service);
      expect(services).toEqual(expect.arrayContaining(['DATABASE', 'REDIS', 'QUEUES', 'HOST_CPU', 'HOST_MEMORY', 'HOST_DISK', 'BACKUP', 'COMPANIES']));
      expect(samples.find((s) => s.service === 'BACKUP').status).toBe('CRITICAL');
      const companies = JSON.parse(samples.find((s) => s.service === 'COMPANIES').detail);
      expect(companies.total).toBeGreaterThanOrEqual(3);

      const stale = await bypass<any>(() => db.monitoringAlert.findFirst({ where: { type: 'BACKUP_STALE', startedAt: syntheticNow, endedAt: null } }));
      const verify = await bypass<any>(() => db.monitoringAlert.findFirst({ where: { type: 'BACKUP_VERIFY_FAILED', startedAt: syntheticNow, endedAt: null } }));
      expect(stale).toMatchObject({ severity: 'CRITICAL', companyId: null, source: 'CENTRAL' });
      expect(verify).toMatchObject({ severity: 'CRITICAL', companyId: null });
      const integ = await bypass<any>(() => db.monitoringAlert.findFirst({ where: { type: 'INTEGRATION_HEALTH', companyId: A.companyId, endedAt: null } }));
      expect(integ.severity).toBe('CRITICAL'); // canal em ERRO

      // não repete antes do intervalo (uma segunda chamada logo em seguida não coleta)
      expect(await runCentralEvaluation(new Date(syntheticNow.getTime() + 60_000))).toEqual({ skipped: 'not_due' });

      // teto diário de telemetria: a coleta de amostras para, os alertas continuam sendo avaliados
      process.env.MONITORING_SAMPLES_MAX_PER_DAY = '0';
      const capped = await runCentralEvaluation(new Date(syntheticNow.getTime() + 10 * 60_000));
      expect(capped).toMatchObject({ skipped: null, capped: true, samples: 0 });
      delete process.env.MONITORING_SAMPLES_MAX_PER_DAY;

      // interruptor de runtime: com a coleta desligada nada é coletado
      await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({ toggles: { sampling: false } });
      expect(await runCentralEvaluation(new Date(syntheticNow.getTime() + 20 * 60_000))).toEqual({ skipped: 'sampling_disabled' });
      await request(app).put(`${CENTRAL}/settings`).set(bearer(saToken)).send({ toggles: { sampling: null } });

      // o backup REAL aparece na visão executiva com o nível certo: criado, NÃO verificado (a verificação falhou)
      const overview = await get('/overview?range=6h'); // período ainda não pedido neste arquivo: não pega a visão guardada em cache
      expect(overview.body.backup).toMatchObject({ configured: true, level: 'CREATED', status: 'CRITICAL' });
      expect(overview.body.backup.lastVerify.state).toBe('falha');
    });
  });
});
