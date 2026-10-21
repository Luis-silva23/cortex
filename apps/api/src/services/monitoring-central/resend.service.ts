/**
 * RESEND — provedor OPCIONAL de e-mail (alertas de incidente e notificações operacionais). Só envia com configuração AUTORIZADA e domínio remetente VALIDADO:
 *   RESEND_API_KEY, ALERT_EMAIL_FROM (endereço no domínio verificado), ALERT_EMAIL_TO (lista de operadores) e RESEND_DOMAIN_VERIFIED=true (declaração explícita de que o
 *   domínio foi validado no painel do provedor). Faltou qualquer uma: NÃO envia nada e a central de alertas interna segue normal.
 * Proteções: desligável em tempo de execução, deduplicação por chave, limite por hora/dia/mês (abaixo do plano gratuito, nunca acima do ambiente), disjuntor após
 * falhas seguidas e teto de tempo na chamada. Nunca contrata plano nem autoriza excedente: no limite, SUPRIME e registra. Não guarda o conteúdo das mensagens.
 * Nada aqui é chamado no caminho de uma requisição de usuário: só jobs e ações explícitas do Super Admin.
 */
import { createHash } from 'crypto';
import { logger } from '../../utils/logger';
import { getEffective, type MonitoringLimits } from './settings.service';
import { lastDeliveryAt, recordDelivery, safeError, sentCounts, type SentCounts } from './deliveries';

const RESEND_URL = 'https://api.resend.com';
const TIMEOUT_MS = 5_000;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 15 * 60_000;

export interface ResendConfig {
  configured: boolean;
  missing: string[];
  from: string | null;
  to: string[];
  domain: string | null;
}

export function resendConfig(env: NodeJS.ProcessEnv = process.env): ResendConfig {
  const present = (k: string) => typeof env[k] === 'string' && env[k]!.trim().length > 0;
  const missing: string[] = [];
  if (!present('RESEND_API_KEY')) missing.push('RESEND_API_KEY');
  if (!present('ALERT_EMAIL_FROM')) missing.push('ALERT_EMAIL_FROM');
  if (!present('ALERT_EMAIL_TO')) missing.push('ALERT_EMAIL_TO');
  if (env.RESEND_DOMAIN_VERIFIED?.trim().toLowerCase() !== 'true') missing.push('RESEND_DOMAIN_VERIFIED=true');
  const from = present('ALERT_EMAIL_FROM') ? env.ALERT_EMAIL_FROM!.trim() : null;
  const domain = from ? (/@([^>\s]+)>?$/.exec(from)?.[1] ?? null) : null;
  const to = present('ALERT_EMAIL_TO') ? env.ALERT_EMAIL_TO!.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { configured: missing.length === 0, missing, from, to, domain };
}

export type SuppressReason = 'DISABLED' | 'NOT_CONFIGURED' | 'DEDUPE' | 'HOUR_CAP' | 'DAY_CAP' | 'MONTH_CAP' | 'BREAKER';

export interface DecisionInput {
  configured: boolean;
  enabled: boolean;
  counts: SentCounts;
  limits: Pick<MonitoringLimits, 'emailMaxPerHour' | 'emailMaxPerDay' | 'emailMaxPerMonth' | 'emailDedupeMinutes'>;
  lastSameKeyAt: Date | null;
  now: Date;
  breakerOpenUntil: number;
}

/** Decisão PURA de envio (testável sem rede): primeiro motivo que impede, na ordem de custo. */
export function decideSend(i: DecisionInput): { send: true } | { send: false; reason: SuppressReason } {
  if (!i.configured) return { send: false, reason: 'NOT_CONFIGURED' };
  if (!i.enabled) return { send: false, reason: 'DISABLED' };
  if (i.breakerOpenUntil > i.now.getTime()) return { send: false, reason: 'BREAKER' };
  if (i.lastSameKeyAt && i.now.getTime() - i.lastSameKeyAt.getTime() < i.limits.emailDedupeMinutes * 60_000) return { send: false, reason: 'DEDUPE' };
  if (i.counts.hour >= i.limits.emailMaxPerHour) return { send: false, reason: 'HOUR_CAP' };
  if (i.counts.day >= i.limits.emailMaxPerDay) return { send: false, reason: 'DAY_CAP' };
  if (i.counts.month >= i.limits.emailMaxPerMonth) return { send: false, reason: 'MONTH_CAP' };
  return { send: true };
}

// Disjuntor em memória (por processo): falhas seguidas pausam novas tentativas por BREAKER_PAUSE_MS, sem martelar o provedor.
const breaker = { failures: 0, openUntil: 0 };
export const breakerState = () => ({ ...breaker });
export function __resetResendBreaker() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

// Supressões repetidas pelo mesmo motivo não viram uma linha cada: no máximo uma por motivo e hora (senão a própria proteção viraria tempestade de gravações).
const lastSuppressedLog = new Map<string, number>();

export interface SendEmailInput {
  subject: string;
  text: string;
  html?: string;
  dedupeKey: string;
  alertId?: string | null;
  /** Destinatários; sem isto, a lista de operadores ALERT_EMAIL_TO. */
  to?: string[];
}

