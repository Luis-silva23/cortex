import { z } from 'zod';
import { prisma, runWithRLSContext } from '@ln-system/database';
import type { ChannelPrincipal } from '../../middleware/channel-auth';
import { CommerceError } from '../commerce/errors';
import commerceOrderService, { createOrderSchema } from '../commerce/order.service';
import paymentEventsService, { paymentEventSchema } from '../commerce/payment-events.service';
import { autoAcceptIfEnabled } from '../commerce/reservation.service';
import { sanitizeErrorMessage } from '../sales-channels/gateway';
import { Logger } from '../logger.service';

/**
 * ENTRADA do Integration Gateway (docs/CORTEX/COMMERCE_API.md §12): recebe EVENTOS NORMALIZADOS de um provedor (por webhook assinado
 * ou por consulta periódica) e os aplica pelos MESMOS serviços da Commerce API — pedido com preço oficial, pagamento externo
 * monotônico, cancelamento. Nada é gravado pelo provedor diretamente; empresa, filial e canal vêm do canal autenticado, nunca do corpo.
 *
 *  - IDEMPOTÊNCIA: cada evento é reivindicado em `channel_inbound_events` por (canal, `eventId`, operação). O mesmo evento recebido de
 *    novo é `DUPLICATE` e não faz nada: nem segundo pedido, nem segunda cobrança, nem segunda venda, nem segundo movimento de estoque.
 *    Uma entrega que travou no meio (RECEIVED antigo) ou falhou (FAILED) é refeita com segurança porque cada serviço de destino
 *    também é idempotente (entrega "pelo menos uma vez" + aplicação idempotente).
 *  - FORA DE ORDEM: pagamento ou cancelamento de um pedido que ainda não chegou fica GUARDADO (`DEFERRED`, com o evento normalizado)
 *    e é aplicado quando o pedido chega, em ordem de ocorrência; se o pedido nunca chegar, vence em 24 h e vira alerta. Evento mais
 *    velho que o último já aplicado é descartado pela máquina monotônica do pagamento (`STALE`), não aplicado.
 *  - DADO EXTERNO É NÃO CONFIÁVEL: esquema fechado (campo desconhecido é recusado), preço e total conferidos contra o CÓRTEX, SKU só
 *    se publicado para o canal, regra de negócio recusada vira `REJECTED` registrado (sem retentativa inútil) e nunca é aplicada pela metade.
 *  - SEM SEGREDO: só ids, códigos e valores de negócio vão para o banco e para os eventos do canal; mensagens de erro são sanitizadas.
 */

const refPattern = /^[A-Za-z0-9._:\-]+$/;
const idSchema = z.string().trim().min(1).max(120).regex(refPattern, 'use letras, números e . _ : -');
const when = z.string().datetime().optional();

export const normalizedEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ORDER_CREATED'), eventId: idSchema, occurredAt: when, order: createOrderSchema }).strict(),
  z
    .object({ type: z.literal('PAYMENT'), eventId: idSchema, occurredAt: when, externalOrderId: idSchema, payment: paymentEventSchema.omit({ eventId: true, occurredAt: true }) })
    .strict(),
  z.object({ type: z.literal('ORDER_CANCELLED'), eventId: idSchema, occurredAt: when, externalOrderId: idSchema, reason: z.string().trim().max(300).optional() }).strict(),
]);
export type ParsedEvent = z.infer<typeof normalizedEventSchema>;

export interface GatewayChannel {
  id: string;
  companyId: string;
  branchId: string | null;
  provider: string | null;
  config: unknown;
}

export type InboundOutcome = 'APPLIED' | 'DUPLICATE' | 'DEFERRED' | 'REJECTED' | 'REVIEW' | 'INVALID' | 'FAILED';
export interface InboundResult {
  eventId: string | null;
  type: string | null;
  outcome: InboundOutcome;
  code?: string;
}

