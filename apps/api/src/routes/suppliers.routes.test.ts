/**
 * ACHADO DE AUDITORIA: criar/editar/desativar fornecedor não tinha NENHUMA
 * trava de papel — qualquer usuário autenticado do tenant (inclusive
 * OPERATOR/MECHANIC) podia reescrever dado cadastral real de um fornecedor
 * (CNPJ, endereço, contato/pagamento) usado depois por Compras/Financeiro,
 * ou desativá-lo. Mesmo padrão já usado em partners.routes.ts: GET
 * permanece aberto a qualquer usuário do tenant (uso operacional legítimo),
 * escrita (POST/PUT/DELETE) agora exige Gerência+.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const listMock = jest.fn().mockResolvedValue({ suppliers: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getByIdMock = jest.fn().mockResolvedValue({ id: 'supplier-1', name: 'Fornecedor X' });
const createMock = jest.fn().mockResolvedValue({ id: 'supplier-new', name: 'Fornecedor Novo' });
const updateMock = jest.fn().mockResolvedValue({ id: 'supplier-1', name: 'Fornecedor Atualizado' });
const deactivateMock = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/supplier.service', () => ({
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
import suppliersRoutes from './suppliers.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/suppliers', suppliersRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('suppliers.routes — guarda de papel em escrita (achado de auditoria)', () => {
  const app = buildApp();

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])(
    'bloqueia %s de criar fornecedor (POST) com 403',
    async (userType) => {
      verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', 'Bearer t')
        .send({ name: 'Fornecedor Hostil', document: '12345678000199' });

      expect(res.status).toBe(403);
      expect(createMock).not.toHaveBeenCalled();
    }
  );

  it.each(['OPERATOR', 'MECHANIC'])('bloqueia %s de editar fornecedor (PUT) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .put('/api/suppliers/supplier-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Reescrito sem autorização' });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('bloqueia %s de desativar fornecedor (DELETE) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app).delete('/api/suppliers/supplier-1').set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s criar fornecedor (POST)', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/suppliers')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Fornecedor Legítimo', document: '12345678000199' });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s editar (PUT) e desativar (DELETE) fornecedor', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const putRes = await request(app)
      .put('/api/suppliers/supplier-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Atualizado' });
    expect(putRes.status).toBe(200);

    const deleteRes = await request(app).delete('/api/suppliers/supplier-1').set('Authorization', 'Bearer t');
    expect(deleteRes.status).toBe(200);
  });

  it('NÃO restringe leitura (GET /) — qualquer usuário autenticado do tenant continua podendo listar/buscar fornecedores', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'OPERATOR', companyId: 'company-A' });

    const listRes = await request(app).get('/api/suppliers').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);

    const getRes = await request(app).get('/api/suppliers/supplier-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
    expect(getByIdMock).toHaveBeenCalledTimes(1);
  });
});
