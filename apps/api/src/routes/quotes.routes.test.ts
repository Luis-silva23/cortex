/**
 * ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel —
 * inclusive VIEWER conseguia criar/versionar/enviar/decidir/converter
 * qualquer orçamento (convert cria uma Ordem de Serviço de verdade). Sem
 * chamador em nenhum frontend hoje, mas a API já responde a qualquer
 * requisição autenticada — exclui só o VIEWER, mesmo padrão de
 * appointments/follow-ups/revisions.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const listMock = jest.fn().mockResolvedValue({ quotes: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getByIdMock = jest.fn().mockResolvedValue({ id: 'quote-1' });
const createMock = jest.fn().mockResolvedValue({ id: 'quote-new' });

jest.mock('../services/quote.service', () => ({
  __esModule: true,
  default: {
    list: (...args: any[]) => listMock(...args),
    getById: (...args: any[]) => getByIdMock(...args),
    create: (...args: any[]) => createMock(...args),
    addVersion: jest.fn().mockResolvedValue({ id: 'version-1' }),
    send: jest.fn().mockResolvedValue({ id: 'version-1' }),
    decide: jest.fn().mockResolvedValue({ id: 'version-1' }),
    convertToServiceOrder: jest.fn().mockResolvedValue({ id: 'so-1' }),
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
import quotesRoutes from './quotes.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/quotes', quotesRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ quotes: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  getByIdMock.mockResolvedValue({ id: 'quote-1' });
  createMock.mockResolvedValue({ id: 'quote-new' });
});

describe('quotes.routes — GET aberto ao tenant, escrita exclui só VIEWER', () => {
  const app = buildApp();

  it('bloqueia VIEWER de criar orçamento (POST) com 403', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'c1', items: [] });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('permite %s criar orçamento (POST)', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'c1', items: [] });

    expect(res.status).toBe(201);
  });

  it('NÃO restringe leitura (GET /, GET /:id) — inclusive VIEWER continua consultando orçamentos', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/quotes').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);

    const getRes = await request(app).get('/api/quotes/quote-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
  });
});
