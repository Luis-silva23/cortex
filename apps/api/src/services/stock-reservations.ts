import type { PrismaTransactionClient } from '@ln-system/database';
import { stockLedger } from './stock-ledger';

/**
 * Reserva de estoque (docs/CORTEX/COMMERCE_API.md §4). A reserva NÃO é movimento do livro: o inventário fixa o saldo absoluto e
 * apagaria uma promessa temporária. Aqui ficam as duas regras que TODA saída comercial precisa respeitar:
 *
 *   disponível para venda = saldo do livro da filial − reservas ACTIVE ainda não vencidas da filial
 *
 *   1. quem retira saldo por venda, peça de OS, transferência ou devolução ao fornecedor confere o DISPONÍVEL, não o saldo físico;
 *   2. quem trava produtos para conferir e gravar o faz SEMPRE em ordem de id (`lockProductsInOrder`): duas operações com os mesmos
 *      produtos em ordem oposta nunca esperam uma pela outra (sem ciclo, sem deadlock).
 *
 * Reserva vencida (`expiresAt` no passado) deixa de contar na hora, sem depender de rotina: o disponível está correto mesmo que o
 * job de expiração atrase. Eventos físicos (avaria, perda, inventário, ajuste) NÃO são bloqueados pela reserva — a verdade física
 * vence; o que sobra sem lastro é sinalizado (`reservationShortfalls`), nunca cancelado em silêncio.
 */

/** Trava as linhas dos produtos em ordem de id, numa só consulta. Chamar dentro da transação, ANTES de conferir o saldo. */
export async function lockProductsInOrder(tx: PrismaTransactionClient, productIds: string[]): Promise<string[]> {
  const sorted = [...new Set(productIds)].sort();
  if (sorted.length > 0) await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
  return sorted;
}

export interface ReservationScope {
  companyId: string;
  branchId: string;
  productIds: string[];
  /** Ignora a reserva deste pedido (ao converter ou re-reservar, a própria reserva não pode se contar contra o pedido). */
  excludeOrderId?: string;
  now?: Date;
}

/** Soma das reservas ACTIVE e não vencidas, por produto, na filial. Produto sem reserva: 0. */
export async function reservedByProduct(tx: PrismaTransactionClient, scope: ReservationScope): Promise<Map<string, number>> {
  const result = new Map(scope.productIds.map((id) => [id, 0]));
  if (scope.productIds.length === 0) return result;
  const rows = await tx.stockReservation.groupBy({
    by: ['productId'],
    where: {
      companyId: scope.companyId,
      branchId: scope.branchId,
      productId: { in: scope.productIds },
      status: 'ACTIVE',
      expiresAt: { gt: scope.now ?? new Date() },
      ...(scope.excludeOrderId ? { orderId: { not: scope.excludeOrderId } } : {}),
    },
    _sum: { quantity: true },
  });
  for (const r of rows) result.set(r.productId, Number(r._sum.quantity ?? 0));
  return result;
}

/** Reservado de UM produto na filial (reservas vivas). Para as saídas comerciais que conferem o saldo produto a produto. */
export async function reservedFor(tx: PrismaTransactionClient, scope: { companyId: string; branchId: string; productId: string; excludeOrderId?: string; now?: Date }): Promise<number> {
  const agg = await tx.stockReservation.aggregate({
    where: {
      companyId: scope.companyId,
      branchId: scope.branchId,
      productId: scope.productId,
      status: 'ACTIVE',
      expiresAt: { gt: scope.now ?? new Date() },
      ...(scope.excludeOrderId ? { orderId: { not: scope.excludeOrderId } } : {}),
    },
    _sum: { quantity: true },
  });
  return Number(agg._sum.quantity ?? 0);
}

export interface Availability {
  balance: number;
  reserved: number;
  available: number;
}

/** Saldo físico, reservado e disponível por produto (disponível nunca fica negativo para quem consulta; `balance` pode estar negativo). */
export async function availabilityOf(tx: PrismaTransactionClient, scope: ReservationScope): Promise<Map<string, Availability>> {
  const [balances, reserved] = await Promise.all([
    stockLedger.balances({ companyId: scope.companyId, branchId: scope.branchId, productIds: scope.productIds }, tx),
    reservedByProduct(tx, scope),
  ]);
  return new Map(
    scope.productIds.map((id) => {
      const balance = balances.get(id)?.balance ?? 0;
      const held = reserved.get(id) ?? 0;
      return [id, { balance, reserved: held, available: balance - held }] as const;
    })
  );
}

/** Libera (RELEASED) as reservas ainda ativas do pedido, com motivo. Devolve quantas linhas mudaram. Repetir é inofensivo. */
export async function releaseReservations(tx: PrismaTransactionClient, orderId: string, reason: string, now = new Date()): Promise<number> {
  const res = await tx.stockReservation.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'RELEASED', closedAt: now, closedReason: reason.slice(0, 120) } });
  return res.count;
}

/** Reserva ativa que já não tem saldo físico para cobri-la (depois de avaria, perda, inventário ou ajuste). Só informa. */
export async function reservationShortfalls(tx: PrismaTransactionClient, scope: Omit<ReservationScope, 'excludeOrderId'>) {
  const map = await availabilityOf(tx, scope);
  return [...map.entries()].filter(([, a]) => a.reserved > 0 && a.balance < a.reserved).map(([productId, a]) => ({ productId, ...a }));
}
