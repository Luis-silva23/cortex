/**
 * ACHADO DE AUDITORIA: abrir sessão de inventário e lançar contagem não tinham
 * trava de papel (só fechar/cancelar exigiam Gerência+) — VIEWER conseguia
 * abrir inventário e lançar contagens que o fechamento vira ajuste de
 * estoque. Chamador único: admin-web (sem restrição de papel na tela), então
 * a trava exclui só o VIEWER; fechar/cancelar seguem Gerência+ e a leitura
 * segue aberta.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const svc = {
  start: jest.fn(),
  listByCompany: jest.fn(),
  getById: jest.fn(),
  addCount: jest.fn(),
  close: jest.fn(),
  cancel: jest.fn(),
};

jest.mock('../services/inventory.service', () => ({
  __esModule: true,
  default: {
    start: (...a: any[]) => svc.start(...a),
    listByCompany: (...a: any[]) => svc.listByCompany(...a),
    getById: (...a: any[]) => svc.getById(...a),
    addCount: (...a: any[]) => svc.addCount(...a),
    close: (...a: any[]) => svc.close(...a),
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
import inventoryRoutes from './inventory.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', inventoryRoutes);
  return app;
}

function actAs(userType: string) {
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A', branchId: 'branch-1' });
}

const writes: Array<{ name: string; service: keyof typeof svc; call: (app: express.Express) => request.Test }> = [
  {
    name: 'abrir sessão de inventário',
    service: 'start',
    call: (app) => request(app).post('/api/inventory').set('Authorization', 'Bearer t').send({ branchId: 'branch-1' }),
  },
  {
    name: 'lançar contagem',
    service: 'addCount',
    call: (app) => request(app).post('/api/inventory/inv-1/counts').set('Authorization', 'Bearer t').send({ productId: 'p1', countedQuantity: 3 }),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  svc.start.mockResolvedValue({ id: 'inv-1' });
  svc.addCount.mockResolvedValue({ id: 'count-1' });
  svc.close.mockResolvedValue({ id: 'inv-1', status: 'CLOSED' });
  svc.listByCompany.mockResolvedValue([]);
  svc.getById.mockResolvedValue({ id: 'inv-1' });
});

describe('inventory.routes — escrita exclui só o VIEWER', () => {
  const app = buildApp();

  describe.each(writes)('$name', ({ service, call }) => {
    it('bloqueia VIEWER com 403 sem chegar ao service', async () => {
      actAs('VIEWER');
      const res = await call(app);
      expect(res.status).toBe(403);
      expect(svc[service]).not.toHaveBeenCalled();
    });

    it.each(['OPERATOR', 'MECHANIC', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s', async (userType) => {
      actAs(userType);
      const res = await call(app);
      expect(res.status).toBe(201);
      expect(svc[service]).toHaveBeenCalledTimes(1);
    });
  });

  it('fechar inventário continua exigindo Gerência+ (OPERATOR 403, MANAGER 200)', async () => {
    actAs('OPERATOR');
    const denied = await request(app).post('/api/inventory/inv-1/close').set('Authorization', 'Bearer t');
    expect(denied.status).toBe(403);
    expect(svc.close).not.toHaveBeenCalled();

    actAs('MANAGER');
    const allowed = await request(app).post('/api/inventory/inv-1/close').set('Authorization', 'Bearer t');
    expect(allowed.status).toBe(200);
  });

  it('NÃO restringe leitura — VIEWER continua listando e consultando inventários', async () => {
    actAs('VIEWER');
    expect((await request(app).get('/api/inventory').set('Authorization', 'Bearer t')).status).toBe(200);
    expect((await request(app).get('/api/inventory/inv-1').set('Authorization', 'Bearer t')).status).toBe(200);
  });
});
