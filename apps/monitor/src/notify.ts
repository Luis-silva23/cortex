/**
 * Aviso por e-mail, SMS e WhatsApp a partir dos eventos do motor — independente da API e do painel (é o ponto da coisa: a API pode ser justamente o que caiu).
 *   • Cada canal é uma TAREFA própria (`NotificationJob`) gravada no estado: se o processo reinicia, as pendentes continuam; se um canal falha, os outros não são afetados.
 *   • Entrega com retentativas controladas (`retryDelaysSec`, `maxAttempts`) e teto por canal e hora; passou do teto, a tarefa ESPERA (não gasta tentativa).
 *   • Queda CRITICAL → canais críticos (padrão: os três); ATTENTION → só e-mail. Recuperação só vai aos canais que JÁ avisaram da queda (nada de "voltou" sem ter avisado).
 *   • Incidente agrupado sob um pai caído não gera aviso próprio.
 *   • "Enviado" aqui = ACEITO pelo provedor. Não há confirmação de entrega no aparelho (isso exigiria webhook de status do provedor, que este processo não recebe).
 *   • Nada de segredo, e-mail ou número em log: só canal, fase, resultado e motivo curto.
 */
import {
  composeIncidentMessage,
  emailAttempts,
  emailConfig,
  redact,
  sendWithFailover,
  smsAttempts,
  smsConfig,
  toSmsText,
  whatsappAttempts,
  whatsappConfig,
  type AlertChannel,
  type TransportDeps,
  type TransportResult,
} from '../../../packages/shared/utils/alert-channels';
import type { EngineEvent, Incident, MonitorConfig, MonitorState, NotificationJob, TargetConfig } from './types';

export type NotifyOutcome = 'SENT' | 'RETRY' | 'FAILED' | 'SKIPPED' | 'WAITING';

export interface NotifyLogEntry {
  channel: AlertChannel;
  phase: NotificationJob['phase'];
  incident: string;
  outcome: NotifyOutcome;
  reason: string;
  attempt: number;
}

const HOUR = 3_600_000;
const PHASE_OF: Record<EngineEvent['kind'], NotificationJob['phase']> = { OPENED: 'OPEN', ESCALATED: 'ESCALATED', RECOVERED: 'RECOVERED', REMINDER: 'REMINDER' };

export function channelsFor(cfg: MonitorConfig, incident: Incident): AlertChannel[] {
  return incident.severity === 'CRITICAL' ? cfg.notify.criticalChannels : cfg.notify.attentionChannels;
}

/** Cria as tarefas de aviso de um evento (sem enviar nada). Cancela avisos de abertura ainda pendentes quando o incidente já se recuperou. */
export function planJobs(state: MonitorState, ev: EngineEvent, cfg: MonitorConfig, targets: TargetConfig[], now: number, newId: () => string): NotificationJob[] {
  const inc = ev.incident;
  if (inc.groupedUnder) return [];
  const phase = PHASE_OF[ev.kind];
  let channels: AlertChannel[];
  if (phase === 'RECOVERED') {
    // o que ainda não foi enviado perde o sentido; só avisa "recuperado" onde o aviso de queda chegou a ser aceito
    state.pending = state.pending.filter((j) => !(j.incidentId === inc.id && j.phase !== 'RECOVERED'));
    channels = inc.notifiedChannels;
  } else {
    channels = channelsFor(cfg, inc);
  }
  const name = targets.find((t) => t.id === inc.target)?.name ?? inc.target;
  const msg = composeIncidentMessage({
    phase,
    severity: inc.severity === 'CRITICAL' ? 'CRÍTICO' : 'ATENÇÃO',
    target: name,
    type: inc.type,
    detail: phase === 'RECOVERED' ? null : inc.detail,
    since: new Date(inc.startedAt),
    durationMs: phase === 'RECOVERED' && inc.endedAt ? inc.endedAt - inc.startedAt : null,
    source: `monitor externo (${cfg.location})`,
    panelUrl: cfg.panelUrl,
  });
  const jobs: NotificationJob[] = [];
  for (const channel of channels) {
    // não duplica: a mesma fase do mesmo incidente no mesmo canal já pendente
    if (phase !== 'REMINDER' && state.pending.some((j) => j.incidentId === inc.id && j.phase === phase && j.channel === channel)) continue;
    jobs.push({ id: newId(), channel, phase, incidentId: inc.id, subject: msg.subject, text: msg.text, attempts: 0, nextTryAt: now, createdAt: now });
  }
  return jobs;
}

function sentInLastHour(state: MonitorState, channel: AlertChannel, now: number): number {
  const list = (state.sent[channel] ?? []).filter((t) => now - t < HOUR);
  state.sent[channel] = list;
  return list.length;
}

