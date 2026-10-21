import { prisma, runInTransaction, runWithRLSContext, type PrismaTransactionClient } from '@ln-system/database';
import { openSecret } from '@ln-system/shared/utils/secret-box';
import moduleSettingsService from '../module-settings.service';
import { Logger } from '../logger.service';
import { GatewayTimeoutError, gatewayBreaker, providerRegistry, sanitizeErrorMessage, withTimeout, type ChannelContext, type ChannelProvider } from '../sales-channels/gateway';
import catalogService from '../commerce/catalog.service';
import { commerceError } from '../commerce/errors';
import { ProviderError, type OutboundOrderStatus, type ProviderErrorKind } from './contract';

/**
 * CAIXA DE SAÍDA (Integration Gateway, Fase 3, docs/CORTEX/COMMERCE_API.md §12). Tudo o que o CÓRTEX precisa dizer a um provedor
 * (estoque, preço, catálogo, estado do pedido, entrega) é GRAVADO aqui, na MESMA transação da mudança que o originou, e enviado
 * depois por uma rotina. Consequências que são o ponto do desenho:
 *   - nenhuma chamada externa roda no caminho do PDV, da venda ou da conversão: se o provedor cai, a loja continua;
 *   - o aviso nunca se perde (está no PostgreSQL, a fonte da verdade) e nunca se duplica (`dedupeKey` único por canal);
 *   - o envio tem prazo, espera crescente, disjuntor por canal e prazo máximo na caixa; a chave de idempotência enviada ao provedor
 *     é o id da linha, então repetir um envio incerto (timeout) não duplica o efeito lá;
 *   - falha de um canal só atrasa as linhas dele.
 * Redis não participa: o PostgreSQL é a fila; o BullMQ só dispara a rotina que varre as linhas devidas.
 */
export const OUTBOX_TYPES = ['INVENTORY_SYNC', 'PRICE_SYNC', 'CATALOG_SYNC', 'ORDER_STATUS', 'FULFILLMENT_STATUS'] as const;
export type OutboxType = (typeof OUTBOX_TYPES)[number];

export const MAX_ATTEMPTS = 8;
export const DEADLINE_HOURS = 24;
const STALE_LOCK_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 8_000;
const PAUSE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const RATE_LIMIT_CAP_MS = 60 * 60_000;
const SYNC_CHUNK = 200;

// ---------------------------------------------------------------------------------------------------------------------------
// Política de falha (pura: provada por teste unitário)
// ---------------------------------------------------------------------------------------------------------------------------

/** Espera crescente: 30 s, 1 min, 2 min, 4 min... até 30 min, com variação de ±10% para não sincronizar canais. */
export function backoffMs(attempt: number, rand = Math.random()): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
  return Math.round(base * (0.9 + rand * 0.2));
}

export type FailurePlan =
  | { action: 'RETRY'; kind: ProviderErrorKind; delayMs: number; countsForBreaker: boolean; message: string }
  | { action: 'DEAD'; kind: ProviderErrorKind; reason: 'CLIENT_ERROR' | 'MAX_ATTEMPTS'; countsForBreaker: boolean; message: string }
  | { action: 'AUTH'; kind: 'AUTH'; message: string };

export function classifyFailure(err: unknown): { kind: ProviderErrorKind; retryAfterSec?: number; message: string } {
  if (err instanceof ProviderError) return { kind: err.kind, retryAfterSec: err.retryAfterSec, message: sanitizeErrorMessage(err) };
  if (err instanceof GatewayTimeoutError) return { kind: 'TIMEOUT', message: sanitizeErrorMessage(err) };
  return { kind: 'NETWORK', message: sanitizeErrorMessage(err) };
}

/**
 * Decide o que fazer com uma falha de envio. `attempt` é o número da tentativa que acabou de falhar (1, 2, ...).
 *  AUTH → para e pausa o canal; RATE_LIMIT → respeita Retry-After e NÃO conta para o disjuntor; CLIENT (4xx) → DEAD sem insistir;
 *  SERVER/TIMEOUT/NETWORK → espera crescente e conta para o disjuntor; em qualquer repetição, estourou o limite → DEAD.
 */
