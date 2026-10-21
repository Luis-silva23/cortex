/**
 * GET /api/users aceita `userType` e `isActive` (antes só listava tudo, 20 por
 * página): as telas de OS e de comissões de mecânicos precisam só dos
 * mecânicos e tinham de baixar todos os perfis e filtrar no navegador — na
 * tela de comissões só os 20 primeiros usuários chegavam e o resto aparecia
 * como um pedaço do id.
 *
 * Aqui: o repasse dos filtros para o service e a validação (valor inválido é
 * 400, nunca "ignora o filtro"). A prova contra Postgres real está em
 * test/integration/users-list-filters.integration.test.ts.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
  rateLimitAuthorizer: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/logger.service', () => ({
  Logger: { critical: jest.fn() },
}));

const findAllMock = jest.fn();

jest.mock('../services/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findAll: (...args: any[]) => findAllMock(...args),
  })),
}));

jest.mock('../services/role.service', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('@ln-system/database', () => ({
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../middleware/tenant', () => ({
  tenantIsolation: (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import userRoutes from './user.routes';
import { errorHandler } from '../middleware/errorHandler';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', userRoutes);
  app.use(errorHandler);
  return app;
}

const app = buildApp();
const emptyPage = { users: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } };

beforeEach(() => {
  jest.clearAllMocks();
  verifyAccessTokenMock.mockReturnValue({ userId: 'manager-1', userType: 'MANAGER', companyId: 'company-A' });
  findAllMock.mockResolvedValue(emptyPage);
});

const get = (query: string) => request(app).get(`/api/users${query}`).set('Authorization', 'Bearer t');

describe('GET /api/users — filtros opcionais', () => {
  it('sem filtros: comportamento anterior (empresa do token, filtros vazios)', async () => {
    const res = await get('');
    expect(res.status).toBe(200);
    expect(findAllMock).toHaveBeenCalledWith('company-A', { page: 1, limit: 20 }, {});
  });

  it('repassa userType e isActive ao service, convertendo isActive para boolean', async () => {
    const res = await get('?userType=MECHANIC&isActive=true&limit=100');
    expect(res.status).toBe(200);
    expect(findAllMock).toHaveBeenCalledWith('company-A', { page: 1, limit: 100 }, { userType: 'MECHANIC', isActive: true });

    await get('?isActive=false');
    expect(findAllMock).toHaveBeenLastCalledWith('company-A', { page: 1, limit: 20 }, { isActive: false });
  });

  it('SUPER_ADMIN continua sem escopo de empresa (companyId undefined) e pode filtrar', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'root-1', userType: 'SUPER_ADMIN', companyId: undefined });
    await get('?userType=COMPANY_ADMIN');
    expect(findAllMock).toHaveBeenCalledWith(undefined, { page: 1, limit: 20 }, { userType: 'COMPANY_ADMIN' });
  });

  it.each(['MECANICO', 'mechanic', '', 'MECHANIC,MANAGER'])('userType inválido "%s" é 400 e não consulta', async (value) => {
    const res = await get(`?userType=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userType inválido/);
    expect(findAllMock).not.toHaveBeenCalled();
  });

  it('userType repetido (array) é 400', async () => {
    const res = await get('?userType=MECHANIC&userType=MANAGER');
    expect(res.status).toBe(400);
    expect(findAllMock).not.toHaveBeenCalled();
  });

  it.each(['yes', '1', 'TRUE', ''])('isActive inválido "%s" é 400 e não consulta', async (value) => {
    const res = await get(`?isActive=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isActive inválido/);
    expect(findAllMock).not.toHaveBeenCalled();
  });
});
