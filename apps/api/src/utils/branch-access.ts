
/**
 * REGRA ÚNICA das rotas: quais filiais este usuário pode acessar (decisão 153).
 *  - SUPER_ADMIN / COMPANY_ADMIN: todas as filiais DA empresa (a RLS prende à empresa) → `null` (= sem lista);
 *  - demais papéis: a lista que o `tenantIsolation` calculou NO SERVIDOR a partir dos vínculos gravados (`req.user.branchIds`), nunca o que veio do cliente.
 * O banco repete a regra (RLS com o conjunto assinado); esta camada responde com erro claro (403 BRANCH_FORBIDDEN) antes de consultar.
 */
export const COMPANY_WIDE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN'] as const;
export const isCompanyWideRole = (userType: string | undefined) => !!userType && (COMPANY_WIDE_ROLES as readonly string[]).includes(userType);

export interface BranchActor {
  userType?: string;
  branchId?: string | null;
  branchIds?: string[];
}

/** `null` = papel de empresa inteira (sem lista); array = as filiais autorizadas (pode ser vazio). */
export function authorizedBranchIds(user: BranchActor): string[] | null {
  if (isCompanyWideRole(user.userType)) return null;
  const set = new Set<string>(user.branchIds ?? []);
  if (user.branchId) set.add(user.branchId);
  return [...set];
}

/** O usuário pode acessar esta filial? (`null`/vazio = registro da empresa toda: só quem é de empresa inteira grava; qualquer um lê.) */
export function canAccessBranch(user: BranchActor, branchId: string | null | undefined): boolean {
  const set = authorizedBranchIds(user);
  if (set === null) return true;
  return !!branchId && set.includes(branchId);
}
