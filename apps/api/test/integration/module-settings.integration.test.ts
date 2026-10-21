import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import moduleSettingsService from '../../src/services/module-settings.service';
import stockService from '../../src/services/stock.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

async function runInRLSContext<T>(companyId: string, branchId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId }, fn);
}

// Uma NOVA runWithRLSContext({SUPER_ADMIN}) chamada logo depois de várias
// chamadas sequenciais acumuladas (aqui: os 2 createFixture em paralelo,
// cada um com uma dúzia de creates internos) provou ser instável neste
// ambiente — mesmo problema já documentado e contornado em
// rbac.integration.test.ts::verifyUserRoles. Contorno idêntico: bypass
// direto via $transaction com set_config cru, sem depender do
// AsyncLocalStorage de runWithRLSContext.
async function createBranchBypassingRLS(companyId: string, name: string) {
  const [, branch] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.branch.create({ data: { companyId, name, isHeadquarter: false, isActive: true } }) as any,
  ]);
  return branch as { id: string };
}

describe('Ativação/desativação de módulos por empresa/filial — integração real (Postgres + RLS)', () => {
  let fixtureA: IntegrationFixture;
  let fixtureB: IntegrationFixture;
  let branchA2Id: string;

  beforeAll(async () => {
    [fixtureA, fixtureB] = await Promise.all([createFixture('modsettingsA'), createFixture('modsettingsB')]);
    const branchA2 = await createBranchBypassingRLS(fixtureA.companyId, 'Filial A2');
    branchA2Id = branchA2.id;
  }, 30000);

  afterAll(async () => {
    // a filial A2 e as configurações de módulo dela saem no destroyFixture (expurgo guiado pelas FKs; configurações antes da filial)
    await Promise.all([destroyFixture(fixtureA), destroyFixture(fixtureB)]);
  }, 30000);

  it('opt-out: sem nenhuma configuração, todo módulo começa habilitado', async () => {
    const enabled = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.isModuleEnabled(fixtureA.companyId, fixtureA.branchId, 'FISCAL')
    );
    expect(enabled).toBe(true);
  });

  it('desativar company-wide bloqueia todas as filiais da empresa; reativar restaura', async () => {
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        module: 'FISCAL',
        isEnabled: false,
        actorId: fixtureA.userId,
        reason: 'Empresa ainda não emite nota fiscal',
      })
    );

    const disabledOnMainBranch = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.isModuleEnabled(fixtureA.companyId, fixtureA.branchId, 'FISCAL')
    );
    const disabledOnSecondBranch = await runInRLSContext(fixtureA.companyId, branchA2Id, () =>
      moduleSettingsService.isModuleEnabled(fixtureA.companyId, branchA2Id, 'FISCAL')
    );
    expect(disabledOnMainBranch).toBe(false);
    expect(disabledOnSecondBranch).toBe(false);

    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        module: 'FISCAL',
        isEnabled: true,
        actorId: fixtureA.userId,
      })
    );
    const reenabled = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.isModuleEnabled(fixtureA.companyId, fixtureA.branchId, 'FISCAL')
    );
    expect(reenabled).toBe(true);
  }, 15000);

  it('override por filial: desativar só numa filial não afeta as demais da mesma empresa', async () => {
    await runInRLSContext(fixtureA.companyId, branchA2Id, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        branchId: branchA2Id,
        module: 'OFICINA',
        isEnabled: false,
        actorId: fixtureA.userId,
        reason: 'Filial A2 não presta serviço de oficina',
      })
    );

    const a2 = await runInRLSContext(fixtureA.companyId, branchA2Id, () =>
      moduleSettingsService.isModuleEnabled(fixtureA.companyId, branchA2Id, 'OFICINA')
    );
    const mainBranch = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.isModuleEnabled(fixtureA.companyId, fixtureA.branchId, 'OFICINA')
    );
    expect(a2).toBe(false);
    expect(mainBranch).toBe(true);
  }, 15000);

  it('isolamento cross-tenant real via RLS: desativar um módulo na Empresa A não afeta a Empresa B', async () => {
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        module: 'COMPRAS',
        isEnabled: false,
        actorId: fixtureA.userId,
        reason: 'Teste de isolamento',
      })
    );

    const companyBStillEnabled = await runInRLSContext(fixtureB.companyId, fixtureB.branchId, () =>
      moduleSettingsService.isModuleEnabled(fixtureB.companyId, fixtureB.branchId, 'COMPRAS')
    );
    expect(companyBStillEnabled).toBe(true);
  }, 15000);

  it('desativar um módulo NUNCA apaga/altera dado histórico do módulo — só bloqueia o gate', async () => {
    // Estoque real já existe na fixture (criado por createFixture). Saldo
    // ANTES de desativar ESTOQUE.
    const before = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      stockService.getBalance(fixtureA.productId, fixtureA.companyId, fixtureA.branchId)
    );

    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        module: 'ESTOQUE',
        isEnabled: false,
        actorId: fixtureA.userId,
        reason: 'Teste de preservação de histórico',
      })
    );

    // Módulo desativado (gate bloquearia a API), mas o SERVIÇO/DADO em si
    // continua intacto e consultável — desativação nunca é uma ação de
    // exclusão, é só uma trava checada no middleware HTTP.
    const after = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      stockService.getBalance(fixtureA.productId, fixtureA.companyId, fixtureA.branchId)
    );
    expect(after.balance).toBe(before.balance);
    expect(after.hasMovements).toBe(true);

    // reverte para não afetar os demais testes deste describe.
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        module: 'ESTOQUE',
        isEnabled: true,
        actorId: fixtureA.userId,
      })
    );
  }, 15000);

  it('histórico de quem desativou/reativou fica registrado (auditoria)', async () => {
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.setEnabled({
        companyId: fixtureA.companyId,
        module: 'VENDAS',
        isEnabled: false,
        actorId: fixtureA.userId,
        reason: 'Auditoria de histórico',
      })
    );
    const history = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      moduleSettingsService.listRaw(fixtureA.companyId)
    );
    const entry = history.find((h) => h.module === 'VENDAS' && h.branchId === null);
    expect(entry).toBeDefined();
    expect(entry?.disabledBy).toBe(fixtureA.userId);
    expect(entry?.disabledReason).toBe('Auditoria de histórico');
    expect(entry?.disabledAt).not.toBeNull();
  }, 15000);
});
