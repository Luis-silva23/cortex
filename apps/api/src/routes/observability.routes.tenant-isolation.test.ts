/**
 * Testes de RBAC do router de observabilidade (`/api/observability/*`) —
 * escopo é de PLATAFORMA (RequestLog/SystemLog não têm companyId de
 * isolamento por design: são infraestrutura, não dado de negócio), então a
 * única barreira que importa aqui é `requireSuperAdmin`. Este teste prova,
 * via HTTP real (supertest, já presente em devDependencies — ver
 * package.json), que TODAS as rotas do router estão atrás dele: um usuário
 * autenticado mas não-SUPER_ADMIN (COMPANY_ADMIN, MANAGER) deve levar 403
 * em cada uma, e um SUPER_ADMIN deve passar pelo guard (chegando ao handler
 * real, que aqui é mockado para não bater em Prisma/BullMQ de verdade).
 *
 * `verifyAccessToken` é mockado para decodificar o "token" de teste como o
 * payload JWT diretamente (controle total do `userType` em cada caso), sem
 * precisar de um segredo/token real — o resto de `authMiddleware` (a
 * checagem "Bearer ", a rejeição de token de MFA pendente) roda de verdade.
 * `rateLimitGeneral` é mockado para não depender de Redis.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
}));

const getMetricsMock = jest.fn().mockResolvedValue({ ok: true });
const getJobsStatusMock = jest.fn().mockResolvedValue({ ok: true });
const getDetailedHealthMock = jest.fn().mockResolvedValue({ status: 'healthy' });
const getSecurityStatsMock = jest.fn().mockResolvedValue({ ok: true });
const getIntegrationStatsMock = jest.fn().mockResolvedValue({ ok: true });
const listSystemLogsMock = jest.fn().mockResolvedValue({ data: [], pagination: {} });
const getSystemLogByIdMock = jest.fn().mockResolvedValue({ id: 'log-1' });
const listRequestLogsMock = jest.fn().mockResolvedValue({ data: [], pagination: {} });
const getAlertsMock = jest.fn().mockResolvedValue([]);

jest.mock('../services/observability.service', () => ({
  __esModule: true,
  default: {
    getMetrics: getMetricsMock,
    getJobsStatus: getJobsStatusMock,
    getDetailedHealth: getDetailedHealthMock,
    getSecurityStats: getSecurityStatsMock,
    getIntegrationStats: getIntegrationStatsMock,
    listSystemLogs: listSystemLogsMock,
    getSystemLogById: getSystemLogByIdMock,
    listRequestLogs: listRequestLogsMock,
    getAlerts: getAlertsMock,
  },
}));

import express from 'express';
import request from 'supertest';
import observabilityRoutes from './observability.routes';

function buildApp() {
  const app = express();
  app.use('/api/observability', observabilityRoutes);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err.message });
  });
  return app;
}

const GET_ROUTES = [
  '/api/observability/metrics',
  '/api/observability/jobs',
  '/api/observability/health',
  '/api/observability/security',
  '/api/observability/integrations',
  '/api/observability/logs/system',
  '/api/observability/logs/system/some-id',
  '/api/observability/logs/requests',
  '/api/observability/alerts',
];

function authHeaderFor(userType: string) {
  // authMiddleware só olha se começa com "Bearer " e delega o parsing do
  // conteúdo ao verifyAccessToken mockado — o "token" abaixo nunca é
  // interpretado como JWT de verdade neste teste.
  return `Bearer test-token-${userType}`;
}

describe('GET /api/observability/* — RBAC (requireSuperAdmin em TODAS as rotas)', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejeita requisição sem token (401) em toda rota', async () => {
    for (const route of GET_ROUTES) {
      const res = await request(app).get(route);
      expect(res.status).toBe(401);
    }
  });

  it.each(['COMPANY_ADMIN', 'MANAGER', 'ADMIN', 'OPERATOR'])(
    'rejeita usuário autenticado do tipo %s (403) em toda rota — nenhuma rota escapa do guard',
    async (userType) => {
      verifyAccessTokenMock.mockReturnValue({
        userId: 'u1',
        email: 'user@company-a.com',
        userType,
        companyId: 'company-A',
      });

      for (const route of GET_ROUTES) {
        const res = await request(app).get(route).set('Authorization', authHeaderFor(userType));
        expect(res.status).toBe(403);
      }

      // Nenhum handler real deve ter sido alcançado para um usuário barrado.
      expect(getMetricsMock).not.toHaveBeenCalled();
      expect(getJobsStatusMock).not.toHaveBeenCalled();
      expect(listSystemLogsMock).not.toHaveBeenCalled();
      expect(listRequestLogsMock).not.toHaveBeenCalled();
      expect(getSecurityStatsMock).not.toHaveBeenCalled();
    }
  );

  it('rejeita token de MFA pendente mesmo que o payload marque SUPER_ADMIN (defesa em profundidade do authMiddleware)', async () => {
    verifyAccessTokenMock.mockReturnValue({
      userId: 'u1',
      email: 'admin@platform.com',
      userType: 'SUPER_ADMIN',
      mfaPending: true,
    });

    const res = await request(app).get('/api/observability/metrics').set('Authorization', authHeaderFor('SUPER_ADMIN'));
    expect(res.status).toBe(401);
    expect(getMetricsMock).not.toHaveBeenCalled();
  });

  it('permite SUPER_ADMIN em toda rota — guard passa e o handler real é chamado', async () => {
    verifyAccessTokenMock.mockReturnValue({
      userId: 'super-1',
      email: 'ti@platform.com',
      userType: 'SUPER_ADMIN',
    });

    for (const route of GET_ROUTES) {
      const res = await request(app).get(route).set('Authorization', authHeaderFor('SUPER_ADMIN'));
      expect(res.status).toBeLessThan(400);
    }

    expect(getMetricsMock).toHaveBeenCalledTimes(1);
    expect(getJobsStatusMock).toHaveBeenCalledTimes(1);
    expect(getDetailedHealthMock).toHaveBeenCalledTimes(1);
    expect(getSecurityStatsMock).toHaveBeenCalledTimes(1);
    expect(getIntegrationStatsMock).toHaveBeenCalledTimes(1);
    expect(listSystemLogsMock).toHaveBeenCalledTimes(1);
    expect(getSystemLogByIdMock).toHaveBeenCalledTimes(1);
    expect(listRequestLogsMock).toHaveBeenCalledTimes(1);
    expect(getAlertsMock).toHaveBeenCalledTimes(1);
  });
});
