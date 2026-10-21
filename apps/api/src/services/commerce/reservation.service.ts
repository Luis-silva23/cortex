import { z } from 'zod';
import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { Logger } from '../logger.service';
import { availabilityOf, lockProductsInOrder, reservationShortfalls } from '../stock-reservations';
import { commerceError } from './errors';
import { logOrderEvent, orderView, type OrderActor } from './order.service';
import { enqueueOrderStatus } from '../integrations/outbox.service';
import type { ChannelPrincipal } from '../../middleware/channel-auth';

/**
 * Aceite do pedido externo = RESERVA de estoque (docs/CORTEX/COMMERCE_API.md §4). A reserva é uma promessa temporária por pedido e
 * produto; não é movimento do livro e não é venda. Regras:
 *  - tudo ou nada: reserva todas as linhas do pedido ou nenhuma;
 *  - o disponível é o saldo da filial menos as reservas vivas (PDV, balcão, OS e transferência passam a conferir o mesmo número);
 *  - os produtos são travados em ordem de id, na mesma transação que grava a reserva: dois aceites, ou um aceite e uma venda do
 *    balcão, nunca reservam/vendem a mesma última unidade;
 *  - o PRAZO da reserva é decisão comercial e NÃO tem valor padrão: precisa estar configurado no canal (`reservationTtlMinutes`);
 *  - reserva vencida deixa de contar na hora (o disponível já a ignora); a rotina `expireDue` só a marca EXPIRED e avisa.
 */
const orderPolicySchema = z
  .object({
    reservationTtlMinutes: z.number().int().min(1).max(10_080).optional(),
    autoAcceptOrders: z.boolean().optional(),
    autoConvertOnPaymentConfirmed: z.boolean().optional(),
  })
  .passthrough();

export interface OrderPolicy {
  reservationTtlMinutes: number | null;
  autoAcceptOrders: boolean;
  autoConvertOnPaymentConfirmed: boolean;
}

/** Política de pedido do canal (em `SalesChannel.config`). Tudo desligado e SEM prazo por padrão: nada é decidido pelo código. */
export function readOrderPolicy(config: unknown): OrderPolicy {
  const parsed = orderPolicySchema.safeParse(config ?? {});
  const c = parsed.success ? parsed.data : {};
  return { reservationTtlMinutes: c.reservationTtlMinutes ?? null, autoAcceptOrders: c.autoAcceptOrders === true, autoConvertOnPaymentConfirmed: c.autoConvertOnPaymentConfirmed === true };
}

const ORDER_VIEW_INCLUDE = { items: true, sale: { select: { saleNumber: true } }, fulfillment: { select: { status: true, type: true } } } as const;

