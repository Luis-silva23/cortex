/**
 * ACHADO DE AUDITORIA: processar e reconciliar pagamento não tinham trava de
 * papel (só cancel/refund tinham, por permissão `finance:reverse`) — VIEWER
 * conseguia registrar um pagamento e disparar reconciliação com o gateway.
 * Processar é chamado só pelo PDV (OPERATOR/MANAGER e admins); reconciliar não
 * tem chamador em nenhum frontend/job e decide o status financeiro de um
 * pagamento pendente, então fica com Gerência+.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const svc = {
  listPayments: jest.fn(),
  getPaymentByTransactionId: jest.fn(),
  processPayment: jest.fn(),
  reconcilePayment: jest.fn(),
};

jest.mock('../services/payment.service', () => ({
  __esModule: true,
  default: {
    listPayments: (...a: any[]) => svc.listPayments(...a),
    getPaymentByTransactionId: (...a: any[]) => svc.getPaymentByTransactionId(...a),
    processPayment: (...a: any[]) => svc.processPayment(...a),
    reconcilePayment: (...a: any[]) => svc.reconcilePayment(...a),
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
import paymentsRoutes from './payments.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRoutes);
  return app;
}

function actAs(userType: string) {
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A', branchId: 'branch-1' });
}

const processCall = (app: express.Express) =>
  request(app).post('/api/payments').set('Authorization', 'Bearer t').send({ saleId: 'sale-1', amount: 10, paymentMethod: 'CASH' });

const reconcileCall = (app: express.Express) => request(app).post('/api/payments/pay-1/reconcile').set('Authorization', 'Bearer t');

beforeEach(() => {
  jest.clearAllMocks();
  svc.listPayments.mockResolvedValue({ payments: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  svc.processPayment.mockResolvedValue({ id: 'pay-new', status: 'APPROVED' });
  svc.reconcilePayment.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
});

describe('payments.routes — processar (PDV) e reconciliar (backoffice)', () => {
  const app = buildApp();

  describe('processar pagamento (POST /)', () => {
    it.each(['VIEWER', 'MECHANIC'])('bloqueia %s com 403 sem chegar ao service', async (userType) => {
      actAs(userType);
      const res = await processCall(app);
      expect(res.status).toBe(403);
      expect(svc.processPayment).not.toHaveBeenCalled();
    });

    it.each(['OPERATOR', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s', async (userType) => {
      actAs(userType);
      const res = await processCall(app);
      expect(res.status).toBe(201);
      expect(svc.processPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconciliar pagamento (POST /:id/reconcile)', () => {
    it.each(['VIEWER', 'MECHANIC', 'OPERATOR'])('bloqueia %s com 403 sem chegar ao service', async (userType) => {
      actAs(userType);
      const res = await reconcileCall(app);
      expect(res.status).toBe(403);
      expect(svc.reconcilePayment).not.toHaveBeenCalled();
    });

    it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s', async (userType) => {
      actAs(userType);
      const res = await reconcileCall(app);
      expect(res.status).toBe(200);
      expect(svc.reconcilePayment).toHaveBeenCalledTimes(1);
    });
  });

  it('NÃO restringe leitura — VIEWER continua listando pagamentos', async () => {
    actAs('VIEWER');
    const res = await request(app).get('/api/payments').set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
  });
});
