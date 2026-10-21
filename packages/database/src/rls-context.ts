import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped Row-Level Security context. Mirrors exactly the three
 * Postgres session settings the RLS policies read (see the `get_current_*`
 * SQL functions in prisma/migrations/0_init/migration.sql):
 *   app.current_company_id, app.current_branch_id, app.user_type
 *
 * companyId/branchId are null for SUPER_ADMIN (who isn't scoped to any
 * single company/branch) — never for anyone else. userType is always set;
 * the RLS functions treat a missing/empty setting the same as "no access"
 * (NULLIF(..., '') -> NULL -> every rls_company_match/is_super_admin check
 * evaluates to false), so an empty AsyncLocalStorage store fails closed,
 * not open.
 */
export interface RLSContext {
  companyId: string | null;
  userType: string;
  /** Filial ATIVA (a de trabalho). Para quem tem várias filiais é uma das de `branchIds`. */
  branchId: string | null;
  /**
   * Filiais AUTORIZADAS do usuário, calculadas pelo servidor a partir dos vínculos gravados no banco (`users.branchId` +
   * `user_branches`), nunca de dado enviado pelo cliente. Vazio/ausente = só `branchId` (comportamento anterior). Papéis de
   * empresa inteira (SUPER_ADMIN/COMPANY_ADMIN) ignoram a lista: a RLS os deixa ver todas as filiais da empresa.
   */
  branchIds?: string[];
  /** Usuário autenticado (para políticas "só as próprias linhas"). null para contexto de plataforma/sistema. */
  userId?: string | null;
}

const rlsStorage = new AsyncLocalStorage<RLSContext>();

/**
 * Runs `fn` with `context` available to every Prisma query executed during
 * its lifetime (via the $allOperations extension in ./index.ts), however
 * deep the call stack / however many awaits happen in between — that's the
 * whole point of AsyncLocalStorage over e.g. a parameter threaded through
 * every service function. Call this ONCE per request (see
 * apps/api/src/middleware/tenant.ts) with values derived from the already-
 * verified JWT (req.user), never from client-supplied companyId/branchId —
 * that's what makes RLS an actual second layer of defense instead of the
 * app just re-asserting what the request claimed about itself.
 */
// `await` DENTRO do escopo: a consulta do Prisma é preguiçosa (executa no `.then`); devolvida sem await, o `.then`
// acontecia fora do contexto e a RLS negava tudo em silêncio.
export function runWithRLSContext<T>(context: RLSContext, fn: () => Promise<T>): Promise<T> {
  return rlsStorage.run(context, async () => await fn());
}

/** Read by the Prisma extension in ./index.ts; not meant to be called from application code. */
export function getCurrentRLSContext(): RLSContext | undefined {
  return rlsStorage.getStore();
}
