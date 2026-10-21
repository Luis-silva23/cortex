const findUniqueCompanyMock = jest.fn();
const findFirstLicenseMock = jest.fn();
const countBranchMock = jest.fn();
const findFirstBranchMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    company: { findUnique: findUniqueCompanyMock },
    license: { findFirst: findFirstLicenseMock },
    branch: { count: countBranchMock, findFirst: findFirstBranchMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

import { BranchService } from './branch.service';

describe('BranchService.create — regras de negócio', () => {
  const service = new BranchService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejeita criar filial para empresa inexistente', async () => {
    findUniqueCompanyMock.mockResolvedValueOnce(null);

    await expect(
      service.create({ companyId: 'company-X', name: 'Filial Nova' })
    ).rejects.toThrow('Empresa não encontrada');
  });

  it('rejeita criar filial além do limite do plano (License.maxBranches)', async () => {
    findUniqueCompanyMock.mockResolvedValueOnce({ id: 'company-A' });
    findFirstLicenseMock.mockResolvedValueOnce({ id: 'lic-1', status: 'ACTIVE', maxBranches: 2 });
    countBranchMock.mockResolvedValueOnce(2); // já no limite

    await expect(
      service.create({ companyId: 'company-A', name: 'Filial 3' })
    ).rejects.toThrow('Limite de filiais do plano atingido');
  });

  it('permite criar quando não há licença ACTIVE (não bloqueia setup inicial)', async () => {
    findUniqueCompanyMock.mockResolvedValueOnce({ id: 'company-A' });
    findFirstLicenseMock.mockResolvedValueOnce(null);
    transactionMock.mockImplementationOnce(async (cb: any) =>
      cb({
        branch: {
          updateMany: jest.fn(),
          create: jest.fn().mockResolvedValue({ id: 'branch-1', companyId: 'company-A', name: 'Matriz' }),
        },
      })
    );

    const result = await service.create({ companyId: 'company-A', name: 'Matriz' });
    expect(result.id).toBe('branch-1');
  });

  it('ao marcar como matriz, desmarca qualquer outra matriz da mesma empresa', async () => {
    findUniqueCompanyMock.mockResolvedValueOnce({ id: 'company-A' });
    findFirstLicenseMock.mockResolvedValueOnce(null);

    const updateManyMock = jest.fn();
    transactionMock.mockImplementationOnce(async (cb: any) =>
      cb({
        branch: {
          updateMany: updateManyMock,
          create: jest.fn().mockResolvedValue({ id: 'branch-2', companyId: 'company-A', isHeadquarter: true }),
        },
      })
    );

    await service.create({ companyId: 'company-A', name: 'Nova Matriz', isHeadquarter: true });

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { companyId: 'company-A', isHeadquarter: true },
      data: { isHeadquarter: false },
    });
  });
});

describe('BranchService.toggleActive / delete — proteção da última filial', () => {
  const service = new BranchService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejeita desativar a única filial ativa da empresa', async () => {
    findFirstBranchMock.mockResolvedValueOnce({ id: 'branch-1', companyId: 'company-A', isActive: true });
    countBranchMock.mockResolvedValueOnce(1);

    await expect(service.toggleActive('branch-1', 'company-A')).rejects.toThrow(
      'Não é possível desativar a única filial ativa da empresa'
    );
  });

  it('rejeita excluir a única filial da empresa', async () => {
    findFirstBranchMock.mockResolvedValueOnce({ id: 'branch-1', companyId: 'company-A' });
    countBranchMock.mockResolvedValueOnce(1);

    await expect(service.delete('branch-1', 'company-A')).rejects.toThrow(
      'Não é possível excluir a única filial da empresa'
    );
  });
});
