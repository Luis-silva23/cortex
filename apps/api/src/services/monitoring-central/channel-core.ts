/**
 * NÚCLEO COMUM dos canais de notificação externos (SMS, WhatsApp; o e-mail da Resend usa as mesmas funções puras): decisão de envio, disjuntor e o "executor" que junta
 * configuração, limites, deduplicação, tentativas com provedor alternativo e registro. O transporte de cada provedor mora em `@ln-system/shared/utils/alert-channels`
 * (uma implementação só, também usada pelo monitor independente); aqui ficam só as regras que dependem do banco e do ambiente da API.
 *
 * Princípios (os mesmos do e-mail, decisão registrada em docs/CORTEX/ALERTAS_CANAIS.md):
 *   • canal independente: a falha, o limite ou o desligamento de um canal NUNCA impede os outros (cada um tem o seu disjuntor, os seus limites e o seu registro);
 *   • nada é enviado sem configuração AUTORIZADA e sem as declarações explícitas do operador; "não configurado" e "desligado" são estados, não eventos (não gravam nada);
 *   • limites por hora/dia/mês e janela de deduplicação por chave; sem como contar (banco indisponível) NÃO envia: melhor suprimir do que estourar limite sem saber;
 *   • o que é gravado não tem o texto da mensagem nem o número do destinatário: só canal, resultado, chave de deduplicação e o erro já mascarado.
 */
import { logger } from '../../utils/logger';
import { sendWithFailover, type ProviderAttempt, type TransportResult } from '@ln-system/shared/utils/alert-channels';
import { getEffective, type MonitoringLimits } from './settings.service';
import { lastDeliveryAt, recordDelivery, safeError, sentCounts, type DeliveryChannel, type SentCounts } from './deliveries';

export interface ChannelLimits {
  maxPerHour: number;
  maxPerDay: number;
  maxPerMonth: number;
  dedupeMinutes: number;
}

export type SuppressReason = 'DISABLED' | 'NOT_CONFIGURED' | 'DEDUPE' | 'HOUR_CAP' | 'DAY_CAP' | 'MONTH_CAP' | 'BREAKER';

export interface DecisionInput {
  configured: boolean;
  enabled: boolean;
  counts: SentCounts;
  limits: ChannelLimits;
  lastSameKeyAt: Date | null;
  now: Date;
  breakerOpenUntil: number;
  /** Mensagens que este envio vai gastar (uma por destinatário). */
  needed?: number;
}

/** Decisão PURA de envio (testável sem rede): primeiro motivo que impede, na ordem de custo. */
export function decideChannelSend(i: DecisionInput): { send: true } | { send: false; reason: SuppressReason } {
  const need = Math.max(1, i.needed ?? 1);
  if (!i.configured) return { send: false, reason: 'NOT_CONFIGURED' };
  if (!i.enabled) return { send: false, reason: 'DISABLED' };
  if (i.breakerOpenUntil > i.now.getTime()) return { send: false, reason: 'BREAKER' };
  if (i.lastSameKeyAt && i.now.getTime() - i.lastSameKeyAt.getTime() < i.limits.dedupeMinutes * 60_000) return { send: false, reason: 'DEDUPE' };
  if (i.counts.hour + need > i.limits.maxPerHour) return { send: false, reason: 'HOUR_CAP' };
  if (i.counts.day + need > i.limits.maxPerDay) return { send: false, reason: 'DAY_CAP' };
  if (i.counts.month + need > i.limits.maxPerMonth) return { send: false, reason: 'MONTH_CAP' };
  return { send: true };
}

export interface Breaker {
  state: () => { failures: number; openUntil: number };
  fail: (now: number) => void;
  ok: () => void;
  reset: () => void;
  openUntil: () => number;
}

/** Disjuntor em memória (por processo): falhas seguidas pausam novas tentativas, sem martelar o provedor. */
export function createBreaker(failuresToOpen = 3, pauseMs = 15 * 60_000): Breaker {
  const s = { failures: 0, openUntil: 0 };
  return {
    state: () => ({ ...s }),
    fail: (now: number) => {
      s.failures += 1;
      if (s.failures >= failuresToOpen) s.openUntil = now + pauseMs;
    },
    ok: () => {
      s.failures = 0;
    },
    reset: () => {
      s.failures = 0;
      s.openUntil = 0;
    },
    openUntil: () => s.openUntil,
  };
}

/** Limites do canal a partir dos limites efetivos (ambiente restringido pelo Super Admin). */
export function channelLimits(channel: 'EMAIL' | 'SMS' | 'WHATSAPP', l: MonitoringLimits): ChannelLimits {
  if (channel === 'SMS') return { maxPerHour: l.smsMaxPerHour, maxPerDay: l.smsMaxPerDay, maxPerMonth: l.smsMaxPerMonth, dedupeMinutes: l.smsDedupeMinutes };
  if (channel === 'WHATSAPP') return { maxPerHour: l.whatsappMaxPerHour, maxPerDay: l.whatsappMaxPerDay, maxPerMonth: l.whatsappMaxPerMonth, dedupeMinutes: l.whatsappDedupeMinutes };
  return { maxPerHour: l.emailMaxPerHour, maxPerDay: l.emailMaxPerDay, maxPerMonth: l.emailMaxPerMonth, dedupeMinutes: l.emailDedupeMinutes };
}

