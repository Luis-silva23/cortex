import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import roleService from '../../src/services/role.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Perfil de SISTEMA (companyId null) é compartilhado por todas as empresas. updateRole/deleteRole já o
 * tratavam como somente-leitura para quem não é SUPER_ADMIN, mas assignPermission/revokePermission aceitavam
 * `companyId null OR companyId = empresa`: o COMPANY_ADMIN da empresa A podia dar ou tirar permissões de um
 * perfil usado pelas empresas B, C... (escrita entre tenants).
 */

const asSuperAdmin = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: null as any, userType: 'SUPER_ADMIN', branchId: null }, fn);

async function countLinks(roleId: string, permissionId: string): Promise<number> {
  const [, n] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.rolePermission.count({ where: { roleId, permissionId } }) as any,
  ]);
  return n as unknown as number;
}

describe('Perfis de sistema não são alteráveis por admin de empresa (permissões)', () => {
  let fixture: IntegrationFixture;
  let sysRoleId: string | undefined;
  let sysPermA: string | undefined;
  let sysPermB: string | undefined;
  const marker = `Integration SYSROLE ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    fixture = await createFixture('sysrole');
    const role = await asSuperAdmin(() => roleService.createRole({ name: marker, companyId: null }));
    sysRoleId = role.id;
    sysPermA = (await asSuperAdmin(() => roleService.createPermission({ name: `${marker} a`, companyId: null }))).id;
    sysPermB = (await asSuperAdmin(() => roleService.createPermission({ name: `${marker} b`, companyId: null }))).id;
    await asSuperAdmin(() => roleService.assignPermission(sysRoleId!, sysPermB!));
  });

  afterAll(async () => {
    if (sysRoleId || sysPermA || sysPermB) {
      const ids = [sysPermA, sysPermB].filter((id): id is string => Boolean(id));
      await prismaUnsafeBypassRLS.$transaction([
        contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
        ...(sysRoleId ? [prismaUnsafeBypassRLS.role.delete({ where: { id: sysRoleId } })] : []),
        ...(ids.length ? [prismaUnsafeBypassRLS.permission.deleteMany({ where: { id: { in: ids } } })] : []),
      ]);
    }
    if (fixture) await destroyFixture(fixture);
  });

  it('COMPANY_ADMIN não anexa permissão a perfil de sistema', async () => {
    await expect(
      runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        roleService.assignPermission(sysRoleId!, sysPermA!, fixture.companyId)
      )
    ).rejects.toThrow('Perfil não encontrado');
    expect(await countLinks(sysRoleId!, sysPermA!)).toBe(0);
  });

  it('COMPANY_ADMIN não remove permissão de perfil de sistema', async () => {
    await expect(
      runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        roleService.revokePermission(sysRoleId!, sysPermB!, fixture.companyId)
      )
    ).rejects.toThrow('Perfil não encontrado');
    expect(await countLinks(sysRoleId!, sysPermB!)).toBe(1);
  });

  it('SUPER_ADMIN continua administrando o perfil de sistema', async () => {
    await asSuperAdmin(() => roleService.assignPermission(sysRoleId!, sysPermA!));
    expect(await countLinks(sysRoleId!, sysPermA!)).toBe(1);
  });
});
