/**
 * ACHADO DE AUDITORIA: nenhuma trava de papel (nem auditLog) existia em
 * nenhum write deste arquivo — qualquer usuário autenticado do tenant,
 * inclusive VIEWER, podia criar/editar/desativar moto de qualquer
 * cliente. Sem chamador real em pdv-desktop/mobile/tv (só leem dado de
 * moto para exibição) — só admin-web usa create/update/delete — mesmo
 * padrão Gerência+ já estabelecido em suppliers/products/partners/
 * categories.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('@ln-system/shared/src/validators/pdv.validators', () => ({
  motorcycleSchema: { parse: (data: any) => data },
  updateMotorcycleSchema: { parse: (data: any) => data },
}));

const listMock = jest.fn().mockResolvedValue({ motorcycles: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getByIdMock = jest.fn().mockResolvedValue({ id: 'moto-1', brand: 'Honda', model: 'CG 160' });
const createMock = jest.fn().mockResolvedValue({ id: 'moto-new', brand: 'Honda', model: 'CG 160' });
const updateMock = jest.fn().mockResolvedValue({ id: 'moto-1', brand: 'Honda', model: 'CG 160 Atualizada' });
const deactivateMock = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/motorcycle.service', () => ({
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
import motorcyclesRoutes from './motorcycles.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/motorcycles', motorcyclesRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('motorcycles.routes — GET aberto ao tenant; cadastro como Clientes (todos menos VIEWER); edição Gerência+', () => {
  const app = buildApp();

  it('NÃO restringe leitura (GET /, GET /:id) — qualquer usuário autenticado do tenant continua consultando motos', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/motorcycles').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);

    const getRes = await request(app).get('/api/motorcycles/moto-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
    expect(getByIdMock).toHaveBeenCalledTimes(1);
  });

  it.each(['VIEWER'])('bloqueia %s de criar moto (POST) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/motorcycles')
      .set('Authorization', 'Bearer t')
      .send({ brand: 'Honda', model: 'CG 160', customerId: 'customer-1' });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('bloqueia %s de editar moto (PUT) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .put('/api/motorcycles/moto-1')
      .set('Authorization', 'Bearer t')
      .send({ model: 'Reescrito sem autorização' });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('bloqueia %s de desativar moto (DELETE) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app).delete('/api/motorcycles/moto-1').set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s criar moto (POST)', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/motorcycles')
      .set('Authorization', 'Bearer t')
      .send({ brand: 'Honda', model: 'CG 160', customerId: 'customer-1' });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s editar (PUT) e desativar (DELETE) moto', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const putRes = await request(app)
      .put('/api/motorcycles/moto-1')
      .set('Authorization', 'Bearer t')
      .send({ model: 'Atualizada' });
    expect(putRes.status).toBe(200);

    const deleteRes = await request(app).delete('/api/motorcycles/moto-1').set('Authorization', 'Bearer t');
    expect(deleteRes.status).toBe(200);
  });
});
