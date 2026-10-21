import { prisma } from '@ln-system/database';
import { AppError, AuthorizationError } from '@ln-system/shared';
import { canAccessBranch } from './branch-access';

/**
 * Filial em que um registro NOVO deve ser gravado (agendamento, follow-up, revisão).
 *
 * Mesma regra das tabelas-irmãs (rls_company_branch_match):
 *  - usuário preso a uma filial (token com branchId) grava NA filial dele — o `branchId`
 *    do corpo é opcional e, se vier, precisa ser o mesmo (senão 403);
 *  - quem é da empresa toda (COMPANY_ADMIN/SUPER_ADMIN, sem branchId no token) pode
 *    informar uma filial DA PRÓPRIA empresa (validada) ou deixar sem filial (NULL = empresa toda).
 *
 * Antes as rotas repassavam o `branchId` do corpo cru: quem não mandava (o admin-web) gravava
 * NULL, e os apps Android/TV — que filtram por `branchId = filial` — nunca viam o registro;
 * um `branchId` de outra empresa também passava.
 */
export async function resolveWriteBranchId(
  user: { companyId?: string | null; branchId?: string | null; branchIds?: string[]; userType?: string },
  requested?: string | null
): Promise<string | undefined> {
  if (user.branchId) {
    // usuário de filial: grava na filial ATIVA ou em outra das SUAS filiais autorizadas (vínculos calculados no servidor; decisão 153)
    if (requested && requested !== user.branchId && !canAccessBranch(user, requested)) {
      throw new AuthorizationError('Você só pode registrar nas filiais às quais está vinculado', 'BRANCH_FORBIDDEN');
    }
    return requested || user.branchId;
  }

  if (!requested) return undefined;

  if (!user.companyId) {
    throw new AppError('Empresa não identificada para validar a filial', 400, 'COMPANY_CONTEXT_REQUIRED');
  }
  const branch = await prisma.branch.findFirst({
    where: { id: requested, companyId: user.companyId },
    select: { id: true },
  });
  if (!branch) {
    throw new AppError('Filial não encontrada nesta empresa', 400, 'BRANCH_NOT_FOUND');
  }
  return branch.id;
}

/** Igual a resolveWriteBranchId, para registros que SEMPRE pertencem a uma filial (OS, pedido de compra, caixa). */
export async function requireWriteBranchId(
  user: { companyId?: string | null; branchId?: string | null; branchIds?: string[]; userType?: string },
  requested?: string | null
): Promise<string> {
  const branchId = await resolveWriteBranchId(user, requested);
  if (!branchId) throw new AppError('Informe a filial', 400, 'BRANCH_REQUIRED');
  return branchId;
}
