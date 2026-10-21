import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import moduleSettingsRoutes from '../../src/routes/module-settings.routes';
import dashboardRoutes from '../../src/routes/dashboard.routes';
import partnersRoutes from '../../src/routes/partners.routes';
import importRoutes from '../../src/routes/import.routes';
import { jobQueue } from '../../src/config/queue';
import { errorHandler } from '../../src/middleware/errorHandler';
import cacheService, { CacheKeys } from '../../src/services/cache.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

// `data:import` é permissão RBAC sem seed (docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md E1a). Aqui o que
// se prova é o GATE DE MÓDULO da rota de importação de estoque, então a
// permissão passa direto — o resto do middleware de permissão é o real.
jest.mock('../../src/middleware/permission', () => {
  const actual = jest.requireActual('../../src/middleware/permission');
  return { ...actual, requirePermission: () => (_req: any, _res: any, next: any) => next() };
});

/**
 * Configurações → Módulos — prova REAL (HTTP + Postgres/RLS + Redis, JWT real).
 *
 * ACHADOS DE AUDITORIA:
 * 1) SUPER_ADMIN (JWT sem empresa) chamando POST /module-settings/:module usava
 *    `companyId: undefined`; o Prisma IGNORA `undefined` no where, então o
 *    `findFirst` casava a primeira linha `branchId null` daquele módulo de
 *    QUALQUER empresa e a atualizava (e o cache da empresa afetada não era
 *    invalidado). GET/history também misturavam todas as empresas.
 * 2) Módulo desativado continuava operável direto pela API em rotas que não
 *    tinham o gate: dashboards (vendas/estoque/oficina/financeiro), /partners
 *    e POST /import/stock.
 * 3) O audit log de ativar/desativar módulo gravava `newValue: "null"` — sem
 *    módulo, estado nem motivo.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Módulos — escopo por empresa e gates (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;

  const token = (f: IntegrationFixture | null, userType: string) =>
    generateAccessToken({
      userId: (f ?? A).userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: (f ? f.companyId : undefined) as any,
      branchId: (f ? f.branchId : undefined) as any,
      userType,
    });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const settingRow = (companyId: string, module: string) =>
    bypass<any>(() => prismaUnsafeBypassRLS.companyModuleSetting.findFirst({ where: { companyId, branchId: null, module: module as any } }));

  // O estado dos módulos fica em cache no Redis (5 min); escrever direto no
  // banco, como o teste faz, precisa derrubar a chave — o service já faz isso
  // quando a escrita passa por ele.
  const dropCache = () =>
    Promise.all([A, B].map((f) => cacheService.delete(CacheKeys.moduleSettings(f.companyId))));

  const setModule = async (f: IntegrationFixture, module: string, isEnabled: boolean, reason?: string) => {
    await bypass(() =>
      prismaUnsafeBypassRLS.companyModuleSetting.create({
        data: { companyId: f.companyId, branchId: null, module: module as any, isEnabled, disabledReason: reason ?? null },
      })
    );
    await dropCache();
  };

  beforeAll(async () => {
    A = await createFixture('modscope-A');
    B = await createFixture('modscope-B');
    app = express();
    app.use(express.json());
    app.use('/api/module-settings', moduleSettingsRoutes);
    app.use('/api/dashboard', dashboardRoutes);
    app.use('/api/partners', partnersRoutes);
    app.use('/api/import', importRoutes);
    app.use(errorHandler);
    // O audit vai por fila (BullMQ): intercepta sem enfileirar de verdade.
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 30000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await destroyFixture(A);
    await destroyFixture(B);
  }, 30000);

  beforeEach(async () => {
    await bypass(() => prismaUnsafeBypassRLS.companyModuleSetting.deleteMany({ where: { companyId: { in: [A.companyId, B.companyId] } } }));
    await dropCache();
    auditSpy.mockClear();
  });

  describe('SUPER_ADMIN não pode agir sem escolher a empresa', () => {
    it('POST sem companyId é 400 e NENHUMA linha de nenhuma empresa é alterada', async () => {
      await setModule(B, 'FISCAL', false, 'desligado pela empresa B');

      const res = await request(app)
        .post('/api/module-settings/FISCAL')
        .set(auth(token(null, 'SUPER_ADMIN')))
        .send({ isEnabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/companyId/);
      const row = await settingRow(B.companyId, 'FISCAL');
      expect(row.isEnabled).toBe(false);
      expect(row.disabledReason).toBe('desligado pela empresa B');
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('POST com companyId altera SÓ aquela empresa e o audit aponta para ela', async () => {
      await setModule(B, 'FISCAL', false, 'desligado pela empresa B');

      const res = await request(app)
        .post('/api/module-settings/FISCAL')
        .set(auth(token(null, 'SUPER_ADMIN')))
        .send({ companyId: A.companyId, isEnabled: false, reason: 'plano suspenso' });

      expect(res.status).toBe(200);
      expect((await settingRow(A.companyId, 'FISCAL')).isEnabled).toBe(false);
      expect((await settingRow(B.companyId, 'FISCAL')).disabledReason).toBe('desligado pela empresa B');
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][1].companyId).toBe(A.companyId);
    });

    it('GET sem companyId devolve o padrão (tudo habilitado, exceto o módulo opt-in CANAIS), sem misturar as linhas das empresas', async () => {
      await setModule(B, 'FISCAL', false, 'x');
      const res = await request(app).get('/api/module-settings').set(auth(token(null, 'SUPER_ADMIN')));
      expect(res.status).toBe(200);
      expect(res.body.modules.every((m: any) => m.isEnabled === (m.module !== 'CANAIS') && m.source === 'DEFAULT')).toBe(true);
    });

    it('GET com ?companyId mostra o estado daquela empresa', async () => {
      await setModule(B, 'FISCAL', false, 'x');
      const res = await request(app).get(`/api/module-settings?companyId=${B.companyId}`).set(auth(token(null, 'SUPER_ADMIN')));
      expect(res.body.modules.find((m: any) => m.module === 'FISCAL')).toMatchObject({ isEnabled: false, source: 'COMPANY_WIDE' });
    });

    it('history sem companyId é 400 (não lista todas as empresas)', async () => {
      const res = await request(app).get('/api/module-settings/history').set(auth(token(null, 'SUPER_ADMIN')));
      expect(res.status).toBe(400);
    });
  });

  describe('COMPANY_ADMIN só age na própria empresa', () => {
    it('companyId de OUTRA empresa no body/query é ignorado: vale a do token', async () => {
      await setModule(B, 'FISCAL', false, 'desligado pela empresa B');

      const res = await request(app)
        .post(`/api/module-settings/FISCAL?companyId=${B.companyId}`)
        .set(auth(token(A, 'COMPANY_ADMIN')))
        .send({ companyId: B.companyId, isEnabled: true });

      expect(res.status).toBe(200);
      expect((await settingRow(A.companyId, 'FISCAL')).isEnabled).toBe(true);
      const rowB = await settingRow(B.companyId, 'FISCAL');
      expect(rowB.isEnabled).toBe(false);
      expect(rowB.disabledReason).toBe('desligado pela empresa B');
    });

    it('desativar exige motivo; o estado vale na hora (cache invalidado) e o histórico só traz a própria empresa', async () => {
      await setModule(B, 'VENDAS', false, 'só da B');

      const noReason = await request(app).post('/api/module-settings/FISCAL').set(auth(token(A, 'COMPANY_ADMIN'))).send({ isEnabled: false });
      expect(noReason.status).toBe(400);

      // aquece o cache com o estado atual, depois muda
      await request(app).get('/api/module-settings').set(auth(token(A, 'COMPANY_ADMIN')));
      const off = await request(app)
        .post('/api/module-settings/FISCAL')
        .set(auth(token(A, 'COMPANY_ADMIN')))
        .send({ isEnabled: false, reason: 'sem emissão por enquanto' });
      expect(off.status).toBe(200);

      const state = await request(app).get('/api/module-settings').set(auth(token(A, 'COMPANY_ADMIN')));
      expect(state.body.modules.find((m: any) => m.module === 'FISCAL').isEnabled).toBe(false);

      const history = await request(app).get('/api/module-settings/history').set(auth(token(A, 'COMPANY_ADMIN')));
      expect(history.status).toBe(200);
      expect(history.body.history.map((h: any) => h.companyId)).toEqual([A.companyId]);
    });

    it('MANAGER e OPERATOR não alteram módulo (403) e nada é gravado', async () => {
      for (const userType of ['MANAGER', 'OPERATOR']) {
        const res = await request(app).post('/api/module-settings/FISCAL').set(auth(token(A, userType))).send({ isEnabled: false, reason: 'tentativa' });
        expect(res.status).toBe(403);
      }
      expect(await settingRow(A.companyId, 'FISCAL')).toBeNull();
    });
  });

  describe('o audit registra módulo, estado e motivo', () => {
    it('newValue tem o módulo, isEnabled e o motivo; entityId é a linha alterada', async () => {
      const res = await request(app)
        .post('/api/module-settings/ESTOQUE')
        .set(auth(token(A, 'COMPANY_ADMIN')))
        .send({ isEnabled: false, reason: 'inventário geral em andamento' });
      expect(res.status).toBe(200);

      expect(auditSpy).toHaveBeenCalledTimes(1);
      const payload = auditSpy.mock.calls[0][1];
      expect(payload).toMatchObject({ companyId: A.companyId, entity: 'CompanyModuleSetting', entityId: res.body.id });
      expect(JSON.parse(payload.newValue)).toMatchObject({
        module: 'ESTOQUE',
        isEnabled: false,
        reason: 'inventário geral em andamento',
      });
    });
  });

  describe('módulo desativado bloqueia a API direta (MODULE_DISABLED)', () => {
    const gate = async (module: string) => setModule(A, module, false, 'teste de gate');

    it.each([
      ['GET /api/dashboard/sales', 'VENDAS', '/api/dashboard/sales'],
      ['GET /api/dashboard/pdv', 'VENDAS', '/api/dashboard/pdv'],
      ['GET /api/dashboard/stock', 'ESTOQUE', '/api/dashboard/stock'],
      ['GET /api/dashboard/workshop', 'OFICINA', '/api/dashboard/workshop'],
      ['GET /api/dashboard/financial', 'FINANCEIRO', '/api/dashboard/financial'],
      ['GET /api/partners', 'VENDAS', '/api/partners'],
    ])('%s com %s desativado → 403 MODULE_DISABLED', async (_label, module, path) => {
      await gate(module);
      const res = await request(app).get(path).set(auth(token(A, 'COMPANY_ADMIN')));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MODULE_DISABLED');
    });

    it('POST /api/import/stock com ESTOQUE desativado → 403 MODULE_DISABLED (nada é gravado)', async () => {
      await gate('ESTOQUE');
      const before = await bypass<number>(() => prismaUnsafeBypassRLS.stockMovement.count({ where: { companyId: A.companyId } }));

      const res = await request(app)
        .post('/api/import/stock')
        .set(auth(token(A, 'COMPANY_ADMIN')))
        .send({ items: [{ sku: 'X', quantity: 5 }] });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MODULE_DISABLED');
      const after = await bypass<number>(() => prismaUnsafeBypassRLS.stockMovement.count({ where: { companyId: A.companyId } }));
      expect(after).toBe(before);
    });

    it('com o módulo LIGADO a mesma rota funciona (o gate não bloqueia quem deve passar) e a outra empresa não é afetada', async () => {
      await gate('VENDAS'); // só a A desliga
      const b = await request(app).get('/api/partners').set(auth(token(B, 'COMPANY_ADMIN')));
      expect(b.status).toBe(200);
      const a = await request(app).get('/api/dashboard/workshop').set(auth(token(A, 'COMPANY_ADMIN')));
      expect(a.status).toBe(200);
    });

    it('SUPER_ADMIN nunca é bloqueado pelo gate (suporte)', async () => {
      await gate('VENDAS');
      const res = await request(app).get(`/api/partners`).set(auth(token(null, 'SUPER_ADMIN')));
      expect(res.status).toBe(200);
    });
  });
});
