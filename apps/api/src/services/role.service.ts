import { prisma, Role, Permission, Prisma } from '@ln-system/database';
import { invalidateUserPermissionsCache, invalidateRolePermissionsCache } from '../middleware/permission';
import { AuthorizationError } from '@ln-system/shared';

/**
 * Gerencia o RBAC granular (Role/Permission/RolePermission/UserRole) já
 * existente no schema desde fases anteriores, mas até a FASE 31 sem
 * NENHUMA rota/service para administrá-lo — as tabelas existiam e o
 * middleware `requirePermission`/`requireAllPermissions` (middleware/
 * permission.ts) já sabia lê-las, mas nada nunca escrevia nelas. Mesmo
 * padrão de "schema pronto, service ausente" já visto em Inventory/
 * DamageRecord/Transfer/CommissionRule/DiscountRule.
 *
 * companyId null em Role/Permission = item de sistema (visível/usável por
 * qualquer empresa, só o Super Admin pode criar/editar/excluir). companyId
 * preenchido = específico de uma empresa, gerenciável pelo Company Admin
 * daquela empresa.
 */
export class RoleService {
  async listPermissions(companyId?: string): Promise<Permission[]> {
    return prisma.permission.findMany({
      where: companyId ? { OR: [{ companyId: null }, { companyId }] } : undefined,
      orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
    });
  }

  async createPermission(data: { name: string; description?: string; scope?: 'GLOBAL' | 'BRANCH' | 'OWN'; companyId: string | null }): Promise<Permission> {
    return prisma.permission.create({
      data: {
        name: data.name,
        description: data.description,
        scope: data.scope ?? 'BRANCH',
        companyId: data.companyId,
      },
    });
  }

  async deletePermission(id: string, companyId?: string): Promise<void> {
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.permission.findFirst({ where });
    if (!existing) {
      throw new Error('Permissão não encontrada');
    }

    // RolePermission cascateia com a exclusão — precisamos saber ANTES quais
    // perfis tinham esta permissão, para invalidar o cache de todo mundo
    // que tem um desses perfis (senão a permissão removida continuaria
    // "válida" no cache de alguém até o TTL de 10min expirar sozinho).
    const affectedRoles = await prisma.rolePermission.findMany({ where: { permissionId: id }, select: { roleId: true } });

    await prisma.permission.delete({ where: { id } });

    await Promise.all(affectedRoles.map((r) => invalidateRolePermissionsCache(r.roleId)));
  }

  async listRoles(companyId?: string): Promise<(Role & { rolePermissions: { permission: Permission }[] })[]> {
    return prisma.role.findMany({
      where: companyId ? { OR: [{ companyId: null }, { companyId }] } : undefined,
      orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
      include: { rolePermissions: { include: { permission: true } } },
    });
  }

  async createRole(data: { name: string; description?: string; companyId: string | null }): Promise<Role> {
    return prisma.role.create({
      data: {
        name: data.name,
        description: data.description,
        companyId: data.companyId,
        isSystem: false,
      },
    });
  }

  async updateRole(id: string, data: { name?: string; description?: string }, companyId?: string): Promise<Role> {
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.role.findFirst({ where });
    if (!existing) {
      throw new Error('Perfil não encontrado');
    }
    // AuthorizationError (403): como Error puro a rota respondia 500.
    if (existing.isSystem) {
      throw new AuthorizationError('Perfis de sistema não podem ser editados', 'SYSTEM_ROLE');
    }
    return prisma.role.update({ where: { id }, data });
  }

  async deleteRole(id: string, companyId?: string): Promise<void> {
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.role.findFirst({ where });
    if (!existing) {
      throw new Error('Perfil não encontrado');
    }
    if (existing.isSystem) {
      throw new AuthorizationError('Perfis de sistema não podem ser excluídos', 'SYSTEM_ROLE');
    }

    // Mesmo motivo de deletePermission: UserRole cascateia com a exclusão
    // do perfil, então precisamos saber ANTES quem tinha o perfil.
    await invalidateRolePermissionsCache(id);
    await prisma.role.delete({ where: { id } });
  }

