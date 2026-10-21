/**
 * ACHADO DE AUDITORIA: POST /sales/:id/return exigia `items` no corpo
 * (schema Zod), mas o PDV sempre chamou essa rota SEM items (devolução
 * total) — todo clique em "Devolver Venda" retornava 400 antes de chegar
 * no service. Corrigido junto com a exigência de dupla autorização (mesmo
 * padrão de POST /sales/:id/cancel, já que devolução faz o mesmo estorno
 * financeiro). Este teste cobre a rota: omitir items agora é aceito
 * (devolução total), e faltar os campos de autorizador é rejeitado (400)
 * antes de chamar o service.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitMFA: (_req: any, _res: any, next: any) => next(),
  rateLimitAuthorizer: (_req: any, _res: any, next: any) => next(),
}));

const returnSaleMock = jest.fn().mockResolvedValue({ id: 'sale-1', status: 'RETURNED', authorizer: { id: 'a1', name: 'Carlos' } });

jest.mock('../services/sale.service', () => ({
  __esModule: true,
  default: {
    returnSale: (...args: any[]) => returnSaleMock(...args),
  },
}));

jest.mock('@ln-system/database', () => ({
  prisma: {
    companyModuleSetting: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import salesRoutes from './sales.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sales', salesRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  returnSaleMock.mockResolvedValue({ id: 'sale-1', status: 'RETURNED', authorizer: { id: 'a1', name: 'Carlos' } });
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'OPERATOR', companyId: 'company-A', branchId: 'branch-1' });
});

describe('POST /sales/:id/return', () => {
  const app = buildApp();

  it('aceita a chamada real do PDV: SEM items (devolução total) + autorizador — antes desta correção isto sempre dava 400', async () => {
    const res = await request(app)
      .post('/api/sales/sale-1/return')
      .set('Authorization', 'Bearer t')
      .send({ reason: 'Produto com defeito', authorizerNumericId: 123456, authorizerPassword: 'senha-correta' });

    expect(res.status).toBe(200);
    expect(returnSaleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sale-1',
        reason: 'Produto com defeito',
        items: undefined,
        authorizerNumericId: 123456,
        authorizerPassword: 'senha-correta',
      })
    );
  });

  it('rejeita (400) sem os campos de autorizador — antes desta correção não havia exigência nenhuma de autorização', async () => {
    const res = await request(app)
      .post('/api/sales/sale-1/return')
      .set('Authorization', 'Bearer t')
      .send({ reason: 'Produto com defeito' });

    expect(res.status).toBe(400);
    expect(returnSaleMock).not.toHaveBeenCalled();
  });

  it('devolução parcial: repassa os items informados ao service', async () => {
    const items = [{ saleItemId: 'item-1', quantity: 1 }];
    const res = await request(app)
      .post('/api/sales/sale-1/return')
      .set('Authorization', 'Bearer t')
      .send({ reason: 'Produto com defeito', items, authorizerNumericId: 123456, authorizerPassword: 'senha-correta' });

    expect(res.status).toBe(200);
    expect(returnSaleMock).toHaveBeenCalledWith(expect.objectContaining({ items }));
  });

  it('propaga o erro do service (ex.: dupla autorização recusada) como 400 com a mensagem exata', async () => {
    returnSaleMock.mockRejectedValueOnce(new Error('The requesting user cannot authorize their own sale return'));

    const res = await request(app)
      .post('/api/sales/sale-1/return')
      .set('Authorization', 'Bearer t')
      .send({ reason: 'Produto com defeito', authorizerNumericId: 123456, authorizerPassword: 'senha-correta' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The requesting user cannot authorize their own sale return');
  });
});