// Supressões repetidas pelo mesmo motivo não viram uma linha cada: no máximo uma por motivo, chave e hora (senão a própria proteção viraria tempestade de gravações).
const lastSuppressedLog = new Map<string, number>();

export interface RunChannelInput {
  channel: Exclude<DeliveryChannel, 'SENTRY'>;
  configured: boolean;
  enabled: boolean;
  recipients: string[];
  dedupeKey: string;
  alertId?: string | null;
  breaker: Breaker;
  /** Monta as tentativas (provedor principal e alternativos) para UM destinatário. */
  attemptsFor: (recipient: string) => ProviderAttempt[];
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Tentativas por provedor para falha repetível (padrão 2). */
  attemptsPerProvider?: number;
}

export interface RunChannelResult {
  status: 'SENT' | 'FAILED' | 'SUPPRESSED';
  reason?: SuppressReason | string;
  /** Destinatários que o provedor ACEITOU (não é "entregue no aparelho"). */
  accepted: number;
  failed: number;
  /** Provedor que aceitou (quando houve), para o registro operacional. */
  provider?: string;
  /** Teve de usar um provedor alternativo? */
  usedFallback?: boolean;
}

/** Executa um envio num canal respeitando limites, deduplicação, disjuntor e registro. Nunca lança. */
export async function runChannel(input: RunChannelInput): Promise<RunChannelResult> {
  const now = input.now ?? new Date();
  try {
    const effective = await getEffective();
    const toggle = input.channel === 'SMS' ? effective.toggles.smsNotifications : input.channel === 'WHATSAPP' ? effective.toggles.whatsappNotifications : effective.toggles.emailNotifications;
    let counts: SentCounts = { hour: 0, day: 0, month: 0 };
    let lastSameKeyAt: Date | null = null;
    if (input.configured && toggle && input.recipients.length > 0) {
      try {
        [counts, lastSameKeyAt] = await Promise.all([sentCounts(input.channel, now), lastDeliveryAt(input.channel, input.dedupeKey)]);
      } catch (error) {
        logger.warn('Canal de alerta: contagem de envios indisponível; envio suprimido', { channel: input.channel, error: safeError(error instanceof Error ? error.message : error) });
        return { status: 'SUPPRESSED', reason: 'COUNT_UNAVAILABLE', accepted: 0, failed: 0 };
      }
    }
    const decision = decideChannelSend({
      configured: input.configured && input.recipients.length > 0,
      enabled: input.enabled && toggle,
      counts,
      limits: channelLimits(input.channel, effective.limits),
      lastSameKeyAt,
      now,
      breakerOpenUntil: input.breaker.openUntil(),
      needed: input.recipients.length,
    });
    if (!decision.send) {
      if (decision.reason !== 'NOT_CONFIGURED' && decision.reason !== 'DISABLED') {
        const key = `${input.channel}:${decision.reason}:${input.dedupeKey}`;
        if (now.getTime() - (lastSuppressedLog.get(key) ?? 0) > 3_600_000) {
          lastSuppressedLog.set(key, now.getTime());
          await recordDelivery({ channel: input.channel, status: 'SUPPRESSED', dedupeKey: input.dedupeKey, alertId: input.alertId, error: decision.reason });
        }
      }
      return { status: 'SUPPRESSED', reason: decision.reason, accepted: 0, failed: 0 };
    }

    let accepted = 0;
    let failed = 0;
    let provider: string | undefined;
    let usedFallback = false;
    let lastError = '';
    for (const recipient of input.recipients) {
      const attempts = input.attemptsFor(recipient);
      const { result, tried } = await sendWithFailover(attempts, { attemptsPerProvider: input.attemptsPerProvider, sleep: input.sleep });
      const r: TransportResult = result;
      if (r.ok) {
        accepted += 1;
        provider = r.provider;
        usedFallback = usedFallback || (tried.length > 1 && tried[0]?.provider !== r.provider);
        await recordDelivery({ channel: input.channel, status: 'SENT', dedupeKey: input.dedupeKey, alertId: input.alertId });
      } else {
        failed += 1;
        lastError = `${r.provider}: ${r.error ?? 'falha'}`;
        await recordDelivery({ channel: input.channel, status: 'FAILED', dedupeKey: input.dedupeKey, alertId: input.alertId, error: lastError });
      }
    }
    if (accepted > 0) input.breaker.ok();
    else input.breaker.fail(now.getTime());
    if (failed > 0) logger.warn('Canal de alerta: falha ao entregar a pelo menos um destinatário (alerta interno segue funcionando)', { channel: input.channel, accepted, failed, error: lastError });
    return accepted > 0 ? { status: 'SENT', accepted, failed, provider, usedFallback } : { status: 'FAILED', reason: lastError, accepted, failed };
  } catch (error) {
    logger.warn('Canal de alerta falhou de forma inesperada (ignorado)', { channel: input.channel, error: safeError(error instanceof Error ? error.message : error) });
    return { status: 'FAILED', reason: 'UNEXPECTED', accepted: 0, failed: 0 };
  }
}