  /**
   * Vincula uma permissão a um perfil. `permissionCompanyId`/`roleCompanyId`
   * (null = sistema) precisam ser compatíveis com quem está requisitando —
   * quem não é Super Admin só pode misturar permissões/perfis de sistema
   * com os da própria empresa, nunca de outra empresa.
   */
  async assignPermission(roleId: string, permissionId: string, companyId?: string): Promise<void> {
    // O PERFIL tem de ser da própria empresa: perfil de sistema (companyId null) é compartilhado por todas as
    // empresas e só o SUPER_ADMIN o altera (mesma regra de updateRole/deleteRole). A PERMISSÃO pode ser de sistema.
    const roleWhere = companyId ? { id: roleId, companyId } : { id: roleId };
    const role = await prisma.role.findFirst({ where: roleWhere });
    if (!role) {
      throw new Error('Perfil não encontrado');
    }

    const permWhere = companyId ? { id: permissionId, OR: [{ companyId: null }, { companyId }] } : { id: permissionId };
    const permission = await prisma.permission.findFirst({ where: permWhere });
    if (!permission) {
      throw new Error('Permissão não encontrada');
    }

    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId } },
      create: { roleId, permissionId },
      update: {},
    });

    // A permissão do PERFIL mudou — todo usuário com esse perfil precisa
    // recalcular na próxima checagem, não só quem chamou esta rota.
    await invalidateRolePermissionsCache(roleId);
  }

  async revokePermission(roleId: string, permissionId: string, companyId?: string): Promise<void> {
    const roleWhere = companyId ? { id: roleId, companyId } : { id: roleId };
    const role = await prisma.role.findFirst({ where: roleWhere });
    if (!role) {
      throw new Error('Perfil não encontrado');
    }

    await prisma.rolePermission.deleteMany({ where: { roleId, permissionId } });
    await invalidateRolePermissionsCache(roleId);
  }

  /**
   * Atribui um perfil a um usuário, opcionalmente restrito a uma filial
   * (UserRole.branchId — o mesmo usuário pode ter perfis diferentes em
   * filiais diferentes). `userCompanyId`/`roleCompanyId` já validados pelo
   * caller (rota) contra o tenant do requisitante.
   *
   * ACHADO DE AUDITORIA DE SEGURANÇA (cadeia de escalação de privilégio):
   * um COMPANY_ADMIN pode criar uma Permission com nome livre (ex.:
   * "backup:restore"), criar uma Role, anexar a permissão, e — sem esta
   * checagem — atribuir essa role A SI MESMO, adquirindo qualquer
   * capacidade gateada por `requirePermission`. `actorUserId` é quem está
   * fazendo a chamada (sempre `req.user.userId`, nunca do body) —
   * bloquear auto-atribuição incondicionalmente (inclusive para
   * SUPER_ADMIN, que já ignora RBAC de qualquer forma via
   * `userType === 'SUPER_ADMIN'` em todo lugar, então não perde nada)
   * fecha esse vetor pela raiz, não só no caso do backup.
   */
  async assignRoleToUser(userId: string, roleId: string, branchId: string | null, companyId: string | undefined, actorUserId: string): Promise<void> {
    if (userId === actorUserId) {
      throw new Error('Não é permitido atribuir um perfil a si mesmo');
    }

    const userWhere = companyId ? { id: userId, companyId } : { id: userId };
    const user = await prisma.user.findFirst({ where: userWhere });
    if (!user) {
      throw new Error('Usuário não encontrado');
    }

    const roleWhere = companyId ? { id: roleId, OR: [{ companyId: null }, { companyId }] } : { id: roleId };
    const role = await prisma.role.findFirst({ where: roleWhere });
    if (!role) {
      throw new Error('Perfil não encontrado');
    }

    if (branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: user.companyId ?? undefined } });
      if (!branch) {
        throw new Error('Filial não encontrada nesta empresa');
      }
    }

    // NÃO usar `userRole.upsert()` com `branchId` na chave composta: o
    // Prisma 5.7 rejeita em runtime um valor `null` literal para um campo
    // opcional dentro de uma `@@unique` composta ("Argument branchId must
    // not be null"), mesmo com TypeScript aceitando `branchId: null` sem
    // erro de tipo — confirmado em teste real (atribuição de perfil sem
    // filial específica, o caso mais comum, sempre falhava com 500 antes
    // desta correção). `findFirst` + `create` condicional usa um `where`
    // comum (não de chave única), que aceita `null` normalmente.
    const existing = await prisma.userRole.findFirst({ where: { userId, roleId, branchId } });
    if (!existing) {
      try {
        await prisma.userRole.create({ data: { userId, roleId, branchId } });
      } catch (error) {
        // TOCTOU: duas requisições concorrentes atribuindo o mesmo perfil
        // ao mesmo usuário — a constraint única do banco é a garantia real,
        // o findFirst acima é só para a resposta mais rápida no caso comum.
        // Perder a corrida aqui significa que já está atribuído: sucesso,
        // não erro.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
      }
    }

    await invalidateUserPermissionsCache(userId);
  }

  async revokeRoleFromUser(userId: string, roleId: string, branchId: string | null, companyId?: string): Promise<void> {
    const userWhere = companyId ? { id: userId, companyId } : { id: userId };
    const user = await prisma.user.findFirst({ where: userWhere });
    if (!user) {
      throw new Error('Usuário não encontrado');
    }

    await prisma.userRole.deleteMany({ where: { userId, roleId, branchId } });
    await invalidateUserPermissionsCache(userId);
  }

  async listUserRoles(userId: string, companyId?: string) {
    const userWhere = companyId ? { id: userId, companyId } : { id: userId };
    const user = await prisma.user.findFirst({ where: userWhere });
    if (!user) {
      throw new Error('Usuário não encontrado');
    }

    return prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });
  }
}

export default new RoleService();
