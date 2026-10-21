const findManyMock = jest.fn();
const findFirstMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();
const branchFindFirstMock = jest.fn();
const companyFindFirstMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    companyModuleSetting: {
      findMany: findManyMock,
      findFirst: findFirstMock,
      create: createMock,
      update: updateMock,
    },
    branch: { findFirst: branchFindFirstMock },
    company: { findFirst: companyFindFirstMock },
  })),
  Prisma: {},
}));

import { DEFAULT_DISABLED_MODULES, ModuleSettingsService } from './module-settings.service';

describe('ModuleSettingsService.isModuleEnabled', () => {
  const service = new ModuleSettingsService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retorna habilitado por padrão quando não há nenhuma configuração (opt-out)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const enabled = await service.isModuleEnabled('company-A', 'branch-1', 'ESTOQUE');
    expect(enabled).toBe(true);
  });

  it('respeita a configuração company-wide (branchId null) quando não há override de filial', async () => {
    findManyMock.mockResolvedValueOnce([{ branchId: null, module: 'FISCAL', isEnabled: false }]);
    const enabled = await service.isModuleEnabled('company-A', 'branch-1', 'FISCAL');
    expect(enabled).toBe(false);
  });

  it('override de filial específica vence sobre a configuração company-wide', async () => {
    findManyMock.mockResolvedValueOnce([
      { branchId: null, module: 'OFICINA', isEnabled: false },
      { branchId: 'branch-1', module: 'OFICINA', isEnabled: true },
    ]);
    const enabled = await service.isModuleEnabled('company-A', 'branch-1', 'OFICINA');
    expect(enabled).toBe(true);
  });

  it('uma filial sem override próprio cai para a configuração company-wide', async () => {
    findManyMock.mockResolvedValueOnce([
      { branchId: null, module: 'COMPRAS', isEnabled: false },
      { branchId: 'branch-2', module: 'COMPRAS', isEnabled: true }, // outra filial, não deve afetar branch-1
    ]);
    const enabled = await service.isModuleEnabled('company-A', 'branch-1', 'COMPRAS');
    expect(enabled).toBe(false);
  });

  it('sem branchId informado, usa só a configuração company-wide', async () => {
    findManyMock.mockResolvedValueOnce([{ branchId: null, module: 'VENDAS', isEnabled: false }]);
    const enabled = await service.isModuleEnabled('company-A', null, 'VENDAS');
    expect(enabled).toBe(false);
  });
});

describe('ModuleSettingsService.setEnabled', () => {
  const service = new ModuleSettingsService();

  beforeEach(() => {
    jest.clearAllMocks();
    branchFindFirstMock.mockResolvedValue({ id: 'branch-1' });
    companyFindFirstMock.mockResolvedValue({ id: 'company-A' });
    createMock.mockImplementation(({ data }: any) => Promise.resolve({ id: 'setting-new', ...data }));
    updateMock.mockImplementation(({ data }: any) => Promise.resolve({ id: 'setting-1', ...data }));
  });

  // `companyId` undefined no where do Prisma é IGNORADO: sem estas travas o
  // findFirst casaria a primeira linha do módulo de QUALQUER empresa e a alteraria.
  it('sem companyId NÃO grava nada (nem consulta) — o where sem empresa casaria qualquer linha', async () => {
    await expect(
      service.setEnabled({ companyId: undefined as any, module: 'FISCAL', isEnabled: true, actorId: 'user-1' })
    ).rejects.toThrow('companyId é obrigatório');
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('empresa que não existe é recusada antes de gravar', async () => {
    companyFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      service.setEnabled({ companyId: 'nao-existe', module: 'FISCAL', isEnabled: false, actorId: 'user-1', reason: 'teste' })
    ).rejects.toThrow('Empresa não encontrada');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('listEffective sem empresa devolve o padrão (tudo habilitado, exceto o módulo opt-in CANAIS) sem ler o banco', async () => {
    const effective = await service.listEffective(undefined);
    expect(effective.length).toBeGreaterThan(0);
    expect(effective.every((m) => m.source === 'DEFAULT' && m.isEnabled === (m.module !== 'CANAIS'))).toBe(true);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('CANAIS nasce desativado (opt-in) e é o único: sem linha de configuração, os demais módulos seguem habilitados', async () => {
    findManyMock.mockResolvedValue([]);
    expect(await service.isModuleEnabled('company-A', 'branch-1', 'CANAIS')).toBe(false);
    expect(await service.isModuleEnabled('company-A', 'branch-1', 'FISCAL')).toBe(true);
    expect(DEFAULT_DISABLED_MODULES).toEqual(['CANAIS']);
  });

  it('listRaw sem empresa é recusado (não lista as linhas de todas as empresas)', async () => {
    await expect(service.listRaw(undefined as any)).rejects.toThrow('companyId é obrigatório');
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('rejeita módulo desconhecido', async () => {
    await expect(
      service.setEnabled({ companyId: 'company-A', module: 'NAO_EXISTE' as any, isEnabled: false, actorId: 'user-1' })
    ).rejects.toThrow('Unknown module');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejeita branchId que não pertence à empresa (mesma classe de achado já corrigida em outros services nesta sessão)', async () => {
    branchFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      service.setEnabled({
        companyId: 'company-A',
        branchId: 'branch-of-another-company',
        module: 'ESTOQUE',
        isEnabled: false,
        actorId: 'user-1',
      })
    ).rejects.toThrow('not found in this company');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('cria um novo registro quando nenhum existia, gravando quem desativou e por quê', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const result = await service.setEnabled({
      companyId: 'company-A',
      module: 'FISCAL',
      isEnabled: false,
      actorId: 'user-1',
      reason: 'Empresa ainda não emite nota fiscal',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: 'company-A',
          branchId: null,
          module: 'FISCAL',
          isEnabled: false,
          disabledBy: 'user-1',
          disabledReason: 'Empresa ainda não emite nota fiscal',
        }),
      })
    );
    expect(result.isEnabled).toBe(false);
  });

  it('atualiza um registro existente em vez de duplicar (respeita a UNIQUE parcial)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'setting-1', companyId: 'company-A', branchId: null, module: 'FISCAL' });
    await service.setEnabled({ companyId: 'company-A', module: 'FISCAL', isEnabled: true, actorId: 'user-2' });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'setting-1' },
        data: expect.objectContaining({ isEnabled: true, reenabledBy: 'user-2' }),
      })
    );
    expect(createMock).not.toHaveBeenCalled();
  });
});
