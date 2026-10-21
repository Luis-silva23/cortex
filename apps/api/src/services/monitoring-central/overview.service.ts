/**
 * LEITURAS da Central de Monitoramento (Super Admin): visão executiva, séries históricas, comparação entre empresas e o detalhe de UMA empresa. Só LÊ — dados reais
 * (request_logs, service_health_samples, companies/licenças/usuários, canais, alertas, backups). Cada indicador volta com a sua DEFINIÇÃO (model.ts) e o que for estimativa ou falta
 * de dado é dito: nada é arredondado para 100% por falta de informação. Agregações são feitas no banco (GROUP BY / PERCENTILE_CONT) e a visão pesada é guardada em cache curto.
 * Isolamento: este serviço só é alcançado pelas rotas `/monitoring/central/*` (exclusivas de SUPER_ADMIN); as consultas por empresa filtram `companyId` explicitamente.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@ln-system/database';
import cacheService from '../cache.service';
import monitoringService, { RANGES, type RangeKey } from '../monitoring.service';
import { asPlatform, getEffective, rawQuery } from './settings.service';
import { readBackupStatus } from './backup-status';
import {
  INDICATOR_DEFINITIONS,
  alertCategory,
  alertStatus,
  availability,
  classifyIntegrations,
  companyLifecycle,
  integrationSummary,
  isStale,
  monthlyCounts,
  type CompanyLifecycle,
  type IntegrationInputs,
  type IntegrationItem,
} from './model';

export const MODULE_ROUTE_PREFIXES: Record<string, string[]> = {
  ESTOQUE: ['/api/products', '/api/categories', '/api/stock', '/api/inventory', '/api/damage', '/api/transfers'],
  COMPRAS: ['/api/suppliers', '/api/purchase-orders', '/api/supplier-returns'],
  VENDAS: ['/api/sales', '/api/payments', '/api/cash-register', '/api/customers', '/api/discount-rules', '/api/discount-events', '/api/partners'],
  FINANCEIRO: ['/api/financial', '/api/receivables', '/api/employee-agreements', '/api/agreement-companies', '/api/installment-policies'],
  FISCAL: ['/api/fiscal'],
  OFICINA: ['/api/service-orders', '/api/quotes', '/api/motorcycles', '/api/mechanics', '/api/warranties', '/api/commission-rules'],
  POS_VENDA: ['/api/revisions', '/api/follow-ups', '/api/appointments'],
  CANAIS: ['/api/sales-channels'],
};
export const ALL_MODULES = Object.keys(MODULE_ROUTE_PREFIXES);

export const isRange = (r: unknown): r is RangeKey => typeof r === 'string' && r in RANGES;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Empresas: ciclo de vida e integrações (consultas agregadas, uma por tabela — nunca por empresa)
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function lifecycleMap(): Promise<Map<string, { name: string; isActive: boolean; createdAt: Date; lifecycle: CompanyLifecycle }>> {
  const [companies, licenses, logins] = await asPlatform(() =>
    Promise.all([
      prisma.company.findMany({ select: { id: true, name: true, isActive: true, createdAt: true } }),
      prisma.license.groupBy({ by: ['companyId'], where: { status: 'ACTIVE' } }),
      prisma.user.groupBy({ by: ['companyId'], where: { companyId: { not: null }, lastLoginAt: { not: null } } }),
    ])
  );
  const withLicense = new Set(licenses.map((l) => l.companyId));
  const withLogin = new Set(logins.map((l) => l.companyId as string));
  return new Map(
    companies.map((c) => [
      c.id,
      { name: c.name, isActive: c.isActive, createdAt: c.createdAt, lifecycle: companyLifecycle({ isActive: c.isActive, hasActiveLicense: withLicense.has(c.id), hasEverLoggedIn: withLogin.has(c.id) }) },
    ])
  );
}

export async function companiesSnapshot() {
  const map = await lifecycleMap();
  const all = [...map.values()];
  return {
    total: all.length,
    active: all.filter((c) => c.lifecycle === 'ACTIVE').length,
    onboarding: all.filter((c) => c.lifecycle === 'ONBOARDING').length,
    suspended: all.filter((c) => c.lifecycle === 'SUSPENDED').length,
  };
}

/** Entradas de integração das empresas ATIVAS (ou só de `companyIds`): canais, caixa de saída esgotada em 24 h, fiscal e provedor de pagamento. */
export async function loadIntegrationInputs(companyIds?: string[]): Promise<Map<string, IntegrationInputs>> {
  const since24h = new Date(Date.now() - 86_400_000);
  const scope = companyIds ? { companyId: { in: companyIds } } : {};
  const [companies, channels, dead, fiscal, payments] = await asPlatform(() =>
    Promise.all([
      prisma.company.findMany({ where: { isActive: true, ...(companyIds ? { id: { in: companyIds } } : {}) }, select: { id: true } }),
      prisma.salesChannel.findMany({ where: scope, select: { id: true, companyId: true, displayName: true, provider: true, isActive: true, connectionStatus: true, lastSyncAt: true } }),
      prisma.channelOutbox.groupBy({ by: ['channelId'], where: { ...scope, status: 'DEAD', updatedAt: { gte: since24h } }, _count: { _all: true } }),
      prisma.fiscalConfig.findMany({ where: scope, select: { companyId: true, nfceEnabled: true, nfeEnabled: true, certificatePath: true } }),
      prisma.paymentSetting.findMany({ where: { ...scope, OR: [{ cardProvider: { not: null } }, { pixProvider: { not: null } }] }, select: { companyId: true, cardProvider: true, pixProvider: true } }),
    ])
  );
  const deadBy = new Map(dead.map((d) => [d.channelId, d._count._all]));
  const out = new Map<string, IntegrationInputs>();
  for (const c of companies) out.set(c.id, { channels: [], fiscal: { branchesConfigured: 0, fiscalEnabled: 0, withCertificate: 0 }, automaticPaymentProvider: false });
  for (const ch of channels) {
    out.get(ch.companyId)?.channels.push({
      id: ch.id,
      name: ch.displayName,
      provider: ch.provider,
      isActive: ch.isActive,
      connectionStatus: ch.connectionStatus,
      lastSyncAt: ch.lastSyncAt,
      deadOutbox24h: deadBy.get(ch.id) ?? 0,
    });
  }
  for (const f of fiscal) {
    const e = out.get(f.companyId);
    if (!e) continue;
    e.fiscal.branchesConfigured++;
    if (f.nfceEnabled || f.nfeEnabled) {
      e.fiscal.fiscalEnabled++;
      if (f.certificatePath) e.fiscal.withCertificate++;
    }
  }
  for (const p of payments) {
    const auto = [p.cardProvider, p.pixProvider].some((v) => v && v.trim().toUpperCase() !== 'MANUAL');
    if (auto && out.has(p.companyId)) out.get(p.companyId)!.automaticPaymentProvider = true;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Séries (agregação no banco)
// ---------------------------------------------------------------------------------------------------------------------------------------------
interface ApiSeriesOpts {
  since: Date;
  until: Date;
  bucketSec: number;
  companyId?: string;
  module?: string;
}

function requestFilters({ since, until, companyId, module }: ApiSeriesOpts) {
  const conds: Prisma.Sql[] = [Prisma.sql`"createdAt" >= ${since}`, Prisma.sql`"createdAt" <= ${until}`];
  if (companyId) conds.push(Prisma.sql`"companyId" = ${companyId}`);
  if (module && MODULE_ROUTE_PREFIXES[module]) conds.push(Prisma.sql`route LIKE ANY (${MODULE_ROUTE_PREFIXES[module].map((p) => `${p}%`)}::text[])`);
  return Prisma.join(conds, ' AND ');
}

/** Latência p95 e erros 5xx por balde de tempo (request_logs). Balde sem requisição não existe na saída: a tela interrompe a linha (lacuna), não inventa zero. */
export async function apiSeries(opts: ApiSeriesOpts) {
  const rows = await rawQuery<Array<{ bucket: bigint; total: bigint; errors: bigint; p95: number | null }>>(Prisma.sql`
    SELECT (floor(extract(epoch from "createdAt") / ${opts.bucketSec}::float8) * ${opts.bucketSec}::float8)::bigint AS bucket,
           COUNT(*) AS total, COUNT(*) FILTER (WHERE "statusCode" >= 500) AS errors,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
    FROM request_logs WHERE ${requestFilters(opts)} GROUP BY 1 ORDER BY 1`);
  return rows.map((r) => {
    const total = Number(r.total);
    const errors = Number(r.errors);
    return { t: Number(r.bucket) * 1000, requests: total, errors, p95Ms: r.p95 === null ? null : Math.round(Number(r.p95)), errorPct: total > 0 ? Math.round((errors / total) * 1000) / 10 : null };
  });
}

async function apiTotals(opts: ApiSeriesOpts) {
  const [row] = await rawQuery<Array<{ total: bigint; errors: bigint; p95: number | null; users: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "statusCode" >= 500) AS errors,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95, COUNT(DISTINCT "userId") AS users
    FROM request_logs WHERE ${requestFilters(opts)}`);
  const total = Number(row?.total ?? 0);
  const errors = Number(row?.errors ?? 0);
  return { requests: total, errors, p95Ms: total > 0 && row?.p95 != null ? Math.round(Number(row.p95)) : null, errorPct: total > 0 ? Math.round((errors / total) * 1000) / 10 : null, activeUsers: Number(row?.users ?? 0) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Visão executiva
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function getOverview(range: RangeKey, now = new Date()) {
  return cacheService.remember(`monitoring-central:overview:${range}`, 15, () => computeOverview(range, now));
}

const emptySev = () => ({ OFFLINE: 0, CRITICAL: 0, ATTENTION: 0 });

async function computeOverview(range: RangeKey, now: Date) {
  const { ms, bucketSec } = RANGES[range];
  const since = new Date(now.getTime() - ms);
  const effective = await getEffective();
  const intervalMs = effective.limits.sampleMinutes * 60_000;
  const [grouped, latest, api, openAlerts, recentAlerts, incidents, central, lifecycle, integrations, backup, companyNames] = await Promise.all([
    asPlatform(() => prisma.serviceHealthSample.groupBy({ by: ['service', 'status'], where: { sampledAt: { gte: since }, service: { in: ['DATABASE', 'REDIS', 'QUEUES', 'API'] } }, _count: { _all: true } })),
    asPlatform(() => prisma.serviceHealthSample.findMany({ where: { sampledAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }, orderBy: { sampledAt: 'desc' }, distinct: ['service'] })),
    asPlatform(() => apiTotals({ since, until: now, bucketSec })),
    asPlatform(() => prisma.monitoringAlert.findMany({ where: { endedAt: null }, select: { id: true, severity: true, type: true, companyId: true, handling: true }, take: 2000 })),
    asPlatform(() => prisma.monitoringAlert.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: 'desc' }, take: 20 })),
    asPlatform(() => prisma.healthIncident.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: 'desc' }, take: 20 })),
    monitoringService.centralHealth().catch(() => null),
    lifecycleMap(),
    loadIntegrationInputs(),
    readBackupStatus(process.env, now),
    asPlatform(() => prisma.company.findMany({ select: { id: true, name: true } })),
  ]);

  // disponibilidade por serviço = amostras sem OFFLINE ÷ amostras coletadas (lacunas ficam de fora e baixam a cobertura)
  const expected = Math.max(1, Math.floor(ms / intervalMs));
  const perService: Record<string, ReturnType<typeof availability>> = {};
  const all: Array<{ status: string }> = [];
  for (const service of ['DATABASE', 'REDIS', 'QUEUES', 'API']) {
    const rows = grouped.filter((g) => g.service === service);
    const samples = rows.flatMap((g) => Array.from({ length: g._count._all }, () => ({ status: g.status })));
    perService[service] = availability(samples, service === 'API' ? 0 : expected);
    all.push(...samples);
  }
  const overall = availability(all, 0);
  const lastSampleAt = latest.reduce<Date | null>((acc, s) => (!acc || s.sampledAt > acc ? s.sampledAt : acc), null);
  const hostLatest = (service: string) => num(latest.find((s) => s.service === service)?.valuePct ?? null);

  const sev = emptySev();
  const byCategory: Record<string, number> = {};
  let unhandled = 0;
  for (const a of openAlerts) {
    if (a.severity in sev) sev[a.severity as keyof typeof sev]++;
    byCategory[alertCategory(a.type)] = (byCategory[alertCategory(a.type)] ?? 0) + 1;
    if (a.handling === 'OPEN') unhandled++;
  }

  // integrações: soma de todas as empresas ativas; "sem verificadas" = empresas cujo percentual não pode ser calculado
  const agg = { healthy: 0, degraded: 0, error: 0, notVerified: 0, notConfigured: 0, disabled: 0 };
  let companiesWithoutVerified = 0;
  for (const inputs of integrations.values()) {
    const s = integrationSummary(classifyIntegrations(inputs));
    agg.healthy += s.healthy;
    agg.degraded += s.degraded;
    agg.error += s.error;
    agg.notVerified += s.notVerified;
    agg.notConfigured += s.notConfigured;
    agg.disabled += s.disabled;
    if (s.verified === 0) companiesWithoutVerified++;
  }
  const verified = agg.healthy + agg.degraded + agg.error;

  const names = new Map(companyNames.map((c) => [c.id, c.name]));
  const all2 = [...lifecycle.values()];
  return {
    generatedAt: now.toISOString(),
    range,
    definitions: INDICATOR_DEFINITIONS,
    freshness: { lastSampleAt: lastSampleAt?.toISOString() ?? null, stale: isStale(lastSampleAt, now, intervalMs), sampleIntervalMinutes: effective.limits.sampleMinutes, sampling: effective.toggles.sampling },
    availability: { overall, perService },
    api: { ...api, requestsDefinition: INDICATOR_DEFINITIONS.apiLatency },
    companies: {
      total: all2.length,
      active: all2.filter((c) => c.lifecycle === 'ACTIVE').length,
      onboarding: all2.filter((c) => c.lifecycle === 'ONBOARDING').length,
      suspended: all2.filter((c) => c.lifecycle === 'SUSPENDED').length,
    },
    integrations: { ...agg, verified, healthPct: verified === 0 ? null : Math.round(((agg.healthy + 0.5 * agg.degraded) / verified) * 1000) / 10, companiesWithoutVerified, companiesTotal: integrations.size },
    alerts: { open: openAlerts.length, unhandled, bySeverity: sev, byCategory },
    infra: {
      source: 'live' as const,
      database: central ? { status: central.database.status, latencyMs: central.database.latencyMs } : null,
      redis: central ? { status: central.redis.status, latencyMs: central.redis.latencyMs, memoryMb: central.redis.memoryMb } : null,
      queues: central ? central.queues : null,
      host: { cpuPct: hostLatest('HOST_CPU'), memPct: hostLatest('HOST_MEMORY'), diskPct: hostLatest('HOST_DISK'), note: 'Servidor onde a API roda (última amostra coletada); em ambiente local é a máquina de desenvolvimento.' },
    },
    backup,
    incidents: {
      alerts: recentAlerts.map((a) => ({ id: a.id, type: a.type, category: alertCategory(a.type), severity: a.severity, status: alertStatus(a), detail: a.detail, companyId: a.companyId, companyName: a.companyId ? (names.get(a.companyId) ?? null) : null, startedAt: a.startedAt, endedAt: a.endedAt, occurrences: a.occurrences })),
      health: incidents.map((i) => ({ id: i.id, component: i.component, status: i.status, detail: i.detail, companyId: i.companyId, companyName: names.get(i.companyId) ?? null, startedAt: i.startedAt, endedAt: i.endedAt })),
    },
    environment: { local: process.env.NODE_ENV !== 'production', note: process.env.NODE_ENV !== 'production' ? 'Ambiente local/não produção: estes números descrevem a máquina de desenvolvimento, não um serviço publicado.' : null },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Séries da plataforma
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function getSeries(range: RangeKey, now = new Date()) {
  return cacheService.remember(`monitoring-central:series:${range}`, 30, () => computeSeries(range, now));
}

async function computeSeries(range: RangeKey, now: Date) {
  const { ms, bucketSec } = RANGES[range];
  const since = new Date(now.getTime() - ms);
  const sampleRows = await asPlatform(() =>
    rawQuery<Array<{ bucket: bigint; service: string; total: bigint; down: bigint; avg: number | null; max: number | null }>>(Prisma.sql`
      SELECT (floor(extract(epoch from "sampledAt") / ${bucketSec}::float8) * ${bucketSec}::float8)::bigint AS bucket, service,
             COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'OFFLINE') AS down, AVG("valuePct") AS avg, MAX("valuePct") AS max
      FROM service_health_samples WHERE "sampledAt" >= ${since} AND "sampledAt" <= ${now} GROUP BY 1, 2 ORDER BY 1`)
  );
  const byBucket = new Map<number, { total: number; down: number }>();
  const host: Record<string, Array<{ t: number; avg: number | null; max: number | null }>> = { HOST_CPU: [], HOST_MEMORY: [], HOST_DISK: [] };
  const perService: Record<string, Array<{ t: number; availabilityPct: number }>> = { DATABASE: [], REDIS: [], QUEUES: [], API: [] };
  for (const r of sampleRows) {
    const t = Number(r.bucket) * 1000;
    const total = Number(r.total);
    const down = Number(r.down);
    if (r.service in perService) {
      perService[r.service].push({ t, availabilityPct: Math.round(((total - down) / total) * 10_000) / 100 });
      const acc = byBucket.get(t) ?? { total: 0, down: 0 };
      byBucket.set(t, { total: acc.total + total, down: acc.down + down });
    } else if (r.service in host) {
      host[r.service].push({ t, avg: round1(num(r.avg)), max: round1(num(r.max)) });
    }
  }
  const overall = [...byBucket.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, availabilityPct: Math.round(((v.total - v.down) / v.total) * 10_000) / 100 }));
  const api = await asPlatform(() => apiSeries({ since, until: now, bucketSec }));

  // empresas: novas por mês (MEDIDO: companies.createdAt) e ativas por dia (só a partir do início da coleta diária)
  const [created, companySamples] = await asPlatform(() =>
    Promise.all([
      prisma.company.findMany({ select: { createdAt: true } }),
      prisma.serviceHealthSample.findMany({ where: { service: 'COMPANIES' }, orderBy: { sampledAt: 'asc' }, select: { sampledAt: true, detail: true }, take: 400 }),
    ])
  );
  const activeDaily = companySamples
    .map((s) => {
      try {
        const d = JSON.parse(s.detail ?? '{}') as { active?: number; total?: number; onboarding?: number };
        return { t: s.sampledAt.getTime(), active: d.active ?? null, onboarding: d.onboarding ?? null, total: d.total ?? null };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const sampleTimes = (await asPlatform(() => prisma.serviceHealthSample.aggregate({ _min: { sampledAt: true } })))._min.sampledAt;

  return {
    generatedAt: now.toISOString(),
    range,
    bucketSeconds: bucketSec,
    availability: { overall, perService },
    api,
    host,
    companies: {
      newPerMonth: monthlyCounts(created.map((c) => c.createdAt)),
      activeDaily,
      coverage: { collectionStartedAt: sampleTimes?.toISOString() ?? null, note: 'A série de empresas ativas por dia só existe a partir do início da coleta; antes disso o histórico de ativação não foi guardado.' },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Comparação entre empresas
// ---------------------------------------------------------------------------------------------------------------------------------------------
export interface CompanyListParams {
  range: RangeKey;
  q?: string;
  lifecycle?: CompanyLifecycle;
  severity?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

const SORTABLE = ['name', 'requests', 'errorPct', 'p95Ms', 'integrationHealthPct', 'openAlerts', 'lastActivityAt', 'branches', 'users'] as const;

export async function listCompanies(params: CompanyListParams, now = new Date()) {
  const { ms } = RANGES[params.range];
  const since = new Date(now.getTime() - ms);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const page = Math.max(params.page ?? 1, 1);
  const q = params.q?.trim().toLowerCase();

  const [life, usage, activity, branches, users, disabled, alerts, integrations] = await Promise.all([
    lifecycleMap(),
    asPlatform(() =>
      rawQuery<Array<{ companyId: string; total: bigint; errors: bigint; p95: number | null }>>(Prisma.sql`
        SELECT "companyId", COUNT(*) AS total, COUNT(*) FILTER (WHERE "statusCode" >= 500) AS errors, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
        FROM request_logs WHERE "companyId" IS NOT NULL AND "createdAt" >= ${since} AND "createdAt" <= ${now} GROUP BY "companyId"`)
    ),
    asPlatform(() => rawQuery<Array<{ companyId: string; last: Date }>>(Prisma.sql`SELECT "companyId", MAX("createdAt") AS last FROM request_logs WHERE "companyId" IS NOT NULL GROUP BY "companyId"`)),
    asPlatform(() => prisma.branch.groupBy({ by: ['companyId'], where: { isActive: true }, _count: { _all: true } })),
    asPlatform(() => prisma.user.groupBy({ by: ['companyId'], where: { companyId: { not: null }, isActive: true }, _count: { _all: true } })),
    asPlatform(() => prisma.companyModuleSetting.groupBy({ by: ['companyId'], where: { isEnabled: false, branchId: null }, _count: { _all: true } })),
    asPlatform(() => prisma.monitoringAlert.findMany({ where: { endedAt: null, companyId: { not: null } }, select: { companyId: true, severity: true } })),
    loadIntegrationInputs(),
  ]);
  const usageBy = new Map(usage.map((u) => [u.companyId, u]));
  const lastBy = new Map(activity.map((a) => [a.companyId, a.last]));
  const branchBy = new Map(branches.map((b) => [b.companyId, b._count._all]));
  const userBy = new Map(users.map((u) => [u.companyId as string, u._count._all]));
  const disabledBy = new Map(disabled.map((d) => [d.companyId, d._count._all]));
  const alertsBy = new Map<string, ReturnType<typeof emptySev>>();
  for (const a of alerts) {
    const s = alertsBy.get(a.companyId as string) ?? emptySev();
    if (a.severity in s) s[a.severity as keyof typeof s]++;
    alertsBy.set(a.companyId as string, s);
  }

  let items = [...life.entries()].map(([id, c]) => {
    const u = usageBy.get(id);
    const requests = u ? Number(u.total) : 0;
    const errors = u ? Number(u.errors) : 0;
    const summary = integrationSummary(classifyIntegrations(integrations.get(id) ?? { channels: [], fiscal: { branchesConfigured: 0, fiscalEnabled: 0, withCertificate: 0 }, automaticPaymentProvider: false }));
    const sev = alertsBy.get(id) ?? emptySev();
    return {
      id,
      name: c.name,
      lifecycle: c.lifecycle,
      isActive: c.isActive,
      createdAt: c.createdAt,
      branches: branchBy.get(id) ?? 0,
      users: userBy.get(id) ?? 0,
      modulesEnabled: ALL_MODULES.length - (disabledBy.get(id) ?? 0),
      modulesTotal: ALL_MODULES.length,
      requests,
      errors,
      errorPct: requests > 0 ? Math.round((errors / requests) * 1000) / 10 : null,
      p95Ms: u?.p95 != null ? Math.round(Number(u.p95)) : null,
      integrationHealthPct: summary.healthPct,
      integrations: { verified: summary.verified, notConfigured: summary.notConfigured, notVerified: summary.notVerified, error: summary.error, degraded: summary.degraded },
      openAlerts: sev,
      openAlertsTotal: sev.OFFLINE + sev.CRITICAL + sev.ATTENTION,
      lastActivityAt: lastBy.get(id) ?? null,
    };
  });
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q));
  if (params.lifecycle) items = items.filter((i) => i.lifecycle === params.lifecycle);
  if (params.severity) items = items.filter((i) => (params.severity === 'ANY' ? i.openAlertsTotal > 0 : (i.openAlerts[params.severity as keyof ReturnType<typeof emptySev>] ?? 0) > 0));

  const sort = (SORTABLE as readonly string[]).includes(params.sort ?? '') ? (params.sort as string) : 'name';
  const dir = params.dir === 'desc' ? -1 : 1;
  const val = (i: (typeof items)[number]): number | string | null => (sort === 'openAlerts' ? i.openAlertsTotal : sort === 'lastActivityAt' ? (i.lastActivityAt ? i.lastActivityAt.getTime() : null) : ((i as Record<string, unknown>)[sort] as number | string | null));
  items.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1; // sem dado vai para o fim, nunca para o topo
    if (y === null) return -1;
    return (typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)) * dir || a.name.localeCompare(b.name);
  });
  const total = items.length;
  return { range: params.range, generatedAt: now.toISOString(), total, page, limit, items: items.slice((page - 1) * limit, page * limit), definitions: { integrationHealth: INDICATOR_DEFINITIONS.integrationHealth, companies: INDICATOR_DEFINITIONS.companies } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Detalhe de UMA empresa
// ---------------------------------------------------------------------------------------------------------------------------------------------
export interface CompanyDetailParams {
  range: RangeKey;
  module?: string;
  severity?: string;
}

export async function companyDetail(companyId: string, params: CompanyDetailParams, now = new Date()) {
  const company = await asPlatform(() =>
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isActive: true, createdAt: true, city: true, state: true } })
  );
  if (!company) return null;
  const { ms, bucketSec } = RANGES[params.range];
  const since = new Date(now.getTime() - ms);
  const module = params.module && MODULE_ROUTE_PREFIXES[params.module] ? params.module : undefined;
  const base = { since, until: now, bucketSec, companyId, module };

  const [life, branches, usersByType, moduleSettings, integrationMap, alerts, incidents, series, totals, lastActivity, lastLogin, sales, serviceOrders, integrationLogs, fiscalByStatus, paymentsRejected, health] = await Promise.all([
    lifecycleMap(),
    asPlatform(() => prisma.branch.findMany({ where: { companyId }, select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } })),
    asPlatform(() => prisma.user.groupBy({ by: ['userType'], where: { companyId, isActive: true }, _count: { _all: true } })),
    asPlatform(() => prisma.companyModuleSetting.findMany({ where: { companyId, branchId: null }, select: { module: true, isEnabled: true, disabledAt: true } })),
    loadIntegrationInputs([companyId]),
    asPlatform(() =>
      prisma.monitoringAlert.findMany({ where: { companyId, ...(params.severity && params.severity !== 'ANY' ? { severity: params.severity } : {}) }, orderBy: [{ endedAt: { sort: 'desc', nulls: 'first' } }, { startedAt: 'desc' }], take: 50 })
    ),
    asPlatform(() => prisma.healthIncident.findMany({ where: { companyId, startedAt: { gte: since } }, orderBy: { startedAt: 'desc' }, take: 30 })),
    asPlatform(() => apiSeries(base)),
    asPlatform(() => apiTotals(base)),
    asPlatform(() => rawQuery<Array<{ last: Date | null }>>(Prisma.sql`SELECT MAX("createdAt") AS last FROM request_logs WHERE "companyId" = ${companyId}`)),
    asPlatform(() => prisma.user.aggregate({ where: { companyId }, _max: { lastLoginAt: true } })),
    asPlatform(() => prisma.sale.count({ where: { companyId, createdAt: { gte: since } } })),
    asPlatform(() => prisma.serviceOrder.count({ where: { companyId, createdAt: { gte: since } } })),
    asPlatform(() => prisma.systemLog.groupBy({ by: ['service', 'event'], where: { companyId, category: 'integration', level: { in: ['ERROR', 'FATAL', 'WARN'] }, createdAt: { gte: since } }, _count: { _all: true }, _max: { createdAt: true }, orderBy: { _count: { event: 'desc' } }, take: 10 })),
    asPlatform(() => prisma.fiscalDocument.groupBy({ by: ['status'], where: { companyId, createdAt: { gte: since } }, _count: { _all: true } })),
    asPlatform(() => prisma.payment.count({ where: { companyId, status: 'REJECTED', createdAt: { gte: since } } })),
    monitoringService.companyHealth(companyId).catch(() => null),
  ]);

  const inputs = integrationMap.get(companyId) ?? { channels: [], fiscal: { branchesConfigured: 0, fiscalEnabled: 0, withCertificate: 0 }, automaticPaymentProvider: false };
  const items: IntegrationItem[] = classifyIntegrations(inputs);
  const enabledBy = new Map(moduleSettings.map((m) => [m.module as string, m.isEnabled]));
  const info = life.get(companyId);
  return {
    generatedAt: now.toISOString(),
    range: params.range,
    filters: { module: module ?? null, severity: params.severity ?? null },
    company: { ...company, lifecycle: info?.lifecycle ?? null },
    structure: { branches, usersByType: usersByType.map((u) => ({ userType: u.userType, count: u._count._all })) },
    // módulo "habilitado" = não desativado de forma explícita; CANAIS nasce desativado (opt-in), então sem registro ele conta como desativado
    modules: ALL_MODULES.map((m) => ({ module: m, enabled: enabledBy.has(m) ? Boolean(enabledBy.get(m)) : m !== 'CANAIS' })),
    integrations: { items, summary: integrationSummary(items), definition: INDICATOR_DEFINITIONS.integrationHealth },
    integrationErrors: {
      logs: integrationLogs.map((l) => ({ service: l.service, event: l.event, count: l._count._all, lastAt: l._max.createdAt })),
      fiscalDocumentsByStatus: fiscalByStatus.map((f) => ({ status: f.status, count: f._count._all })),
      paymentsRejected,
      note: 'Pagamento e emissão fiscal não têm integração automática nesta versão: estes números são indicadores de uso (recusas/rejeições registradas), não falha de integração.',
    },
    usage: { ...totals, sales, serviceOrders, lastActivityAt: lastActivity[0]?.last ?? null, lastLoginAt: lastLogin._max.lastLoginAt, note: 'Contagens de uso no período (sem valores financeiros).' },
    health,
    alerts: alerts.map((a) => ({ id: a.id, type: a.type, category: alertCategory(a.type), severity: a.severity, status: alertStatus(a), detail: a.detail, startedAt: a.startedAt, endedAt: a.endedAt, occurrences: a.occurrences, assignedTo: a.assignedTo })),
    incidents,
    series: { bucketSeconds: bucketSec, api: series },
  };
}

export { alertStatus };
