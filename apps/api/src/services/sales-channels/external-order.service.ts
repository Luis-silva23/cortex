import { z } from 'zod';
import { prisma, runInTransaction } from '@ln-system/database';
import type { ExternalPaymentStatus } from '@prisma/client';
import moduleSettingsService from '../module-settings.service';
import { sanitizeErrorMessage } from './gateway';

/**
 * Recepção IDEMPOTENTE de pedidos e eventos de canais externos (site próprio, iFood, marketplaces). Hoje NÃO há rota pública que a
 * chame: o webhook só será montado quando houver um provedor homologado (docs/CORTEX/CANAIS.md). Aqui fica o contrato, provado
 * por teste, para que a ativação futura não precise reabrir vendas, estoque nem painel.
 *
 * O que esta camada faz — e o que NÃO faz:
 *   - guarda o PEDIDO (`ExternalOrder`) e o estado do pagamento informado pelo canal; um pedido recebido não é venda, não baixa
 *     estoque, não cria pagamento e não gera documento fiscal. A venda só nasce por uma conversão deliberada (fora deste arquivo);
 *   - o mesmo evento (canal + id do evento + operação) recebido de novo não faz nada (`DUPLICATE`); o mesmo pedido não duplica;
 *   - cancelamento de pedido que já virou venda NÃO cancela a venda: pede revisão (cancelar venda exige autorização, estorno e
 *     reposição de estoque pelo fluxo próprio);
 *   - módulo CANAIS desligado ou canal inativo: nada é processado;
 *   - o corpo é validado com esquema fechado (campo desconhecido é recusado: nada de dado de pagamento ou lixo no banco).
 */

export const EXTERNAL_OPERATIONS = ['ORDER_CREATED', 'PAYMENT_UPDATED', 'ORDER_CANCELLED'] as const;
export type ExternalOperation = (typeof EXTERNAL_OPERATIONS)[number];

const money = z.number().finite().min(0).max(10_000_000);

export const externalOrderPayloadSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            sku: z.string().trim().min(1).max(80),
            name: z.string().trim().max(200).optional(),
            quantity: z.number().finite().positive().max(100_000),
            unitPrice: money,
          })
          .strict()
      )
      .min(1)
      .max(200),
    total: money,
    currency: z.literal('BRL').default('BRL'),
    customer: z.object({ name: z.string().trim().max(200).optional() }).strict().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

const idSchema = z.string().trim().min(1).max(120);

export interface IngestInput {
  companyId: string;
  channelId: string;
  externalEventId: string;
  operation: ExternalOperation;
  externalOrderId: string;
  /** Obrigatório em ORDER_CREATED. */
  payload?: unknown;
  /** PAYMENT_UPDATED (e opcional em ORDER_CREATED): o que o canal diz sobre o pagamento. */
  paymentStatus?: ExternalPaymentStatus;
  correlationId?: string;
}

export type IngestResult =
  | { outcome: 'CREATED' | 'UPDATED' | 'IGNORED' | 'DUPLICATE'; orderId?: string; reason?: string }
  | { outcome: 'NEEDS_REVIEW'; orderId: string; reason: string }
  | { outcome: 'REJECTED'; reason: 'CHANNEL_NOT_FOUND' | 'MODULE_DISABLED' | 'CHANNEL_INACTIVE' | 'INVALID_INPUT' | 'ORDER_UNKNOWN' | 'INVALID_TRANSITION' };

const PAYMENT_STATUSES: ExternalPaymentStatus[] = ['UNKNOWN', 'PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED'];

