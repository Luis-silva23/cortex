/**
 * INFRAESTRUTURA (Super Admin): visão consolidada de serviços, dependências, requisições da API e incidentes — LÊ o que a Central já coleta, não coleta nada novo e não cria
 * outro registro de alerta:
 *   • serviços e dependências → `service_health_samples` (API, banco, Redis, filas, servidor, backup e os alvos medidos de FORA pelo monitor independente: `EXT_<ALVO>`);
 *   • requisições da API → `request_logs` (volume, taxa de erro 5xx, média, p95 e distribuição por código HTTP);
 *   • incidentes → `monitoring_alerts` (a MESMA tabela da Central de Alertas; técnico = escopo de plataforma, operacional = empresa/filial/equipamento) — sem duplicar registro.
 * Só aparece o que é realmente monitorado: serviço sem amostra no período não vira linha, e ausência de dado é "sem dado", nunca "100%". Nada aqui traz segredo, URL de alvo
 * ou corpo de resposta. Exclusivo de SUPER_ADMIN (rota em `/monitoring/central/infrastructure`).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@ln-system/database';
import cacheService from '../cache.service';
import { RANGES, type RangeKey } from '../monitoring.service';
import { alertCategory, alertGuidance, alertStatus, isStale, type AlertCategory } from './model';
import { readBackupStatus } from './backup-status';
import { externalMonitorState, SERVICE_PREFIX, staleMinutes } from './external-monitor.service';
import { externalStatus } from './external-status.service';
import { asPlatform, getEffective, rawQuery } from './settings.service';

export type ServiceKind = 'api' | 'dependency' | 'capacity' | 'backup' | 'external';
export type ServiceState = 'NORMAL' | 'ATTENTION' | 'CRITICAL' | 'OFFLINE' | 'NO_DATA';

const LABELS: Record<string, { label: string; kind: ServiceKind }> = {
  API: { label: 'API (requisições reais)', kind: 'api' },
  DATABASE: { label: 'Banco de dados', kind: 'dependency' },
  REDIS: { label: 'Redis', kind: 'dependency' },
  QUEUES: { label: 'Filas', kind: 'dependency' },
  HOST_CPU: { label: 'Servidor · CPU', kind: 'capacity' },
  HOST_MEMORY: { label: 'Servidor · memória', kind: 'capacity' },
  HOST_DISK: { label: 'Servidor · disco', kind: 'capacity' },
  BACKUP: { label: 'Backup', kind: 'backup' },
};
export const INTERNAL_SERVICES = Object.keys(LABELS);

export function describeService(service: string): { label: string; kind: ServiceKind; external: boolean } {
  if (service.startsWith(SERVICE_PREFIX)) return { label: `${service.slice(SERVICE_PREFIX.length).replace(/_/g, ' ').toLowerCase()} (medido de fora)`, kind: 'external', external: true };
  const known = LABELS[service];
  return { label: known?.label ?? service, kind: known?.kind ?? 'dependency', external: false };
}

export const SERVICE_KEY_RE = /^[A-Z0-9_]{2,45}$/;
export const SEVERITIES = ['ATTENTION', 'CRITICAL', 'OFFLINE'] as const;
export const INCIDENT_STATES = ['OPEN', 'RESOLVED'] as const;
export const SCOPES = ['technical', 'operational'] as const;

export interface InfrastructureFilters {
  service?: string;
  severity?: (typeof SEVERITIES)[number];
  state?: (typeof INCIDENT_STATES)[number];
  scope?: (typeof SCOPES)[number];
}

/** Técnico = da plataforma (sem empresa) medido pela Central ou pelo monitor externo; operacional = empresa, filial ou equipamento. */
export function alertScope(a: { companyId: string | null; source: string }): 'technical' | 'operational' {
  return a.companyId === null && (a.source === 'CENTRAL' || a.source === 'EXTERNAL') ? 'technical' : 'operational';
}

/** O alerta pertence ao serviço filtrado? (alvo externo: `EXTERNAL_<ALVO>_*`; internos: pela categoria do alerta) */
export function alertMatchesService(type: string, service: string): boolean {
  // casamento EXATO do tipo (`EXTERNAL_<ALVO>_DOWN|SLOW|ERRORS`): "api" não pode puxar os incidentes de "api_gateway"
  if (service.startsWith(SERVICE_PREFIX)) return type.length > 0 && new RegExp(`^EXTERNAL_${service.slice(SERVICE_PREFIX.length)}_(DOWN|SLOW|ERRORS)$`).test(type);
  const cat: AlertCategory = alertCategory(type);
  const map: Record<string, AlertCategory> = { API: 'API', DATABASE: 'DATABASE', REDIS: 'REDIS', QUEUES: 'QUEUES', HOST_CPU: 'HOST', HOST_MEMORY: 'HOST', HOST_DISK: 'HOST', BACKUP: 'BACKUP' };
  return map[service] === cat;
}

