/**
 * Cobertura unitária (Prisma mockado) dos 4 contratos de idempotência —
 * a prova de concorrência real (constraint única no Postgres, 5
 * requisições simultâneas -> 1 operação efetiva) foi feita contra o
 * servidor/banco reais nesta mesma sessão; este arquivo cobre os ramos de
 * lógica do middleware para regressão rápida em CI.
 */

const createMock = jest.fn();
const findUniqueMock = jest.fn();
const updateMock = jest.fn();
const updateManyMock = jest.fn();
const deleteManyMock = jest.fn();

class FakeP2002 extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

jest.mock('@ln-system/database', () => ({
  prisma: {
    idempotencyKey: {
      create: (...args: any[]) => createMock(...args),
      findUnique: (...args: any[]) => findUniqueMock(...args),
      update: (...args: any[]) => updateMock(...args),
      updateMany: (...args: any[]) => updateManyMock(...args),
      deleteMany: (...args: any[]) => deleteManyMock(...args),
    },
  },
  Prisma: {
    PrismaClientKnownRequestError: FakeP2002,
  },
}));

jest.mock('../services/logger.service', () => ({
  Logger: { security: jest.fn(), error: jest.fn() },
}));

import { idempotency } from './idempotency';

function mockReqRes(overrides: Partial<any> = {}) {
  const req: any = {
    header: (name: string) => (name === 'Idempotency-Key' ? overrides.key : undefined),
    body: overrides.body ?? { a: 1 },
    user: { companyId: 'company-A', userId: 'user-1' },
    route: { path: '/' },
    baseUrl: '/api/sales',
    method: 'POST',
    requestId: 'req-1',
    ...overrides.req,
  };
  const json = jest.fn();
  const res: any = { statusCode: 200, json, status: jest.fn().mockReturnThis() };
  return { req, res, json };
}

describe('idempotency middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sem header Idempotency-Key: passa direto, sem tocar no banco', async () => {
    const { req, res } = mockReqRes({ key: undefined });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('chave nova: cria registro PENDING e segue para o handler real', async () => {
    createMock.mockResolvedValueOnce({ id: 'idem-1' });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(createMock).toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('mesma chave + mesmo corpo, já COMPLETED: devolve a resposta cacheada sem chamar next()', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex');
    findUniqueMock.mockResolvedValueOnce({
      status: 'COMPLETED',
      requestHash: hash,
      responseStatus: 201,
      responseBody: { id: 'sale-1' },
    });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: 'sale-1' });
    expect(next).not.toHaveBeenCalled();
  });

  it('mesma chave + mesmo corpo, ainda PENDING (corrida concorrente): 409, sem reexecutar', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex');
    findUniqueMock.mockResolvedValueOnce({ status: 'PENDING', requestHash: hash });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });

  const sameHash = () => require('crypto').createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex');

  it('mesma chave + mesmo corpo, FAILED (5xx anterior): reassume a chave e reexecuta', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    findUniqueMock.mockResolvedValueOnce({ id: 'idem-1', status: 'FAILED', requestHash: sameHash() });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'idem-1', status: 'FAILED' } }));
    expect(next).toHaveBeenCalledWith();
    // a resposta nova é persistida no mesmo registro
    updateMock.mockResolvedValueOnce({});
    res.statusCode = 201;
    res.json({ ok: true });
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'idem-1' } }));
  });

  it('chave VENCIDA (expiresAt no passado), já COMPLETED: a chave está livre — remove a vencida, reassume e REEXECUTA (não devolve a resposta antiga)', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002()).mockResolvedValueOnce({ id: 'idem-new' });
    findUniqueMock.mockResolvedValueOnce({
      id: 'idem-old',
      status: 'COMPLETED',
      requestHash: sameHash(),
      responseStatus: 201,
      responseBody: { id: 'sale-antiga' },
      expiresAt: new Date(Date.now() - 60_000),
    });
    deleteManyMock.mockResolvedValueOnce({ count: 1 });
    const { req, res, json } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: 'idem-old', expiresAt: { lte: expect.any(Date) } } });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledWith();
    expect(json).not.toHaveBeenCalled(); // nenhuma resposta antiga foi devolvida
    // a resposta nova é gravada no registro NOVO
    updateMock.mockResolvedValueOnce({});
    res.statusCode = 201;
    res.json({ ok: true });
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'idem-new' } }));
  });

  it('chave vencida reassumida por OUTRA requisição ao mesmo tempo: 409, sem reexecutar', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002()).mockRejectedValueOnce(new FakeP2002());
    findUniqueMock.mockResolvedValueOnce({ id: 'idem-old', status: 'COMPLETED', requestHash: sameHash(), expiresAt: new Date(Date.now() - 1) });
    deleteManyMock.mockResolvedValueOnce({ count: 0 });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });

  it('chave VIGENTE (expiresAt no futuro), já COMPLETED: continua devolvendo a resposta guardada (a janela de 24 h vale)', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    findUniqueMock.mockResolvedValueOnce({
      id: 'idem-1',
      status: 'COMPLETED',
      requestHash: sameHash(),
      responseStatus: 201,
      responseBody: { id: 'sale-1' },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  it('FAILED retomada por outra requisição concorrente: 409, sem reexecutar', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    findUniqueMock.mockResolvedValueOnce({ id: 'idem-1', status: 'FAILED', requestHash: sameHash() });
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });

  it('falha ao consultar a chave existente: vai para o errorHandler (não fica pendurada)', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    const dbError = new Error('conexão perdida');
    findUniqueMock.mockRejectedValueOnce(dbError);
    const { req, res } = mockReqRes({ key: 'abc' });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(next).toHaveBeenCalledWith(dbError);
  });

  it('mesma chave + corpo DIFERENTE: 422, sem reexecutar', async () => {
    createMock.mockRejectedValueOnce(new FakeP2002());
    findUniqueMock.mockResolvedValueOnce({ status: 'COMPLETED', requestHash: 'outro-hash-completamente-diferente' });
    const { req, res } = mockReqRes({ key: 'abc', body: { a: 1 } });
    const next = jest.fn();
    await idempotency()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(next).not.toHaveBeenCalled();
  });
});