/** Estado de pagamento só anda para o que o canal pode afirmar; REFUNDED é final e nada volta a UNKNOWN. */
export function canMovePayment(from: ExternalPaymentStatus, to: ExternalPaymentStatus): boolean {
  if (from === to) return false;
  if (from === 'REFUNDED') return false;
  if (to === 'UNKNOWN') return false;
  if (to === 'REFUNDED') return from === 'CONFIRMED';
  return true;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

async function note(channel: { id: string; companyId: string; branchId: string | null }, level: 'INFO' | 'WARN', type: string, message: string, input: IngestInput) {
  await prisma.channelEvent.create({
    data: {
      companyId: channel.companyId,
      branchId: channel.branchId,
      channelId: channel.id,
      type,
      level,
      message: message.slice(0, 500),
      correlationId: input.correlationId ?? null,
      data: { operation: input.operation, externalEventId: input.externalEventId, externalOrderId: input.externalOrderId } as any,
    },
  });
}

export async function ingestExternalEvent(input: IngestInput): Promise<IngestResult> {
  const channel = await prisma.salesChannel.findFirst({ where: { id: input.channelId, companyId: input.companyId } });
  if (!channel) return { outcome: 'REJECTED', reason: 'CHANNEL_NOT_FOUND' };

  if (!(await moduleSettingsService.isModuleEnabled(channel.companyId, channel.branchId, 'CANAIS'))) {
    await note(channel, 'WARN', 'EVENT_REJECTED', 'Evento recusado: módulo de canais desativado', input);
    return { outcome: 'REJECTED', reason: 'MODULE_DISABLED' };
  }
  if (!channel.isActive) {
    await note(channel, 'WARN', 'EVENT_REJECTED', 'Evento recusado: canal desativado', input);
    return { outcome: 'REJECTED', reason: 'CHANNEL_INACTIVE' };
  }

  const ids = z.object({ e: idSchema, o: idSchema }).safeParse({ e: input.externalEventId, o: input.externalOrderId });
  const payload = input.operation === 'ORDER_CREATED' ? externalOrderPayloadSchema.safeParse(input.payload) : null;
  const payment = input.paymentStatus === undefined ? true : PAYMENT_STATUSES.includes(input.paymentStatus);
  if (!EXTERNAL_OPERATIONS.includes(input.operation) || !ids.success || (payload && !payload.success) || !payment) {
    const where = payload && !payload.success ? payload.error.issues.map((i) => i.path.join('.') || 'corpo').slice(0, 5).join(', ') : 'identificação do evento';
    await note(channel, 'WARN', 'EVENT_REJECTED', `Evento recusado: dados inválidos (${sanitizeErrorMessage(where)})`, input);
    return { outcome: 'REJECTED', reason: 'INVALID_INPUT' };
  }

  try {
    return await runInTransaction(async (tx): Promise<IngestResult> => {
      // 1) Reivindica o evento: (canal, evento, operação) é único. Se já veio, a violação desfaz tudo e vira DUPLICATE.
      await tx.channelInboundEvent.create({
        data: { companyId: channel.companyId, branchId: channel.branchId, channelId: channel.id, externalEventId: input.externalEventId, operation: input.operation, outcome: 'RECEIVED' },
      });

      const existing = await tx.externalOrder.findFirst({ where: { channelId: channel.id, externalOrderId: input.externalOrderId } });
      const logged = (level: 'INFO' | 'WARN', type: string, message: string) =>
        tx.channelEvent.create({
          data: {
            companyId: channel.companyId,
            branchId: channel.branchId,
            channelId: channel.id,
            type,
            level,
            message,
            correlationId: input.correlationId ?? null,
            data: { operation: input.operation, externalEventId: input.externalEventId, externalOrderId: input.externalOrderId } as any,
          },
        });

      if (input.operation === 'ORDER_CREATED') {
        if (existing) {
          await logged('INFO', 'ORDER_IGNORED', 'Pedido já recebido antes: nada foi criado de novo');
          return { outcome: 'IGNORED', orderId: existing.id, reason: 'ORDER_EXISTS' };
        }
        const created = await tx.externalOrder.create({
          data: {
            companyId: channel.companyId,
            branchId: channel.branchId,
            channelId: channel.id,
            externalOrderId: input.externalOrderId,
            status: 'RECEIVED',
            paymentStatus: input.paymentStatus ?? 'UNKNOWN',
            payload: payload!.data as any,
          },
        });
        await logged('INFO', 'ORDER_RECEIVED', 'Pedido recebido (ainda não é venda, pagamento nem baixa de estoque)');
        return { outcome: 'CREATED', orderId: created.id };
      }

      if (!existing) throw new UnknownOrder(); // desfaz também a reivindicação do evento: ele pode ser reenviado depois do pedido

      if (input.operation === 'PAYMENT_UPDATED') {
        const to = input.paymentStatus;
        if (!to || !canMovePayment(existing.paymentStatus, to)) {
          await logged('INFO', 'ORDER_IGNORED', `Mudança de pagamento ignorada (${existing.paymentStatus} → ${to ?? 'sem estado'})`);
          return { outcome: 'IGNORED', orderId: existing.id, reason: 'INVALID_TRANSITION' };
        }
        await tx.externalOrder.update({ where: { id: existing.id }, data: { paymentStatus: to } });
        await logged('INFO', 'PAYMENT_UPDATED', `Pagamento informado pelo canal: ${to} (não cria pagamento nem venda)`);
        return { outcome: 'UPDATED', orderId: existing.id };
      }

      // ORDER_CANCELLED
      if (existing.status === 'CONVERTED') {
        await logged('WARN', 'ORDER_NEEDS_REVIEW', 'Canal cancelou um pedido que já virou venda: a venda NÃO foi cancelada; trate pelo cancelamento/devolução da venda');
        return { outcome: 'NEEDS_REVIEW', orderId: existing.id, reason: 'ORDER_ALREADY_SALE' };
      }
      if (existing.status === 'CANCELLED') {
        await logged('INFO', 'ORDER_IGNORED', 'Pedido já estava cancelado');
        return { outcome: 'IGNORED', orderId: existing.id, reason: 'ALREADY_CANCELLED' };
      }
      await tx.externalOrder.update({ where: { id: existing.id }, data: { status: 'CANCELLED' } });
      await logged('INFO', 'ORDER_CANCELLED', 'Pedido cancelado pelo canal');
      return { outcome: 'UPDATED', orderId: existing.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: 'DUPLICATE', reason: 'EVENT_ALREADY_PROCESSED' };
    if (err instanceof UnknownOrder) {
      await note(channel, 'WARN', 'EVENT_REJECTED', 'Evento recusado: pedido desconhecido', input);
      return { outcome: 'REJECTED', reason: 'ORDER_UNKNOWN' };
    }
    throw err;
  }
}

class UnknownOrder extends Error {}
