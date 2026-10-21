/**
 * ACHADO DE AUDITORIA: nenhuma escrita de OS tinha trava de papel — VIEWER
 * criava OS, adicionava item (em EXECUÇÃO+ isso baixa estoque na hora), movia
 * o status (finalizar/cancelar), atribuía mecânico e registrava checklist de
 * entrada. Chamador: admin-web (sem restrição de papel); mobile/tv só leem
 * OS. A trava exclui só o VIEWER (OPERATOR e MECHANIC são os atores naturais
 * da oficina); leitura e /:id/payment (requirePermission) não mudam.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const svc = {
  list: jest.fn(),
  getById: jest.fn(),
  create: jest.fn(),
  addItem: jest.fn(),
  transitionStatus: jest.fn(),
  assignMechanic: jest.fn(),
  setEstimatedDelivery: jest.fn(),
  registerPayment: jest.fn(),
};
const checklist = { create: jest.fn(), getByServiceOrderId: jest.fn() };

jest.mock('../services/service-order.service', () => ({
  __esModule: true,
  default: {
    list: (...a: any[]) => svc.list(...a),
    getById: (...a: any[]) => svc.getById(...a),
    create: (...a: any[]) => svc.create(...a),
    addItem: (...a: any[]) => svc.addItem(...a),
    transitionStatus: (...a: any[]) => svc.transitionStatus(...a),
    assignMechanic: (...a: any[]) => svc.assignMechanic(...a),
    setEstimatedDelivery: (...a: any[]) => svc.setEstimatedDelivery(...a),
    registerPayment: (...a: any[]) => svc.registerPayment(...a),
  },
}));

jest.mock('../services/vehicle-entry-checklist.service', () => ({
  __esModule: true,
  default: {
    create: (...a: any[]) => checklist.create(...a),
    getByServiceOrderId: (...a: any[]) => checklist.getByServiceOrderId(...a),
  },
}));

jest.mock('@ln-system/database', () => ({
  prisma: { companyModuleSetting: { findMany: jest.fn().mockResolvedValue([]) } },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import serviceOrdersRoutes from './service-orders.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/service-orders', serviceOrdersRoutes);
  return app;
}

function actAs(userType: string) {
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A', branchId: 'branch-1' });
}

const auth = (r: request.Test) => r.set('Authorization', 'Bearer t');

const writes: Array<{ name: string; mock: jest.Mock; okStatus: number; call: (app: express.Express) => request.Test }> = [
  {
    name: 'criar OS',
    mock: svc.create,
    okStatus: 201,
    call: (app) => auth(request(app).post('/api/service-orders')).send({ branchId: 'branch-1', customerId: 'c1', motorcycleId: 'm1', entryKilometer: 1000 }),
  },
  {
    name: 'adicionar item',
    mock: svc.addItem,
    okStatus: 201,
    call: (app) => auth(request(app).post('/api/service-orders/os-1/items')).send({ itemType: 'SERVICE', description: 'Troca de óleo', quantity: 1, unitPrice: 50 }),
  },
  {
    name: 'mudar status',
    mock: svc.transitionStatus,
    okStatus: 200,
    call: (app) => auth(request(app).post('/api/service-orders/os-1/status')).send({ toStatus: 'DIAGNOSTICO' }),
  },
  {
    name: 'atribuir mecânico',
    mock: svc.assignMechanic,
    okStatus: 200,
    call: (app) => auth(request(app).post('/api/service-orders/os-1/mechanic')).send({ mechanicId: 'mech-1' }),
  },
  {
    name: 'definir previsão de entrega',
    mock: svc.setEstimatedDelivery,
    okStatus: 200,
    call: (app) => auth(request(app).put('/api/service-orders/os-1/estimated-delivery')).send({ estimatedDelivery: '2026-10-01' }),
  },
  {
    name: 'registrar checklist de entrada',
    mock: checklist.create,
    okStatus: 201,
    call: (app) => auth(request(app).post('/api/service-orders/os-1/entry-checklist')).send({ motorcycleId: 'm1', items: [{ item: 'Retrovisor', ok: true }] }),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  svc.list.mockResolvedValue({ serviceOrders: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  svc.getById.mockResolvedValue({ id: 'os-1' });
  svc.create.mockResolvedValue({ id: 'os-new' });
  svc.addItem.mockResolvedValue({ id: 'item-1' });
  svc.transitionStatus.mockResolvedValue({ id: 'os-1' });
  svc.assignMechanic.mockResolvedValue({ id: 'os-1' });
  svc.setEstimatedDelivery.mockResolvedValue({ id: 'os-1' });
  checklist.create.mockResolvedValue({ id: 'chk-1' });
  checklist.getByServiceOrderId.mockResolvedValue({ id: 'chk-1' });
});

describe('service-orders.routes — escrita exclui só o VIEWER', () => {
  const app = buildApp();

  describe.each(writes)('$name', ({ mock, okStatus, call }) => {
    it('bloqueia VIEWER com 403 sem chegar ao service', async () => {
      actAs('VIEWER');
      const res = await call(app);
      expect(res.status).toBe(403);
      expect(mock).not.toHaveBeenCalled();
    });

    it.each(['OPERATOR', 'MECHANIC', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s', async (userType) => {
      actAs(userType);
      const res = await call(app);
      expect(res.status).toBe(okStatus);
      expect(mock).toHaveBeenCalledTimes(1);
    });
  });

  it('NÃO restringe leitura — VIEWER continua vendo lista, detalhe e checklist de entrada', async () => {
    actAs('VIEWER');
    expect((await auth(request(app).get('/api/service-orders'))).status).toBe(200);
    expect((await auth(request(app).get('/api/service-orders/os-1'))).status).toBe(200);
    expect((await auth(request(app).get('/api/service-orders/os-1/entry-checklist'))).status).toBe(200);
  });
});
