import { Request, Response, NextFunction } from 'express';
import { prisma } from '@ln-system/database';
import { AuthorizationError } from '@ln-system/shared';
import cacheService, { CacheKeys, CacheTTL } from '../services/cache.service';

// requirePermission só protege ESCRITA (pagar, estornar, comprar, ajustar estoque): VIEWER é papel somente-leitura
// e não ganha escrita por perfil granular atribuído a ele.
function assertNotReadOnly(user: { userType?: string }) {
  if (user.userType === 'VIEWER') {
    throw new AuthorizationError('Perfil somente leitura não executa esta ação', 'READ_ONLY_ROLE');
  }
}

/**
 * Perfil padrão do COMPANY_ADMIN (docs/CORTEX/contracts/permission-matrix.md, "Perfis padrão"): as operações administrativas
 * contidas na própria empresa — o escopo vem do token + RLS, nunca do corpo. Lista enumerada, não curinga: permissão
 * nova não entra aqui sem decisão. `backup:*` fica de fora (restauração é de plataforma, só SUPER_ADMIN).
 * MANAGER/OPERATOR/MECHANIC não têm padrão: só o que um perfil granular atribuído conceder.
 */
export const COMPANY_ADMIN_PERMISSIONS: readonly string[] = [
  'finance:manage', 'finance:pay', 'finance:reverse',
  'purchases:manage', 'purchases:approve', 'purchases:receive',
  'stock:adjust', 'stock:transfer',
  'data:import',
  // Central de Suporte (2026-09-28): ver e responder os chamados da empresa (preso a uma filial: só os dela).
  'support:view_company',
];

async function effectivePermissions(user: { userId: string; companyId?: string; branchId?: string | null; userType?: string }) {
  const granted = await getUserPermissions(user.userId, user.companyId, user.branchId ?? null);
  return user.userType === 'COMPANY_ADMIN' ? [...new Set([...COMPANY_ADMIN_PERMISSIONS, ...granted])] : granted;
}

