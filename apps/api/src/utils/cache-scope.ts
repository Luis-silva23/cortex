import { getCurrentRLSContext } from '@ln-system/database';

/**
 * Escopo de VISIBILIDADE de quem está pedindo, para compor chaves de cache.
 *
 * O Redis não passa pela RLS: um valor calculado sob o contexto de uma filial e
 * guardado numa chave que só tem a empresa é entregue depois a QUALQUER usuário
 * da empresa — quem chega primeiro define o que os outros veem (vazamento entre
 * filiais e, na outra direção, o administrador vendo só o que a filial via).
 *
 *  - SUPER_ADMIN / COMPANY_ADMIN (RLS enxerga todas as filiais): 'all'
 *  - demais papéis: 'b:<filial>' (a filial do token; 'none' se não tiver)
 *  - fora de uma requisição (sem contexto): 'noctx'
 */
export function visibilityScope(): string {
  const ctx = getCurrentRLSContext();
  if (!ctx) return 'noctx';
  if (ctx.userType === 'SUPER_ADMIN' || ctx.userType === 'COMPANY_ADMIN') return 'all';
  // com várias filiais autorizadas a visibilidade é o CONJUNTO (duas filiais não compartilham o valor calculado para uma só)
  if (ctx.branchIds && ctx.branchIds.length > 0) return `b:${[...new Set(ctx.branchIds)].sort().join('+')}`;
  return `b:${ctx.branchId ?? 'none'}`;
}

/** true se o papel atual enxerga todas as filiais da empresa (ou não há contexto). */
export function seesAllBranches(): boolean {
  const ctx = getCurrentRLSContext();
  return !ctx || ctx.userType === 'SUPER_ADMIN' || ctx.userType === 'COMPANY_ADMIN';
}

/** Filiais autorizadas do requisitante (a ativa se não houver lista); vazio para papéis de empresa inteira ou sem contexto. */
export function requesterBranchIds(): string[] {
  const ctx = getCurrentRLSContext();
  if (!ctx) return [];
  if (ctx.branchIds && ctx.branchIds.length > 0) return ctx.branchIds;
  return ctx.branchId ? [ctx.branchId] : [];
}

/** Filial do requisitante (null para papéis de empresa inteira ou sem contexto). */
export function requesterBranchId(): string | null {
  const ctx = getCurrentRLSContext();
  return ctx?.branchId ?? null;
}