export function planFailure(err: unknown, attempt: number, maxAttempts: number, rand = Math.random()): FailurePlan {
  const f = classifyFailure(err);
  if (f.kind === 'AUTH') return { action: 'AUTH', kind: 'AUTH', message: f.message };
  if (f.kind === 'CLIENT') return { action: 'DEAD', kind: 'CLIENT', reason: 'CLIENT_ERROR', countsForBreaker: false, message: f.message };
  const rateLimited = f.kind === 'RATE_LIMIT';
  if (attempt >= maxAttempts) return { action: 'DEAD', kind: f.kind, reason: 'MAX_ATTEMPTS', countsForBreaker: !rateLimited, message: f.message };
  const delayMs = rateLimited && f.retryAfterSec ? Math.min(Math.max(f.retryAfterSec * 1000, 1000), RATE_LIMIT_CAP_MS) : backoffMs(attempt, rand);
  return { action: 'RETRY', kind: f.kind, delayMs, countsForBreaker: !rateLimited, message: f.message };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Enfileirar (dentro da transação de quem muda o estado)
// ---------------------------------------------------------------------------------------------------------------------------

type Client = PrismaTransactionClient | typeof prisma;
type ChannelRef = { id: string; companyId: string; branchId: string | null };
export interface OutboxItem {
  type: OutboxType;
  dedupeKey: string;
  payload: unknown;
  correlationId?: string | null;
}

/** Grava as linhas; as que já existem (mesmo canal + `dedupeKey`) são ignoradas em silêncio. Devolve quantas foram criadas. */
export async function enqueueMany(tx: Client, channel: ChannelRef, items: OutboxItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const deadlineAt = new Date(Date.now() + DEADLINE_HOURS * 3_600_000);
  const res = await (tx as PrismaTransactionClient).channelOutbox.createMany({
    data: items.map((i) => ({
      companyId: channel.companyId,
      branchId: channel.branchId,
      channelId: channel.id,
      type: i.type,
      dedupeKey: i.dedupeKey,
      payload: i.payload as any,
      maxAttempts: MAX_ATTEMPTS,
      deadlineAt,
      correlationId: i.correlationId ?? null,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

type OrderRef = { id: string; companyId: string; branchId: string | null; channelId: string; externalOrderId: string };

async function providerChannel(tx: Client, channelId: string): Promise<{ channel: ChannelRef; provider: ChannelProvider } | null> {
  const channel = await (tx as PrismaTransactionClient).salesChannel.findUnique({ where: { id: channelId }, select: { id: true, companyId: true, branchId: true, provider: true } });
  const provider = providerRegistry.get(channel?.provider);
  return channel && provider ? { channel, provider } : null;
}

/**
 * Avisa o provedor do novo estado do pedido. NÃO faz nada para canal sem provedor (site próprio: o site consulta o CÓRTEX) nem para
 * provedor que não implementa a operação. Chamar dentro da transação que mudou o estado (padrão "caixa de saída").
 */
export async function enqueueOrderStatus(tx: Client, order: OrderRef, status: OutboundOrderStatus, opts: { reason?: string; correlationId?: string } = {}): Promise<number> {
  const target = await providerChannel(tx, order.channelId);
  if (!target?.provider.notifyOrderStatus) return 0;
  return enqueueMany(tx, target.channel, [
    {
      type: 'ORDER_STATUS',
      dedupeKey: `ORDER_STATUS:${order.id}:${status}`,
      payload: { externalOrderId: order.externalOrderId, status, ...(opts.reason ? { reason: opts.reason.slice(0, 300) } : {}) },
      correlationId: opts.correlationId,
    },
  ]);
}

export async function enqueueFulfillment(tx: Client, order: OrderRef, status: string, type: string | null, correlationId?: string): Promise<number> {
  const target = await providerChannel(tx, order.channelId);
  if (!target?.provider.notifyFulfillment) return 0;
  return enqueueMany(tx, target.channel, [
    { type: 'FULFILLMENT_STATUS', dedupeKey: `FULFILLMENT:${order.id}:${status}`, payload: { externalOrderId: order.externalOrderId, status, type }, correlationId },
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Sincronização iniciada por pessoa autorizada (catálogo, preço, estoque). O CÓRTEX é o mestre: só envia, nunca lê de volta.
// ---------------------------------------------------------------------------------------------------------------------------

export type SyncKind = 'INVENTORY' | 'PRICE' | 'CATALOG';
const SYNC_TYPE: Record<SyncKind, OutboxType> = { INVENTORY: 'INVENTORY_SYNC', PRICE: 'PRICE_SYNC', CATALOG: 'CATALOG_SYNC' };
const SYNC_METHOD: Record<SyncKind, 'syncInventory' | 'syncPrices' | 'syncCatalog'> = { INVENTORY: 'syncInventory', PRICE: 'syncPrices', CATALOG: 'syncCatalog' };

const chunk = <T,>(rows: T[], n: number): T[][] => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, i * n + n));

export async function enqueueSync(input: { companyId: string; channelId: string; kind: SyncKind; correlationId?: string }) {
  const channel = await prisma.salesChannel.findFirst({ where: { id: input.channelId, companyId: input.companyId } });
  if (!channel) throw commerceError.notFound('Canal');
  const provider = providerRegistry.get(channel.provider);
  if (!provider || !provider[SYNC_METHOD[input.kind]]) throw commerceError.invalidState('SEM_PROVEDOR');
  if (!channel.branchId) throw commerceError.channelBranchRequired();

  const view = { companyId: channel.companyId, branchId: channel.branchId, channelId: channel.id, channelConfig: (channel.config as Record<string, unknown> | null) ?? {} };
  const items: unknown[] = await catalogService.syncItems(view, input.kind);
  const bucket = Math.floor(Date.now() / 60_000); // o mesmo pedido repetido no mesmo minuto não enfileira duas vezes
  const rows = chunk(items, SYNC_CHUNK).map((part, i) => ({
    type: SYNC_TYPE[input.kind],
    dedupeKey: `${SYNC_TYPE[input.kind]}:${bucket}:${i}`,
    payload: { items: part },
    correlationId: input.correlationId,
  }));
  const created = await enqueueMany(prisma, { id: channel.id, companyId: channel.companyId, branchId: channel.branchId }, rows);
  return { items: items.length, batches: rows.length, enqueued: created };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Enviar (rotina por minuto)
// ---------------------------------------------------------------------------------------------------------------------------

type OutboxRow = Awaited<ReturnType<typeof prisma.channelOutbox.findMany>>[number];

async function logEvent(row: { companyId: string; branchId: string | null; channelId: string; correlationId: string | null }, level: 'INFO' | 'WARN' | 'ERROR', type: string, message: string, data: Record<string, unknown> = {}) {
  await prisma.channelEvent
    .create({ data: { companyId: row.companyId, branchId: row.branchId, channelId: row.channelId, type, level, message: message.slice(0, 500), correlationId: row.correlationId, data: data as any } })
    .catch((err) => Logger.error('Falha ao registrar evento do canal', err instanceof Error ? err : new Error(String(err))));
}

async function claimDue(now: Date, limit: number): Promise<OutboxRow[]> {
  // As colunas são `timestamp` SEM fuso (o Prisma grava em UTC). Em SQL cru o instante vai como texto ISO e é convertido para UTC de forma
  // explícita: passar um `Date` direto faria o Postgres reinterpretar o valor no fuso da sessão (e a linha "devida" nunca venceria).
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
    runInTransaction(async (tx) => {
      const ids = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE channel_outbox o SET status = 'PROCESSING', "lockedAt" = (${nowIso}::timestamptz AT TIME ZONE 'UTC'), attempts = o.attempts + 1, "updatedAt" = (${nowIso}::timestamptz AT TIME ZONE 'UTC')
        WHERE o.id IN (
          SELECT id FROM channel_outbox
          WHERE (status = 'PENDING' AND "nextAttemptAt" <= (${nowIso}::timestamptz AT TIME ZONE 'UTC'))
             OR (status = 'PROCESSING' AND "lockedAt" < (${staleIso}::timestamptz AT TIME ZONE 'UTC'))
          ORDER BY "nextAttemptAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING o.id`;
      return ids.length === 0 ? [] : tx.channelOutbox.findMany({ where: { id: { in: ids.map((r) => r.id) } }, orderBy: { nextAttemptAt: 'asc' } });
    })
  );
}

/** Devolve a linha à fila sem gastar tentativa (canal pausado, disjuntor aberto): a tentativa só conta quando o provedor foi chamado. */
const release = (row: OutboxRow, delayMs: number, now: Date) =>
  prisma.channelOutbox.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { status: 'PENDING', attempts: Math.max(0, row.attempts - 1), nextAttemptAt: new Date(now.getTime() + delayMs), lockedAt: null } });

export type DeliverResult = 'SENT' | 'RETRY' | 'DEAD' | 'PAUSED';

async function deliver(row: OutboxRow, now: Date): Promise<DeliverResult> {
  if (row.deadlineAt <= now) {
    await prisma.channelOutbox.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { status: 'DEAD', lockedAt: null, lastError: 'Prazo máximo na caixa de saída vencido', lastErrorKind: 'DEADLINE' } });
    await logEvent(row, 'WARN', 'OUTBOX_DEAD', `Envio descartado: prazo máximo vencido (${row.type})`, { outboxId: row.id, type: row.type, reason: 'DEADLINE' });
    return 'DEAD';
  }

  const channel = await prisma.salesChannel.findFirst({ where: { id: row.channelId, companyId: row.companyId } });
  const moduleOn = channel ? await moduleSettingsService.isModuleEnabled(channel.companyId, channel.branchId, 'CANAIS') : false;
  // Canal desativado, em erro de credencial ou módulo desligado: pausa. Nada é enviado e o prazo máximo continua valendo.
  if (!channel || !channel.isActive || channel.connectionStatus === 'ERROR' || !moduleOn) {
    await release(row, PAUSE_MS, now);
    return 'PAUSED';
  }
  const provider = providerRegistry.get(channel.provider);
  const method = provider ? OPERATION[row.type as OutboxType] : undefined;
  if (!provider || !method || !(provider as any)[method]) {
    await prisma.channelOutbox.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { status: 'DEAD', lockedAt: null, lastError: 'O provedor não implementa esta operação', lastErrorKind: 'UNSUPPORTED' } });
    await logEvent(row, 'WARN', 'OUTBOX_DEAD', `Envio descartado: o provedor não implementa ${row.type}`, { outboxId: row.id, type: row.type, reason: 'UNSUPPORTED' });
    return 'DEAD';
  }
  if (!gatewayBreaker.canCall(channel.id, now.getTime())) {
    await release(row, 60_000, now);
    return 'PAUSED';
  }

  let credentials: Record<string, string> | null = null;
  if (channel.credentialsEncrypted) {
    try {
      credentials = JSON.parse(openSecret(channel.credentialsEncrypted));
    } catch {
      await release(row, PAUSE_MS, now);
      await logEvent(row, 'ERROR', 'OUTBOX_PAUSED', 'Envio pausado: não foi possível abrir a credencial do canal; cadastre de novo', { outboxId: row.id });
      return 'PAUSED';
    }
  }
  const ctx: ChannelContext = { channelId: channel.id, companyId: channel.companyId, branchId: channel.branchId, provider: provider.key, externalAccountId: channel.externalAccountId, config: (channel.config as Record<string, unknown> | null) ?? null, credentials };
  const opts = { idempotencyKey: row.id, correlationId: row.correlationId ?? undefined };

  try {
    await withTimeout(call(provider, row, ctx, opts), SEND_TIMEOUT_MS);
  } catch (err) {
    const plan = planFailure(err, row.attempts, row.maxAttempts);
    if (plan.action === 'AUTH') {
      // Credencial recusada: o canal vai a ERROR e para (mesma regra do teste de conexão); a linha espera, sem gastar tentativa.
      await prisma.salesChannel.update({ where: { id: channel.id }, data: { connectionStatus: 'ERROR', lastError: plan.message, isActive: false } });
      await release(row, PAUSE_MS, now);
      await logEvent(row, 'ERROR', 'PROVIDER_AUTH_FAILED', `O provedor recusou a credencial: canal em erro e envios pausados (${row.type})`, { outboxId: row.id });
      return 'PAUSED';
    }
    if (plan.countsForBreaker) gatewayBreaker.failure(channel.id, now.getTime());
    if (plan.action === 'DEAD') {
      await prisma.channelOutbox.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { status: 'DEAD', lockedAt: null, lastError: plan.message, lastErrorKind: plan.kind } });
      await logEvent(row, 'WARN', 'OUTBOX_DEAD', `Envio descartado (${plan.reason}): ${row.type} — trate por pessoa autorizada`, { outboxId: row.id, type: row.type, kind: plan.kind, reason: plan.reason });
      return 'DEAD';
    }
    await prisma.channelOutbox.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { status: 'PENDING', lockedAt: null, nextAttemptAt: new Date(now.getTime() + plan.delayMs), lastError: plan.message, lastErrorKind: plan.kind } });
    return 'RETRY';
  }

  gatewayBreaker.success(channel.id);
  await prisma.channelOutbox.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { status: 'SENT', sentAt: now, lockedAt: null, lastError: null, lastErrorKind: null } });
  await prisma.salesChannel.update({ where: { id: channel.id }, data: { lastSyncAt: now } });
  return 'SENT';
}