function findIncident(state: MonitorState, id: string): Incident | undefined {
  for (const t of Object.values(state.targets)) {
    for (const inc of Object.values(t.incidents)) if (inc?.id === id) return inc;
  }
  return undefined;
}

/** Envia UMA tarefa pelo canal. `ok` = pelo menos um destinatário aceito pelo provedor. */
export async function deliver(job: NotificationJob, env: NodeJS.ProcessEnv, deps: TransportDeps): Promise<{ ok: boolean; skipped?: string; error?: string; retryable: boolean }> {
  const one = { attemptsPerProvider: 1, sleep: async () => undefined };
  if (job.channel === 'EMAIL') {
    const cfg = emailConfig(env);
    if (!cfg.configured) return { ok: false, skipped: `e-mail não configurado (faltam: ${cfg.missing.join(', ')})`, retryable: false };
    // provedores prontos na ordem configurada (Resend e/ou relé do Apps Script)
    const r = (await sendWithFailover(emailAttempts(env, { subject: job.subject, text: job.text, idempotencyKey: job.id }, deps), one)).result;
    return { ok: r.ok, error: r.error, retryable: r.retryable };
  }
  if (job.channel === 'SMS') {
    const cfg = smsConfig(env);
    if (!cfg.configured) return { ok: false, skipped: `SMS não configurado (faltam: ${cfg.missing.join(', ')})`, retryable: false };
    const text = toSmsText(`${job.subject}\n${job.text}`);
    const rs: TransportResult[] = [];
    for (const to of cfg.to) rs.push((await sendWithFailover(smsAttempts(env, to, text, job.id, deps), one)).result);
    const ok = rs.some((r) => r.ok);
    return { ok, error: ok ? undefined : rs[0]?.error, retryable: rs.some((r) => r.retryable) };
  }
  const cfg = whatsappConfig(env);
  if (!cfg.configured) return { ok: false, skipped: `WhatsApp não configurado (faltam: ${cfg.missing.join(', ')})`, retryable: false };
  const rs: TransportResult[] = [];
  for (const to of cfg.to) {
    rs.push((await sendWithFailover(whatsappAttempts(env, to, job.text, job.id, deps), one)).result);
  }
  const ok = rs.some((r) => r.ok);
  return { ok, error: ok ? undefined : rs[0]?.error, retryable: rs.some((r) => r.retryable) };
}

/** Processa as tarefas vencidas. Muda `state` (pendentes, contagem por hora, canais notificados do incidente) e devolve o registro do que aconteceu. */
export async function processJobs(state: MonitorState, cfg: MonitorConfig, env: NodeJS.ProcessEnv, now: number, deps: TransportDeps = {}): Promise<NotifyLogEntry[]> {
  const log: NotifyLogEntry[] = [];
  const keep: NotificationJob[] = [];
  for (const job of state.pending) {
    if (job.nextTryAt > now) {
      keep.push(job);
      continue;
    }
    const base = { channel: job.channel, phase: job.phase, incident: job.incidentId };
    if (sentInLastHour(state, job.channel, now) >= cfg.notify.maxPerHourPerChannel) {
      keep.push({ ...job, nextTryAt: now + 5 * 60_000 });
      log.push({ ...base, outcome: 'WAITING', reason: 'teto por hora do canal atingido', attempt: job.attempts });
      continue;
    }
    let res: Awaited<ReturnType<typeof deliver>>;
    try {
      res = await deliver(job, env, deps);
    } catch (e) {
      res = { ok: false, error: redact(e instanceof Error ? e.message : e, 120), retryable: true };
    }
    if (res.skipped) {
      log.push({ ...base, outcome: 'SKIPPED', reason: res.skipped, attempt: job.attempts });
      continue; // canal sem configuração: descarta (repetir não adianta); fica registrado
    }
    if (res.ok) {
      (state.sent[job.channel] ??= []).push(now);
      const inc = findIncident(state, job.incidentId);
      if (inc && job.phase !== 'RECOVERED' && !inc.notifiedChannels.includes(job.channel)) inc.notifiedChannels.push(job.channel);
      log.push({ ...base, outcome: 'SENT', reason: 'aceito pelo provedor (entrega no aparelho não é confirmada)', attempt: job.attempts + 1 });
      continue;
    }
    const attempts = job.attempts + 1;
    if (!res.retryable || attempts >= cfg.notify.maxAttempts) {
      log.push({ ...base, outcome: 'FAILED', reason: redact(res.error ?? 'falha sem detalhe', 120), attempt: attempts });
      continue;
    }
    const delays = cfg.notify.retryDelaysSec;
    const wait = delays[Math.min(attempts - 1, delays.length - 1)] * 1000;
    keep.push({ ...job, attempts, nextTryAt: now + wait });
    log.push({ ...base, outcome: 'RETRY', reason: redact(res.error ?? 'falha sem detalhe', 120), attempt: attempts });
  }
  state.pending = keep;
  return log;
}
