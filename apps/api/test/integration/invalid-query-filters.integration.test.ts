import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { generateAccessToken } from '@ln-system/shared/utils/token';

/**
 * Filtros de listagem inválidos respondiam 500 "Erro interno" (o valor ia direto ao Prisma): datas em 13 rotas,
 * `action` fora do enum na auditoria e `statusCode` não numérico nos logs de requisição. Precisam ser 400 com
 * mensagem; o mesmo filtro válido continua 200.
 */
describe('Filtros de consulta inválidos → 400 (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let admin: string;
  let superAdmin: string;

  const DATE_ROUTES_ADMIN = [
    '/api/financial/payables', '/api/financial/receivables', '/api/financial/cash-flow', '/api/audit-logs',
    '/api/dashboard/sales', '/api/dashboard/workshop', '/api/dashboard/ceo',
  ];
  const DATE_ROUTES_SA = [
    '/api/observability/metrics', '/api/observability/security', '/api/observability/integrations',
    '/api/observability/logs/system', '/api/observability/logs/requests',
  ];
  const get = (url: string, token: string) => request(app).get(url).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    fixture = await createFixture('badfilter');
    const base = { userId: fixture.userId, email: 'badfilter@test.local', companyId: fixture.companyId, branchId: fixture.branchId };
    admin = generateAccessToken({ ...base, userType: 'COMPANY_ADMIN' });
    superAdmin = generateAccessToken({ ...base, userType: 'SUPER_ADMIN' });
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) await destroyFixture(fixture);
  });

  describe.each([
    ...DATE_ROUTES_ADMIN.map((url) => [url, 'admin'] as const),
    ...DATE_ROUTES_SA.map((url) => [url, 'sa'] as const),
  ])('%s', (url, who) => {
    const token = () => (who === 'admin' ? admin : superAdmin);

    it.each(['startDate=abc', 'endDate=2026-13-45'])('%s → 400 com mensagem', async (query) => {
      const res = await get(`${url}?${query}`, token());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Data inválida/);
    });

    it('datas válidas → 200', async () => {
      const res = await get(`${url}?startDate=2026-09-01&endDate=2026-09-30`, token());
      expect(res.status).toBe(200);
    });
  });

  it('auditoria: action fora do enum → 400; action válida → 200', async () => {
    expect((await get('/api/audit-logs?action=HACK', admin)).status).toBe(400);
    expect((await get('/api/audit-logs?action=UPDATE', admin)).status).toBe(200);
  });

  it('logs de requisição: statusCode não numérico → 400; numérico → 200', async () => {
    expect((await get('/api/observability/logs/requests?statusCode=abc', superAdmin)).status).toBe(400);
    expect((await get('/api/observability/logs/requests?statusCode=500', superAdmin)).status).toBe(200);
  });
});