export const requirePermission = (...permissions: string[]) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      if (!user) {
        throw new AuthorizationError('Usuário não autenticado');
      }

      // Super Admin tem todas as permissões
      if (user.userType === 'SUPER_ADMIN') {
        return next();
      }
      assertNotReadOnly(user);

      const userPermissions = await effectivePermissions(user);

      // Verificar se tem alguma das permissões necessárias
      const hasPermission = permissions.some(permission => 
        userPermissions.includes(permission)
      );

      if (!hasPermission) {
        throw new AuthorizationError(
          'Você não tem permissão para realizar esta ação',
          'INSUFFICIENT_PERMISSIONS'
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware para verificar se o usuário tem TODAS as permissões
 */
export const requireAllPermissions = (...permissions: string[]) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      if (!user) {
        throw new AuthorizationError('Usuário não autenticado');
      }

      // Super Admin tem todas as permissões
      if (user.userType === 'SUPER_ADMIN') {
        return next();
      }
      assertNotReadOnly(user);

      const userPermissions = await effectivePermissions(user);

      // Verificar se tem TODAS as permissões
      const hasAllPermissions = permissions.every(permission => 
        userPermissions.includes(permission)
      );

      if (!hasAllPermissions) {
        const missingPermissions = permissions.filter(
          p => !userPermissions.includes(p)
        );

        throw new AuthorizationError(
          `Permissões insuficientes: ${missingPermissions.join(', ')}`,
          'MISSING_PERMISSIONS'
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware para verificar se o usuário é de um tipo específico
 */
export const requireUserType = (...userTypes: string[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      if (!user) {
        throw new AuthorizationError('Usuário não autenticado');
      }

      if (!userTypes.includes(user.userType)) {
        throw new AuthorizationError(
          'Tipo de usuário não autorizado',
          'INVALID_USER_TYPE'
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware para verificar se usuário pertence à empresa
 */
export const requireSameCompany = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const companyId = req.params.companyId || req.body.companyId || req.query.companyId;

    if (!user) {
      throw new AuthorizationError('Usuário não autenticado');
    }

    // Super Admin pode acessar qualquer empresa
    if (user.userType === 'SUPER_ADMIN') {
      return next();
    }

    // Verificar se o usuário pertence à empresa
    if (user.companyId !== companyId) {
      throw new AuthorizationError(
        'Você não tem acesso a esta empresa',
        'COMPANY_ACCESS_DENIED'
      );
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware para verificar se usuário pode acessar a filial
 */
export const requireBranchAccess = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const user = (req as any).user;
    const branchId = req.params.branchId || req.body.branchId || req.query.branchId;

    if (!user) {
      throw new AuthorizationError('Usuário não autenticado');
    }

    // Super Admin e Company Admin têm acesso a todas as filiais
    if (user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN') {
      return next();
    }

    // Verificar se usuário tem acesso à filial
    const hasAccess = await checkBranchAccess(user.userId, branchId);

    if (!hasAccess) {
      throw new AuthorizationError(
        'Você não tem acesso a esta filial',
        'BRANCH_ACCESS_DENIED'
      );
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Permissões dos perfis atribuídos ao usuário, cacheadas (`CacheTTL.USER_PERMISSIONS`).
 * `branch`: filial em que o token opera. Perfil atribuído a uma filial (UserRole.branchId) só vale nela; perfil sem
 * filial vale na empresa. Token de empresa inteira (null) recebe só os perfis sem filial. 'ALL' lista todos os
 * perfis (tela de administração de usuários, não decisão de acesso).
 */
export async function getUserPermissions(userId: string, _companyId?: string, branch: string | null | 'ALL' = 'ALL'): Promise<string[]> {
  const scopeKey = branch === 'ALL' ? 'all' : branch ?? 'company';
  return cacheService.remember(`${CacheKeys.userPermissions(userId)}:${scopeKey}`, CacheTTL.USER_PERMISSIONS, async () => {
    const userRoles = await prisma.userRole.findMany({
      where: branch === 'ALL' ? { userId } : { userId, OR: [{ branchId: null }, ...(branch ? [{ branchId: branch }] : [])] },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });

    const permissions = userRoles.flatMap(ur =>
      ur.role.rolePermissions.map(rp => rp.permission.name)
    );

    // Remover duplicadas
    return [...new Set(permissions)];
  });
}

/**
 * Verificar se usuário tem acesso à filial
 */
async function checkBranchAccess(userId: string, branchId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { branchId: true },
  });

  // Se usuário tem branchId null, tem acesso a todas as filiais da empresa
  if (!user?.branchId) {
    return true;
  }

  // Verificar se é a mesma filial
  return user.branchId === branchId;
}

/**
 * Invalida o cache de permissões de um usuário — precisa ser chamada por
 * toda escrita que muda o que um usuário pode fazer: atribuir/revogar
 * perfil (`role.service.ts::assignRoleToUser/revokeRoleFromUser`) e
 * atribuir/revogar permissão de um perfil (`assignPermission/
 * revokePermission`, que afeta todo usuário com aquele perfil — sem um
 * jeito barato de saber quais usuários têm um perfil específico sem
 * consultar o banco, invalida-se pelo padrão de chave completo nesse caso).
 */
export async function invalidateUserPermissionsCache(userId: string) {
  await cacheService.delete(CacheKeys.userPermissions(userId));
  await cacheService.invalidate(`${CacheKeys.userPermissions(userId)}:*`);
}

/** Invalida o cache de permissões de TODOS os usuários que têm um perfil específico — usar quando as permissões do PRÓPRIO perfil mudam (não de um usuário só). */
export async function invalidateRolePermissionsCache(roleId: string) {
  const userRoles = await prisma.userRole.findMany({ where: { roleId }, select: { userId: true } });
  await Promise.all(userRoles.map((ur) => invalidateUserPermissionsCache(ur.userId)));
}
