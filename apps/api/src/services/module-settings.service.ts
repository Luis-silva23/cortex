import { prisma, runWithRLSContext, SystemModule } from '@ln-system/database';
import cacheService, { CacheKeys, CacheTTL } from './cache.service';

export { SystemModule };

export const SYSTEM_MODULES: SystemModule[] = ['ESTOQUE', 'COMPRAS', 'VENDAS', 'FINANCEIRO', 'FISCAL', 'OFICINA', 'POS_VENDA', 'CANAIS'];

/**
 * Módulos que nascem DESATIVADOS (opt-in): sem linha de configuração valem como desligados. Hoje só CANAIS (canais externos: site
 * próprio, iFood, marketplaces): enquanto a empresa não ligar, nada é processado nem chamado e nenhum canal aparece no painel.
 * Todos os outros módulos seguem o padrão antigo (ausência de linha = habilitado).
 */
export const DEFAULT_DISABLED_MODULES: SystemModule[] = ['CANAIS'];
export const isEnabledByDefault = (module: SystemModule): boolean => !DEFAULT_DISABLED_MODULES.includes(module);

type ModuleSettingRow = {
  branchId: string | null;
  module: SystemModule;
  isEnabled: boolean;
};

type CachedSettings = { gen: number; rows: ModuleSettingRow[] };

const GEN_KEY_TTL_SECONDS = 24 * 60 * 60; // muito maior que MODULE_SETTINGS (5 min): uma geração nunca "volta" enquanto há entrada viva

