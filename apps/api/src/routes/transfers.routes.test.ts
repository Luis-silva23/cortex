/**
 * ACHADO DE AUDITORIA: solicitar, enviar e receber transferência não tinham
 * trava de papel (só aprovar/rejeitar/cancelar exigiam Gerência+) — VIEWER
 * conseguia movimentar estoque entre filiais (enviar baixa a origem; receber
 * dá entrada no destino). Chamador único: admin-web (sem restrição de papel),
 * então a trava exclui só o VIEWER; aprovar/rejeitar/cancelar seguem
 * Gerência+ e a leitura segue aberta.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const svc = {
  request: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  approve: jest.fn(),
  reject: jest.fn(),
  send: jest.fn(),
  receive: jest.fn(),
  cancel: jest.fn(),
};

jest.mock('../services/transfer.service', () => ({
  __esModule: true,
  default: {
    request: (...a: any[]) => svc.request(...a),
    list: (...a: any[]) => svc.list(...a),
    getById: (...a: any[]) => svc.getById(...a),
    approve: (...a: any[]) => svc.approve(...a),
    reject: (...a: any[]) => svc.reject(...a),
    send: (...a: any[]) => svc.send(...a),
    receive: (...a: any[]) => svc.receive(...a),
    cancel: (...a: any[]) => svc.cancel(...a),
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
import transfersRoutes from './transfers.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/transfers', transfersRoutes);
  return app;
}

function actAs(userType: string) {
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A', branchId: 'branch-1' });
}

const items = [{ productId: 'p1', quantity: 2 }];

const writes: Array<{ name: string; service: keyof typeof svc; okStatus: number; call: (app: express.Express) => request.Test }> = [
  {
    name: 'solicitar transferência',
    service: 'request',
    okStatus: 201,
    call: (app) =>
      request(app).post('/api/transfers').set('Authorization', 'Bearer t').send({ fromBranchId: 'b1', toBranchId: 'b2', items }),
  },
  {
    name: 'enviar transferência',
    service: 'send',
    okStatus: 200,
    call: (app) => request(app).post('/api/transfers/t-1/send').set('Authorization', 'Bearer t').send({ items }),
  },
  {
    name: 'receber transferência',
    service: 'receive',
    okStatus: 200,
    call: (app) => request(app).post('/api/transfers/t-1/receive').set('Authorization', 'Bearer t').send({ items }),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  svc.request.mockResolvedValue({ id: 't-1' });
  svc.send.mockResolvedValue({ id: 't-1', status: 'IN_TRANSIT' });
  svc.receive.mockResolvedValue({ id: 't-1', status: 'RECEIVED' });
  svc.approve.mockResolvedValue({ id: 't-1', status: 'APPROVED' });
  svc.list.mockResolvedValue([]);
  svc.getById.mockResolvedValue({ id: 't-1' });
});

describe('transfers.routes — escrita exclui só o VIEWER', () => {
  const app = buildApp();

  describe.each(writes)('$name', ({ service, okStatus, call }) => {
    it('bloqueia VIEWER com 403 sem chegar ao service', async () => {
      actAs('VIEWER');
      const res = await call(app);
      expect(res.status).toBe(403);
      expect(svc[service]).not.toHaveBeenCalled();
    });

    it.each(['OPERATOR', 'MECHANIC', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s', async (userType) => {
      actAs(userType);
      const res = await call(app);
      expect(res.status).toBe(okStatus);
      expect(svc[service]).toHaveBeenCalledTimes(1);
    });
  });

  it('aprovar transferência continua exigindo Gerência+ (OPERATOR 403, MANAGER 200)', async () => {
    actAs('OPERATOR');
    const denied = await request(app).post('/api/transfers/t-1/approve').set('Authorization', 'Bearer t');
    expect(denied.status).toBe(403);
    expect(svc.approve).not.toHaveBeenCalled();

    actAs('MANAGER');
    const allowed = await request(app).post('/api/transfers/t-1/approve').set('Authorization', 'Bearer t');
    expect(allowed.status).toBe(200);
  });

  it('NÃO restringe leitura — VIEWER continua listando e consultando transferências', async () => {
    actAs('VIEWER');
    expect((await request(app).get('/api/transfers').set('Authorization', 'Bearer t')).status).toBe(200);
    expect((await request(app).get('/api/transfers/t-1').set('Authorization', 'Bearer t')).status).toBe(200);
  });
});
