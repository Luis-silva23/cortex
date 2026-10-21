import { Request, Response, NextFunction } from 'express';
const resolveBranchScopeMock = jest.fn();
jest.mock('../services/branch-scope.service', () => ({
  ...jest.requireActual('../services/branch-scope.service'),
  resolveBranchScope: (...args: unknown[]) => resolveBranchScopeMock(...args),
}));

import { companyScoped, tenantIsolation, validateTenantAccess } from './tenant';

beforeEach(() => {
  resolveBranchScopeMock.mockReset();
  resolveBranchScopeMock.mockResolvedValue({ branchIds: [], activeBranchId: null });
});

/**
 * Testes de isolamento multi-tenant (Regra do projeto: Empresa A NÃO pode
 * acessar dados da Empresa B). Estes testes exercitam o middleware real,
 * não uma simulação — qualquer regressão aqui é uma falha de segurança.
 */

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockNext(): NextFunction {
  return jest.fn();
}

describe('tenantIsolation', () => {
  it('rejeita requisição sem usuário autenticado (401)', async () => {
    const req = {} as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('permite SUPER_ADMIN mesmo sem companyId', async () => {
    const req = { user: { userId: 'u1', email: 'a@a.com', userType: 'SUPER_ADMIN' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejeita usuário comum sem companyId (403) — não pode ficar "solto" sem empresa', async () => {
    const req = {
      user: { userId: 'u2', email: 'b@b.com', userType: 'ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('permite usuário comum com companyId definido', async () => {
    const req = {
      user: { userId: 'u3', email: 'c@c.com', userType: 'ADMIN', companyId: 'company-A' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('companyScoped + SUPER_ADMIN — alvo de empresa explícito', () => {
  const run = (path: string, opts?: { except?: string[] }) => {
    const req = { path, headers: {}, query: {}, user: { userId: 'sa', email: 's@a.com', userType: 'SUPER_ADMIN' } } as unknown as Request;
    const next = mockNext();
    companyScoped(opts)(req, mockRes(), next);
    return req as any;
  };

  it('marca a requisição como de empresa', () => {
    expect(run('/').companyScoped).toBe(true);
  });

  it('não marca os caminhos globais listados em `except` (nem sub-caminhos)', () => {
    expect(run('/super-admin', { except: ['/super-admin'] }).companyScoped).toBe(false);
    expect(run('/super-admin/x', { except: ['/super-admin'] }).companyScoped).toBe(false);
    expect(run('/stock', { except: ['/super-admin'] }).companyScoped).toBe(true);
  });

  it('SUPER_ADMIN em rota de empresa SEM alvo: 400 COMPANY_CONTEXT_REQUIRED, sem chegar na rota', async () => {
    const req = { companyScoped: true, headers: {}, query: {}, user: { userId: 'sa', email: 's@a.com', userType: 'SUPER_ADMIN' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('COMPANY_CONTEXT_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN com alvo malformado: 400 INVALID_COMPANY_CONTEXT', async () => {
    const req = { companyScoped: true, headers: { 'x-company-id': 'nao-e-uuid' }, query: {}, user: { userId: 'sa', email: 's@a.com', userType: 'SUPER_ADMIN' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('INVALID_COMPANY_CONTEXT');
    expect(next).not.toHaveBeenCalled();
  });

  it('usuário comum ignora X-Company-Id: continua preso à empresa do token', async () => {
    const req = {
      companyScoped: true,
      headers: { 'x-company-id': '11111111-1111-1111-1111-111111111111' },
      query: { companyId: '22222222-2222-2222-2222-222222222222' },
      user: { userId: 'u', email: 'u@a.com', userType: 'OPERATOR', companyId: 'company-A' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await tenantIsolation(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user.companyId).toBe('company-A');
  });
});

describe('validateTenantAccess — isolamento cross-tenant', () => {
  it('BLOQUEIA usuário da Empresa A tentando acessar recurso da Empresa B', () => {
    const req = {
      user: { userId: 'u1', email: 'a@a.com', userType: 'ADMIN', companyId: 'company-A' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    // Recurso pertence à empresa B
    validateTenantAccess('company-B')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('PERMITE usuário acessando recurso da própria empresa', () => {
    const req = {
      user: { userId: 'u1', email: 'a@a.com', userType: 'ADMIN', companyId: 'company-A' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    validateTenantAccess('company-A')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN pode acessar recurso de qualquer empresa', () => {
    const req = {
      user: { userId: 'u1', email: 'root@ln.com', userType: 'SUPER_ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    validateTenantAccess('company-qualquer')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejeita requisição sem usuário autenticado (401)', () => {
    const req = {} as Request;
    const res = mockRes();
    const next = mockNext();

    validateTenantAccess('company-A')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('tenantIsolation — filiais autorizadas calculadas no servidor (decisão 153)', () => {
  const branchUser = (extra: Record<string, unknown> = {}) =>
    ({ headers: {}, query: {}, user: { userId: 'm1', email: 'm@a.com', userType: 'MANAGER', companyId: 'company-A', branchId: 'b1', ...extra } }) as unknown as Request;

  it('gerente: o conjunto vem do servidor (principal + vínculos) e SOBRESCREVE qualquer branchIds que viesse no token', async () => {
    resolveBranchScopeMock.mockResolvedValue({ branchIds: ['b1', 'b2'], activeBranchId: 'b1' });
    const req = branchUser({ branchIds: ['b1', 'b2', 'b3-forjada'] });
    const next = mockNext();
    await tenantIsolation(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user.branchIds).toEqual(['b1', 'b2']);
    expect((req as any).user.branchId).toBe('b1');
    expect(resolveBranchScopeMock).toHaveBeenCalledTimes(1);
  });

  it('vínculo removido: a filial do token deixa de valer e a ativa passa a ser a que sobrou', async () => {
    resolveBranchScopeMock.mockResolvedValue({ branchIds: ['b2'], activeBranchId: 'b2' });
    const req = branchUser({ branchId: 'b1' });
    await tenantIsolation(req, mockRes(), mockNext());
    expect((req as any).user.branchIds).toEqual(['b2']);
    expect((req as any).user.branchId).toBe('b2');
  });

  it('gerente sem nenhuma filial vinculada: segue sem filial (as rotas respondem BRANCH_REQUIRED)', async () => {
    resolveBranchScopeMock.mockResolvedValue({ branchIds: [], activeBranchId: null });
    const req = branchUser();
    const next = mockNext();
    await tenantIsolation(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user.branchIds).toEqual([]);
    expect((req as any).user.branchId).toBeUndefined();
  });

  it('COMPANY_ADMIN não consulta vínculos: a empresa inteira vem da RLS, e uma lista no token é descartada', async () => {
    const req = branchUser({ userType: 'COMPANY_ADMIN', branchId: undefined, branchIds: ['b9'] });
    const next = mockNext();
    await tenantIsolation(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(resolveBranchScopeMock).not.toHaveBeenCalled();
    expect((req as any).user.branchIds).toBeUndefined();
  });

  it('falha ao ler os vínculos: 503 AUTH_UNAVAILABLE (nunca aceita sem provar o escopo, nunca 401/403)', async () => {
    resolveBranchScopeMock.mockRejectedValue(new Error('banco fora'));
    const res = { ...mockRes(), setHeader: jest.fn() } as unknown as Response;
    const next = mockNext();
    await tenantIsolation(branchUser(), res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('AUTH_UNAVAILABLE');
    expect(next).not.toHaveBeenCalled();
  });
});
