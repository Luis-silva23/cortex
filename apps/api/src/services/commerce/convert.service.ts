import { prisma, runInTransaction } from '@ln-system/database';
import type { FulfillmentStatus, FulfillmentType } from '@prisma/client';
import { stockLedger } from '../stock-ledger';
import { availabilityOf, lockProductsInOrder } from '../stock-reservations';
import { CommerceError, commerceError } from './errors';
import { fromCents, logOrderEvent, orderView, toCents, type OrderActor } from './order.service';
import { readOrderPolicy } from './reservation.service';
import { enqueueFulfillment, enqueueOrderStatus } from '../integrations/outbox.service';

/**
 * ConvertOrder — a única porta pela qual um pedido externo vira VENDA (docs/CORTEX/COMMERCE_API.md §5). Uma transação, idempotente:
 *  - trava o pedido; se já foi convertido, devolve a venda que já existe (nunca cria outra: `external_orders.saleId` é único);
 *  - exige pagamento CONFIRMADO cobrindo o total do pedido (nenhuma venda "sem condição");
 *  - consome a reserva; se ela venceu e o dinheiro já está confirmado, tenta RESERVAR DE NOVO (só com estoque disponível, nunca
 *    estoque negativo); sem estoque, não cria venda e deixa o alerta para tratamento por pessoa autorizada;
 *  - cria a venda de canal (PAID, sem caixa físico e sem operador presumido), os itens com o PREÇO DO PEDIDO (o oficial no aceite), o
 *    pagamento APROVADO a partir do pagamento externo e o movimento SALE do estoque — tudo ou nada;
 *  - NÃO mexe no caixa do balcão: o dinheiro de canal não passa pela gaveta (o fechamento de caixa físico não muda);
 *  - cria o fulfillment `PENDING` (a venda existe sem a entrega concluída).
 */
const FAILURE_CODES = new Set(['PAYMENT_NOT_CONFIRMED', 'RESERVATION_LOST_NO_STOCK', 'INSUFFICIENT_PHYSICAL_STOCK', 'INVALID_ORDER_STATE']);

const ORDER_VIEW_INCLUDE = { items: true, sale: { select: { saleNumber: true } }, fulfillment: { select: { status: true, type: true } } } as const;

