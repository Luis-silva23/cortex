/**
 * ENTRADA do monitor independente (apps/monitor) na Central de Monitoramento. O monitor roda FORA da API e do painel e já avisa por conta própria (e-mail/SMS/WhatsApp);
 * aqui a API só REGISTRA o que ele mediu, para o Super Admin ver tudo num lugar só:
 *   • resultados → `service_health_samples` com serviço `EXT_<ALVO>` (latência e disponibilidade medidas de fora; só novos, sem duplicar em reenvio);
 *   • incidentes → `monitoring_alerts` com origem EXTERNAL pelo MESMO mecanismo de alertas (um aberto por tipo; recuperação encerra) — SEM notificar de novo.
 * Segurança: assinatura HMAC com segredo exclusivo (`MONITOR_INGEST_SECRET`, ≥ 32 caracteres, só variável de ambiente), corpo ≤ 256 KB validado campo a campo (nada do corpo vira SQL,
 * caminho ou comando), relógio dos resultados limitado, e reenvio de incidente antigo NÃO reabre alerta já encerrado. Sem o segredo configurado, a entrada fica DESLIGADA.
 */
import { prisma } from '@ln-system/database';
import { z } from 'zod';
import monitoringService, { type AlertCondition } from '../monitoring.service';
import { asPlatform } from './settings.service';

export const INGEST_SECRET_MIN = 32;
const DAY = 86_400_000;
const FUTURE_SKEW_MS = 5 * 60_000;
export const SERVICE_PREFIX = 'EXT_';

export function ingestSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.MONITOR_INGEST_SECRET?.trim();
  return s && s.length >= INGEST_SECRET_MIN ? s : null;
}

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/);
const ms = z.number().int().nonnegative().max(32_503_680_000_000);
const incidentSchema = z.object({
  id: z.string().min(8).max(64),
  target: id,
  kind: z.enum(['DOWN', 'SLOW', 'ERRORS']),
  type: z.string().regex(/^EXTERNAL_[A-Z0-9_]{1,60}_(DOWN|SLOW|ERRORS)$/),
  severity: z.enum(['ATTENTION', 'CRITICAL']),
  startedAt: ms,
  endedAt: ms.nullable(),
  detail: z.string().max(500),
  cause: z.string().max(200).nullable(),
  groupedUnder: id.nullable(),
  notifiedChannels: z.array(z.enum(['EMAIL', 'SMS', 'WHATSAPP'])).max(3),
});

export const ingestSchema = z.object({
  monitorId: id,
  location: z.string().max(80),
  sentAt: ms,
  targets: z.array(z.object({ id, name: z.string().max(80), status: z.enum(['UNKNOWN', 'UP', 'DEGRADED', 'DOWN']) })).max(50),
  results: z.array(z.object({ target: id, at: ms, ok: z.boolean(), httpStatus: z.number().int().min(100).max(599).nullable(), latencyMs: z.number().int().min(0).max(600_000), failure: z.enum(['http', 'timeout', 'network', 'content']).nullable() })).max(200),
  incidents: z.array(incidentSchema).max(50),
});
export type IngestPayload = z.infer<typeof ingestSchema>;

export const serviceOf = (target: string) => `${SERVICE_PREFIX}${target.toUpperCase().replace(/-/g, '_')}`;

export interface IngestResult {
  samples: number;
  skippedSamples: number;
  incidents: Record<string, number>;
  staleIncidents: number;
}

export async function ingest(payload: IngestPayload, now: Date = new Date()): Promise<IngestResult> {
  const t = now.getTime();
  const lowest = t - 7 * DAY;
  const highest = t + FUTURE_SKEW_MS;

  // ---- resultados: só os novos por alvo (reenvio não duplica) e com relógio plausível ----
  const targets = [...new Set(payload.results.map((r) => r.target))];
  const latest = new Map<string, number>();
  if (targets.length) {
    const rows = await asPlatform(() => prisma.serviceHealthSample.groupBy({ by: ['service'], where: { service: { in: targets.map(serviceOf) } }, _max: { sampledAt: true } }));
    for (const r of rows) if (r._max.sampledAt) latest.set(r.service, r._max.sampledAt.getTime());
  }
  const fresh = payload.results
    .filter((r) => r.at >= lowest && r.at <= highest && r.at > (latest.get(serviceOf(r.target)) ?? 0))
    .sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const data = fresh
    .filter((r) => {
      const k = `${r.target}:${r.at}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({
      sampledAt: new Date(r.at),
      service: serviceOf(r.target),
      status: r.ok ? 'NORMAL' : 'CRITICAL',
      latencyMs: r.latencyMs,
      valuePct: null as number | null,
      detail: r.ok ? null : `${r.failure ?? 'falha'}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ''} · medido por ${payload.location}`.slice(0, 200),
    }));
  if (data.length) await asPlatform(() => prisma.serviceHealthSample.createMany({ data }));

  // ---- incidentes: pelo mesmo mecanismo de alertas, sem notificar de novo ----
  const outcomes: Record<string, number> = {};
  let stale = 0;
  for (const inc of [...payload.incidents].sort((a, b) => a.startedAt - b.startedAt)) {
    if (inc.startedAt > highest) continue;
    const key = { companyId: null, branchId: null, deviceId: null, type: inc.type };
    if (!inc.endedAt) {
      // reenvio atrasado de um incidente que já foi encerrado não pode reabri-lo
      const last = await asPlatform(() => prisma.monitoringAlert.findFirst({ where: key, orderBy: { startedAt: 'desc' }, select: { endedAt: true } }));
      if (last?.endedAt && last.endedAt.getTime() >= inc.startedAt) {
        stale++;
        continue;
      }
    }
    const cond: AlertCondition = {
      source: 'EXTERNAL',
      ...key,
      metric: 'externalProbe',
      value: null,
      threshold: null,
      status: inc.endedAt ? 'NORMAL' : inc.severity,
      detail: `${inc.groupedUnder ? `(consequência de ${inc.groupedUnder}) ` : ''}${inc.detail}${inc.cause ? ` — ${inc.cause}` : ''} · medido por ${payload.location}`.slice(0, 300),
    };
    const outcome = await asPlatform(() => monitoringService.applyAlert(cond, new Date(inc.endedAt ?? t)));
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { samples: data.length, skippedSamples: payload.results.length - data.length, incidents: outcomes, staleIncidents: stale };
}

export interface ExternalMonitorState {
  /** O segredo de ingestão está configurado (a entrada está LIGADA)? */
  enabled: boolean;
  /** Alguma vez chegou resultado do monitor externo? */
  everReported: boolean;
  lastReportAt: Date | null;
  ageMinutes: number | null;
  /** Sem relato recente: o painel NÃO sabe como o sistema está visto de fora. */
  stale: boolean;
}

export const staleMinutes = (env: NodeJS.ProcessEnv = process.env) => Math.max(2, Math.min(1440, Number(env.MONITOR_STALE_MINUTES) || 10));

export async function externalMonitorState(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<ExternalMonitorState> {
  const last = await asPlatform(() => prisma.serviceHealthSample.findFirst({ where: { service: { startsWith: SERVICE_PREFIX } }, orderBy: { sampledAt: 'desc' }, select: { sampledAt: true } }));
  const lastReportAt = last?.sampledAt ?? null;
  const ageMinutes = lastReportAt ? Math.max(0, Math.round((now.getTime() - lastReportAt.getTime()) / 60_000)) : null;
  return { enabled: ingestSecret(env) !== null, everReported: lastReportAt !== null, lastReportAt, ageMinutes, stale: ageMinutes !== null && ageMinutes >= staleMinutes(env) };
}
