/**
 * PRE-PRODUCTION HARDENING (Backend/API): `PUT /api/partners/:id` fazia
 * `const data: any = { ...req.body }`, um "mass assignment" que deixava
 * QUALQUER campo do corpo (inclusive `companyId`) chegar direto em
 * `prisma.partner.update()`. Confirmado ao vivo contra Postgres real que a
 * tentativa de reatribuir `companyId` chegava ao banco — só não causava
 * dano porque a policy de RLS de `partners` tem `WITH CHECK` e rejeitava a
 * linha resultante. Este teste cobre a allowlist explícita que substitui o
 * spread cru — `companyId` (e qualquer campo não reconhecido) nunca deve
 * nem chegar a ser passado para o service.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
}));

const listMock = jest.fn().mockResolvedValue([]);
const updateMock = jest.fn().mockResolvedValue({ id: 'partner-1', name: 'Convênio atualizado' });
// a rota agora lê o convênio ANTES de autorizar por filial (404 se invisível; gerente só mexe no da própria filial)
const getByIdMock = jest.fn();
const deleteMock = jest.fn().mockResolvedValue(undefined);
const toggleMock = jest.fn().mockResolvedValue({ id: 'partner-1', isActive: false });

jest.mock('../services/partner.service', () => ({
  __esModule: true,
  default: {
    list: (...args: any[]) => listMock(...args),
    update: (...args: any[]) => updateMock(...args),
    getById: (...args: any[]) => getByIdMock(...args),
    delete: (...args: any[]) => deleteMock(...args),
    toggleActive: (...args: any[]) => toggleMock(...args),
  },
}));

jest.mock('@ln-system/database', () => ({
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

// O gate de módulo (VENDAS) lê o estado no banco/Redis; a prova dele está em
// test/integration/module-settings-scope.integration.test.ts. Aqui só a allowlist.
jest.mock('../middleware/module', () => ({
  requireModuleEnabled: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import partnersRoutes from './partners.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/partners', partnersRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });
  getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: null });
});

describe('PUT /api/partners/:id — allowlist de campos (mass assignment)', () => {
  const app = buildApp();

  it('nunca repassa companyId do corpo da requisição para o service', async () => {
    const res = await request(app)
      .put('/api/partners/partner-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Convênio hijack', companyId: 'company-B' });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const dataArg = updateMock.mock.calls[0][2];
    expect(dataArg).not.toHaveProperty('companyId');
    expect(dataArg).toEqual({ name: 'Convênio hijack' });
  });

  it('nunca repassa campos desconhecidos (ex.: id, createdAt) para o service', async () => {
    await request(app)
      .put('/api/partners/partner-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'X', id: 'outro-id', createdAt: '2020-01-01', isSystem: true });

    const dataArg = updateMock.mock.calls[0][2];
    expect(Object.keys(dataArg).sort()).toEqual(['name']);
  });

  it('ainda aceita normalmente os campos editáveis reais', async () => {
    await request(app)
      .put('/api/partners/partner-1')
      .set('Authorization', 'Bearer t')
      .send({ discountValue: '15', maxDiscountAmount: '50', stackable: true });

    const dataArg = updateMock.mock.calls[0][2];
    expect(dataArg).toEqual({ discountValue: 15, maxDiscountAmount: 50, stackable: true });
  });
});

describe('escopo de FILIAL do convênio — o gerente só mexe no da própria filial (rota; a RLS repete a regra)', () => {
  const app = buildApp();
  const asManager = (branchId: string | null) =>
    verifyAccessTokenMock.mockReturnValue({ userId: 'm1', userType: 'MANAGER', companyId: 'company-A', branchId });

  it('convênio da empresa toda (sem filial): gerente NÃO edita, NÃO apaga e NÃO ativa/desativa — 403 BRANCH_FORBIDDEN, o service nem é chamado', async () => {
    asManager('branch-A1');
    getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: null });
    const put = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ name: 'x' });
    const del = await request(app).delete('/api/partners/partner-1').set('Authorization', 'Bearer t');
    const tog = await request(app).post('/api/partners/partner-1/toggle-active').set('Authorization', 'Bearer t');
    for (const res of [put, del, tog]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('BRANCH_FORBIDDEN');
    }
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(toggleMock).not.toHaveBeenCalled();
  });

  it('convênio de OUTRA filial: gerente é recusado em PUT/DELETE/toggle', async () => {
    asManager('branch-A1');
    getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: 'branch-A2' });
    const put = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ name: 'x' });
    const del = await request(app).delete('/api/partners/partner-1').set('Authorization', 'Bearer t');
    expect([put.status, del.status]).toEqual([403, 403]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('convênio da PRÓPRIA filial: gerente edita normalmente; tentar mover para outra filial (ou para "empresa toda") é 403', async () => {
    asManager('branch-A1');
    getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: 'branch-A1' });
    const ok = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ name: 'x' });
    expect(ok.status).toBe(200);
    const move = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ branchId: 'branch-A2' });
    const wide = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ branchId: null });
    expect([move.status, wide.status]).toEqual([403, 403]);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('criar: sem branchId a regra de filial deixa passar (nasce na filial do gerente); com OUTRA filial é 403 BRANCH_FORBIDDEN', async () => {
    asManager('branch-A1');
    const body = { name: 'Conv', discountValue: 10 };
    const own = await request(app).post('/api/partners').set('Authorization', 'Bearer t').send(body);
    // o service de criação não está no mock: a rota chega até ele (400 do mock ausente), ou seja, não foi barrada pela regra de filial
    expect(own.status).not.toBe(403);
    const other = await request(app).post('/api/partners').set('Authorization', 'Bearer t').send({ ...body, branchId: 'branch-A2' });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('BRANCH_FORBIDDEN');
  });

  it('gerente sem filial no token: 403 BRANCH_REQUIRED', async () => {
    asManager(null);
    getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: null });
    const res = await request(app).delete('/api/partners/partner-1').set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BRANCH_REQUIRED');
  });

  it('convênio invisível (outra empresa ou inexistente): 404, nunca 403 — não confirma que o id existe', async () => {
    asManager('branch-A1');
    getByIdMock.mockResolvedValue(null);
    const res = await request(app).put('/api/partners/partner-de-outra-empresa').set('Authorization', 'Bearer t').send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('administrador da empresa continua editando convênio da empresa toda e de qualquer filial', async () => {
    getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: null });
    const wide = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ name: 'x' });
    getByIdMock.mockResolvedValue({ id: 'partner-1', companyId: 'company-A', branchId: 'branch-A2' });
    const other = await request(app).put('/api/partners/partner-1').set('Authorization', 'Bearer t').send({ name: 'y' });
    expect([wide.status, other.status]).toEqual([200, 200]);
  });
});
