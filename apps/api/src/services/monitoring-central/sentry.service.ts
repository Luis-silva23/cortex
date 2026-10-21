/**
 * SENTRY — captura OPCIONAL de exceções de aplicação, sem SDK: um cliente mínimo que envia o evento pela API de envelope. Desligado por padrão: sem SENTRY_DSN nada é
 * enviado e nada é cobrado. Segurança e custo:
 *   • MASCARAMENTO antes de sair da máquina: e-mails, documentos (CPF/CNPJ), tokens (JWT/Bearer), URLs com senha, chaves de provedor e caminhos locais (que revelam o
 *     usuário do sistema) saem da mensagem e da pilha; nenhum corpo de requisição, cabeçalho, cookie, usuário ou empresa é enviado — só rota (modelo), método, status e requestId;
 *   • AMOSTRAGEM (SENTRY_SAMPLE_RATE), DEDUPLICAÇÃO por impressão digital (mesmo erro dentro da janela conta 1), TETO por hora/dia (abaixo do plano gratuito) e DISJUNTOR;
 *   • NUNCA atrapalha a operação: fora do caminho da resposta (não aguardado), com teto de 2 s, e qualquer falha do Sentry é engolida e registrada;
 *   • ligar/desligar em tempo de execução (só restringe), estado e últimos erros de entrega visíveis na Central.
 * Limites do plano gratuito mudam: confira a página de preços do provedor antes de ligar (na última consulta: 5 mil erros/mês, 1 usuário). Nunca contrata plano.
 */
import { createHash, randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { getEffective } from './settings.service';
import { recordDelivery, safeError, sentCounts } from './deliveries';

const TIMEOUT_MS = 2_000;
const BREAKER_FAILURES = 5;
const BREAKER_PAUSE_MS = 5 * 60_000;

export interface ParsedDsn {
  key: string;
  host: string;
  projectId: string;
  endpoint: string;
}

/** `https://<chave>@<host>/<projeto>` → destino do envelope. DSN inválido ou sem https devolve null (integração fica desligada). */
export function parseDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn || !dsn.trim()) return null;
  try {
    const u = new URL(dsn.trim());
    const projectId = u.pathname.replace(/^\/+/, '').split('/').pop() ?? '';
    if (u.protocol !== 'https:' || !u.username || !projectId || !/^\d+$/.test(projectId)) return null;
    return { key: u.username, host: u.host, projectId, endpoint: `https://${u.host}/api/${projectId}/envelope/` };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Mascaramento
// ---------------------------------------------------------------------------------------------------------------------------------------------
export function scrubText(value: unknown, max = 500): string {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?/g, '[jwt]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s'"]+/gi, '[url-com-credencial]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[cnpj]')
    .replace(/\b(re|sk|pk|rk)_[A-Za-z0-9_-]{8,}\b/g, '[chave]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[hex]')
    .replace(/\b[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/])*(?=[^\s\\/:*?"<>|]+)/g, '…/')
    .replace(/\/(?:home|Users)\/[^\s/]+\//g, '…/')
    .slice(0, max);
}

/** Pilha sem caminho de máquina: mantém só o trecho relativo ao projeto (src/…, node_modules/…). */
export function scrubStack(stack: string | undefined, maxFrames = 25): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1, maxFrames + 1)
    .map((l) => scrubText(l.trim().replace(/^at\s+/, ''), 240))
    .filter(Boolean);
}

/** Rota como MODELO (`/api/users/:id`), nunca com ids reais, e sem query string. */
export function routeTemplate(route: unknown): string {
  return scrubText(String(route ?? '').split('?')[0], 120).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':id');
}

export interface CaptureContext {
  route?: string;
  method?: string;
  statusCode?: number;
  requestId?: string;
}

export function buildEvent(error: unknown, ctx: CaptureContext, env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level: 'error',
    server_name: 'cortex-api',
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    release: env.SENTRY_RELEASE || undefined,
    exception: { values: [{ type: scrubText(err.name, 80), value: scrubText(err.message), stacktrace: { frames: scrubStack(err.stack).reverse().map((f) => ({ function: f })) } }] },
    tags: {
      route: ctx.route ? routeTemplate(ctx.route) : undefined,
      method: ctx.method ? scrubText(ctx.method, 10) : undefined,
      status: ctx.statusCode !== undefined ? String(ctx.statusCode) : undefined,
      request_id: ctx.requestId ? scrubText(ctx.requestId, 64) : undefined,
    },
  };
}

export function buildEnvelope(event: ReturnType<typeof buildEvent>, dsn: string, now = new Date()): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: now.toISOString(), dsn });
  const item = JSON.stringify({ type: 'event' });
  return `${header}\n${item}\n${JSON.stringify(event)}`;
}

/** Impressão digital do erro (mesma causa = mesma chave): nome + mensagem mascarada + primeiro quadro da pilha. */
export function fingerprint(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error));
  return createHash('sha256').update(`${err.name}|${scrubText(err.message, 200)}|${scrubStack(err.stack, 1)[0] ?? ''}`).digest('hex').slice(0, 24);
}

export type SentryDrop = 'NOT_CONFIGURED' | 'DISABLED' | 'SAMPLED_OUT' | 'DEDUPE' | 'HOUR_CAP' | 'DAY_CAP' | 'BREAKER';