export const MAX_EVENTS_PER_DELIVERY = 50;
/** Entrega reivindicada que não terminou depois disto é considerada travada e pode ser refeita. */
const STUCK_MS = 2 * 60_000;
export const DEFERRED_MAX_AGE_MS = 24 * 3_600_000;

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
const orderRefOf = (e: ParsedEvent) => (e.type === 'ORDER_CREATED' ? e.order.externalOrderId : e.externalOrderId);

/** O "usuário" do gateway: um canal com provedor, com os escopos que os serviços exigem. A empresa e a filial são as do CANAL. */
export function gatewayPrincipal(channel: GatewayChannel & { branchId: string }): ChannelPrincipal {
  return {
    companyId: channel.companyId,
    branchId: channel.branchId,
    channelId: channel.id,
    credentialId: 'gateway',
    keyId: `provider:${channel.provider ?? 'unknown'}`,
    scopes: ['CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE'],
    channelConfig: (channel.config as Record<string, unknown> | null) ?? {},
  };
}

async function channelEvent(channel: GatewayChannel, level: 'INFO' | 'WARN' | 'ERROR', type: string, message: string, correlationId: string | undefined, data: Record<string, unknown>) {
  await prisma.channelEvent
    .create({ data: { companyId: channel.companyId, branchId: channel.branchId, channelId: channel.id, type, level, message: message.slice(0, 500), correlationId: correlationId ?? null, data: data as any } })
    .catch((err) => Logger.error('Falha ao registrar evento do canal', err instanceof Error ? err : new Error(String(err))));
}

type Applied = { outcome: 'APPLIED' | 'DEFERRED' | 'REJECTED' | 'REVIEW'; code?: string };

async function apply(channel: GatewayChannel, principal: ChannelPrincipal, ev: ParsedEvent, correlationId: string | undefined): Promise<Applied> {
  const log = (level: 'INFO' | 'WARN', type: string, message: string, extra: Record<string, unknown> = {}) =>
    channelEvent(channel, level, type, message, correlationId, { eventId: ev.eventId, eventType: ev.type, externalOrderId: orderRefOf(ev), ...extra });

  try {
    if (ev.type === 'ORDER_CREATED') {
      const created = await commerceOrderService.create(principal, ev.order, correlationId, { source: 'WEBHOOK' });
      if (!created.replayed) await autoAcceptIfEnabled(principal, created.order.cortexOrderId, correlationId);
      return { outcome: 'APPLIED', code: created.replayed ? 'ORDER_EXISTS' : 'CREATED' };
    }
    if (ev.type === 'PAYMENT') {
      const r = await paymentEventsService.record(principal, ev.externalOrderId, { eventId: ev.eventId, occurredAt: ev.occurredAt, ...ev.payment }, correlationId);
      return { outcome: 'APPLIED', code: r.outcome };
    }
    await commerceOrderService.cancelByChannel(principal, ev.externalOrderId, ev.reason, correlationId);
    return { outcome: 'APPLIED', code: 'CANCELLED' };
  } catch (err) {
    if (!(err instanceof CommerceError)) throw err;
    // Pedido ainda desconhecido: o evento chegou antes do pedido. Fica guardado e é aplicado quando o pedido chegar.
    if (err.code === 'NOT_FOUND' && ev.type !== 'ORDER_CREATED') {
      await log('INFO', 'INBOUND_EVENT_DEFERRED', 'Evento chegou antes do pedido: guardado para ser aplicado quando o pedido chegar');
      return { outcome: 'DEFERRED', code: 'ORDER_NOT_YET_RECEIVED' };
    }
    // O canal cancelou um pedido que já virou venda: a venda NÃO é cancelada (isso exige autorização, estorno e reposição de estoque).
    if (err.code === 'INVALID_ORDER_STATE' && ev.type === 'ORDER_CANCELLED') {
      await log('WARN', 'ORDER_NEEDS_REVIEW', 'O canal cancelou um pedido que já não pode ser cancelado aqui (já virou venda ou foi encerrado): nada foi desfeito; trate pelo fluxo de cancelamento/devolução', { orderStatus: (err.details as { status?: string } | undefined)?.status });
      return { outcome: 'REVIEW', code: 'ORDER_NOT_CANCELLABLE' };
    }
    // Regra de negócio recusou (preço, produto, total, conflito...): determinístico, não adianta tentar de novo.
    await log('WARN', 'INBOUND_EVENT_REJECTED', `Evento recusado: ${err.code}`, { code: err.code, details: sanitizeDetails(err.details) });
    return { outcome: 'REJECTED', code: err.code };
  }
}

