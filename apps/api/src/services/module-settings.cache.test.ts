/**
 * Cache do estado dos módulos (gate de acesso) — dois defeitos reais achados na prova
 * ao vivo de "ligar/desligar módulo" com 2 filiais:
 *  1) o cache é por EMPRESA mas era preenchido sob o RLS de quem chamou: um usuário de
 *     filial só enxerga as linhas company-wide + as da própria filial, então o override
 *     de OUTRA filial sumia do cache e o gate dela lia "habilitado";
 *  2) corrida "lê o banco (estado velho) → toggle + invalidação → grava o cache velho":
 *     o módulo ficava no estado errado até o TTL (5 min).
 */
const store = new Map<string, any>();
const fakeCache = {
  get: jest.fn(async (key: string) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null)),
  set: jest.fn(async (key: string, value: any) => {
    store.set(key, JSON.parse(JSON.stringify(value)));
  }),
  delete: jest.fn(async (key: string) => {
    store.delete(key);
  }),
  increment: jest.fn(async (key: string) => {
    const next = (Number(store.get(key)) || 0) + 1;
    store.set(key, next);
    return next;
  }),
  expire: jest.fn(async () => undefined),
};

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: fakeCache,
  CacheKeys: {
    moduleSettings: (companyId: string) => `company:${companyId}:module-settings`,
    moduleSettingsGen: (companyId: string) => `company:${companyId}:module-settings:gen`,
  },
  CacheTTL: { MODULE_SETTINGS: 300 },
}));

const findManyMock = jest.fn();
const findFirstMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    companyModuleSetting: {
      findMany: findManyMock,
      findFirst: findFirstMock,
      create: createMock,
      update: updateMock,
    },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'branch-2' }) },
    company: { findFirst: jest.fn().mockResolvedValue({ id: 'company-A' }) },
  })),
  Prisma: {},
}));

import { getCurrentRLSContext } from '@ln-system/database';
import { ModuleSettingsService } from './module-settings.service';

type Row = { branchId: string | null; module: string; isEnabled: boolean };

describe('ModuleSettingsService — cache do gate (por empresa, sob RLS de filial)', () => {
  const service = new ModuleSettingsService();

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    findFirstMock.mockResolvedValue(null);
    createMock.mockImplementation(({ data }: any) => Promise.resolve({ id: 'setting-new', ...data }));
    updateMock.mockImplementation(({ data }: any) => Promise.resolve({ id: 'setting-1', ...data }));
  });

  it('lê o conjunto COMPLETO da empresa (contexto de administração, sem filial), não o RLS de quem chamou', async () => {
    const seen: Array<ReturnType<typeof getCurrentRLSContext>> = [];
    findManyMock.mockImplementation(async () => {
      seen.push(getCurrentRLSContext());
      return [];
    });

    await service.isModuleEnabled('company-A', 'branch-1', 'ESTOQUE');

    expect(seen).toEqual([{ companyId: 'company-A', userType: 'COMPANY_ADMIN', branchId: null }]);
  });

  it('o override de OUTRA filial vale mesmo quando o cache foi aquecido por um usuário da filial 1', async () => {
    // Com o RLS de filial a filial 1 veria só [company-wide]; com o contexto de admin vê tudo.
    const all: Row[] = [{ branchId: 'branch-2', module: 'ESTOQUE', isEnabled: false }];
    findManyMock.mockImplementation(async () => {
      const ctx = getCurrentRLSContext();
      return ctx?.userType === 'COMPANY_ADMIN' && ctx.branchId === null ? all : [];
    });

    // A filial 1 aquece o cache primeiro...
    expect(await service.isModuleEnabled('company-A', 'branch-1', 'ESTOQUE')).toBe(true);
    // ...e a filial 2 continua BLOQUEADA (o gate não pode ler "sem override = habilitado").
    expect(await service.isModuleEnabled('company-A', 'branch-2', 'ESTOQUE')).toBe(false);
  });

  it('1ª consulta lê o banco e grava o cache; a 2ª vem do cache (sem novo findMany)', async () => {
    findManyMock.mockResolvedValue([{ branchId: null, module: 'FISCAL', isEnabled: false }]);

    expect(await service.isModuleEnabled('company-A', null, 'FISCAL')).toBe(false);
    expect(await service.isModuleEnabled('company-A', null, 'FISCAL')).toBe(false);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(store.get('company:company-A:module-settings')).toMatchObject({ gen: 0 });
  });

  it('setEnabled invalida na hora: a consulta seguinte lê o banco e enxerga o novo estado', async () => {
    findManyMock.mockResolvedValueOnce([]); // estado antigo: habilitado
    expect(await service.isModuleEnabled('company-A', null, 'VENDAS')).toBe(true);

    findManyMock.mockResolvedValueOnce([{ branchId: null, module: 'VENDAS', isEnabled: false }]);
    await service.setEnabled({ companyId: 'company-A', module: 'VENDAS', isEnabled: false, actorId: 'user-1', reason: 'teste' });

    expect(store.has('company:company-A:module-settings')).toBe(false);
    expect(await service.isModuleEnabled('company-A', null, 'VENDAS')).toBe(false);
    expect(findManyMock).toHaveBeenCalledTimes(2);
  });

  it('CORRIDA: leitura do banco iniciada ANTES do toggle não pode cravar o estado velho no cache', async () => {
    // A requisição R1 começa a ler o banco (estado antigo = habilitado) e "trava" no meio.
    let releaseStaleRead!: (rows: Row[]) => void;
    findManyMock.mockImplementationOnce(() => new Promise<Row[]>((resolve) => (releaseStaleRead = resolve)));
    const r1 = service.isModuleEnabled('company-A', null, 'COMPRAS');
    await new Promise((resolve) => setImmediate(resolve)); // R1 já está aguardando o banco

    // Enquanto isso o admin desliga COMPRAS (grava e invalida).
    await service.setEnabled({ companyId: 'company-A', module: 'COMPRAS', isEnabled: false, actorId: 'admin', reason: 'teste' });

    // A leitura velha termina DEPOIS da invalidação e tenta gravar o cache.
    releaseStaleRead([]);
    expect(await r1).toBe(true); // R1 responde com o que leu (consistente com o instante dela)

    // A próxima consulta NÃO pode reaproveitar o estado velho: tem de ler o banco de novo.
    findManyMock.mockResolvedValueOnce([{ branchId: null, module: 'COMPRAS', isEnabled: false }]);
    expect(await service.isModuleEnabled('company-A', null, 'COMPRAS')).toBe(false);
  });

  it('entrada de cache no formato antigo (lista crua, sem geração) é ignorada e relida', async () => {
    store.set('company:company-A:module-settings', [{ branchId: null, module: 'FISCAL', isEnabled: true }]);
    findManyMock.mockResolvedValueOnce([{ branchId: null, module: 'FISCAL', isEnabled: false }]);
    expect(await service.isModuleEnabled('company-A', null, 'FISCAL')).toBe(false);
  });
});
