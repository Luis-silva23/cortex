import { z } from 'zod';
import { prisma, runInTransaction } from '@ln-system/database';
import type { ExternalPaymentStatus } from '@prisma/client';
import type { ChannelPrincipal } from '../../middleware/channel-auth';
import { commerceError, CommerceError } from './errors';
import { toCents, fromCents } from './order.service';
import convertService from './convert.service';

/**
 * Pagamento EXTERNO de um pedido (docs/CORTEX/COMMERCE_API.md §8). Separado do pedido, da venda e do pagamento físico:
 *  - o CÓRTEX só RECEBE eventos de pagamento (informados pelo canal/PSP, assinados); não cobra, não mexe no caixa, não cria venda;
 *  - cada pagamento é identificado por `providerRef` (único por canal) e cada evento por `eventId` (único por canal): o mesmo evento
 *    repetido não faz nada (`DUPLICATE`) — nem segunda cobrança, nem segunda venda, nem segundo movimento de estoque;
 *  - o estado de cada pagamento é MONOTÔNICO: PENDING → CONFIRMED | FAILED; CONFIRMED → REFUNDED; FAILED e REFUNDED são finais.
 *    Evento mais velho que o último já aplicado é ignorado (webhook fora de ordem); transição inválida é ignorada e registrada;
 *  - timeout ou ausência de evento NUNCA vira recusa: o pagamento fica PENDING até o provedor dizer o contrário;
 *  - valor diferente do total do pedido e pagamento confirmado em pedido já encerrado NÃO são descartados nem aplicados em silêncio:
 *    são registrados como alerta (WARN) para tratamento por pessoa autorizada (mesmo princípio da exceção de pagamento da venda).
 */
const refPattern = /^[A-Za-z0-9._:-]+$/;

export const paymentEventSchema = z
  .object({
    eventId: z.string().trim().min(1).max(120).regex(refPattern, 'use letras, números e . _ : -'),
    providerRef: z.string().trim().min(1).max(120).regex(refPattern, 'use letras, números e . _ : -'),
    status: z.enum(['PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED']),
    amount: z
      .number()
      .finite()
      .min(0)
      .max(10_000_000)
      .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'use no máximo 2 casas decimais'),
    occurredAt: z.string().datetime().optional(),
    /** Forma de pagamento informada pelo canal (opcional; sem informação = OUTRO). Vira a forma do pagamento na venda. */
    method: z.enum(['PIX', 'DEBIT_CARD', 'CREDIT_CARD', 'BANK_TRANSFER', 'OTHER']).optional(),
  })
  .strict();

export type PaymentEventInput = z.infer<typeof paymentEventSchema>;

/** Transições permitidas de UM pagamento (`from = null`: primeiro evento daquele `providerRef`). */
export function canMovePaymentState(from: ExternalPaymentStatus | null, to: ExternalPaymentStatus): boolean {
  if (from === null) return to === 'PENDING' || to === 'CONFIRMED' || to === 'FAILED';
  if (from === 'PENDING') return to === 'CONFIRMED' || to === 'FAILED';
  if (from === 'CONFIRMED') return to === 'REFUNDED';
  return false; // FAILED, REFUNDED e UNKNOWN não andam
}

/** Estado de pagamento do PEDIDO, derivado dos pagamentos dele. Confirmado só quando o confirmado cobre o total. */
export function aggregatePaymentStatus(payments: Array<{ status: ExternalPaymentStatus; amountCents: number }>, totalCents: number): ExternalPaymentStatus {
  const confirmed = payments.filter((p) => p.status === 'CONFIRMED').reduce((s, p) => s + p.amountCents, 0);
  if (totalCents > 0 && confirmed >= totalCents) return 'CONFIRMED';
  if (payments.some((p) => p.status === 'PENDING') || confirmed > 0) return 'PENDING';
  if (payments.some((p) => p.status === 'REFUNDED')) return 'REFUNDED';
  if (payments.some((p) => p.status === 'FAILED')) return 'FAILED';
  return 'UNKNOWN';
}

