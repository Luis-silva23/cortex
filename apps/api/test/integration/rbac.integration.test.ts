import { prisma, prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import roleService from '../../src/services/role.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Regressão real (Postgres real, sem mock) para o bug encontrado em
 * 2026-09-09: `roleService.assignRoleToUser()` usava `userRole.upsert()`
 * com `branchId` (opcional) dentro da chave composta `@@unique([userId,
 * roleId, branchId])` — o Prisma 5.7 rejeita em runtime um `null` literal
 * nessa posição ("Argument branchId must not be null"), mesmo aceitando o
 * tipo em compilação. Isso quebrava o caso MAIS COMUM de atribuição de
 * perfil (sem restringir a uma filial específica) com um 500 cru.
 *
 * Histórico: TASK-007 do quadro de tarefas original (fora do repositório).
 */

async function runInRLSContext<T>(companyId: string, branchId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId }, fn);
}

/**
 * Leitura de verificação com bypass total de RLS — usada só para CONFIRMAR
 * o estado real do banco depois de um teste, nunca dentro do código de
 * produção. `runWithRLSContext({SUPER_ADMIN})` chamado de forma SEQUENCIAL
 * logo depois de outra chamada a `runWithRLSContext` (não aninhada, mas em
 * sucessão rápida) provou ser instável neste ambiente sob acúmulo de
 * chamadas — reproduzido aqui: uma linha recém-commitada por
 * `assignRoleToUser` (dentro de `runInRLSContext`) não aparecia numa
 * consulta de verificação feita logo em seguida via um NOVO
 * `runWithRLSContext({SUPER_ADMIN})`, mesmo a criação tendo retornado o
 * registro criado com sucesso (confirmado com log direto no service). Uma
 * reprodução isolada com só 1-2 chamadas sequenciais NÃO reproduzia — só
 * depois de várias chamadas acumuladas (fixture + setup do teste). Mesma
 * classe do problema já documentado para `packages/database/index.ts`
 * (nunca aninhar `runWithRLSContext`) — aqui estendido para "não confiar em
 * `runWithRLSContext` sequencial para uma leitura de verificação
 * logo após muitas chamadas anteriores". Correção: `prismaUnsafeBypassRLS`
 * com `$transaction([...])` explícito, o mesmo padrão já comprovado em
 * `transfer.service.ts`.
 */
async function verifyUserRoles(where: { userId: string; roleId: string; branchId?: string | null }) {
  const hasBranchFilter = where.branchId !== undefined;
  const [, rows] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.userRole.findMany({
      where: hasBranchFilter
        ? { userId: where.userId, roleId: where.roleId, branchId: where.branchId }
        : { userId: where.userId, roleId: where.roleId },
    }) as any,
  ]);
  return rows as Array<{ id: string; userId: string; roleId: string; branchId: string | null }>;
}

describe('RBAC — atribuição de perfil a usuário (regressão real)', () => {
  let fixture: IntegrationFixture;
  let roleId: string;
  let permissionId: string;

  beforeAll(async () => {
    fixture = await createFixture('rbac');
    await runInRLSContext(fixture.companyId, fixture.branchId, async () => {
      const role = await roleService.createRole({ name: 'RBAC Regression Role', companyId: fixture.companyId });
      roleId = role.id;
      const permission = await roleService.createPermission({
        name: 'write:rbac-regression',
        companyId: fixture.companyId,
      });
      permissionId = permission.id;
      await roleService.assignPermission(roleId, permissionId, fixture.companyId);
    });
  }, 30000);

  afterAll(async () => {
    // Só apaga o que ESTE teste criou, e só se os ids existirem (o beforeAll pode ter falhado antes de
    // atribuí-los). Antes: `userRole.deleteMany({ where: { roleId } })` com roleId undefined apagava TODOS os
    // vínculos de perfil do banco. `Role` apaga em cascata seus userRole/rolePermission (onDelete: Cascade).
    await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      if (roleId) await prisma.role.delete({ where: { id: roleId } });
      if (permissionId) await prisma.permission.delete({ where: { id: permissionId } });
    });
    await destroyFixture(fixture);
  }, 30000);

  it('atribui um perfil a um usuário SEM restringir a uma filial (o caso mais comum) sem lançar erro', async () => {
    await expect(
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        roleService.assignRoleToUser(fixture.userId, roleId, null, fixture.companyId, 'rbac-test-actor')
      )
    ).resolves.not.toThrow();

    const rows = await verifyUserRoles({ userId: fixture.userId, roleId });
    expect(rows).toHaveLength(1);
    expect(rows[0].branchId).toBeNull();
  });

  it('reflete a permissão do perfil nas permissões efetivas do usuário', async () => {
    const userRoles = await runInRLSContext(fixture.companyId, fixture.branchId, () =>
      roleService.listUserRoles(fixture.userId, fixture.companyId)
    );
    const names = userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.name));
    expect(names).toContain('write:rbac-regression');
  });

  it('é idempotente — atribuir o mesmo perfil de novo não lança erro nem duplica', async () => {
    await expect(
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        roleService.assignRoleToUser(fixture.userId, roleId, null, fixture.companyId, 'rbac-test-actor')
      )
    ).resolves.not.toThrow();

    const rows = await verifyUserRoles({ userId: fixture.userId, roleId, branchId: null });
    expect(rows.length).toBe(1);
  });

  it('atribuições concorrentes do mesmo perfil (corrida real) convergem para uma única linha, sem erro cru', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        roleService.assignRoleToUser(fixture.userId, roleId, null, fixture.companyId, 'rbac-test-actor')
      )
    );
    const results = await Promise.allSettled(attempts);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(0);

    const rows = await verifyUserRoles({ userId: fixture.userId, roleId, branchId: null });
    expect(rows.length).toBe(1);
  });

  it('revoga o perfil e as permissões efetivas voltam a não incluí-lo', async () => {
    await runInRLSContext(fixture.companyId, fixture.branchId, () =>
      roleService.revokeRoleFromUser(fixture.userId, roleId, null, fixture.companyId)
    );

    const remaining = await verifyUserRoles({ userId: fixture.userId, roleId });
    expect(remaining).toHaveLength(0);
  });

  /**
   * Regressão para o achado de auditoria de segurança (CRÍTICO,
   * 2026-09-14): sem esta checagem, um COMPANY_ADMIN podia criar uma
   * Permission com nome livre (ex.: "backup:restore"), criar uma Role,
   * anexar a permissão, e atribuir essa role A SI MESMO — adquirindo
   * qualquer capacidade gateada por requirePermission(), incluindo
   * backup/restore do banco inteiro (todas as empresas). A correção real
   * é `backup.routes.ts` agora usar `requireSuperAdmin` em vez de
   * `requirePermission`, mas esta checagem em `assignRoleToUser` fecha o
   * vetor pela raiz para qualquer rota gateada por `requirePermission`,
   * presente ou futura — não deve regredir silenciosamente.
   */
  it('rejeita um usuário atribuir um perfil a si mesmo (bloqueia auto-escalação de privilégio)', async () => {
    await expect(
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        roleService.assignRoleToUser(fixture.userId, roleId, null, fixture.companyId, fixture.userId)
      )
    ).rejects.toThrow('Não é permitido atribuir um perfil a si mesmo');

    // Confirma que nada foi de fato atribuído por essa tentativa.
    const rows = await verifyUserRoles({ userId: fixture.userId, roleId });
    expect(rows).toHaveLength(0);
  });
});
