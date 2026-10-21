const isModuleEnabledMock = jest.fn();

jest.mock('../services/module-settings.service', () => ({
  __esModule: true,
  default: { isModuleEnabled: (...args: any[]) => isModuleEnabledMock(...args) },
}));

import { requireModuleEnabled } from './module';

function mockReqRes(user: any) {
  return { req: { user } as any, res: {} as any, next: jest.fn() };
}

describe('requireModuleEnabled', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bloqueia (chama next com erro) quando não há usuário autenticado', async () => {
    const { req, res, next } = mockReqRes(undefined);
    await requireModuleEnabled('ESTOQUE')(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/não autenticado/) }));
    expect(isModuleEnabledMock).not.toHaveBeenCalled();
  });

  it('deixa passar sem checar o banco quando o usuário é SUPER_ADMIN', async () => {
    const { req, res, next } = mockReqRes({ userType: 'SUPER_ADMIN', companyId: 'company-A' });
    await requireModuleEnabled('FISCAL')(req, res, next);
    expect(next).toHaveBeenCalledWith(); // sem argumento = sucesso
    expect(isModuleEnabledMock).not.toHaveBeenCalled();
  });

  it('deixa passar quando o módulo está habilitado', async () => {
    isModuleEnabledMock.mockResolvedValueOnce(true);
    const { req, res, next } = mockReqRes({ userType: 'COMPANY_ADMIN', companyId: 'company-A', branchId: 'branch-1' });
    await requireModuleEnabled('OFICINA')(req, res, next);
    expect(isModuleEnabledMock).toHaveBeenCalledWith('company-A', 'branch-1', 'OFICINA');
    expect(next).toHaveBeenCalledWith();
  });

  // REGRA FUNDAMENTAL do recurso: mesmo um usuário com toda permissão
  // granular concedida é bloqueado se o MÓDULO estiver desativado — as
  // duas checagens são independentes.
  it('bloqueia com AuthorizationError (MODULE_DISABLED) quando o módulo está desativado', async () => {
    isModuleEnabledMock.mockResolvedValueOnce(false);
    const { req, res, next } = mockReqRes({ userType: 'COMPANY_ADMIN', companyId: 'company-A', branchId: 'branch-1' });
    await requireModuleEnabled('FINANCEIRO')(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MODULE_DISABLED',
        statusCode: 403,
        message: 'Módulo desativado para esta filial ou empresa. Favor entrar em contato com o administrador.',
      })
    );
  });
});