const CLOSED_ORDER_STATUSES = ['CANCELLED', 'REJECTED', 'EXPIRED'];
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

export type PaymentEventResult = {
  outcome: 'CREATED' | 'UPDATED' | 'IGNORED' | 'STALE' | 'DUPLICATE';
  reason?: string;
  paymentStatus: ExternalPaymentStatus;
  orderStatus: string;
  /** Só quando o canal ligou a conversão automática e o pagamento acabou de cobrir o pedido aceito. */
  autoConvert?: { attempted: boolean; converted?: boolean; saleNumber?: number; code?: string };
};

export const paymentEventsService = {
  async record(principal: ChannelPrincipal, externalOrderId: string, raw: unknown, correlationId?: string): Promise<PaymentEventResult> {
    const parsed = paymentEventSchema.safeParse(raw);
    if (!parsed.success) throw commerceError.invalidRequest(parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
    const input = parsed.data;

    const order = await prisma.externalOrder.findFirst({ where: { channelId: principal.channelId, externalOrderId } });
    if (!order) throw commerceError.notFound('Pedido');

    try {
      const result = await runInTransaction(async (tx): Promise<PaymentEventResult> => {
        // Serializa os eventos do MESMO pedido: dois webhooks simultâneos não se atropelam.
        await tx.$queryRaw`SELECT id FROM external_orders WHERE id = ${order.id} FOR UPDATE`;

        // 1) Reivindica o evento. Se já veio, a violação desfaz tudo e vira DUPLICATE (tratada fora da transação).
        await tx.channelInboundEvent.create({
          data: { companyId: principal.companyId, branchId: principal.branchId, channelId: principal.channelId, externalEventId: input.eventId, operation: 'PAYMENT_UPDATED', outcome: 'RECEIVED' },
        });

        const fresh = await tx.externalOrder.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
        const totalCents = fresh.totalAmount === null ? 0 : toCents(Number(fresh.totalAmount));
        const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
        const log = (level: 'INFO' | 'WARN', type: string, message: string, extra: Record<string, unknown> = {}) =>
          tx.channelEvent.create({
            data: {
              companyId: principal.companyId,
              branchId: principal.branchId,
              channelId: principal.channelId,
              type,
              level,
              message,
              correlationId: correlationId ?? null,
              data: { orderId: order.id, externalOrderId, eventId: input.eventId, providerRef: input.providerRef, ...extra } as any,
            },
          });
        const result = (outcome: PaymentEventResult['outcome'], status: ExternalPaymentStatus, reason?: string): PaymentEventResult => ({ outcome, reason, paymentStatus: status, orderStatus: fresh.status });

        const sameRefElsewhere = await tx.externalPayment.findFirst({ where: { channelId: principal.channelId, providerRef: input.providerRef, NOT: { orderId: order.id } } });
        if (sameRefElsewhere) throw new CommerceError(409, 'PAYMENT_REF_IN_USE', 'Esta referência de pagamento já pertence a outro pedido.');

        const existing = fresh.payments.find((p) => p.providerRef === input.providerRef) ?? null;
        if (existing) {
          if (existing.lastEventAt && occurredAt < existing.lastEventAt) {
            await log('INFO', 'PAYMENT_EVENT_STALE', 'Evento de pagamento mais antigo que o último aplicado: ignorado');
            return result('STALE', fresh.paymentStatus, 'OLDER_THAN_LAST_EVENT');
          }
          if (existing.status === input.status) {
            await log('INFO', 'PAYMENT_EVENT_IGNORED', `Pagamento já estava ${input.status}: nada mudou`);
            return result('IGNORED', fresh.paymentStatus, 'SAME_STATE');
          }
          if (!canMovePaymentState(existing.status, input.status)) {
            await log('WARN', 'PAYMENT_EVENT_IGNORED', `Mudança de pagamento recusada (${existing.status} → ${input.status})`, { from: existing.status, to: input.status });
            return result('IGNORED', fresh.paymentStatus, 'INVALID_TRANSITION');
          }
          if (toCents(input.amount) !== toCents(Number(existing.amount))) {
            await log('WARN', 'PAYMENT_AMOUNT_CHANGED', 'O valor do evento difere do valor já registrado para este pagamento; o valor registrado foi mantido', { registered: Number(existing.amount), received: input.amount });
          }
          await tx.externalPayment.update({ where: { id: existing.id }, data: { status: input.status, lastEventAt: occurredAt } });
        } else {
          if (!canMovePaymentState(null, input.status)) {
            await log('WARN', 'PAYMENT_EVENT_IGNORED', `Primeiro evento de pagamento inválido (${input.status})`);
            return result('IGNORED', fresh.paymentStatus, 'INVALID_FIRST_STATE');
          }
          await tx.externalPayment.create({
            data: {
              companyId: principal.companyId,
              branchId: principal.branchId,
              channelId: principal.channelId,
              orderId: order.id,
              providerRef: input.providerRef,
              status: input.status,
              amount: input.amount,
              source: 'CHANNEL_REPORTED',
              method: input.method ?? 'OTHER',
              lastEventAt: occurredAt,
            },
          });
        }

        // Recalcula o estado do pedido a partir de TODOS os pagamentos dele.
        const all = await tx.externalPayment.findMany({ where: { orderId: order.id } });
        const aggregate = aggregatePaymentStatus(all.map((p) => ({ status: p.status, amountCents: toCents(Number(p.amount)) })), totalCents);
        if (aggregate !== fresh.paymentStatus) await tx.externalOrder.update({ where: { id: order.id }, data: { paymentStatus: aggregate } });

        await log('INFO', 'PAYMENT_UPDATED', `Pagamento ${input.providerRef}: ${input.status} (informado pelo canal; não cria pagamento físico, venda nem movimento de caixa)`, { status: input.status, amount: input.amount });

        if (input.status === 'CONFIRMED') {
          const confirmedCents = all.filter((p) => p.status === 'CONFIRMED').reduce((s, p) => s + toCents(Number(p.amount)), 0);
          if (confirmedCents !== totalCents) await log('WARN', 'PAYMENT_AMOUNT_MISMATCH', 'O valor confirmado difere do total do pedido: trate por pessoa autorizada (nada foi convertido)', { confirmed: fromCents(confirmedCents), expected: fromCents(totalCents) });
          if (CLOSED_ORDER_STATUSES.includes(fresh.status)) await log('WARN', 'PAYMENT_ON_CLOSED_ORDER', `Pagamento confirmado em pedido ${fresh.status}: a devolução do dinheiro precisa de tratamento por pessoa autorizada`, { orderStatus: fresh.status });
        }
        return result(existing ? 'UPDATED' : 'CREATED', aggregate);
      });
      // Conversão automática (opcional, desligada por padrão): depois do COMMIT do evento, em outra transação; falha dela nunca desfaz
      // nem derruba o evento de pagamento (que já está registrado), só fica no relatório e no evento do canal.
      if ((result.outcome === 'CREATED' || result.outcome === 'UPDATED') && result.paymentStatus === 'CONFIRMED' && ['ACCEPTED', 'EXPIRED'].includes(result.orderStatus)) {
        result.autoConvert = await convertService.maybeAutoConvert({ companyId: principal.companyId, channelId: principal.channelId, orderId: order.id, correlationId });
      }
      return result;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const claimed = await prisma.channelInboundEvent.findFirst({ where: { channelId: principal.channelId, externalEventId: input.eventId, operation: 'PAYMENT_UPDATED' } });
        if (claimed) {
          const current = await prisma.externalOrder.findFirst({ where: { id: order.id } });
          return { outcome: 'DUPLICATE', reason: 'EVENT_ALREADY_PROCESSED', paymentStatus: current?.paymentStatus ?? 'UNKNOWN', orderStatus: current?.status ?? order.status };
        }
      }
      throw err;
    }
  },
};

export default paymentEventsService;
