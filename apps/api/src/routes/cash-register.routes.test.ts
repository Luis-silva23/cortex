/**
 * ACHADO DE AUDITORIA: nenhum write de cash-register.routes.ts tinha trava de
 * papel — VIEWER (só-leitura no resto do sistema) e MECHANIC conseguiam abrir
 * e fechar caixa e lançar reforço. O único chamador real é o PDV, operado por
 * OPERATOR/MANAGER e admins, então a trava aceita só esses papéis; leitura
 * (caixa atual, histórico, fechamento) continua aberta ao tenant.
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
  getCurrentOpenRegister: jest.fn(),
  listCashRegisters: jest.fn(),
  getCashRegisterById: jest.fn(),
  getClosureReport: jest.fn(),
  openCashRegister: jest.fn(),
  closeCashRegister: jest.fn(),
  addCashMovement: jest.fn(),
  requestWithdrawal: jest.fn(),
};

jest.mock('../services/cash-register.service', () => ({
  __esModule: true,
  default: {
    getCurrentOpenRegister: (...a: any[]) => svc.getCurrentOpenRegister(...a),
    listCashRegisters: (...a: any[]) => svc.listCashRegisters(...a),
    getCashRegisterById: (...a: any[]) => svc.getCashRegisterById(...a),
    getClosureReport: (...a: any[]) => svc.getClosureReport(...a),
    openCashRegister: (...a: any[]) => svc.openCashRegister(...a),
    closeCashRegister: (...a: any[]) => svc.closeCashRegister(...a),
    addCashMovement: (...a: any[]) => svc.addCashMovement(...a),
    requestWithdrawal: (...a: any[]) => svc.requestWithdrawal(...a),
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
import cashRegisterRoutes from './cash-register.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cash-register', cashRegisterRoutes);
  return app;
}

function actAs(userType: string) {
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A', branchId: 'branch-1' });
}

const writes: Array<{ name: string; service: keyof typeof svc; okStatus: number; call: (app: express.Express) => request.Test }> = [
  {
    name: 'abrir caixa',
    service: 'openCashRegister',
    okStatus: 201,
    call: (app) =>
      request(app)
        .post('/api/cash-register/open')
        .set('Authorization', 'Bearer t')
        .send({ branchId: 'branch-1', registerNumber: 1, openingAmount: 100 }),
  },
  {
    name: 'fechar caixa',
    service: 'closeCashRegister',
    okStatus: 200,
    call: (app) => request(app).post('/api/cash-register/cr-1/close').set('Authorization', 'Bearer t').send({ actualAmount: 100 }),
  },
  {
    name: 'lançar reforço',
    service: 'addCashMovement',
    okStatus: 201,
    call: (app) =>
      request(app)
        .post('/api/cash-register/movement')
        .set('Authorization', 'Bearer t')
        .send({ cashRegisterId: 'cr-1', movementType: 'DEPOSIT', amount: 10 }),
  },
  {
    name: 'retirada (sangria)',
    service: 'requestWithdrawal',
    okStatus: 201,
    call: (app) =>
      request(app)
        .post('/api/cash-register/cr-1/withdrawal')
        .set('Authorization', 'Bearer t')
        .send({ amount: 10, reason: 'Troco', authorizerNumericId: 123456, authorizerPassword: 'senha' }),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  svc.getCurrentOpenRegister.mockResolvedValue({ id: 'cr-1', status: 'OPEN' });
  svc.listCashRegisters.mockResolvedValue({ cashRegisters: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  svc.openCashRegister.mockResolvedValue({ id: 'cr-1' });
  svc.closeCashRegister.mockResolvedValue({ id: 'cr-1' });
  svc.addCashMovement.mockResolvedValue({ id: 'mv-1' });
  svc.requestWithdrawal.mockResolvedValue({ id: 'mv-2' });
});

describe('cash-register.routes — escrita só para quem opera o caixa', () => {
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

  it.each([
    ['número do caixa zero', { registerNumber: 0, openingAmount: 100 }, 'registerNumber'],
    ['número do caixa fracionário', { registerNumber: 1.5, openingAmount: 100 }, 'registerNumber'],
    ['número do caixa acima do Int do banco', { registerNumber: 3_000_000_000, openingAmount: 100 }, 'registerNumber'],
    ['valor inicial negativo', { registerNumber: 2, openingAmount: -50 }, 'openingAmount'],
  ])('abrir caixa recusa %s com mensagem legível, sem chegar ao service', async (_label, body, field) => {
    actAs('OPERATOR');
    const res = await request(app)
      .post('/api/cash-register/open')
      .set('Authorization', 'Bearer t')
      .send({ branchId: 'branch-1', ...body });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
    expect(res.body.error).not.toMatch(/^\s*\[/); // não é o JSON cru do ZodError
    expect(svc.openCashRegister).not.toHaveBeenCalled();
  });

  it('NÃO restringe leitura — VIEWER continua consultando caixa atual e histórico', async () => {
    actAs('VIEWER');

    const current = await request(app).get('/api/cash-register/current').query({ branchId: 'branch-1' }).set('Authorization', 'Bearer t');
    expect(current.status).toBe(200);

    const history = await request(app).get('/api/cash-register/history').set('Authorization', 'Bearer t');
    expect(history.status).toBe(200);
  });
});
