/**
 * ACHADO DE AUDITORIA: mesmo achado de appointments.routes.ts — o único
 * write deste arquivo não tinha trava de papel, inclusive VIEWER
 * conseguia registrar uma revisão. Exclui só o VIEWER (registro de
 * revisão é tarefa operacional real de MECHANIC/OPERATOR).
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('@ln-system/shared/src/validators/revision.validators', () => ({
  createRevisionSchema: { parse: (data: any) => ({ ...data, performedAt: data.performedAt ?? new Date().toISOString() }) },
  revisionFilterSchema: { parse: (data: any) => data },
}));

const listMock = jest.fn().mockResolvedValue({ revisions: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getByIdMock = jest.fn().mockResolvedValue({ id: 'rev-1' });
const createMock = jest.fn().mockResolvedValue({ id: 'rev-new' });

jest.mock('../services/revision.service', () => ({
  __esModule: true,
  default: {
    list: (...args: any[]) => listMock(...args),
    getById: (...args: any[]) => getByIdMock(...args),
    create: (...args: any[]) => createMock(...args),
  },
}));

jest.mock('@ln-system/database', () => ({
  prisma: { companyModuleSetting: { findMany: jest.fn().mockResolvedValue([]) } },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import revisionsRoutes from './revisions.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/revisions', revisionsRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ revisions: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  getByIdMock.mockResolvedValue({ id: 'rev-1' });
  createMock.mockResolvedValue({ id: 'rev-new' });
});

describe('revisions.routes — GET aberto ao tenant, escrita exclui só VIEWER', () => {
  const app = buildApp();

  it('bloqueia VIEWER de registrar revisão (POST) com 403', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/revisions')
      .set('Authorization', 'Bearer t')
      .send({ motorcycleId: 'm1' });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('permite %s registrar revisão (POST) — tarefa operacional real', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/revisions')
      .set('Authorization', 'Bearer t')
      .send({ motorcycleId: 'm1' });

    expect(res.status).toBe(201);
  });

  it('NÃO restringe leitura (GET /, GET /:id) — inclusive VIEWER continua consultando revisões', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/revisions').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);

    const getRes = await request(app).get('/api/revisions/rev-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
  });
});
