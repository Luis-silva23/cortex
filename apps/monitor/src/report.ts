/**
 * Envio dos resultados e incidentes ao painel (API do CÓRTEX) — OPCIONAL e de mão única: o monitor nunca depende dele para medir nem para avisar.
 *   • Corpo JSON assinado com HMAC (mesma assinatura da Commerce API: X-Cortex-Timestamp + X-Cortex-Signature) com segredo exclusivo do monitor.
 *   • A API pode ficar fora por horas (é o caso típico de um incidente): resultados e incidentes esperam numa FILA no estado (`outbox`), com teto; passou do teto, descartam-se
 *     os resultados mais ANTIGOS (os incidentes são poucos e ficam). Ao voltar, o lote vai em ordem, em partes pequenas.
 *   • Incidente é reenviado por identificador: a API faz "upsert", então repetir não duplica alerta.
 */
import { redact } from '../../../packages/shared/utils/alert-channels';
import { signRequest } from '../../../packages/shared/utils/request-signature';
import type { EngineEvent, Incident, MonitorConfig, MonitorState, ProbeResult, TargetState } from './types';

export const MAX_RESULTS_PER_POST = 200;
export const MAX_INCIDENTS_PER_POST = 50;

export interface IngestPayload {
  monitorId: string;
  location: string;
  sentAt: number;
  targets: Array<{ id: string; name: string; status: TargetState['status'] }>;
  results: Array<{ target: string; at: number; ok: boolean; httpStatus: number | null; latencyMs: number; failure: ProbeResult['failure'] }>;
  incidents: Array<Pick<Incident, 'id' | 'target' | 'kind' | 'type' | 'severity' | 'startedAt' | 'endedAt' | 'detail' | 'cause' | 'groupedUnder' | 'notifiedChannels'>>;
}

/** Põe na fila de envio o que aconteceu neste ciclo. Resultados "inconclusivos" (rede do próprio monitor fora) NÃO vão: não dizem nada sobre o alvo. */
export function enqueue(state: MonitorState, results: ProbeResult[], events: EngineEvent[], cfg: Pick<MonitorConfig, 'outboxMax'>): void {
  if (!state.outbox) state.outbox = { results: [], incidents: [] };
  for (const r of results) if (!r.inconclusive) state.outbox.results.push(r);
  if (state.outbox.results.length > cfg.outboxMax) state.outbox.results = state.outbox.results.slice(-cfg.outboxMax);
  for (const ev of events) {
    state.outbox.incidents = state.outbox.incidents.filter((i) => i.id !== ev.incident.id);
    state.outbox.incidents.push(ev.incident);
  }
  if (state.outbox.incidents.length > 500) state.outbox.incidents = state.outbox.incidents.slice(-500);
}

export function buildPayload(state: MonitorState, cfg: MonitorConfig, now: number): IngestPayload {
  const results = state.outbox.results.slice(0, MAX_RESULTS_PER_POST);
  const incidents = state.outbox.incidents.slice(0, MAX_INCIDENTS_PER_POST);
  return {
    monitorId: cfg.monitorId,
    location: cfg.location,
    sentAt: now,
    targets: cfg.targets.map((t) => ({ id: t.id, name: t.name, status: state.targets[t.id]?.status ?? 'UNKNOWN' })),
    results: results.map((r) => ({ target: r.target, at: r.at, ok: r.ok, httpStatus: r.httpStatus, latencyMs: r.latencyMs, failure: r.failure })),
    incidents: incidents.map((i) => ({ id: i.id, target: i.target, kind: i.kind, type: i.type, severity: i.severity, startedAt: i.startedAt, endedAt: i.endedAt, detail: i.detail, cause: i.cause, groupedUnder: i.groupedUnder, notifiedChannels: i.notifiedChannels })),
  };
}

export interface FlushDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface FlushResult {
  attempted: boolean;
  ok: boolean;
  sentResults: number;
  sentIncidents: number;
  error?: string;
}

/** Envia UM lote assinado (quem chama repete no ciclo seguinte). Só remove da fila o que a API aceitou (2xx). */
export async function flush(state: MonitorState, cfg: MonitorConfig, now: number, deps: FlushDeps = {}): Promise<FlushResult> {
  if (!cfg.ingest) return { attempted: false, ok: true, sentResults: 0, sentIncidents: 0 };
  if (state.outbox.results.length === 0 && state.outbox.incidents.length === 0) return { attempted: false, ok: true, sentResults: 0, sentIncidents: 0 };
  const payload = buildPayload(state, cfg, now);
  const body = JSON.stringify(payload);
  const url = new URL(cfg.ingest.url);
  const timestampSec = Math.floor(now / 1000);
  const signature = signRequest(cfg.ingest.secret, { timestampSec, method: 'POST', path: url.pathname + url.search, rawBody: body });
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Cortex-Timestamp': String(timestampSec), 'X-Cortex-Signature': signature, 'User-Agent': 'CortexMonitor/1.0' },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    try {
      await res.body?.cancel();
    } catch {
      /* sem corpo */
    }
    if (res.status < 200 || res.status >= 300) return { attempted: true, ok: false, sentResults: 0, sentIncidents: 0, error: `API respondeu HTTP ${res.status}` };
    state.outbox.results = state.outbox.results.slice(payload.results.length);
    state.outbox.incidents = state.outbox.incidents.slice(payload.incidents.length);
    return { attempted: true, ok: true, sentResults: payload.results.length, sentIncidents: payload.incidents.length };
  } catch (e) {
    return { attempted: true, ok: false, sentResults: 0, sentIncidents: 0, error: redact(e instanceof Error ? e.message : e, 120) };
  }
}
