import { prisma, runInTransaction, Prisma, User, UserType, Company, Branch } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { revokeUserAccessTokens } from './access-token-revocation';
import { normalizeEmail } from '@ln-system/shared/utils/email';
import { AppError } from '@ln-system/shared';
import type { CreateUserRequest, UpdateUserRequest } from '@ln-system/shared/types';

// Nenhum método deste service devolve o User completo do Prisma — password,
// mfaSecret, mfaBackupCodes, loginAttempts, lockedUntil e lastLoginIp nunca
// são selecionados, de propósito (não devem trafegar para fora da API). O
// tipo de retorno reflete isso explicitamente em vez de mentir como `User`.
type SafeUser = Omit<
  User,
  'password' | 'mfaSecret' | 'mfaBackupCodes' | 'mfaLastStep' | 'loginAttempts' | 'lockedUntil' | 'lastLoginIp' | 'mustChangePassword' | 'passwordChangedAt'
>;

/**
 * LIMITE DE USUÁRIOS DO PLANO (decisão 158): a licença ATIVA guarda `maxUsers` desde o início, mas nada o aplicava (só dispositivos e filiais). Com licença ativa, a empresa
 * não passa de `maxUsers` usuários ATIVOS: criar ou reativar além disso dá 409 `USER_LIMIT_REACHED`. Sem licença ativa não há plano a aplicar (mesma regra do limite de filiais).
 * É um limite de plano, não de segurança: duas criações simultâneas no limite exato podem passar por um usuário.
 */
async function assertUserLimit(companyId: string | null | undefined): Promise<void> {
  if (!companyId) return; // conta de plataforma (Super Admin) não tem plano
  const license = await prisma.license.findFirst({ where: { companyId, status: 'ACTIVE' }, select: { maxUsers: true } });
  if (!license) return;
  const active = await prisma.user.count({ where: { companyId, isActive: true } });
  if (active >= license.maxUsers) {
    throw new AppError(
      `Limite de usuários do plano atingido (${license.maxUsers}). Desative um usuário que não usa mais ou fale com o Super ADM TI para ampliar a licença.`,
      409,
      'USER_LIMIT_REACHED'
    );
  }
}

