import { prisma, runInTransaction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { isCompanyWideRole } from '../utils/branch-access';

/**
 * VÍNCULOS DE FILIAL de um usuário (decisão 153): quem concede, quem enxerga, o que é validado.
 *  - só SUPER_ADMIN e COMPANY_ADMIN gravam (a rota exige o papel; a RLS de `user_branches` e o gatilho do banco repetem a regra);
 *  - o usuário alvo precisa ser da empresa de quem concede (outra empresa ⇒ 404, sem confirmar que existe) e de papel de filial
 *    (SUPER_ADMIN/COMPANY_ADMIN já enxergam todas as filiais);
 *  - as filiais precisam ser da MESMA empresa do usuário alvo (id de outra empresa ⇒ 400 BRANCH_NOT_FOUND); a FK composta do banco também recusa;
 *  - `PUT` define o conjunto de filiais ADICIONAIS por completo (substitui): o que sai do conjunto perde o acesso na requisição seguinte;
 *  - a filial principal (`users.branchId`) não entra na lista adicional (seria redundante) e continua sendo alterada pelo cadastro do usuário.
 */
export const MAX_EXTRA_BRANCHES = 50;

export interface BranchLinks {
  userId: string;
  primaryBranchId: string | null;
  /** filiais adicionais (sem a principal) */
  extraBranchIds: string[];
  /** conjunto autorizado = principal + adicionais */
  branchIds: string[];
  branches: Array<{ id: string; name: string; primary: boolean }>;
}

interface Actor {
  userId: string;
  userType: string;
  companyId?: string | null;
}

async function loadTarget(actor: Actor, targetUserId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, companyId: true, userType: true, branchId: true } });
  // outra empresa (ou usuário inexistente) é a mesma resposta: o id de fora não é confirmado
  if (!target || (actor.userType !== 'SUPER_ADMIN' && target.companyId !== actor.companyId)) throw new AppError('Usuário não encontrado', 404, 'USER_NOT_FOUND');
  if (!target.companyId) throw new AppError('Usuário de plataforma não tem filiais', 400, 'USER_WITHOUT_COMPANY');
  return target as typeof target & { companyId: string };
}

export async function getBranchLinks(actor: Actor, targetUserId: string): Promise<BranchLinks> {
  const target = await loadTarget(actor, targetUserId);
  const links = await prisma.userBranch.findMany({ where: { userId: target.id, companyId: target.companyId }, select: { branchId: true } });
  const extra = [...new Set(links.map((l) => l.branchId))].filter((b) => b !== target.branchId).sort();
  const ids = [...new Set([...(target.branchId ? [target.branchId] : []), ...extra])];
  const branches = ids.length ? await prisma.branch.findMany({ where: { id: { in: ids }, companyId: target.companyId }, select: { id: true, name: true } }) : [];
  const byId = new Map(branches.map((b) => [b.id, b.name]));
  return {
    userId: target.id,
    primaryBranchId: target.branchId,
    extraBranchIds: extra,
    branchIds: ids.sort(),
    branches: ids.map((id) => ({ id, name: byId.get(id) ?? id, primary: id === target.branchId })),
  };
}

export async function setBranchLinks(actor: Actor, targetUserId: string, requested: unknown): Promise<BranchLinks & { added: string[]; removed: string[] }> {
  if (!Array.isArray(requested) || requested.some((b) => typeof b !== 'string' || !b)) throw new AppError('branchIds deve ser uma lista de ids de filial', 400, 'INVALID_BRANCH_IDS');
  const wanted = [...new Set(requested as string[])];
  if (wanted.length > MAX_EXTRA_BRANCHES) throw new AppError(`No máximo ${MAX_EXTRA_BRANCHES} filiais por usuário`, 400, 'TOO_MANY_BRANCHES');
  const target = await loadTarget(actor, targetUserId);
  if (isCompanyWideRole(target.userType)) throw new AppError('Usuário de empresa inteira já enxerga todas as filiais da empresa: não recebe vínculo de filial', 400, 'USER_COMPANY_WIDE');

  if (wanted.length > 0) {
    const found = await prisma.branch.findMany({ where: { id: { in: wanted }, companyId: target.companyId }, select: { id: true } });
    if (found.length !== wanted.length) throw new AppError('Filial não encontrada nesta empresa', 400, 'BRANCH_NOT_FOUND');
  }
  const extras = wanted.filter((b) => b !== target.branchId);

  const { added, removed } = await runInTransaction(async (tx) => {
    const current = (await tx.userBranch.findMany({ where: { userId: target.id, companyId: target.companyId }, select: { branchId: true } })).map((l) => l.branchId);
    const toRemove = current.filter((b) => !extras.includes(b));
    const toAdd = extras.filter((b) => !current.includes(b));
    if (toRemove.length) await tx.userBranch.deleteMany({ where: { userId: target.id, companyId: target.companyId, branchId: { in: toRemove } } });
    if (toAdd.length) {
      await tx.userBranch.createMany({ data: toAdd.map((branchId) => ({ companyId: target.companyId, userId: target.id, branchId, createdBy: actor.userId })) });
    }
    return { added: toAdd.sort(), removed: toRemove.sort() };
  });
  return { ...(await getBranchLinks(actor, targetUserId)), added, removed };
}
