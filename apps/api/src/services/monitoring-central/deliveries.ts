/**
 * Registro das entregas a serviços externos (e-mail de alerta, evento de erro). Serve a três coisas: DEDUPLICAÇÃO (não repetir a mesma mensagem dentro da janela),
 * LIMITES (contar o que já foi enviado na hora/dia/mês) e o painel de CONSUMO. Nunca guarda o conteúdo da mensagem nem segredo: só canal, resultado, chave de
 * deduplicação e o erro já mascarado. Falha ao registrar NUNCA propaga: monitorar não pode derrubar a operação.
 */
import { prisma } from '@ln-system/database';
import { logger } from '../../utils/logger';
import { asPlatform } from './settings.service';

export type DeliveryChannel = 'EMAIL' | 'SENTRY' | 'SMS' | 'WHATSAPP';
export type DeliveryStatus = 'SENT' | 'FAILED' | 'SUPPRESSED';

export interface DeliveryInput {
  channel: DeliveryChannel;
  status: DeliveryStatus;
  dedupeKey?: string | null;
  alertId?: string | null;
  error?: string | null;
}

/** Mascara o que pode ter vazado numa mensagem de erro de provedor (chaves, e-mails, tokens) e limita o tamanho. */
export function safeError(message: unknown, max = 160): string {
  return String(message ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(re|sk|pk)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

export async function recordDelivery(d: DeliveryInput): Promise<void> {
  try {
    await asPlatform(() =>
      prisma.externalDelivery.create({
        data: { channel: d.channel, status: d.status, dedupeKey: d.dedupeKey ?? null, alertId: d.alertId ?? null, error: d.error ? safeError(d.error) : null },
      })
    );
    countsCache.delete(d.channel);
  } catch (error) {
    logger.warn('Falha ao registrar entrega externa (ignorada)', { channel: d.channel, error: safeError(error instanceof Error ? error.message : error) });
  }
}

const startOfUtcMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export interface SentCounts {
  hour: number;
  day: number;
  month: number;
}

const countsCache = new Map<string, { at: number; value: SentCounts }>();
const COUNTS_TTL_MS = 30_000;

/** Entregas ENVIADAS: última hora (janela móvel), dia UTC e mês UTC (o mês do provedor também é de calendário). */
export async function sentCounts(channel: DeliveryChannel, now = new Date()): Promise<SentCounts> {
  const cached = countsCache.get(channel);
  if (cached && Date.now() - cached.at < COUNTS_TTL_MS) return cached.value;
  const count = (since: Date) => prisma.externalDelivery.count({ where: { channel, status: 'SENT', createdAt: { gte: since } } });
  const [hour, day, month] = await asPlatform(() =>
    Promise.all([count(new Date(now.getTime() - 3_600_000)), count(startOfUtcDay(now)), count(startOfUtcMonth(now))])
  );
  const value = { hour, day, month };
  countsCache.set(channel, { at: Date.now(), value });
  return value;
}

/** Instante da última entrega com a mesma chave de deduplicação (e um dos estados dados), ou null. */
export async function lastDeliveryAt(channel: DeliveryChannel, dedupeKey: string, statuses: DeliveryStatus[] = ['SENT']): Promise<Date | null> {
  const row = await asPlatform(() =>
    prisma.externalDelivery.findFirst({ where: { channel, dedupeKey, status: { in: statuses } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  );
  return row?.createdAt ?? null;
}

/** Resumo para a tela de consumo: enviados, falhas e suprimidos nas janelas, mais a última falha conhecida. */
export async function deliverySummary(channel: DeliveryChannel, now = new Date()) {
  const counts = await sentCounts(channel, now);
  const since24h = new Date(now.getTime() - 86_400_000);
  const [failed24h, suppressed24h, lastFailure, lastSent] = await asPlatform(() =>
    Promise.all([
      prisma.externalDelivery.count({ where: { channel, status: 'FAILED', createdAt: { gte: since24h } } }),
      prisma.externalDelivery.count({ where: { channel, status: 'SUPPRESSED', createdAt: { gte: since24h } } }),
      prisma.externalDelivery.findFirst({ where: { channel, status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, error: true } }),
      prisma.externalDelivery.findFirst({ where: { channel, status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
  );
  return { sent: counts, failed24h, suppressed24h, lastFailure, lastSentAt: lastSent?.createdAt ?? null };
}

/** Só para testes. */
export function __resetDeliveryCache() {
  countsCache.clear();
}