export class UserService {
  /**
   * Listar usuários (com filtro por empresa se não for Super Admin).
   *
   * ACHADO DE AUDITORIA DE INTEGRAÇÃO: nenhuma paginação existia aqui —
   * `findMany` sem `take`/`skip` devolvia TODOS os usuários numa única
   * consulta, incluindo (para SUPER_ADMIN, `companyId` undefined) todo
   * usuário de toda empresa da plataforma de uma vez. O middleware global
   * que trava `?limit=` (paginationLimit.ts) não ajuda aqui: essa rota
   * nunca lia `req.query.limit` para começar.
   */
  async findAll(
    companyId?: string,
    pagination: { page?: number; limit?: number } = {},
    filters: { userType?: UserType; isActive?: boolean } = {}
  ): Promise<{
    users: (SafeUser & { company: { id: string; name: string } | null; branch: { id: string; name: string } | null })[];
    pagination: { page: number; limit: number; total: number; pages: number };
  }> {
    const page = pagination.page && pagination.page > 0 ? pagination.page : 1;
    const limit = pagination.limit && pagination.limit > 0 ? Math.min(pagination.limit, 100) : 20;
    // Monta o filtro só com o que foi pedido: sem filtro a consulta é a mesma
    // de antes (e SUPER_ADMIN sem empresa continua vendo todas).
    const where: Prisma.UserWhereInput = {};
    if (companyId) where.companyId = companyId;
    if (filters.userType) where.userType = filters.userType;
    if (filters.isActive !== undefined) where.isActive = filters.isActive;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          numericId: true,
          companyId: true,
          branchId: true,
          name: true,
          email: true,
          phone: true,
          userType: true,
          isActive: true,
          emailVerified: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          company: {
            select: {
              id: true,
              name: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return { users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Buscar usuário por ID
   */
  async findById(id: string): Promise<(SafeUser & {
    company: Company | null;
    branch: Branch | null;
  }) | null> {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        numericId: true,
        companyId: true,
        branchId: true,
        name: true,
        email: true,
        phone: true,
        userType: true,
        isActive: true,
        emailVerified: true,
        mfaEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        company: true,
        branch: true,
      },
    });
  }

  /**
   * Criar usuário
   */
  async create(data: CreateUserRequest): Promise<SafeUser> {
    await assertUserLimit(data.companyId);
    const hashedPassword = await hashPassword(data.password);

    return prisma.user.create({
      data: {
        name: data.name,
        email: normalizeEmail(data.email),
        password: hashedPassword,
        userType: data.userType,
        companyId: data.companyId,
        branchId: data.branchId,
        isActive: true,
        // senha definida pelo administrador é temporária (decisão 157); `requirePasswordChange: false` só para quem a repassa por outro meio seguro
        mustChangePassword: data.requirePasswordChange ?? true,
      },
      select: {
        id: true,
        numericId: true,
        companyId: true,
        branchId: true,
        name: true,
        email: true,
        phone: true,
        userType: true,
        isActive: true,
        emailVerified: true,
        mfaEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Atualizar usuário
   *
   * companyId: quando informado (usuário não é Super Admin), restringe a
   * atualização a usuários da mesma empresa — sem isso, um COMPANY_ADMIN
   * conseguia editar usuários de QUALQUER empresa apenas sabendo o ID (IDOR
   * cross-tenant confirmado). Super Admin passa companyId undefined.
   */
  async update(id: string, data: UpdateUserRequest, companyId?: string): Promise<SafeUser> {
    const updateData: any = { ...data };

    if (data.password) {
      updateData.password = await hashPassword(data.password);
    }

    if (data.email) {
      updateData.email = normalizeEmail(data.email);
    }

    // Garante que o usuário-alvo pertence à empresa do requisitante antes de
    // qualquer escrita. updateMany não lança se where não casar — checamos
    // o count para diferenciar "não encontrado/outra empresa" de sucesso.
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.user.findFirst({ where, select: { id: true, companyId: true, userType: true } });
    if (!existing) {
      throw new Error('Usuário não encontrado');
    }

    // branchId não é validado pelo schema além do formato UUID — sem checar
    // aqui, um Company Admin poderia apontar o usuário para uma filial de
    // OUTRA empresa (o dado em si não vaza nada via RLS, que segue sendo por
    // companyId, mas corrompe qualquer relatório/regra de negócio que
    // confie em branchId pertencer à mesma empresa do usuário).
    if (data.branchId) {
      const targetCompanyId = companyId ?? existing.companyId;
      const branch = await prisma.branch.findFirst({
        where: { id: data.branchId, companyId: targetCompanyId ?? undefined },
        select: { id: true },
      });
      if (!branch) {
        // 400 como em resolveWriteBranchId: como Error puro a rota respondia 500.
        throw new AppError('Filial não encontrada nesta empresa', 400, 'BRANCH_NOT_FOUND');
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        numericId: true,
        companyId: true,
        branchId: true,
        name: true,
        email: true,
        phone: true,
        userType: true,
        isActive: true,
        emailVerified: true,
        mfaEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Mudou de PERFIL: as sessões abertas carregam o perfil antigo (e a exigência de MFA que valia para ele). Revoga refresh e access
    // tokens — a pessoa entra de novo e o perfil NOVO (com a exigência de MFA dele) vale desde o primeiro acesso. Sem isto, promover
    // alguém a COMPANY_ADMIN deixaria a sessão sem MFA renovando até o refresh expirar (decisão 123).
    if (data.userType && data.userType !== existing.userType) {
      await prisma.refreshToken.updateMany({ where: { userId: id, isRevoked: false }, data: { isRevoked: true } });
      await revokeUserAccessTokens(id);
    }
    return updated;
  }

  /**
   * Deletar usuário (mesma proteção de tenant que update/toggleActive)
   */
  async delete(id: string, companyId?: string): Promise<void> {
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.user.findFirst({ where, select: { id: true } });
    if (!existing) {
      throw new Error('Usuário não encontrado');
    }

    await prisma.user.delete({
      where: { id },
    });
    // Excluir não pode deixar o token de acesso já emitido vivo até expirar (mesma proteção de desativar/resetar senha).
    await revokeUserAccessTokens(id);
  }

  /**
   * Desbloquear usuário travado por tentativas de login inválidas
   * (loginAttempts/lockedUntil — mecanismo distinto de isActive/
   * toggleActive, que é uma desativação deliberada, não um lockout
   * automático). Antes desta rota não existia NENHUMA forma de um admin
   * desbloquear uma conta pela API — só era possível via SQL direto (o
   * script reset-all-lockouts.sql usado neste ambiente de testes).
   */
  async unlock(id: string, companyId?: string): Promise<SafeUser> {
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.user.findFirst({ where, select: { id: true } });
    if (!existing) {
      throw new Error('Usuário não encontrado');
    }

    return prisma.user.update({
      where: { id },
      data: { loginAttempts: 0, lockedUntil: null },
      select: {
        id: true,
        numericId: true,
        companyId: true,
        branchId: true,
        name: true,
        email: true,
        phone: true,
        userType: true,
        isActive: true,
        emailVerified: true,
        mfaEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Redefinir senha de um usuário (ação administrativa — Super Admin ou
   * Company Admin definindo uma nova senha em nome do usuário, sem precisar
   * da senha antiga). Também limpa o lockout e revoga todos os refresh
   * tokens existentes: uma senha só é redefinida por um admin quando há
   * suspeita de comprometimento ou o usuário perdeu acesso, então qualquer
   * sessão já emitida com a senha antiga deve parar de funcionar.
   */
  async resetPassword(id: string, newPassword: string, companyId?: string, requirePasswordChange = true): Promise<SafeUser> {
    const where = companyId ? { id, companyId } : { id };
    const existing = await prisma.user.findFirst({ where, select: { id: true } });
    if (!existing) {
      throw new Error('Usuário não encontrado');
    }

    const hashedPassword = await hashPassword(newPassword);

    // ACHADO CRÍTICO (2026-09-14): a forma em lote `prisma.$transaction([opA,
    // opB])` no client estendido (RLS) tem o MESMO problema de atomicidade
    // do `prisma.$transaction(async (tx) => ...)` interativo (ver comentário
    // longo em packages/database/src/index.ts) — cada item do array reabre
    // sua própria mini-transação via `$allOperations`, então nada garantia
    // que a senha só mudasse JUNTO com a revogação dos refresh tokens.
    // `runInTransaction` (forma interativa, sobre o client CRU) é a única
    // forma realmente atômica.
    const user = await runInTransaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { password: hashedPassword, loginAttempts: 0, lockedUntil: null, mustChangePassword: requirePasswordChange, passwordChangedAt: new Date() },
        select: {
          id: true,
          numericId: true,
          companyId: true,
          branchId: true,
          name: true,
          email: true,
          phone: true,
          userType: true,
          isActive: true,
          emailVerified: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, isRevoked: false },
        data: { isRevoked: true },
      });
      return updated;
    });

    await revokeUserAccessTokens(id);
    return user;
  }

  /**
   * Ativar/Desativar usuário (mesma proteção de tenant que update/delete)
   */
  async toggleActive(id: string, companyId?: string): Promise<SafeUser> {
    const where = companyId ? { id, companyId } : { id };
    const user = await prisma.user.findFirst({ where });
    if (!user) {
      throw new Error('Usuário não encontrado');
    }

    const nextActive = !user.isActive;
    if (nextActive) await assertUserLimit(user.companyId); // reativar também ocupa uma vaga do plano

    // Desativar TAMBÉM encerra as sessões: só mudar `isActive` deixava os
    // refresh tokens válidos e a conta "desligada" renovava o acesso para
    // sempre. Mesma transação do update (mesmo padrão de resetPassword).
    const result = await runInTransaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { isActive: nextActive },
        select: {
          id: true,
          numericId: true,
          companyId: true,
          branchId: true,
          name: true,
          email: true,
          phone: true,
          userType: true,
          isActive: true,
          emailVerified: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!nextActive) {
        await tx.refreshToken.updateMany({
          where: { userId: id, isRevoked: false },
          data: { isRevoked: true },
        });
      }
      return updated;
    });
    if (!nextActive) await revokeUserAccessTokens(id);
    return result;
  }
}
