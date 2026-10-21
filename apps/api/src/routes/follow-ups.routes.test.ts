/**
 * ACHADO DE AUDITORIA: mesmo achado de appointments.routes.ts — nenhum
 * write tinha trava de papel, inclusive VIEWER conseguia criar/contatar/
 * aceitar/recusar/cancelar qualquer follow-up. Exclui só o VIEWER (fluxo
 * operacional real de pós-venda, usado por OPERATOR/MECHANIC).
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('@ln-system/shared/src/validators/revision.validators', () => ({
  createFollowUpSchema: { parse: (data: any) => data },
  followUpFilterSchema: { parse: (data: any) => data },
  logFollowUpContactSchema: { parse: (data: any) => data },
  declineOrCancelFollowUpSchema: { parse: (data: any) => data },
}));

const listMock = jest.fn().mockResolvedValue({ followUps: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getByIdMock = jest.fn().mockResolvedValue({ id: 'fu-1' });
const createMock = jest.fn().mockResolvedValue({ id: 'fu-new' });
const dashboardMock = jest.fn().mockResolvedValue({});

jest.mock('../services/follow-up.service', () => ({
  __esModule: true,
  default: {
    dashboard: (...args: any[]) => dashboardMock(...args),
    list: (...args: any[]) => listMock(...args),
    getById: (...args: any[]) => getByIdMock(...args),
    create: (...args: any[]) => createMock(...args),
    logContact: jest.fn().mockResolvedValue({ id: 'event-1' }),
    recordAcceptance: jest.fn().mockResolvedValue({ id: 'fu-1' }),
    decline: jest.fn().mockResolvedValue({ id: 'fu-1' }),
    cancel: jest.fn().mockResolvedValue({ id: 'fu-1' }),
  },
}));

jest.mock('@ln-system/database', () => ({
  prisma: { companyModuleSetting: { findMany: jest.fn().mockResolvedValue([]) } },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import followUpsRoutes from './follow-ups.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/follow-ups', followUpsRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ followUps: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  getByIdMock.mockResolvedValue({ id: 'fu-1' });
  createMock.mockResolvedValue({ id: 'fu-new' });
});

describe('follow-ups.routes — GET aberto ao tenant, escrita exclui só VIEWER', () => {
  const app = buildApp();

  it('bloqueia VIEWER de criar follow-up (POST) com 403', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/follow-ups')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'c1', motorcycleId: 'm1', dueDate: new Date().toISOString() });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('permite %s criar follow-up (POST) — fluxo operacional real de pós-venda', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/follow-ups')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'c1', motorcycleId: 'm1', dueDate: new Date().toISOString() });

    expect(res.status).toBe(201);
  });

  it('NÃO restringe leitura (GET /, /dashboard, /:id) — inclusive VIEWER continua consultando', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/follow-ups').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);

    const dashRes = await request(app).get('/api/follow-ups/dashboard').set('Authorization', 'Bearer t');
    expect(dashRes.status).toBe(200);
  });
});