export class ModuleSettingsService {
  /**
   * Estado bruto dos módulos da EMPRESA INTEIRA (todas as filiais), com cache.
   *
   * Dois defeitos reais corrigidos aqui (achados na prova ao vivo com 2 filiais):
   *
   * 1) O cache é UM por empresa, mas a leitura rodava sob o RLS de QUEM chamou.
   *    `rls_company_branch_match` mostra a um usuário de filial só as linhas
   *    company-wide + as da PRÓPRIA filial. Quem aquecia o cache primeiro (ex.: o
   *    balcão da filial 1) gravava uma lista SEM o override da filial 2 — e o
   *    gate da filial 2 passava a ler "sem override = habilitado", reabrindo por
   *    até 5 min um módulo que o admin tinha desligado só para ela. O gate
   *    precisa do conjunto completo, então a leitura usa o contexto de
   *    administração da própria empresa (nunca cruza empresa: where + RLS por companyId).
   *
   * 2) `remember()` era "lê o banco → grava o cache". Uma requisição que lia o
   *    banco um instante ANTES do toggle gravava o estado velho DEPOIS da
   *    invalidação, e o módulo ficava no estado errado até o TTL. Agora cada entrada
   *    carrega a "geração" vista ANTES da leitura; toda alteração incrementa a
   *    geração, e uma entrada com geração antiga é tratada como ausente.
   */
  private async getCompanySettings(companyId: string): Promise<ModuleSettingRow[]> {
    const gen = (await cacheService.get<number>(CacheKeys.moduleSettingsGen(companyId))) ?? 0;
    const cached = await cacheService.get<CachedSettings>(CacheKeys.moduleSettings(companyId));
    if (cached && cached.gen === gen && Array.isArray(cached.rows)) {
      return cached.rows;
    }

    // `async` + `await` DENTRO do escopo: a PrismaPromise é preguiçosa e só roda
    // quando aguardada; devolvida crua executaria fora do contexto RLS.
    const rows = await runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, async () =>
      await prisma.companyModuleSetting.findMany({
        where: { companyId },
        select: { branchId: true, module: true, isEnabled: true },
      })
    );
    await cacheService.set(CacheKeys.moduleSettings(companyId), { gen, rows }, CacheTTL.MODULE_SETTINGS);
    return rows;
  }

  private async invalidate(companyId: string) {
    const genKey = CacheKeys.moduleSettingsGen(companyId);
    // Primeiro a geração (invalida qualquer entrada/leitura em voo), depois a chave.
    await cacheService.increment(genKey);
    await cacheService.expire(genKey, GEN_KEY_TTL_SECONDS);
    await cacheService.delete(CacheKeys.moduleSettings(companyId));
  }

  /**
   * Ausência de linha = HABILITADO (opt-out), exceto os módulos de `DEFAULT_DISABLED_MODULES` (opt-in). Prioridade: override da
   * filial específica > configuração company-wide (branchId null) >
   * default habilitado. Nunca lança — um módulo desconhecido/mal formado
   * nunca deve derrubar uma checagem de acesso.
   */
  async isModuleEnabled(companyId: string, branchId: string | null | undefined, module: SystemModule): Promise<boolean> {
    const settings = await this.getCompanySettings(companyId);

    if (branchId) {
      const branchOverride = settings.find((s) => s.branchId === branchId && s.module === module);
      if (branchOverride) return branchOverride.isEnabled;
    }

    const companyWide = settings.find((s) => s.branchId === null && s.module === module);
    if (companyWide) return companyWide.isEnabled;

    return isEnabledByDefault(module);
  }

  /**
   * Lista o estado EFETIVO de todos os módulos para uma empresa (e,
   * opcionalmente, o efetivo para uma filial específica) — usado pela tela
   * de administração, não pelo gate em si (isModuleEnabled é o caminho
   * quente, chamado a cada request).
   */
  async listEffective(companyId?: string, branchId?: string) {
    // Sem empresa (SUPER_ADMIN sem ?companyId): o padrão. `companyId`
    // undefined no `where` do Prisma é IGNORADO e devolveria as linhas de
    // TODAS as empresas misturadas (e cacheadas sob "company:undefined").
    if (!companyId) {
      return SYSTEM_MODULES.map((module) => ({
        module,
        isEnabled: isEnabledByDefault(module),
        source: 'DEFAULT' as const,
        companyWideSetting: null,
        branchOverrideSetting: null,
      }));
    }
    const settings = await this.getCompanySettings(companyId);
    return SYSTEM_MODULES.map((module) => {
      const branchOverride = branchId ? settings.find((s) => s.branchId === branchId && s.module === module) : undefined;
      const companyWide = settings.find((s) => s.branchId === null && s.module === module);
      const effective = branchOverride ?? companyWide;
      return {
        module,
        isEnabled: effective?.isEnabled ?? isEnabledByDefault(module),
        source: branchOverride ? 'BRANCH_OVERRIDE' : companyWide ? 'COMPANY_WIDE' : 'DEFAULT',
        companyWideSetting: companyWide ? { isEnabled: companyWide.isEnabled } : null,
        branchOverrideSetting: branchOverride ? { isEnabled: branchOverride.isEnabled } : null,
      };
    });
  }

  /**
   * Lista os registros crus (histórico de quem desativou/reativou, quando,
   * por quê) — para auditoria/tela administrativa.
   */
  async listRaw(companyId: string) {
    if (!companyId) {
      throw new Error('companyId é obrigatório');
    }
    return prisma.companyModuleSetting.findMany({
      where: { companyId },
      orderBy: [{ module: 'asc' }, { branchId: 'asc' }],
    });
  }

  async setEnabled(data: {
    companyId: string;
    branchId?: string | null;
    module: SystemModule;
    isEnabled: boolean;
    actorId: string;
    reason?: string;
  }) {
    if (!SYSTEM_MODULES.includes(data.module)) {
      throw new Error(`Unknown module: ${data.module}`);
    }
    // `undefined` no where do Prisma é ignorado: sem empresa, o findFirst abaixo
    // casaria a primeira linha desse módulo de QUALQUER empresa e a alteraria.
    if (!data.companyId) {
      throw new Error('companyId é obrigatório');
    }
    const company = await prisma.company.findFirst({ where: { id: data.companyId }, select: { id: true } });
    if (!company) {
      throw new Error('Empresa não encontrada');
    }
    if (data.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: data.branchId, companyId: data.companyId },
        select: { id: true },
      });
      if (!branch) {
        throw new Error('Branch not found in this company');
      }
    }

    const branchId = data.branchId ?? null;
    const now = new Date();

    // upsert manual (não dá pra usar o `where` composto único do Prisma
    // diretamente porque a parte "branchId null" é uma unique PARCIAL, que
    // o Prisma Client não sabe endereçar via `upsert` normal) — mesma
    // técnica de find-then-create-or-update já usada em outros pontos
    // desta sessão para constraints parciais.
    const existing = await prisma.companyModuleSetting.findFirst({
      where: { companyId: data.companyId, branchId, module: data.module },
    });

    const historyFields = data.isEnabled
      ? { reenabledBy: data.actorId, reenabledAt: now }
      : { disabledBy: data.actorId, disabledAt: now, disabledReason: data.reason };

    const result = existing
      ? await prisma.companyModuleSetting.update({
          where: { id: existing.id },
          data: { isEnabled: data.isEnabled, ...historyFields },
        })
      : await prisma.companyModuleSetting.create({
          data: {
            companyId: data.companyId,
            branchId,
            module: data.module,
            isEnabled: data.isEnabled,
            ...historyFields,
          },
        });

    await this.invalidate(data.companyId);
    return result;
  }
}

export default new ModuleSettingsService();