/** Detalhes de recusa só levam SKUs, códigos e valores de negócio; nunca texto livre do provedor. */
function sanitizeDetails(details: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(details ?? null).slice(0, 1500));
  } catch {
    return null;
  }
}

async function finalize(rowId: string, applied: Applied) {
  await prisma.channelInboundEvent.update({ where: { id: rowId }, data: { outcome: applied.outcome, processedAt: new Date(), lastError: applied.code ?? null } });
}

async function markFailed(rowId: string, err: unknown) {
  await prisma.channelInboundEvent
    .update({ where: { id: rowId }, data: { outcome: 'FAILED', processedAt: new Date(), lastError: sanitizeErrorMessage(err, 200) } })
    .catch(() => undefined);
}

/**
 * Processa as entregas de um lote (um webhook ou uma consulta). Roda DENTRO do contexto RLS do canal (userType CHANNEL), aberto por
 * quem chama. Um evento inválido ou recusado não impede os demais; `FAILED` (falha nossa, transitória) pede nova entrega ao provedor.
 */
export async function processEvents(channel: GatewayChannel, raw: unknown[], ctx: { correlationId?: string }): Promise<InboundResult[]> {
  if (!channel.branchId) return raw.map(() => ({ eventId: null, type: null, outcome: 'INVALID' as const, code: 'CHANNEL_BRANCH_REQUIRED' }));
  const principal = gatewayPrincipal({ ...channel, branchId: channel.branchId });
  const results: InboundResult[] = [];

  for (const item of raw.slice(0, MAX_EVENTS_PER_DELIVERY)) {
    const parsed = normalizedEventSchema.safeParse(item);
    if (!parsed.success) {
      const hint = (item as { eventId?: unknown } | null)?.eventId;
      const eventId = typeof hint === 'string' && refPattern.test(hint) && hint.length <= 120 ? hint : null;
      await channelEvent(channel, 'WARN', 'INBOUND_EVENT_INVALID', `Evento recusado: formato inválido (${sanitizeErrorMessage(parsed.error.issues.slice(0, 4).map((i) => i.path.join('.') || 'corpo').join(', '))})`, ctx.correlationId, { eventId });
      results.push({ eventId, type: null, outcome: 'INVALID', code: 'INVALID_EVENT' });
      continue;
    }
    const ev = parsed.data;
    results.push(await processOne(channel, principal, ev, ctx.correlationId));
  }
  return results;
}

async function processOne(channel: GatewayChannel, principal: ChannelPrincipal, ev: ParsedEvent, correlationId: string | undefined): Promise<InboundResult> {
  const operation = `GW:${ev.type}`;
  const base = { eventId: ev.eventId, type: ev.type };
  let rowId: string;
  try {
    const row = await prisma.channelInboundEvent.create({
      data: {
        companyId: channel.companyId,
        branchId: channel.branchId,
        channelId: channel.id,
        externalEventId: ev.eventId,
        operation,
        outcome: 'RECEIVED',
        payload: ev as any,
        occurredAt: ev.occurredAt ? new Date(ev.occurredAt) : null,
        orderRef: orderRefOf(ev),
        correlationId: correlationId ?? null,
        attempts: 1,
      },
    });
    rowId = row.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Repetição: já foi reivindicado antes. Só refaz o que ficou pela metade (FAILED, ou RECEIVED travado), e só uma instância vence.
    const existing = await prisma.channelInboundEvent.findFirst({ where: { channelId: channel.id, externalEventId: ev.eventId, operation } });
    const stuck = existing?.outcome === 'RECEIVED' && Date.now() - existing.receivedAt.getTime() > STUCK_MS;
    if (!existing || !(existing.outcome === 'FAILED' || stuck)) return { ...base, outcome: 'DUPLICATE', code: existing?.outcome };
    const won = await prisma.channelInboundEvent.updateMany({ where: { id: existing.id, outcome: existing.outcome, attempts: existing.attempts }, data: { outcome: 'RECEIVED', attempts: existing.attempts + 1, receivedAt: new Date() } });
    if (won.count !== 1) return { ...base, outcome: 'DUPLICATE', code: 'IN_PROGRESS' };
    rowId = existing.id;
  }

  try {
    const applied = await apply(channel, principal, ev, correlationId);
    await finalize(rowId, applied);
    // Chegou o pedido: aplica o que esperava por ele (pagamento, cancelamento), em ordem de ocorrência.
    if (ev.type === 'ORDER_CREATED' && applied.outcome === 'APPLIED') await drainDeferred(channel, principal, orderRefOf(ev), correlationId);
    return { ...base, outcome: applied.outcome, code: applied.code };
  } catch (err) {
    await markFailed(rowId, err);
    Logger.error('Falha ao aplicar evento do Integration Gateway', err instanceof Error ? err : new Error(String(err)));
    return { ...base, outcome: 'FAILED', code: 'TRANSIENT_ERROR' };
  }
}

