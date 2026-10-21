/**
 * Testes de RBAC + isolamento de tenant do router `/api/audit-logs`.
 *
 * A trilha de auditoria (AuditLog) era escrita desde sessões anteriores por
 * praticamente toda rota de CREATE/UPDATE/DELETE (middleware/audit.ts), mas
 * não havia NENHUMA rota para lê-la de volta até esta fase — este teste
 * cobre o contrato de acesso da rota nova: SUPER_ADMIN/COMPANY_ADMIN/
 * MANAGER passam o guard, OPERATOR/VIEWER não; e um COMPANY_ADMIN nunca
 * consegue forçar `companyId` de outra empresa via query string (IDOR).
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
}));

const listMock = jest.fn().mockResolvedValue({ data: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } });
const listForEntityMock = jest.fn().mockResolvedValue([]);
const getByIdMock = jest.fn().mockResolvedValue({ id: 'log-1' });

jest.mock('../services/audit-log.service', () => ({
  __esModule: true,
  default: {
    list: listMock,
    listForEntity: listForEntityMock,
    getById: getByIdMock,
  },
}));

import express from 'express';
import request from 'supertest';
import auditLogsRoutes from './audit-logs.routes';

function buildApp() {
  const app = express();
  app.use('/api/audit-logs', auditLogsRoutes);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err.message });
  });
  return app;
}

function authHeaderFor(userType: string) {
  return `Bearer test-token-${userType}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ data: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } });
});

describe('GET /api/audit-logs — RBAC', () => {
  const app = buildApp();

  it('rejeita requisição sem token (401)', async () => {
    const res = await request(app).get('/api/audit-logs');
    expect(res.status).toBe(401);
  });

  it.each(['OPERATOR', 'VIEWER', 'MECHANIC'])(
    'rejeita usuário do tipo %s (403) — só SUPER_ADMIN/COMPANY_ADMIN/MANAGER administram auditoria',
    async (userType) => {
      verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });
      const res = await request(app).get('/api/audit-logs').set('Authorization', authHeaderFor(userType));
      expect(res.status).toBe(403);
      expect(listMock).not.toHaveBeenCalled();
    }
  );

  it.each(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'])('permite usuário do tipo %s', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: userType === 'SUPER_ADMIN' ? undefined : 'company-A' });
    const res = await request(app).get('/api/audit-logs').set('Authorization', authHeaderFor(userType));
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/audit-logs — isolamento de tenant', () => {
  const app = buildApp();

  it('COMPANY_ADMIN nunca consegue forçar companyId de outra empresa via query string (IDOR)', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });

    await request(app)
      .get('/api/audit-logs?companyId=company-B')
      .set('Authorization', authHeaderFor('COMPANY_ADMIN'));

    // O valor passado pela query string é sempre ignorado para não-SUPER_ADMIN
    // — o service é chamado com a empresa do PRÓPRIO token, nunca a da query.
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-A' }));
  });

  it('SUPER_ADMIN pode filtrar por qualquer companyId via query string', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'super-1', userType: 'SUPER_ADMIN' });

    await request(app)
      .get('/api/audit-logs?companyId=company-B')
      .set('Authorization', authHeaderFor('SUPER_ADMIN'));

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-B' }));
  });

  it('GET /:id restringe por companyId do próprio token para não-SUPER_ADMIN', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'MANAGER', companyId: 'company-A' });

    await request(app).get('/api/audit-logs/log-1').set('Authorization', authHeaderFor('MANAGER'));

    expect(getByIdMock).toHaveBeenCalledWith('log-1', 'company-A');
  });
});
