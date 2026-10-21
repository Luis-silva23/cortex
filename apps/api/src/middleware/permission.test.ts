/**
 * Testes de RBAC granular (requirePermission / requireAllPermissions /
 * requireSameCompany / requireBranchAccess). A maioria das rotas hoje só
 * usa requireUserType (grosseiro); estes middlewares de permissão fina
 * praticamente não têm cobertura. Aqui exercitamos as funções reais,
 * mockando apenas as chamadas ao Prisma que elas fazem internamente.
 */

const findManyUserRoleMock = jest.fn();
const findUniqueUserMock = jest.fn();

jest.mock('@ln-system/database', () => ({
  prisma: {
    userRole: { findMany: findManyUserRoleMock },
    user: { findUnique: findUniqueUserMock },
  },
}));

import { Request, Response, NextFunction } from 'express';
import {
  requirePermission,
  requireAllPermissions,
  requireSameCompany,
  requireBranchAccess,
  COMPANY_ADMIN_PERMISSIONS,
} from './permission';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockNext(): NextFunction {
  return jest.fn();
}

function userRolesWithPermissions(names: string[]) {
  return [
    {
      role: {
        rolePermissions: names.map((name) => ({ permission: { name } })),
      },
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requirePermission', () => {
  it('permite quando o usuário tem a permissão exigida', async () => {
    findManyUserRoleMock.mockResolvedValueOnce(userRolesWithPermissions(['write:products']));

    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requirePermission('write:products')(req, res, next);

    expect(next).toHaveBeenCalledWith(); // sem erro
    expect((next as jest.Mock).mock.calls[0].length).toBe(0);
  });

  it('bloqueia (403 via AuthorizationError) quando falta a permissão', async () => {
    findManyUserRoleMock.mockResolvedValueOnce(userRolesWithPermissions(['read:products']));

    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requirePermission('write:products')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('SUPER_ADMIN sempre passa, sem consultar permissões no banco', async () => {
    const req = {
      user: { userId: 'root', userType: 'SUPER_ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requirePermission('write:products')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(findManyUserRoleMock).not.toHaveBeenCalled();
  });

  it('passa se tiver AO MENOS UMA das permissões (semântica OR)', async () => {
    findManyUserRoleMock.mockResolvedValueOnce(userRolesWithPermissions(['write:sales']));

    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requirePermission('write:products', 'write:sales')(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('encaminha erro quando não há usuário autenticado (AuthorizationError, statusCode 403)', async () => {
    // O middleware usa AuthorizationError também para "não autenticado"
    // (não AuthenticationError/401) — este teste documenta o comportamento
    // real do código, não o que seria semanticamente ideal.
    const req = {} as Request;
    const res = mockRes();
    const next = mockNext();

    await requirePermission('write:products')(req, res, next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });

  it('COMPANY_ADMIN sem perfil tem o padrão administrativo enumerado, e só ele', async () => {
    const req = { user: { userId: 'ca', companyId: 'company-A', userType: 'COMPANY_ADMIN' } } as unknown as Request;
    for (const permission of COMPANY_ADMIN_PERMISSIONS) {
      findManyUserRoleMock.mockResolvedValueOnce([]);
      const next = mockNext();
      await requirePermission(permission)(req, mockRes(), next);
      expect((next as jest.Mock).mock.calls[0].length).toBe(0);
    }
    for (const outside of ['backup:*', 'write:products']) {
      findManyUserRoleMock.mockResolvedValueOnce([]);
      const next = mockNext();
      await requirePermission(outside)(req, mockRes(), next);
      expect((next as jest.Mock).mock.calls[0][0].statusCode).toBe(403);
    }
  });
});

describe('requireAllPermissions', () => {
  it('permite somente quando o usuário tem TODAS as permissões', async () => {
    findManyUserRoleMock.mockResolvedValueOnce(
      userRolesWithPermissions(['write:products', 'delete:products'])
    );

    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireAllPermissions('write:products', 'delete:products')(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('bloqueia quando falta QUALQUER uma das permissões exigidas', async () => {
    findManyUserRoleMock.mockResolvedValueOnce(userRolesWithPermissions(['write:products']));

    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireAllPermissions('write:products', 'delete:products')(req, res, next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('MISSING_PERMISSIONS');
  });

  it('SUPER_ADMIN sempre passa', async () => {
    const req = {
      user: { userId: 'root', userType: 'SUPER_ADMIN' },
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireAllPermissions('write:products', 'delete:products')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(findManyUserRoleMock).not.toHaveBeenCalled();
  });
});

describe('requireSameCompany', () => {
  it('bloqueia quando a companyId do request não bate com a do usuário (params)', () => {
    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
      params: { companyId: 'company-B' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    requireSameCompany(req, res, next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('COMPANY_ACCESS_DENIED');
  });

  it('bloqueia quando a companyId do request não bate com a do usuário (body)', () => {
    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
      params: {},
      body: { companyId: 'company-B' },
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    requireSameCompany(req, res, next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });

  it('permite quando a companyId bate', () => {
    const req = {
      user: { userId: 'u1', companyId: 'company-A', userType: 'ADMIN' },
      params: { companyId: 'company-A' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    requireSameCompany(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('SUPER_ADMIN acessa qualquer companyId', () => {
    const req = {
      user: { userId: 'root', userType: 'SUPER_ADMIN' },
      params: { companyId: 'company-qualquer' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    requireSameCompany(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe('requireBranchAccess', () => {
  it('SUPER_ADMIN e COMPANY_ADMIN sempre passam, sem consultar o banco', async () => {
    const req = {
      user: { userId: 'u1', userType: 'COMPANY_ADMIN' },
      params: { branchId: 'branch-X' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireBranchAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(findUniqueUserMock).not.toHaveBeenCalled();
  });

  it('bloqueia usuário comum vinculado a outra filial', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ branchId: 'branch-A' });

    const req = {
      user: { userId: 'u1', userType: 'EMPLOYEE' },
      params: { branchId: 'branch-B' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireBranchAccess(req, res, next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('BRANCH_ACCESS_DENIED');
  });

  it('permite usuário comum acessando sua própria filial', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ branchId: 'branch-A' });

    const req = {
      user: { userId: 'u1', userType: 'EMPLOYEE' },
      params: { branchId: 'branch-A' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireBranchAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('usuário sem filial fixa (branchId null) tem acesso a todas as filiais da empresa', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ branchId: null });

    const req = {
      user: { userId: 'u1', userType: 'EMPLOYEE' },
      params: { branchId: 'branch-qualquer' },
      body: {},
      query: {},
    } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await requireBranchAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});