export interface SendEmailResult {
  status: 'SENT' | 'FAILED' | 'SUPPRESSED';
  reason?: SuppressReason | string;
}

export interface SendDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export async function sendEmail(input: SendEmailInput, deps: SendDeps = {}): Promise<SendEmailResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const cfg = resendConfig(env);
  const effective = await getEffective(env);
  let counts: SentCounts = { hour: 0, day: 0, month: 0 };
  let lastSameKeyAt: Date | null = null;
  if (cfg.configured && effective.toggles.emailNotifications) {
    try {
      [counts, lastSameKeyAt] = await Promise.all([sentCounts('EMAIL', now), lastDeliveryAt('EMAIL', input.dedupeKey)]);
    } catch (error) {
      // sem como contar (banco indisponível): NÃO envia — melhor suprimir que estourar limite sem saber
      logger.warn('Resend: contagem de envios indisponível; envio suprimido', { error: safeError(error instanceof Error ? error.message : error) });
      return { status: 'SUPPRESSED', reason: 'COUNT_UNAVAILABLE' };
    }
  }
  const decision = decideSend({
    configured: cfg.configured,
    enabled: effective.toggles.emailNotifications,
    counts,
    limits: effective.limits,
    lastSameKeyAt,
    now,
    breakerOpenUntil: breaker.openUntil,
  });
  if (!decision.send) {
    // "não configurado" e "desligado" são estados, não eventos: não gravam nada. Limites, repetição e disjuntor deixam rastro (no máximo 1 por motivo/hora).
    if (decision.reason !== 'NOT_CONFIGURED' && decision.reason !== 'DISABLED') {
      const key = `${decision.reason}:${input.dedupeKey}`;
      if (now.getTime() - (lastSuppressedLog.get(key) ?? 0) > 3_600_000) {
        lastSuppressedLog.set(key, now.getTime());
        await recordDelivery({ channel: 'EMAIL', status: 'SUPPRESSED', dedupeKey: input.dedupeKey, alertId: input.alertId, error: decision.reason });
      }
    }
    return { status: 'SUPPRESSED', reason: decision.reason };
  }

  const recipients = input.to && input.to.length > 0 ? input.to : cfg.to;
  const idempotency = createHash('sha256').update(`${input.dedupeKey}:${Math.floor(now.getTime() / 3_600_000)}`).digest('hex').slice(0, 48);
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${RESEND_URL}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotency },
      body: JSON.stringify({ from: cfg.from, to: recipients, subject: input.subject, text: input.text, ...(input.html ? { html: input.html } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = safeError(((await res.json()) as { message?: string }).message ?? '');
      } catch {
        /* corpo sem JSON: fica só o status */
      }
      throw new Error(`http_${res.status}${detail ? `: ${detail}` : ''}`);
    }
    breaker.failures = 0;
    await recordDelivery({ channel: 'EMAIL', status: 'SENT', dedupeKey: input.dedupeKey, alertId: input.alertId });
    return { status: 'SENT' };
  } catch (error) {
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_FAILURES) breaker.openUntil = now.getTime() + BREAKER_PAUSE_MS;
    const message = safeError(error instanceof Error ? error.message : error);
    await recordDelivery({ channel: 'EMAIL', status: 'FAILED', dedupeKey: input.dedupeKey, alertId: input.alertId, error: message });
    logger.warn('Resend: falha ao entregar e-mail (alerta interno segue funcionando)', { error: message, failures: breaker.failures });
    return { status: 'FAILED', reason: message };
  }
}

/**
 * Verificação OPCIONAL e somente-leitura do domínio remetente no provedor (GET /domains: não envia e-mail e não tem custo). Só roda por ação explícita do Super Admin.
 * Não grava nada e não altera o ambiente: quem declara RESEND_DOMAIN_VERIFIED continua sendo o operador.
 */
export async function checkResendDomain(deps: SendDeps = {}): Promise<{ checked: boolean; domain: string | null; domainStatus: string | null; message: string }> {
  const env = deps.env ?? process.env;
  const cfg = resendConfig(env);
  if (!env.RESEND_API_KEY?.trim() || !cfg.domain) return { checked: false, domain: cfg.domain, domainStatus: null, message: 'Chave do provedor ou endereço remetente ausentes: nada a verificar.' };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${RESEND_URL}/domains`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { checked: false, domain: cfg.domain, domainStatus: null, message: `O provedor respondeu http_${res.status}.` };
    const body = (await res.json()) as { data?: Array<{ name?: string; status?: string }> };
    const found = (body.data ?? []).find((d) => d.name?.toLowerCase() === cfg.domain!.toLowerCase());
    if (!found) return { checked: true, domain: cfg.domain, domainStatus: null, message: 'O domínio do remetente não está cadastrado nesta conta do provedor.' };
    return { checked: true, domain: cfg.domain, domainStatus: found.status ?? null, message: found.status === 'verified' ? 'Domínio verificado no provedor.' : `Domínio no provedor com estado "${found.status}".` };
  } catch (error) {
    return { checked: false, domain: cfg.domain, domainStatus: null, message: safeError(error instanceof Error ? error.message : error) };
  }
}