export const reservationService = {
  async acceptOrder(input: { companyId: string; channelId: string; orderId: string; actor: OrderActor; correlationId?: string }) {
    const channel = await prisma.salesChannel.findFirst({ where: { id: input.channelId, companyId: input.companyId } });
    if (!channel) throw commerceError.notFound('Canal');
    const policy = readOrderPolicy(channel.config);
    if (policy.reservationTtlMinutes === null) throw commerceError.reservationTtlNotConfigured();
    const ttlMs = policy.reservationTtlMinutes * 60_000;

    try {
      return await runInTransaction(async (tx) => {
        // Serializa tudo que mexe neste pedido (aceitar, cancelar, converter, expirar, evento de pagamento).
        await tx.$queryRaw`SELECT id FROM external_orders WHERE id = ${input.orderId} FOR UPDATE`;
        const order = await tx.externalOrder.findFirst({ where: { id: input.orderId, companyId: input.companyId, channelId: input.channelId }, include: { items: true } });
        if (!order) throw commerceError.notFound('Pedido');
        if (order.status === 'ACCEPTED') return { order: orderView({ ...order, sale: null, fulfillment: null }), replayed: true, expiresAt: null as Date | null };
        if (order.status !== 'RECEIVED') throw commerceError.invalidState(order.status);
        const branchId = order.branchId;
        if (!branchId) throw commerceError.channelBranchRequired();

        const ids = await lockProductsInOrder(tx, order.items.map((i) => i.productId));
        const availability = await availabilityOf(tx, { companyId: order.companyId, branchId, productIds: ids });
        const short = order.items
          .map((i) => ({ sku: i.sku, requested: Number(i.quantity), available: Math.max(0, availability.get(i.productId)?.available ?? 0) }))
          .filter((i) => i.available < i.requested);
        if (short.length > 0) throw commerceError.insufficientStock(short);

        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        await tx.stockReservation.createMany({
          data: order.items.map((i) => ({ companyId: order.companyId, branchId, channelId: order.channelId, orderId: order.id, productId: i.productId, quantity: i.quantity, status: 'ACTIVE' as const, expiresAt })),
        });
        await tx.externalOrder.update({ where: { id: order.id }, data: { status: 'ACCEPTED', acceptedAt: now, acceptedBy: input.actor.type === 'USER' ? input.actor.userId : null, statusReason: null, statusChangedAt: now } });
        await logOrderEvent(tx, order, 'ORDER_ACCEPTED', 'INFO', 'Pedido aceito: estoque reservado até o prazo (ainda não é venda)', input.actor, input.correlationId, { expiresAt, items: order.items.length });
        const updated = await tx.externalOrder.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_VIEW_INCLUDE });
        await enqueueOrderStatus(tx, updated, 'ACCEPTED', { correlationId: input.correlationId }); // caixa de saída: o provedor (se houver) é avisado depois
        return { order: orderView(updated), replayed: false, expiresAt };
      });
    } catch (err: any) {
      // Falta de estoque desfaz a transação inteira (nada foi reservado); o registro do motivo fica em evento próprio, fora dela.
      if (err?.code === 'INSUFFICIENT_STOCK') {
        await prisma.channelEvent
          .create({
            data: {
              companyId: input.companyId,
              branchId: channel.branchId,
              channelId: channel.id,
              type: 'ORDER_ACCEPT_FAILED',
              level: 'WARN',
              message: 'Pedido não aceito: estoque disponível insuficiente (nada foi reservado)',
              correlationId: input.correlationId ?? null,
              data: { orderId: input.orderId, items: err.details?.items ?? [] } as any,
            },
          })
          .catch(() => undefined);
      }
      throw err;
    }
  },

  /**
   * Rotina de expiração: marca EXPIRED as reservas vencidas, leva o pedido ACCEPTED a EXPIRED e avisa. Não é ela que devolve o
   * estoque (o disponível já ignora reserva vencida); ela só deixa o estado e o histórico corretos. Idempotente.
   */
  async expireDue(now = new Date(), limit = 200): Promise<{ orders: number; failures: number }> {
    const due = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
      prisma.stockReservation.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: now } }, select: { orderId: true, companyId: true }, distinct: ['orderId'], take: limit })
    );
    let failures = 0;
    for (const d of due) {
      try {
        await runWithRLSContext({ companyId: d.companyId, userType: 'SUPER_ADMIN', branchId: null }, () => this.expireOrder(d.orderId, now));
      } catch (err) {
        failures += 1;
        Logger.error('Falha ao expirar reserva de pedido externo', err instanceof Error ? err : new Error(String(err)));
      }
    }
    return { orders: due.length, failures };
  },

  async expireOrder(orderId: string, now = new Date()) {
    return runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM external_orders WHERE id = ${orderId} FOR UPDATE`;
      const res = await tx.stockReservation.updateMany({ where: { orderId, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED', closedAt: now, closedReason: 'EXPIRED' } });
      if (res.count === 0) return { expired: 0 };
      const order = await tx.externalOrder.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status === 'ACCEPTED') {
        await tx.externalOrder.update({ where: { id: orderId }, data: { status: 'EXPIRED', statusReason: 'Reserva vencida sem pagamento confirmado', statusChangedAt: now } });
        await enqueueOrderStatus(tx, order, 'EXPIRED', { reason: 'Reserva vencida sem pagamento confirmado' });
      }
      await logOrderEvent(tx, order, 'RESERVATION_EXPIRED', 'INFO', 'Reserva de estoque vencida: o estoque voltou a ficar disponível', { type: 'SYSTEM' }, undefined, { lines: res.count });
      const confirmed = await tx.externalPayment.count({ where: { orderId, status: 'CONFIRMED' } });
      if (confirmed > 0) {
        await logOrderEvent(tx, order, 'PAYMENT_ON_EXPIRED_ORDER', 'WARN', 'Pagamento confirmado em pedido cuja reserva venceu: converter (se ainda houver estoque) ou devolver o dinheiro, por pessoa autorizada', { type: 'SYSTEM' }, undefined, {});
      }
      return { expired: res.count };
    });
  },

  /** Reservas que já não têm saldo físico para cobri-las (depois de avaria, perda, inventário ou ajuste): só sinaliza, nunca cancela. */
  async flagShortfalls(companyId: string, branchId: string) {
    return runWithRLSContext({ companyId, userType: 'SUPER_ADMIN', branchId: null }, async () =>
      runInTransaction(async (tx) => {
        const productRows = await tx.stockReservation.findMany({ where: { companyId, branchId, status: 'ACTIVE', expiresAt: { gt: new Date() } }, select: { productId: true }, distinct: ['productId'] });
        return reservationShortfalls(tx, { companyId, branchId, productIds: productRows.map((r) => r.productId) });
      })
    );
  },
};

/**
 * Aceite automático (política do canal `autoAcceptOrders`, desligada por padrão) logo depois de criar o pedido — pela Commerce API ou
 * pelo Integration Gateway. Sem estoque ou sem prazo configurado o pedido continua RECEBIDO para tratamento por pessoa autorizada
 * (o motivo fica no registro do canal). Nunca lança. Devolve o pedido atualizado ou null.
 */
export async function autoAcceptIfEnabled(principal: ChannelPrincipal, orderId: string, correlationId?: string) {
  if (!readOrderPolicy(principal.channelConfig).autoAcceptOrders) return null;
  try {
    return (await reservationService.acceptOrder({ companyId: principal.companyId, channelId: principal.channelId, orderId, actor: { type: 'CHANNEL', keyId: principal.keyId }, correlationId })).order;
  } catch {
    return null;
  }
}

export default reservationService;
