import { PrismaClient, Prisma } from '@prisma/client';
import { getCurrentRLSContext } from './rls-context';

import { CONTEXT_SET_CONFIG_SQL, contextSqlParams } from './context-signing';
import type { RLSContext as SignedRLSContext } from './rls-context';

export { runWithRLSContext, getCurrentRLSContext } from './rls-context';
export type { RLSContext } from './rls-context';
export type { ContextGucs } from './context-signing';
export {
  CONTEXT_SET_CONFIG_SQL,
  PLATFORM_CONTEXT,
  canSignContext,
  contextGucs,
  contextSqlParams,
  contextSqlStatements,
} from './context-signing';

/**
 * Comando que aplica um contexto ASSINADO numa transação em lote (`$transaction([contextStatement(client, ctx), query])`) — o lugar
 * dos antigos três `set_config('app.user_type', …)` crus, que o banco passou a ignorar. `client` é o `prismaUnsafeBypassRLS`, um `tx` ou
 * qualquer cliente Prisma.
 */
export function contextStatement<T extends { $executeRawUnsafe: (q: string, ...v: any[]) => any }>(client: T, ctx: SignedRLSContext): ReturnType<T['$executeRawUnsafe']> {
  return client.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(ctx));
}
// Real (value) re-export, not `export type *` — Prisma enums (AuditAction,
// UserType, ...) compile to real runtime objects, and apps/api code
// references them as values (e.g. `AuditAction.CREATE`), not just types.
export * from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __ln_system_base_prisma: PrismaClient | undefined;
}

// Singleton across tsx-watch reloads / any dev server that keeps the Node
// module cache warm across recompiles — a fresh PrismaClient per reload
// exhausts the Postgres connection pool in minutes.
const basePrisma = global.__ln_system_base_prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
  global.__ln_system_base_prisma = basePrisma;
}

/**
 * Every query issued through this client runs inside its own single-
 * statement transaction that first sets the three Postgres session GUCs
 * the RLS policies read (app.current_company_id, app.current_branch_id,
 * app.user_type — see prisma/migrations/0_init/migration.sql for the
 * `get_current_*`/`rls_company_match` functions and the CREATE POLICY
 * statements that call them), then the real operation.
 *
 * `query(args)` inside a Prisma Client Extension returns a deferred
 * PrismaPromise rather than executing immediately — passing it as the
 * second element of `$transaction([...])` (the array/"batch" form, not the
 * interactive-callback form) is what makes the SET and the real query run
 * back-to-back on the SAME pooled connection. This is the pattern from
 * Prisma's own "Row Level Security" extension docs; an interactive
 * `$transaction(async (tx) => ...)` here would NOT work because `query`
 * always executes against the base client, not against `tx`.
 *
 * No RLS context in scope (a script/seed/worker running outside
 * runWithRLSContext) => the SET is skipped and the query runs with
 * whatever the connection's session vars already are — for a fresh pooled
 * connection that's unset, which every `get_current_*()` reads as NULL, so
 * `rls_company_match`/`is_super_admin` both evaluate false and every
 * tenant-scoped policy denies the row. RLS fails closed, not open.
 */
function buildExtendedClient() {
  return basePrisma.$extends({
    name: 'rls-context',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const ctx = getCurrentRLSContext();

          if (!ctx) {
            return query(args);
          }

          // O contexto vai ASSINADO (HMAC; ver ./context-signing): o banco ignora contexto que a aplicação não assinou.
          const [, result] = await basePrisma.$transaction([
            basePrisma.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(ctx)),
            query(args) as Prisma.PrismaPromise<unknown>,
          ]);

          return result;
        },
      },
    },
  });
}

type ExtendedPrismaClient = ReturnType<typeof buildExtendedClient>;