export const convertService = {
  async convertOrder(input: { companyId: string; channelId: string; orderId: string; actor: OrderActor; correlationId?: string }) {
    try {
      return await runInTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM external_orders WHERE id = ${input.orderId} FOR UPDATE`;
        const order = await tx.externalOrder.findFirst({ where: { id: input.orderId, companyId: input.companyId, channelId: input.channelId }, include: { items: true, payments: true, sale: true } });
        if (!order) throw commerceError.notFound('Pedido');

        // Idempotência: já virou venda → devolve a venda existente, sem criar nada.
        if (order.status === 'CONVERTED' && order.sale) {
          const again = await tx.externalOrder.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_VIEW_INCLUDE });
          return { order: orderView(again), sale: { id: order.sale.id, saleNumber: order.sale.saleNumber, status: order.sale.status, totalAmount: Number(order.sale.totalAmount) }, replayed: true };
        }
        if (order.status !== 'ACCEPTED' && order.status !== 'EXPIRED') throw commerceError.invalidState(order.status);
        const branchId = order.branchId;
        if (!branchId) throw commerceError.channelBranchRequired();
        const channel = await tx.salesChannel.findFirstOrThrow({ where: { id: order.channelId } });

        // Condição: pagamento confirmado cobrindo o total (nenhuma venda sem condição necessária).
        const totalCents = order.totalAmount === null ? 0 : toCents(Number(order.totalAmount));
        const confirmed = order.payments.filter((p) => p.status === 'CONFIRMED');
        const confirmedCents = confirmed.reduce((s, p) => s + toCents(Number(p.amount)), 0);
        if (totalCents <= 0 || order.paymentStatus !== 'CONFIRMED' || confirmedCents !== totalCents) throw commerceError.paymentNotConfirmed();

        // Ordem fixa de travas (a mesma da venda do balcão): número da venda por filial, depois os produtos por id.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4202, hashtext(${`${order.companyId}:${branchId}`}))`;
        const productIds = await lockProductsInOrder(tx, order.items.map((i) => i.productId));
        const now = new Date();

        // Reserva: viva e que cobre a linha? Senão (venceu), tenta reservar de novo com o estoque DISPONÍVEL (sem a própria reserva).
        const reservations = await tx.stockReservation.findMany({ where: { orderId: order.id } });
        const live = (productId: string, qty: number) => reservations.some((r) => r.productId === productId && r.status === 'ACTIVE' && r.expiresAt > now && Number(r.quantity) >= qty);
        const needsRestock = order.items.some((i) => !live(i.productId, Number(i.quantity)));
        const availability = await availabilityOf(tx, { companyId: order.companyId, branchId, productIds, excludeOrderId: order.id });
        if (needsRestock) {
          const short = order.items
            .filter((i) => !live(i.productId, Number(i.quantity)))
            .map((i) => ({ sku: i.sku, requested: Number(i.quantity), available: Math.max(0, availability.get(i.productId)?.available ?? 0) }))
            .filter((i) => i.available < i.requested);
          if (short.length > 0) throw commerceError.reservationLost(short);
        }
        // Saldo FÍSICO: a reserva não é estoque; houve baixa depois dela? Nunca fica negativo por conversão.
        const physical = await stockLedger.balances({ companyId: order.companyId, branchId, productIds }, tx);
        const lacking = order.items.filter((i) => (physical.get(i.productId)?.balance ?? 0) < Number(i.quantity)).map((i) => ({ sku: i.sku, requested: Number(i.quantity), balance: physical.get(i.productId)?.balance ?? 0 }));
        if (lacking.length > 0) throw commerceError.insufficientPhysicalStock(lacking);

        const last = await tx.sale.findFirst({ where: { companyId: order.companyId, branchId }, orderBy: { saleNumber: 'desc' }, select: { saleNumber: true } });
        const saleNumber = (last?.saleNumber ?? 0) + 1;
        const total = fromCents(totalCents);
        const sale = await tx.sale.create({
          data: {
            companyId: order.companyId,
            branchId,
            saleNumber,
            channelId: order.channelId,
            userId: null,
            cashRegisterId: null,
            status: 'PAID',
            subtotal: total,
            discountAmount: 0,
            discountPercent: 0,
            totalAmount: total,
            paidAmount: total,
            changeAmount: 0,
            notes: `Pedido externo ${order.externalOrderId} (${channel.displayName})`,
            items: {
              create: order.items.map((i) => ({
                productId: i.productId,
                productName: i.name,
                productSku: i.sku,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                discountAmount: 0,
                discountPercent: 0,
                totalPrice: i.lineTotal,
              })),
            },
          },
        });

        for (const p of confirmed) {
          await tx.payment.create({
            data: {
              companyId: order.companyId,
              saleId: sale.id,
              paymentMethod: p.method,
              status: 'APPROVED',
              amount: p.amount,
              receivedAmount: p.amount,
              provider: `external:${channel.type}`,
              // `transactionId` é único no banco inteiro: prefixado pelo canal para nunca colidir com outro canal ou empresa.
              transactionId: `ext:${order.channelId}:${p.providerRef}`,
              paidAt: p.lastEventAt ?? now,
              notes: 'Pagamento externo informado pelo canal (não passou pelo caixa do balcão)',
            },
          });
        }

        // Estoque: uma saída SALE por item, na ordem fixa dos produtos (a mesma da trava).
        for (const id of productIds) {
          const item = order.items.find((i) => i.productId === id)!;
          await tx.stockMovement.create({
            data: {
              companyId: order.companyId,
              branchId,
              productId: id,
              movementType: 'SALE',
              quantity: -Number(item.quantity),
              referenceType: 'Sale',
              referenceId: sale.id,
              notes: `Pedido externo ${order.externalOrderId}`,
              userId: input.actor.type === 'USER' ? input.actor.userId : null,
            },
          });
        }

        // Reserva consumida (ou, se venceu e foi refeita agora, registrada já como consumida): o histórico fica completo.
        await tx.stockReservation.updateMany({ where: { orderId: order.id, status: 'ACTIVE' }, data: { status: 'CONSUMED', closedAt: now, closedReason: 'CONVERTED' } });
        for (const i of order.items) {
          const existing = reservations.find((r) => r.productId === i.productId);
          if (!existing) {
            await tx.stockReservation.create({ data: { companyId: order.companyId, branchId, channelId: order.channelId, orderId: order.id, productId: i.productId, quantity: i.quantity, status: 'CONSUMED', expiresAt: now, closedAt: now, closedReason: 'CONVERTED' } });
          } else if (existing.status !== 'ACTIVE') {
            await tx.stockReservation.update({ where: { id: existing.id }, data: { status: 'CONSUMED', quantity: i.quantity, expiresAt: now, closedAt: now, closedReason: 'CONVERTED_AFTER_EXPIRY' } });
          }
        }

        await tx.fulfillment.create({ data: { companyId: order.companyId, branchId, orderId: order.id, saleId: sale.id, status: 'PENDING', statusChangedBy: input.actor.type === 'USER' ? input.actor.userId : null } });
        await tx.externalOrder.update({ where: { id: order.id }, data: { status: 'CONVERTED', saleId: sale.id, convertedAt: now, statusReason: null, statusChangedAt: now } });
        const updated = await tx.externalOrder.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_VIEW_INCLUDE });
        await enqueueOrderStatus(tx, order, 'CONVERTED', { correlationId: input.correlationId }); // caixa de saída: avisa o provedor depois, fora desta venda
        await logOrderEvent(tx, order, 'ORDER_CONVERTED', 'INFO', `Pedido convertido na venda #${saleNumber} (sem caixa físico; o pagamento é o externo)`, input.actor, input.correlationId, { saleId: sale.id, saleNumber, total, restocked: needsRestock });
        return { order: orderView(updated), sale: { id: sale.id, saleNumber, status: sale.status, totalAmount: total }, replayed: false };
      });
    } catch (err) {
      // A venda NÃO foi criada (a transação foi desfeita). O motivo fica registrado fora dela, para tratamento por pessoa autorizada.
      if (err instanceof CommerceError && FAILURE_CODES.has(err.code)) {
        const channel = await prisma.salesChannel.findFirst({ where: { id: input.channelId, companyId: input.companyId }, select: { branchId: true } });
        await prisma.channelEvent
          .create({
            data: {
              companyId: input.companyId,
              branchId: channel?.branchId ?? null,
              channelId: input.channelId,
              type: 'ORDER_CONVERT_FAILED',
              level: 'WARN',
              message: `Pedido não convertido em venda: ${err.code}`,
              correlationId: input.correlationId ?? null,
              data: { orderId: input.orderId, code: err.code, details: err.details ?? null } as any,
            },
          })
          .catch(() => undefined);
      }
      throw err;
    }
  },

  /** Conversão automática ao confirmar o pagamento: só se o canal ligou `autoConvertOnPaymentConfirmed` (padrão desligado). Nunca derruba o evento. */
  async maybeAutoConvert(input: { companyId: string; channelId: string; orderId: string; correlationId?: string }) {
    const channel = await prisma.salesChannel.findFirst({ where: { id: input.channelId, companyId: input.companyId } });
    if (!channel || !readOrderPolicy(channel.config).autoConvertOnPaymentConfirmed) return { attempted: false as const };
    try {
      const r = await this.convertOrder({ ...input, actor: { type: 'SYSTEM' } });
      return { attempted: true as const, converted: true as const, saleNumber: r.sale.saleNumber };
    } catch (err) {
      return { attempted: true as const, converted: false as const, code: err instanceof CommerceError ? err.code : 'ERROR' };
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Fulfillment mínimo (DECISIONS 91 pendente: quem separa, confere, embala e entrega NÃO foi decidido). Só estados e transições seguras.
// ---------------------------------------------------------------------------------------------------------------------
export const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  PENDING: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED_DELIVERY'],
  FAILED_DELIVERY: ['IN_TRANSIT', 'RETURNED', 'CANCELLED'],
  PICKED_UP: [],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

export const canMoveFulfillment = (from: FulfillmentStatus, to: FulfillmentStatus) => FULFILLMENT_TRANSITIONS[from].includes(to);

const needsDelivery = (s: FulfillmentStatus) => s === 'IN_TRANSIT' || s === 'DELIVERED' || s === 'FAILED_DELIVERY';

export const fulfillmentService = {
  async transition(input: { companyId: string; channelId: string; orderId: string; status: FulfillmentStatus; type?: FulfillmentType; notes?: string; actorId: string; correlationId?: string }) {
    return runInTransaction(async (tx) => {
      const order = await tx.externalOrder.findFirst({ where: { id: input.orderId, companyId: input.companyId, channelId: input.channelId } });
      if (!order) throw commerceError.notFound('Pedido');
      const f = await tx.fulfillment.findUnique({ where: { orderId: order.id } });
      if (!f) throw commerceError.fulfillmentInvalid('O pedido ainda não virou venda: não há entrega para acompanhar.');
      if (f.status === input.status && (!input.type || input.type === f.type)) return f; // repetir é inofensivo
      if (!canMoveFulfillment(f.status, input.status)) throw commerceError.fulfillmentInvalid(`Não é possível ir de ${f.status} para ${input.status}.`);
      if (f.type && input.type && f.type !== input.type) throw commerceError.fulfillmentInvalid('O tipo de entrega já definido não muda.');
      const type = f.type ?? input.type ?? null;
      if (input.status === 'PICKED_UP' && type !== null && type !== 'PICKUP') throw commerceError.fulfillmentInvalid('Retirada na loja só vale para o tipo PICKUP.');
      if (needsDelivery(input.status) && (type === null || type === 'PICKUP')) throw commerceError.fulfillmentInvalid('Defina o tipo de entrega (própria ou do canal) antes de enviar.');
      const res = await tx.fulfillment.updateMany({
        where: { id: f.id, status: f.status },
        data: { status: input.status, type: type ?? undefined, statusChangedAt: new Date(), statusChangedBy: input.actorId, ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}) },
      });
      if (res.count !== 1) throw commerceError.fulfillmentInvalid('A entrega mudou enquanto você a alterava. Recarregue.');
      await enqueueFulfillment(tx, order, input.status, type, input.correlationId);
      await logOrderEvent(tx, order, 'FULFILLMENT_UPDATED', 'INFO', `Entrega: ${f.status} → ${input.status}`, { type: 'USER', userId: input.actorId }, input.correlationId, { from: f.status, to: input.status, type });
      return tx.fulfillment.findUniqueOrThrow({ where: { id: f.id } });
    });
  },
};

export default convertService;