export interface SentryDecisionInput {
  configured: boolean;
  enabled: boolean;
  sampleRate: number;
  random: number;
  lastSameAt: number | null;
  now: number;
  dedupeMinutes: number;
  counts: { hour: number; day: number };
  maxPerHour: number;
  maxPerDay: number;
  breakerOpenUntil: number;
}

/** Decisão PURA de captura (testável): primeiro motivo que descarta o evento. */
export function decideCapture(i: SentryDecisionInput): { send: true } | { send: false; reason: SentryDrop } {
  if (!i.configured) return { send: false, reason: 'NOT_CONFIGURED' };
  if (!i.enabled) return { send: false, reason: 'DISABLED' };
  if (i.breakerOpenUntil > i.now) return { send: false, reason: 'BREAKER' };
  if (i.lastSameAt !== null && i.now - i.lastSameAt < i.dedupeMinutes * 60_000) return { send: false, reason: 'DEDUPE' };
  if (i.random >= i.sampleRate) return { send: false, reason: 'SAMPLED_OUT' };
  if (i.counts.hour >= i.maxPerHour) return { send: false, reason: 'HOUR_CAP' };
  if (i.counts.day >= i.maxPerDay) return { send: false, reason: 'DAY_CAP' };
  return { send: true };
}

const breaker = { failures: 0, openUntil: 0 };
const seen = new Map<string, number>();
const dropped: Record<string, number> = {};
export const sentryRuntime = () => ({ breaker: { ...breaker }, dropped: { ...dropped }, tracked: seen.size });
export function __resetSentryState() {
  breaker.failures = 0;
  breaker.openUntil = 0;
  seen.clear();
  for (const k of Object.keys(dropped)) delete dropped[k];
}

export interface CaptureDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: number;
  random?: () => number;
}

/**
 * Captura uma exceção. NÃO é aguardada pelo chamador (`void captureException(...)`) e NUNCA lança. Devolve o resultado só para teste/diagnóstico.
 */
export async function captureException(error: unknown, ctx: CaptureContext = {}, deps: CaptureDeps = {}): Promise<{ sent: boolean; reason?: SentryDrop | string }> {
  try {
    const env = deps.env ?? process.env;
    const dsn = parseDsn(env.SENTRY_DSN);
    const now = deps.now ?? Date.now();
    if (!dsn) return { sent: false, reason: 'NOT_CONFIGURED' };
    const effective = await getEffective(env);
    const fp = fingerprint(error);
    // limites só são consultados (banco) quando o evento sobreviveu às checagens baratas
    const cheap = decideCapture({
      configured: true,
      enabled: effective.toggles.sentry,
      sampleRate: effective.limits.sentrySampleRate,
      random: (deps.random ?? Math.random)(),
      lastSameAt: seen.get(fp) ?? null,
      now,
      dedupeMinutes: effective.limits.sentryDedupeMinutes,
      counts: { hour: 0, day: 0 },
      maxPerHour: effective.limits.sentryMaxPerHour,
      maxPerDay: effective.limits.sentryMaxPerDay,
      breakerOpenUntil: breaker.openUntil,
    });
    if (!cheap.send) {
      dropped[cheap.reason] = (dropped[cheap.reason] ?? 0) + 1;
      return { sent: false, reason: cheap.reason };
    }
    const counts = await sentCounts('SENTRY', new Date(now));
    if (counts.hour >= effective.limits.sentryMaxPerHour || counts.day >= effective.limits.sentryMaxPerDay) {
      const reason: SentryDrop = counts.hour >= effective.limits.sentryMaxPerHour ? 'HOUR_CAP' : 'DAY_CAP';
      dropped[reason] = (dropped[reason] ?? 0) + 1;
      return { sent: false, reason };
    }
    seen.set(fp, now);
    if (seen.size > 500) for (const [k, t] of seen) if (now - t > 3_600_000) seen.delete(k); // memória limitada

    const event = buildEvent(error, ctx, env, new Date(now));
    try {
      const res = await (deps.fetchImpl ?? fetch)(dsn.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=cortex-api/1.0, sentry_key=${dsn.key}`,
        },
        body: buildEnvelope(event, `https://${dsn.key}@${dsn.host}/${dsn.projectId}`, new Date(now)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      breaker.failures = 0;
      await recordDelivery({ channel: 'SENTRY', status: 'SENT', dedupeKey: fp });
      return { sent: true };
    } catch (sendError) {
      breaker.failures += 1;
      if (breaker.failures >= BREAKER_FAILURES) breaker.openUntil = now + BREAKER_PAUSE_MS;
      const message = safeError(sendError instanceof Error ? sendError.message : sendError);
      await recordDelivery({ channel: 'SENTRY', status: 'FAILED', dedupeKey: fp, error: message });
      logger.warn('Sentry: falha ao enviar evento (a operação não é afetada)', { error: message, failures: breaker.failures });
      return { sent: false, reason: message };
    }
  } catch (unexpected) {
    // jamais propaga: monitorar não pode derrubar a requisição que já falhou por outro motivo
    return { sent: false, reason: safeError(unexpected instanceof Error ? unexpected.message : unexpected) };
  }
}

export function sentryConfigStatus(env: NodeJS.ProcessEnv = process.env) {
  const dsn = parseDsn(env.SENTRY_DSN);
  return {
    configured: dsn !== null,
    host: dsn?.host ?? null,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    invalidDsn: Boolean(env.SENTRY_DSN?.trim()) && dsn === null,
  };
}