export function serviceState(args: { lastStatus: string | null; lastAt: Date | null; now: Date; intervalMs: number }): ServiceState {
  if (!args.lastStatus || !args.lastAt) return 'NO_DATA';
  // amostra velha demais (coletor parado): não afirma saúde com dado velho
  if (isStale(args.lastAt, args.now, args.intervalMs)) return 'NO_DATA';
  return (['NORMAL', 'ATTENTION', 'CRITICAL', 'OFFLINE'] as const).includes(args.lastStatus as never) ? (args.lastStatus as ServiceState) : 'NO_DATA';
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function httpClasses(rows: Array<{ code: number; count: number }>) {
  const classes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  for (const r of rows) {
    const k = r.code >= 200 && r.code < 300 ? '2xx' : r.code >= 300 && r.code < 400 ? '3xx' : r.code >= 400 && r.code < 500 ? '4xx' : r.code >= 500 && r.code < 600 ? '5xx' : 'other';
    classes[k] += r.count;
  }
  return classes;
}

export async function getInfrastructure(range: RangeKey, filters: InfrastructureFilters = {}, now = new Date()) {
  const key = `monitoring-central:infra:${range}:${filters.service ?? '-'}:${filters.severity ?? '-'}:${filters.state ?? '-'}:${filters.scope ?? '-'}`;
  return cacheService.remember(key, 15, () => compute(range, filters, now));
}

async function compute(range: RangeKey, filters: InfrastructureFilters, now: Date) {
  const { ms, bucketSec } = RANGES[range];
  const since = new Date(now.getTime() - ms);
  const effective = await getEffective();
  const intervalMs = effective.limits.sampleMinutes * 60_000;

  const [perService, buckets, latest, apiTotal, apiBuckets, codes, alerts, openHealth, companies, ext, external, backup] = await Promise.all([
    asPlatform(() =>
      rawQuery<Array<{ service: string; total: bigint; down: bigint; avg: number | null; p95: number | null; max: number | null; pct: number | null }>>(Prisma.sql`
        SELECT service, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'OFFLINE' OR (starts_with(service, ${SERVICE_PREFIX}) AND status <> 'NORMAL')) AS down,
               AVG("latencyMs") AS avg, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95, MAX("latencyMs") AS max, AVG("valuePct") AS pct
        FROM service_health_samples WHERE "sampledAt" >= ${since} AND "sampledAt" <= ${now} AND service <> 'COMPANIES' GROUP BY service`)
    ),
    asPlatform(() =>
      rawQuery<Array<{ bucket: bigint; service: string; total: bigint; down: bigint; avg: number | null; max: number | null; pct: number | null }>>(Prisma.sql`
        SELECT (floor(extract(epoch from "sampledAt") / ${bucketSec}::float8) * ${bucketSec}::float8)::bigint AS bucket, service, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'OFFLINE' OR (starts_with(service, ${SERVICE_PREFIX}) AND status <> 'NORMAL')) AS down,
               AVG("latencyMs") AS avg, MAX("latencyMs") AS max, AVG("valuePct") AS pct
        FROM service_health_samples WHERE "sampledAt" >= ${since} AND "sampledAt" <= ${now} AND service <> 'COMPANIES' GROUP BY 1, 2 ORDER BY 1`)
    ),
    asPlatform(() => prisma.serviceHealthSample.findMany({ where: { sampledAt: { gte: since }, service: { not: 'COMPANIES' } }, orderBy: { sampledAt: 'desc' }, distinct: ['service'] })),
    asPlatform(() =>
      rawQuery<Array<{ total: bigint; errors: bigint; avg: number | null; p95: number | null }>>(Prisma.sql`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "statusCode" >= 500) AS errors, AVG("durationMs") AS avg, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
        FROM request_logs WHERE "createdAt" >= ${since} AND "createdAt" <= ${now}`)
    ),
    asPlatform(() =>
      rawQuery<Array<{ bucket: bigint; total: bigint; errors: bigint; avg: number | null; p95: number | null }>>(Prisma.sql`
        SELECT (floor(extract(epoch from "createdAt") / ${bucketSec}::float8) * ${bucketSec}::float8)::bigint AS bucket, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE "statusCode" >= 500) AS errors, AVG("durationMs") AS avg, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
        FROM request_logs WHERE "createdAt" >= ${since} AND "createdAt" <= ${now} GROUP BY 1 ORDER BY 1`)
    ),
    asPlatform(() =>
      rawQuery<Array<{ code: number; count: bigint }>>(Prisma.sql`
        SELECT "statusCode" AS code, COUNT(*) AS count FROM request_logs WHERE "createdAt" >= ${since} AND "createdAt" <= ${now} GROUP BY 1 ORDER BY 2 DESC LIMIT 40`)
    ),
    asPlatform(() => prisma.monitoringAlert.findMany({ where: { OR: [{ endedAt: null }, { startedAt: { gte: since } }] }, orderBy: [{ startedAt: 'desc' }], take: 300 })),
    asPlatform(() => prisma.healthIncident.count({ where: { endedAt: null } })),
    asPlatform(() => prisma.company.findMany({ select: { id: true, name: true } })),
    externalMonitorState(now),
    externalStatus(process.env, now).catch(() => null),
    readBackupStatus(process.env, now),
  ]);

  // ---------- serviços (só os que têm amostra no período) ----------
  const lastBy = new Map(latest.map((s) => [s.service, s]));
  const services = perService
    .map((r) => {
      const meta = describeService(r.service);
      const total = Number(r.total);
      const down = Number(r.down);
      const last = lastBy.get(r.service);
      return {
        key: r.service,
        label: meta.label,
        kind: meta.kind,
        external: meta.external,
        state: serviceState({ lastStatus: last?.status ?? null, lastAt: last?.sampledAt ?? null, now, intervalMs: meta.external ? Math.max(intervalMs, 120_000) : intervalMs }),
        lastCheckAt: last?.sampledAt.toISOString() ?? null,
        lastLatencyMs: num(last?.latencyMs ?? null),
        lastValuePct: round(num(last?.valuePct ?? null)),
        samples: total,
        failures: down,
        availabilityPct: total > 0 ? Math.round(((total - down) / total) * 10_000) / 100 : null,
        avgMs: round(num(r.avg)),
        p95Ms: round(num(r.p95)),
        maxMs: round(num(r.max)),
        avgPct: round(num(r.pct)),
        detail: last?.detail ?? null,
        source: meta.external ? ('external-monitor' as const) : ('central-sampler' as const),
      };
    })
    .filter((s) => !filters.service || s.key === filters.service)
    .sort((a, b) => Number(a.external) - Number(b.external) || a.key.localeCompare(b.key));

  // ---------- séries no tempo (linha por padrão na tela; barras como alternativa) ----------
  const latency: Record<string, Array<{ t: number; avgMs: number | null; maxMs: number | null }>> = {};
  const availabilitySeries: Record<string, Array<{ t: number; availabilityPct: number }>> = {};
  const capacity: Record<string, Array<{ t: number; pct: number | null }>> = {};
  for (const r of buckets) {
    if (filters.service && r.service !== filters.service) continue;
    const meta = describeService(r.service);
    const t = Number(r.bucket) * 1000;
    const total = Number(r.total);
    if (meta.kind === 'capacity') (capacity[r.service] ??= []).push({ t, pct: round(num(r.pct)) });
    else if (r.avg !== null) (latency[r.service] ??= []).push({ t, avgMs: round(num(r.avg)), maxMs: round(num(r.max)) });
    (availabilitySeries[r.service] ??= []).push({ t, availabilityPct: Math.round(((total - Number(r.down)) / total) * 10_000) / 100 });
  }
  const apiSeries = apiBuckets.map((r) => {
    const total = Number(r.total);
    const errors = Number(r.errors);
    return { t: Number(r.bucket) * 1000, requests: total, errors, errorPct: total > 0 ? Math.round((errors / total) * 1000) / 10 : null, avgMs: round(num(r.avg)), p95Ms: round(num(r.p95), 0) };
  });
  const at = apiTotal[0];
  const requests = Number(at?.total ?? 0);
  const errors = Number(at?.errors ?? 0);
  const codeRows = codes.map((c) => ({ code: Number(c.code), count: Number(c.count) }));

  // ---------- incidentes (alertas da Central: uma tabela só) ----------
  const names = new Map(companies.map((c) => [c.id, c.name]));
  const all = alerts.map((a) => {
    const scope = alertScope(a);
    const end = a.endedAt ?? now;
    return {
      id: a.id,
      scope,
      type: a.type,
      category: alertCategory(a.type),
      severity: a.severity,
      status: alertStatus(a),
      detail: a.detail,
      guidance: scope === 'technical' ? alertGuidance(a.type) : null,
      source: a.source,
      companyId: a.companyId,
      companyName: a.companyId ? (names.get(a.companyId) ?? null) : null,
      branchId: a.branchId,
      startedAt: a.startedAt.toISOString(),
      endedAt: a.endedAt?.toISOString() ?? null,
      durationMs: Math.max(0, end.getTime() - a.startedAt.getTime()),
      occurrences: a.occurrences,
      recovery: a.endedAt ? (a.resolvedBy ? ('MANUAL' as const) : ('AUTOMATIC' as const)) : null,
    };
  });
  const filtered = all.filter(
    (i) =>
      (!filters.scope || i.scope === filters.scope) &&
      (!filters.severity || i.severity === filters.severity) &&
      (!filters.state || (filters.state === 'OPEN' ? i.endedAt === null : i.endedAt !== null)) &&
      (!filters.service || alertMatchesService(i.type, filters.service))
  );
  const open = all.filter((i) => i.endedAt === null);
  const tally = (scope: 'technical' | 'operational') => {
    const rows = open.filter((i) => i.scope === scope);
    return { open: rows.length, bySeverity: { OFFLINE: rows.filter((r) => r.severity === 'OFFLINE').length, CRITICAL: rows.filter((r) => r.severity === 'CRITICAL').length, ATTENTION: rows.filter((r) => r.severity === 'ATTENTION').length } };
  };

  const internalLast = latest.filter((s) => !s.service.startsWith(SERVICE_PREFIX)).reduce<Date | null>((acc, s) => (!acc || s.sampledAt > acc ? s.sampledAt : acc), null);
  return {
    generatedAt: now.toISOString(),
    range,
    bucketSeconds: bucketSec,
    filters,
    collection: {
      sampling: effective.toggles.sampling,
      sampleIntervalMinutes: effective.limits.sampleMinutes,
      lastSampleAt: internalLast?.toISOString() ?? null,
      stale: isStale(internalLast, now, intervalMs),
    },
    externalMonitor: {
      enabled: ext.enabled,
      everReported: ext.everReported,
      lastReportAt: ext.lastReportAt?.toISOString() ?? null,
      ageMinutes: ext.ageMinutes,
      stale: ext.stale,
      staleAfterMinutes: staleMinutes(),
      state: !ext.enabled ? 'DISABLED' : !ext.everReported ? 'NEVER_REPORTED' : ext.stale ? 'STALE' : 'ACTIVE',
      note: !ext.enabled
        ? 'Entrada do monitor externo desligada (MONITOR_INGEST_SECRET não definido). Sem monitor externo, NÃO há medição vista de fora da infraestrutura.'
        : !ext.everReported
          ? 'Entrada ligada, mas nenhum resultado chegou ainda: o monitor externo não foi implantado ou não está alcançando a API.'
          : ext.stale
            ? 'O monitor externo parou de relatar: a visão de fora está desatualizada.'
            : 'Monitor externo relatando.',
    },
    services,
    series: { latency, availability: availabilitySeries, capacity, api: apiSeries },
    api: {
      requests,
      errors,
      errorPct: requests > 0 ? Math.round((errors / requests) * 1000) / 10 : null,
      avgMs: requests > 0 ? round(num(at?.avg ?? null)) : null,
      p95Ms: requests > 0 && at?.p95 != null ? Math.round(Number(at.p95)) : null,
      definition: 'Requisições reais registradas pela própria API (request_logs); erro = HTTP 5xx. Não inclui o que nunca chegou à API (DNS, rede, API fora do ar) — para isso existe o monitor externo.',
    },
    // `top` = os códigos mais frequentes; `serverErrors` = os 5xx em destaque (um 500 raro não pode sumir atrás de milhares de 200/401)
    http: { total: requests, classes: httpClasses(codeRows), top: codeRows.slice(0, 8), serverErrors: codeRows.filter((c) => c.code >= 500 && c.code < 600).slice(0, 6) },
    dependencies: {
      backup,
      channels: external ? { email: pickChannel(external.resend), sms: pickChannel(external.sms), whatsapp: pickChannel(external.whatsapp), sentry: pickChannel(external.sentry) } : null,
    },
    alerts: { technical: tally('technical'), operational: { ...tally('operational'), healthIncidentsOpen: openHealth } },
    incidents: filtered.slice(0, 100),
    incidentsTruncated: filtered.length > 100,
  };
}

/** Só o necessário da integração (estado, pendências, consumo): nunca chave, token, número ou e-mail. */
function pickChannel(c: unknown) {
  const x = (c ?? {}) as { state?: string; missing?: string[]; consumption?: unknown; enabled?: boolean };
  return { state: x.state ?? 'UNKNOWN', enabled: x.enabled ?? null, missing: x.missing ?? [], consumption: x.consumption ?? null };
}
