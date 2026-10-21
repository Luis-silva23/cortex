/**
 * ACHADO DE AUDITORIA DE INTEGRAÇÃO: GET/POST /categories eram chamados pelo
 * admin-web (telas de criar/editar produto) mas a rota nunca existiu no
 * backend — 404 silencioso, <select> de categoria sempre vazio. Este teste
 * cobre a rota nova: GET aberto a qualquer usuário do tenant (uso
 * operacional legítimo), escrita (POST/PUT/DELETE) restrita a Gerência+,
 * mesmo padrão já usado em suppliers.routes.ts/products.routes.ts.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const listMock = jest.fn().mockResolvedValue([{ id: 'cat-1', name: 'Óleos' }]);
const getByIdMock = jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Óleos' });
const createMock = jest.fn().mockResolvedValue({ id: 'cat-new', name: 'Categoria Nova' });
const updateMock = jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Categoria Atualizada' });
const deactivateMock = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/category.service', () => ({
  __esModule: true,
  default: {
    list: (...args: any[]) => listMock(...args),
    getById: (...args: any[]) => getByIdMock(...args),
    create: (...args: any[]) => createMock(...args),
    update: (...args: any[]) => updateMock(...args),
    deactivate: (...args: any[]) => deactivateMock(...args),
  },
}));

jest.mock('@ln-system/database', () => ({
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import categoriesRoutes from './categories.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/categories', categoriesRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('categories.routes — GET aberto ao tenant, escrita restrita a Gerência+', () => {
  const app = buildApp();

  it('NÃO restringe leitura (GET /) — qualquer usuário autenticado do tenant popula o <select> de categoria', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'OPERATOR', companyId: 'company-A' });

    const listRes = await request(app).get('/api/categories').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listMock).toHaveBeenCalledTimes(1);

    const getRes = await request(app).get('/api/categories/cat-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
    expect(getByIdMock).toHaveBeenCalledTimes(1);
  });

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])('bloqueia %s de criar categoria (POST) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/categories')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Categoria Hostil' });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('bloqueia %s de editar categoria (PUT) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .put('/api/categories/cat-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Reescrito sem autorização' });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('bloqueia %s de desativar categoria (DELETE) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app).delete('/api/categories/cat-1').set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s criar categoria (POST)', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/categories')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Categoria Legítima' });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s editar (PUT) e desativar (DELETE) categoria', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const putRes = await request(app)
      .put('/api/categories/cat-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Atualizada' });
    expect(putRes.status).toBe(200);

    const deleteRes = await request(app).delete('/api/categories/cat-1').set('Authorization', 'Bearer t');
    expect(deleteRes.status).toBe(200);
  });
});
