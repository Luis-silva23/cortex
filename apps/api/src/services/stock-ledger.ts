import { runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { Prisma } from '@prisma/client';

/**
 * Saldo de estoque derivado do livro de movimentações (não existe saldo armazenado).
 *
 * Regra (a mesma de sempre): entradas somam |qtd|, saídas subtraem |qtd|, ajuste soma a quantidade com sinal e
 * inventário FIXA o saldo em |qtd|. Ordem: createdAt, id.
 *
 * Antes cada consulta de saldo carregava TODAS as movimentações do produto para o Node — em cada item de venda,
 * baixa de peça, ajuste, transferência, inventário e avaria — e relatório, painel e alertas repetiam isso produto a
 * produto (N+1). Com o histórico crescendo, uma venda passava a ler dezenas de milhares de linhas. Agora o Postgres
 * devolve só o saldo (último inventário + soma do que veio depois), para um ou vários produtos numa consulta só, e
 * as 10 últimas movimentações apenas quando pedidas.
 */
export const INBOUND_TYPES = ['PURCHASE', 'RETURN', 'TRANSFER_IN', 'PRODUCTION'] as const;
// SUPPLIER_RETURN: devolução ao fornecedor aprovada (supplier-return.service.ts) — saída. Sem ele na lista, o SQL do
// saldo caía no `ELSE 0` e a mercadoria devolvida continuava no estoque.
export const OUTBOUND_TYPES = ['SALE', 'TRANSFER_OUT', 'LOSS', 'SUPPLIER_RETURN'] as const;

export interface LedgerHistoryEntry {
  date: Date;
  type: string;
  quantity: number;
  balance: number;
}

export interface Ledger {
  balance: number;
  count: number;
  history: LedgerHistoryEntry[];
}

export function applyMovement(balance: number, type: string, qty: number): number {
  if ((INBOUND_TYPES as readonly string[]).includes(type)) return balance + Math.abs(qty);
  if ((OUTBOUND_TYPES as readonly string[]).includes(type)) return balance - Math.abs(qty);
  if (type === 'ADJUSTMENT') return balance + qty;
  if (type === 'INVENTORY') return Math.abs(qty);
  return balance;
}

/** Implementação de referência (em memória) da mesma regra — os testes conferem o SQL contra ela. */
export function foldMovements(movements: Array<{ movementType: string; quantity: unknown; createdAt: Date }>): Ledger {
  let balance = 0;
  const history: LedgerHistoryEntry[] = [];
  for (const m of movements) {
    const qty = Number(m.quantity);
    balance = applyMovement(balance, m.movementType, qty);
    history.push({ date: m.createdAt, type: m.movementType, quantity: qty, balance });
  }
  return { balance, count: movements.length, history: history.slice(-10) };
}

// Montado sob demanda (não na carga do módulo): vários testes de unidade substituem `@prisma/client` por um mock.
function deltaSql() {
  const inbound = Prisma.join(INBOUND_TYPES.map((t) => Prisma.sql`${t}`));
  const outbound = Prisma.join(OUTBOUND_TYPES.map((t) => Prisma.sql`${t}`));
  return Prisma.sql`CASE WHEN t IN (${inbound}) THEN abs(q) WHEN t IN (${outbound}) THEN -abs(q) WHEN t = 'ADJUSTMENT' THEN q ELSE 0 END`;
}

function movementsOf(companyId: string, branchId: string | null, productIds: string[]) {
  return Prisma.sql`
    SELECT "productId" AS p, id, "movementType"::text AS t, quantity AS q, "createdAt"
    FROM stock_movements
    WHERE "companyId" = ${companyId} AND "productId" = ANY(${productIds}::text[])
      AND (${branchId}::text IS NULL OR "branchId" = ${branchId}::text)`;
}

// Consulta crua no cliente global não recebe o contexto RLS — sem transação do chamador, abre uma (runInTransaction).
function withClient<T>(client: PrismaTransactionClient | undefined, fn: (tx: PrismaTransactionClient) => Promise<T>) {
  return client ? fn(client) : runInTransaction(fn);
}

export const stockLedger = {
  /** Saldo e nº de movimentações de vários produtos numa consulta. Produto sem movimentação: saldo 0, count 0. */
  async balances(
    scope: { companyId: string; branchId?: string | null; productIds: string[] },
    client?: PrismaTransactionClient
  ): Promise<Map<string, { balance: number; count: number }>> {
    const result = new Map(scope.productIds.map((id) => [id, { balance: 0, count: 0 }]));
    if (scope.productIds.length === 0) return result;
    const rows = await withClient(client, (tx) =>
      tx.$queryRaw<Array<{ productId: string; count: number; balance: number }>>`
        WITH m AS (${movementsOf(scope.companyId, scope.branchId ?? null, scope.productIds)}),
             last_inv AS (
               SELECT DISTINCT ON (p) p, "createdAt" AS inv_at, id AS inv_id, abs(q) AS inv_q
               FROM m WHERE t = 'INVENTORY' ORDER BY p, "createdAt" DESC, id DESC),
             cnt AS (SELECT p, count(*)::int AS count FROM m GROUP BY p),
             after_inv AS (
               SELECT m.p, sum(${deltaSql()}) AS s
               FROM m LEFT JOIN last_inv li ON li.p = m.p
               WHERE m.t <> 'INVENTORY' AND (li.p IS NULL OR (m."createdAt", m.id) > (li.inv_at, li.inv_id))
               GROUP BY m.p)
        SELECT cnt.p AS "productId", cnt.count, (COALESCE(li.inv_q, 0) + COALESCE(a.s, 0))::float8 AS balance
        FROM cnt LEFT JOIN last_inv li ON li.p = cnt.p LEFT JOIN after_inv a ON a.p = cnt.p`
    );
    for (const r of rows) result.set(r.productId, { balance: Number(r.balance), count: r.count });
    return result;
  },

  /** Saldo de um produto; `withHistory` inclui as 10 últimas movimentações com o saldo após cada uma. */
  async read(
    scope: { productId: string; companyId: string; branchId?: string | null },
    opts: { client?: PrismaTransactionClient; withHistory?: boolean } = {}
  ): Promise<Ledger> {
    const { balance, count } = (await this.balances({ ...scope, productIds: [scope.productId] }, opts.client)).get(scope.productId)!;
    if (!opts.withHistory || count === 0) return { balance, count, history: [] };
    const rows = await withClient(opts.client, (tx) =>
      tx.$queryRaw<Array<{ t: string; q: number; createdAt: Date; running: number }>>`
        SELECT t, q::float8 AS q, "createdAt", running::float8 AS running FROM (
          SELECT t, q, "createdAt", id,
                 sum(CASE WHEN t = 'INVENTORY' THEN abs(q) ELSE ${deltaSql()} END)
                   OVER (PARTITION BY seg ORDER BY "createdAt", id) AS running
          FROM (SELECT *, count(*) FILTER (WHERE t = 'INVENTORY') OVER (ORDER BY "createdAt", id) AS seg
                FROM (${movementsOf(scope.companyId, scope.branchId ?? null, [scope.productId])}) s0) s
        ) r
        ORDER BY "createdAt" DESC, id DESC
        LIMIT 10`
    );
    const history = rows.reverse().map((r) => ({ date: r.createdAt, type: r.t, quantity: Number(r.q), balance: Number(r.running) }));
    return { balance, count, history };
  },
};