const OPERATION: Record<OutboxType, 'syncInventory' | 'syncPrices' | 'syncCatalog' | 'notifyOrderStatus' | 'notifyFulfillment'> = {
  INVENTORY_SYNC: 'syncInventory',
  PRICE_SYNC: 'syncPrices',
  CATALOG_SYNC: 'syncCatalog',
  ORDER_STATUS: 'notifyOrderStatus',
  FULFILLMENT_STATUS: 'notifyFulfillment',
};

function call(provider: ChannelProvider, row: OutboxRow, ctx: ChannelContext, opts: { idempotencyKey: string; correlationId?: string }): Promise<void> {
  const payload = row.payload as any;
  switch (row.type as OutboxType) {
    case 'INVENTORY_SYNC':
      return provider.syncInventory!(ctx, payload.items, opts);
    case 'PRICE_SYNC':
      return provider.syncPrices!(ctx, payload.items, opts);
    case 'CATALOG_SYNC':
      return provider.syncCatalog!(ctx, payload.items, opts);
    case 'ORDER_STATUS':
      return provider.notifyOrderStatus!(ctx, payload, opts);
    default:
      return provider.notifyFulfillment!(ctx, payload, opts);
  }
}

/** Rotina por minuto: pega um lote pequeno de linhas devidas (várias instâncias não se atropelam: `SKIP LOCKED`) e envia uma a uma. */
export async function processDue(now = new Date(), limit = 20) {
  const claimed = await claimDue(now, limit);
  const result = { claimed: claimed.length, sent: 0, retried: 0, dead: 0, paused: 0, errors: 0 };
  for (const row of claimed) {
    try {
      const r = await runWithRLSContext({ companyId: row.companyId, userType: 'SUPER_ADMIN', branchId: null }, () => deliver(row, now));
      if (r === 'SENT') result.sent += 1;
      else if (r === 'RETRY') result.retried += 1;
      else if (r === 'DEAD') result.dead += 1;
      else result.paused += 1;
    } catch (err) {
      // Falha NOSSA (banco, bug): a linha fica PROCESSING e é retomada quando a trava vencer; nunca derruba as outras.
      result.errors += 1;
      Logger.error('Falha ao enviar linha da caixa de saída', err instanceof Error ? err : new Error(String(err)));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Administração (pessoa autorizada; a empresa vem do JWT e a RLS isola)
// ---------------------------------------------------------------------------------------------------------------------------

const outboxView = (r: OutboxRow) => ({
  id: r.id,
  type: r.type,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.maxAttempts,
  nextAttemptAt: r.nextAttemptAt,
  deadlineAt: r.deadlineAt,
  sentAt: r.sentAt,
  lastError: r.lastError,
  lastErrorKind: r.lastErrorKind,
  createdAt: r.createdAt,
});

async function requireChannel(companyId: string, channelId: string) {
  const channel = await prisma.salesChannel.findFirst({ where: { id: channelId, companyId }, select: { id: true, companyId: true, branchId: true } });
  if (!channel) throw commerceError.notFound('Canal');
  return channel;
}

export const outboxAdmin = {
  async list(companyId: string, channelId: string, input: { status?: string; limit: number }) {
    await requireChannel(companyId, channelId);
    const status = ['PENDING', 'PROCESSING', 'SENT', 'DEAD', 'CANCELLED'].includes(input.status ?? '') ? (input.status as any) : undefined;
    const [rows, groups, inbound] = await Promise.all([
      prisma.channelOutbox.findMany({ where: { companyId, channelId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: input.limit }),
      prisma.channelOutbox.groupBy({ by: ['status'], where: { companyId, channelId }, _count: { _all: true } }),
      prisma.channelInboundEvent.groupBy({ by: ['outcome'], where: { companyId, channelId, operation: { startsWith: 'GW:' } }, _count: { _all: true } }),
    ]);
    return {
      data: rows.map(outboxView),
      counts: Object.fromEntries(groups.map((g) => [g.status, g._count._all])),
      inboundCounts: Object.fromEntries(inbound.map((g) => [g.outcome, g._count._all])),
    };
  },

  /** Devolve uma linha DEAD (ou PENDING) para nova tentativa imediata, com novo prazo. Só quem a trata (pessoa autorizada) decide. */
  async retry(companyId: string, channelId: string, rowId: string, actorId: string) {
    const channel = await requireChannel(companyId, channelId);
    const now = new Date();
    const res = await prisma.channelOutbox.updateMany({
      where: { id: rowId, channelId, companyId, status: { in: ['DEAD', 'PENDING'] } },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, deadlineAt: new Date(now.getTime() + DEADLINE_HOURS * 3_600_000), lockedAt: null, lastError: null, lastErrorKind: null },
    });
    if (res.count !== 1) throw commerceError.invalidState('NAO_REENVIAVEL');
    await logEvent({ ...channel, channelId, correlationId: null }, 'INFO', 'OUTBOX_RETRY', 'Linha da caixa de saída devolvida para nova tentativa', { outboxId: rowId, actorId });
    return { ok: true };
  },

  async cancel(companyId: string, channelId: string, rowId: string, actorId: string) {
    const channel = await requireChannel(companyId, channelId);
    const res = await prisma.channelOutbox.updateMany({ where: { id: rowId, channelId, companyId, status: { in: ['DEAD', 'PENDING'] } }, data: { status: 'CANCELLED', lockedAt: null } });
    if (res.count !== 1) throw commerceError.invalidState('NAO_CANCELAVEL');
    await logEvent({ ...channel, channelId, correlationId: null }, 'INFO', 'OUTBOX_CANCELLED', 'Linha da caixa de saída cancelada', { outboxId: rowId, actorId });
    return { ok: true };
  },
};
