/**
 * ACHADO DE AUDITORIA: nenhum write de sales.routes.ts tinha trava de papel —
 * VIEWER conseguia criar venda (baixa de estoque + pagamento + caixa) e pedir
 * cancelamento/devolução; MECHANIC idem. Chamadores reais: PDV (criar/
 * cancelar/devolver) e admin-web (cancelar, backoffice) — OPERATOR/MANAGER e
 * admins. Leitura (lista, stats, detalhe) continua aberta ao tenant.
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

const svc = {
  listSales: jest.fn(),
  getSalesStats: jest.fn(),
  getSaleById: jest.fn(),
  createSale: jest.fn(),
  cancelSale: jest.fn(),
  returnSale: jest.fn(),
};

jest.mock('../services/sale.service', () => ({
  __esModule: true,
  default: {
    listSales: (...a: any[]) => svc.listSales(...a),
    getSalesStats: (...a: any[]) => svc.getSalesStats(...a),
    getSaleById: (...a: any[]) => svc.getSaleById(...a),
    createSale: (...a: any[]) => svc.createSale(...a),
    cancelSale: (...a: any[]) => svc.cancelSale(...a),
    returnSale: (...a: any[]) => svc.returnSale(...a),
  },
}));

jest.mock('@ln-system/database', () => ({
  prisma: { companyModuleSetting: { findMany: jest.fn().mockResolvedValue([]) } },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

// A guarda de equipamento de caixa lê a política da empresa (banco): tem teste próprio (middleware/device.test.ts) e de integração.
jest.mock('../middleware/device', () => ({ requireDeviceForCashOps: (_req: unknown, _res: unknown, next: () => void) => next() }));
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

function actAs(userType: string) {
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A', branchId: 'branch-1' });
}

const authorizer = { reason: 'Motivo', authorizerNumericId: 123456, authorizerPassword: 'senha' };

const writes: Array<{ name: string; service: keyof typeof svc; okStatus: number; call: (app: express.Express) => request.Test }> = [
  {
    name: 'criar venda',
    service: 'createSale',
    okStatus: 201,
    call: (app) =>
      request(app)
        .post('/api/sales')
        .set('Authorization', 'Bearer t')
        .send({ branchId: 'branch-1', cashRegisterId: 'cr-1', items: [{ productId: 'p1', quantity: 1, unitPrice: 10 }] }),
  },
  {
    name: 'cancelar venda',
    service: 'cancelSale',
    okStatus: 200,
    call: (app) => request(app).post('/api/sales/sale-1/cancel').set('Authorization', 'Bearer t').send(authorizer),
  },
  {
    name: 'devolver venda',
    service: 'returnSale',
    okStatus: 200,
    call: (app) => request(app).post('/api/sales/sale-1/return').set('Authorization', 'Bearer t').send(authorizer),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  svc.listSales.mockResolvedValue({ sales: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  svc.getSaleById.mockResolvedValue({ id: 'sale-1' });
  svc.createSale.mockResolvedValue({ id: 'sale-new' });
  svc.cancelSale.mockResolvedValue({ id: 'sale-1', status: 'CANCELLED' });
  svc.returnSale.mockResolvedValue({ id: 'sale-1', status: 'RETURNED' });
});

describe('sales.routes — escrita só para quem opera venda', () => {
  const app = buildApp();

  describe.each(writes)('$name', ({ service, okStatus, call }) => {
    it.each(['VIEWER', 'MECHANIC'])('bloqueia %s com 403 sem chegar ao service', async (userType) => {
      actAs(userType);
      const res = await call(app);
      expect(res.status).toBe(403);
      expect(svc[service]).not.toHaveBeenCalled();
    });

    it.each(['OPERATOR', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s', async (userType) => {
      actAs(userType);
      const res = await call(app);
      expect(res.status).toBe(okStatus);
      expect(svc[service]).toHaveBeenCalledTimes(1);
    });
  });

  it('NÃO restringe leitura — VIEWER continua consultando lista e detalhe de vendas', async () => {
    actAs('VIEWER');

    const list = await request(app).get('/api/sales').set('Authorization', 'Bearer t');
    expect(list.status).toBe(200);

    const detail = await request(app).get('/api/sales/sale-1').set('Authorization', 'Bearer t');
    expect(detail.status).toBe(200);
  });
});