// CRÍTICO (achado real, 2026-09-14, via teste de integração contra Postgres
// de verdade — ver `runInTransaction` logo abaixo): `prisma.$transaction(
// async (tx) => ...)` (a forma "interativa") NUNCA foi seguro neste client
// estendido, apesar do tipo `PrismaTransactionClient` (definido mais abaixo)
// parecer normal. `tx.algumModelo.create(...)` dentro do callback também
// passa pelo `$allOperations` acima, que SEMPRE reabre `basePrisma.
// $transaction([SET_CONFIG, query(args)])` — uma transação NOVA e
// INDEPENDENTE, cujo COMMIT acontece imediatamente, sem nenhuma relação com
// a transação "externa" que o `tx` deveria representar. Resultado
// comprovado por teste real: um `tx.customer.create()` seguido de um
// `throw` mais adiante DENTRO do mesmo callback NÃO fazia rollback — o
// registro ficava commitado no banco mesmo com a "transação" tendo
// lançado erro. Pior ainda para bloqueios: `tx.$queryRaw`/`$executeRaw` NÃO
// são operações de modelo, então nem passam pelo `$allOperations` — rodam
// SEM nenhum `set_config` aplicado nessa conexão, e como RLS é FORCE em
// todas as tabelas, um `SELECT ... FOR UPDATE` cru travava ZERO linhas
// (RLS filtrava a linha inteira antes do lock, silenciosamente). Todo
// `SELECT ... FOR UPDATE` escrito nesta sessão antes desta correção (em
// sale.service.ts, stock.service.ts, payment.service.ts) era um no-op —
// nunca serializou nenhuma corrida de verdade. `prisma.$transaction` segue
// existindo em runtime (por compatibilidade), mas é OMITIDO do tipo
// exportado abaixo (`Omit<..., '$transaction'>`) especificamente para que
// qualquer novo código que tente chamar `prisma.$transaction(...)` falhe a
// compilação e aponte para `runInTransaction`, a única forma seguro daqui
// pra frente.
function buildSafeTransactionRunner() {
  return async function runInTransaction<T>(
    fn: (tx: RawTransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }
  ): Promise<T> {
    const ctx = getCurrentRLSContext();
    return basePrisma.$transaction(async (tx) => {
      // Setado UMA vez, como a 1ª instrução real da transação — diferente
      // do `$allOperations` acima (que reaplica isto a cada chamada, cada
      // uma em sua própria mini-transação), aqui `set_config(..., true)`
      // ("is_local") persiste para TODA a duração desta transação real,
      // na MESMA conexão, então toda chamada subsequente em `tx` (incluindo
      // `tx.$queryRaw`/`$executeRaw` cru) já enxerga o contexto certo sem
      // precisar reaplicar nada.
      if (ctx) {
        await tx.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(ctx));
      }
      return fn(tx);
    }, options);
  };
}

// Unit tests across apps/api (see e.g. customer.service.tenant-isolation.
// test.ts) predate this extension and mock '@prisma/client' with a bare
// object — `{ PrismaClient: jest.fn(() => ({ customer: { findFirst: ... }
// })) }` — that has no `$extends` at all. Those tests exercise the
// application layer's own companyId/branchId filtering (a real, valuable
// check in its own right), not real Postgres RLS, which no unit test can
// exercise without an actual database — so skipping the extension there is
// correct, not just a workaround: there is no live RLS to hook into.
const extendedOrRaw: ExtendedPrismaClient =
  typeof (basePrisma as { $extends?: unknown }).$extends === 'function'
    ? buildExtendedClient()
    : (basePrisma as unknown as ExtendedPrismaClient);

export const prisma: Omit<ExtendedPrismaClient, '$transaction'> = extendedOrRaw;

// A implementação real de `runInTransaction` chama `basePrisma.$transaction`
// diretamente (nunca `prisma.$transaction`, que nem existe mais no tipo
// exportado) — funciona idêntico com ou sem `$extends` disponível (mock de
// teste ou client real), já que só usa `basePrisma`.
export const runInTransaction = buildSafeTransactionRunner();

// Tipo do `tx` recebido por `runInTransaction` — o client de transação CRU
// do Prisma (nunca estendido: ver comentário acima sobre por que estender
// `tx` era exatamente a causa do bug de atomicidade). Suas operações de
// modelo (`tx.sale.create`, etc.) têm a mesma forma pública que as do
// client estendido, então call sites existentes que já assumiam
// `PrismaTransactionClient` continuam compilando sem mudança nenhuma.
export type RawTransactionClient = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];
export type PrismaTransactionClient = RawTransactionClient;

/**
 * The raw PrismaClient, without the RLS-context extension above. Despite
 * the name, importing this does NOT by itself escape RLS — Postgres RLS is
 * enforced by connection/session state (`set_config`), not by which JS
 * wrapper issues the query, and a fresh pooled connection has none of the
 * three GUCs set, so every policy fails closed (denies everything) exactly
 * like the extended `prisma` export does with no ambient RLS context.
 *
 * The only legitimate use is a one-off, explicit bypass for an operation
 * that genuinely needs cross-tenant visibility outside any request's own
 * RLS context (see services/transfer.service.ts for the canonical
 * example): batch your own `set_config(...)` calls with the real query in
 * a single `prismaUnsafeBypassRLS.$transaction([...])` array so they run
 * on the same connection. A nested `runWithRLSContext(...)` does NOT
 * achieve this — this extension's context comes from AsyncLocalStorage at
 * the time each query fires, not from the raw client.
 */
export const prismaUnsafeBypassRLS = basePrisma;
