import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';

/**
 * FILIAIS AUTORIZADAS de um usuário (decisão 153): quem NÃO é de empresa inteira (SUPER_ADMIN/COMPANY_ADMIN) acessa a filial principal
 * (`users.branchId`) mais as filiais adicionais vinculadas (`user_branches`). O conjunto é calculado AQUI, no servidor, a cada requisição, a partir do
 * banco — nunca de claim do token nem de parâmetro do cliente — e vai assinado no contexto da RLS. Remover o vínculo revoga o acesso na requisição seguinte.
 *
 * A leitura roda em contexto de plataforma da própria API (a RLS de `user_branches` só deixa o usuário ler as próprias linhas, mas a consulta já filtra por
 * usuário e empresa do token). Em falha do banco o erro sobe: não existe "escopo desconhecido que vira acesso".
 */
export interface BranchScope {
  /** Filiais autorizadas (ordenadas). Vazio = o usuário de filial não está vinculado a nenhuma. */
  branchIds: string[];
  /** Filial de trabalho: a do token se ainda autorizada; senão a principal gravada no banco; senão a primeira autorizada; senão null. */
  activeBranchId: string | null;
}

export { COMPANY_WIDE_ROLES, isCompanyWideRole } from '../utils/branch-access';

/** Leitura injetável (teste unitário): devolve a filial principal gravada no usuário e as filiais adicionais vinculadas. */
export type LinksReader = (userId: string, companyId: string) => Promise<{ primary: string | null; extras: string[]; found: boolean }>;

export const readLinksFromDatabase: LinksReader = async (userId, companyId) => {
  const result = (await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.$queryRawUnsafe(
      `SELECT u."branchId" AS "primary",
              COALESCE(array_agg(ub."branchId") FILTER (WHERE ub."branchId" IS NOT NULL), ARRAY[]::text[]) AS extras
         FROM users u
         LEFT JOIN user_branches ub ON ub."userId" = u.id AND ub."companyId" = u."companyId"
        WHERE u.id = $1 AND u."companyId" = $2
        GROUP BY u.id`,
      userId,
      companyId
    ),
  ])) as [number, Array<{ primary: string | null; extras: string[] }>];
  const row = result[1][0];
  return row ? { primary: row.primary, extras: row.extras ?? [], found: true } : { primary: null, extras: [], found: false };
};

export function computeBranchScope(links: { primary: string | null; extras: string[] }, tokenBranchId?: string | null): BranchScope {
  const branchIds = [...new Set([...(links.primary ? [links.primary] : []), ...links.extras])].sort();
  const activeBranchId =
    tokenBranchId && branchIds.includes(tokenBranchId) ? tokenBranchId : links.primary && branchIds.includes(links.primary) ? links.primary : (branchIds[0] ?? null);
  return { branchIds, activeBranchId };
}

export async function resolveBranchScope(
  user: { userId: string; companyId?: string | null; branchId?: string | null },
  read: LinksReader = readLinksFromDatabase
): Promise<BranchScope> {
  if (!user.companyId) return { branchIds: [], activeBranchId: null };
  const links = await read(user.userId, user.companyId);
  return computeBranchScope(links, user.branchId);
}