/** Aplica os eventos guardados de um pedido (agora que ele existe), do mais antigo para o mais novo. */
export async function drainDeferred(channel: GatewayChannel, principal: ChannelPrincipal, orderRef: string, correlationId?: string): Promise<number> {
  const rows = await prisma.channelInboundEvent.findMany({
    where: { channelId: channel.id, orderRef, outcome: 'DEFERRED' },
    orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }],
    take: 50,
  });
  let applied = 0;
  for (const row of rows) {
    const won = await prisma.channelInboundEvent.updateMany({ where: { id: row.id, outcome: 'DEFERRED' }, data: { outcome: 'RECEIVED', attempts: row.attempts + 1 } });
    if (won.count !== 1) continue; // outra instância já pegou
    const parsed = normalizedEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      await finalize(row.id, { outcome: 'REJECTED', code: 'STORED_EVENT_INVALID' });
      continue;
    }
    try {
      const result = await apply(channel, principal, parsed.data, correlationId ?? row.correlationId ?? undefined);
      await finalize(row.id, result);
      if (result.outcome !== 'DEFERRED') applied += 1;
    } catch (err) {
      await markFailed(row.id, err);
    }
  }
  return applied;
}

/**
 * Rotina: evento guardado há mais de 24 h cujo pedido nunca chegou vira FAILED e deixa alerta (alguém precisa olhar: o canal diz ter
 * um pagamento ou cancelamento de um pedido que o CÓRTEX nunca recebeu). Idempotente.
 */
export async function sweepDeferred(now = new Date(), limit = 200): Promise<{ expired: number }> {
  const cutoff = new Date(now.getTime() - DEFERRED_MAX_AGE_MS);
  const rows = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
    prisma.channelInboundEvent.findMany({ where: { outcome: 'DEFERRED', receivedAt: { lt: cutoff } }, take: limit })
  );
  let expired = 0;
  for (const row of rows) {
    await runWithRLSContext({ companyId: row.companyId, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const res = await prisma.channelInboundEvent.updateMany({ where: { id: row.id, outcome: 'DEFERRED' }, data: { outcome: 'FAILED', processedAt: now, lastError: 'ORDER_NEVER_ARRIVED' } });
      if (res.count !== 1) return;
      expired += 1;
      await prisma.channelEvent.create({
        data: {
          companyId: row.companyId,
          branchId: row.branchId,
          channelId: row.channelId,
          type: 'INBOUND_EVENT_ORPHAN',
          level: 'WARN',
          message: 'Evento guardado há mais de 24 h: o pedido a que ele se refere nunca chegou ao CÓRTEX. Confira com o canal.',
          correlationId: row.correlationId,
          data: { eventId: row.externalEventId, operation: row.operation, externalOrderId: row.orderRef } as any,
        },
      });
    });
  }
  return { expired };
}
