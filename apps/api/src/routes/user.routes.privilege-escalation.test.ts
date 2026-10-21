/**
 * CRÍTICO (achado de auditoria, 2026-09-14): `POST /api/users` e
 * `PUT /api/users/:id` aceitavam `userType` sem nenhuma restrição — um
 * COMPANY_ADMIN (que passa em `requireUserType('SUPER_ADMIN',
 * 'COMPANY_ADMIN')`) podia criar um usuário novo com `userType:
 * 'SUPER_ADMIN'` (acesso à plataforma inteira, sem limite de companyId) ou
 * promover QUALQUER usuário da própria empresa — inclusive a si mesmo —
 * para SUPER_ADMIN com uma única chamada PUT. Mesma classe do bug de
 * escalação de privilégio já corrigido nesta sessão para
 * assignRoleToUser/backup (commit 0dc2e6d), por um caminho diferente.
 * Confirmado ao vivo contra a API real rodando (login como COMPANY_ADMIN,
 * as duas tentativas de exploit, e verificação direta no banco de que
 * nenhuma delas persistiu) antes desta correção ser escrita como teste.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
  rateLimitAuthorizer: (_req: any, _res: any, next: any) => next(),
}));

const createMock = jest.fn().mockResolvedValue({ id: 'new-user', userType: 'MANAGER' });
const updateMock = jest.fn().mockResolvedValue({ id: 'victim-user', userType: 'MANAGER' });

jest.mock('../services/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    create: (...args: any[]) => createMock(...args),
    update: (...args: any[]) => updateMock(...args),
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', userRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/users — COMPANY_ADMIN não pode criar um SUPER_ADMIN', () => {
  const app = buildApp();

  it('rejeita com 403 quando um COMPANY_ADMIN tenta criar userType SUPER_ADMIN', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'admin-1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Evil', email: 'evil@test.local', password: 'Password123!', userType: 'SUPER_ADMIN' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Apenas um Super Admin pode criar outro Super Admin/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('permite normalmente um COMPANY_ADMIN criar um MANAGER (ação legítima)', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'admin-1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Legit', email: 'legit@test.local', password: 'Password123!', userType: 'MANAGER' });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('permite um SUPER_ADMIN criar outro SUPER_ADMIN (caminho legítimo, único permitido)', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'root-1', userType: 'SUPER_ADMIN', companyId: undefined });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer t')
      .send({ name: 'New Root', email: 'newroot@test.local', password: 'Password123!', userType: 'SUPER_ADMIN' });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/users/:id — COMPANY_ADMIN não pode promover ninguém a SUPER_ADMIN', () => {
  const app = buildApp();

  it('rejeita com 403 quando um COMPANY_ADMIN tenta promover outro usuário da mesma empresa a SUPER_ADMIN', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'admin-1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });

    const res = await request(app)
      .put('/api/users/victim-user')
      .set('Authorization', 'Bearer t')
      .send({ userType: 'SUPER_ADMIN' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Apenas um Super Admin pode promover alguém a Super Admin/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejeita mesmo quando o COMPANY_ADMIN tenta promover A SI MESMO', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'admin-1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });

    const res = await request(app)
      .put('/api/users/admin-1')
      .set('Authorization', 'Bearer t')
      .send({ userType: 'SUPER_ADMIN' });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('permite normalmente um COMPANY_ADMIN editar o nome de um usuário (ação legítima)', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'admin-1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });

    const res = await request(app)
      .put('/api/users/victim-user')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Nome corrigido' });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
