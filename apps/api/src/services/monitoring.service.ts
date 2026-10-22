import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import redisClient from '../config/redis';
import observabilityService from './observability.service';
import { DEVICE_ONLINE_WINDOW_MS, HealthStatus, Threshold, devicesStatus, level, worst } from './health-status';
import monitoringThresholds, { EffectiveThresholds, MonitoringMetric } from './monitoring-thresholds.service';
import { recordAlertEvent } from './monitoring-central/alert-events';
import { notifyAlert as notifyAlertBase } from './monitoring-central/notifier';
import { severityRank } from './monitoring-central/model';

// Janelas do histórico: nunca carrega dado bruto ilimitado — cada faixa tem um tamanho de balde (≤ 360 pontos).
export const RANGES = {
  '1h': { ms: 3_600_000, bucketSec: 60 },
  '6h': { ms: 6 * 3_600_000, bucketSec: 300 },
  '24h': { ms: 24 * 3_600_000, bucketSec: 900 },
  '7d': { ms: 7 * 86_400_000, bucketSec: 3_600 },
  '30d': { ms: 30 * 86_400_000, bucketSec: 21_600 },
} as const;
export type RangeKey = keyof typeof RANGES;

const API_WINDOW_MS = 15 * 60_000;
const TELEMETRY_WINDOW_MS = 5 * 60_000;
const QUEUE_FAILURE_WINDOW_MS = 60 * 60_000;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Saúde por empresa → filial → componente, a partir de dados REAIS: requisições registradas (request_logs), telemetria
 * enviada pelos equipamentos (device_telemetry) e a infraestrutura central (Postgres, Redis, filas). Sem coleta, o
 * componente fica NO_DATA — nunca "normal" por falta de dado. Consultas rodam no contexto RLS de quem chama.
 */
export class MonitoringService {
  async branchHealth(companyId: string, branchId: string, now = new Date(), thresholds?: EffectiveThresholds) {
    // Limites efetivos (filial → empresa → global → padrão), configurados pelo Super Admin.
    const t = thresholds ?? (await monitoringThresholds.effective(companyId, branchId));
    const since = new Date(now.getTime() - API_WINDOW_MS);
    const [apiRow] = await runInTransaction((tx) =>
      tx.$queryRaw<Array<{ requests: number; p95: number | null; errors: number }>>`
        SELECT count(*)::int AS requests,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95,
               count(*) FILTER (WHERE "statusCode" >= 500)::int AS errors
        FROM request_logs
        WHERE "companyId" = ${companyId} AND "branchId" = ${branchId} AND "createdAt" > ${since}`
    );
    const requests = apiRow?.requests ?? 0;
    const p95Ms = requests ? round(num(apiRow.p95), 0) : null;
    const errorRatePct = requests ? round((apiRow.errors / requests) * 100, 2) : null;
    const api = {
      status: requests ? worst(level(p95Ms, t.apiP95Ms), level(errorRatePct, t.api5xxPct)) : ('NO_DATA' as HealthStatus),
      requests,
      p95Ms,
      errorRatePct,
    };

    // equipamentos da filial: com sessão na filial ou telemetria da filial nas últimas 24 h
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const [sessions, telemetryDevices] = await Promise.all([
      prisma.deviceSession.findMany({
        where: { companyId, branchId, OR: [{ status: 'ACTIVE' }, { startedAt: { gt: dayAgo } }] },
        select: { deviceId: true },
      }),
      prisma.deviceTelemetry.findMany({ where: { companyId, branchId, collectedAt: { gt: dayAgo } }, distinct: ['deviceId'], select: { deviceId: true } }),
    ]);
    const deviceIds = [...new Set([...sessions, ...telemetryDevices].map((d) => d.deviceId))];
    const [devices, latest] = await Promise.all([
      deviceIds.length
        ? prisma.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, deviceName: true, deviceType: true, status: true, lastSeenAt: true } })
        : Promise.resolve([]),
      deviceIds.length
        ? runInTransaction((tx) =>
            tx.$queryRaw<Array<{ deviceId: string; collectedAt: Date; receivedAt: Date; cpuLoadPct: number | null; memUsedPct: number | null; diskUsedPct: number | null; apiRttMs: number | null; packetLossPct: number | null; appVersion: string | null; runtimeVersion: string | null }>>`
              SELECT DISTINCT ON ("deviceId") "deviceId", "collectedAt", "receivedAt", "cpuLoadPct", "memUsedPct", "diskUsedPct", "apiRttMs", "packetLossPct", "appVersion", "runtimeVersion"
              FROM device_telemetry
              WHERE "companyId" = ${companyId} AND "branchId" = ${branchId} AND "deviceId" IN (${Prisma.join(deviceIds)})
              ORDER BY "deviceId", "collectedAt" DESC`
          )
        : Promise.resolve([]),
    ]);
    const latestBy = new Map(latest.map((t) => [t.deviceId, t]));
    const list = devices.map((d) => {
      const t = latestBy.get(d.id);
      const lastContact = [d.lastSeenAt, t?.receivedAt].filter(Boolean).map((x) => new Date(x as Date).getTime());
      const lastContactAt = lastContact.length ? new Date(Math.max(...lastContact)) : null;
      const online = d.status === 'ACTIVE' && !!lastContactAt && now.getTime() - lastContactAt.getTime() <= DEVICE_ONLINE_WINDOW_MS;
      const fresh = t && now.getTime() - new Date(t.collectedAt).getTime() <= TELEMETRY_WINDOW_MS ? t : null;
      return {
        id: d.id,
        name: d.deviceName,
        type: d.deviceType,
        deviceStatus: d.status,
        online,
        lastContactAt,
        appVersion: t?.appVersion ?? null,
        runtimeVersion: t?.runtimeVersion ?? null,
        cpuPct: round(num(fresh?.cpuLoadPct)),
        memPct: round(num(fresh?.memUsedPct)),
        diskPct: round(num(fresh?.diskUsedPct)),
        rttMs: num(fresh?.apiRttMs),
        lossPct: round(num(fresh?.packetLossPct)),
      };
    });
    const online = list.filter((d) => d.online).length;
    const withData = list.filter((d) => d.online);
    const max = (k: 'cpuPct' | 'memPct' | 'diskPct' | 'lossPct') => {
      const vals = withData.map((d) => d[k]).filter((v): v is number => v !== null);
      return vals.length ? Math.max(...vals) : null;
    };
    const rtts = withData.map((d) => d.rttMs).filter((v): v is number => v !== null);
    const host = { cpuPct: max('cpuPct'), memPct: max('memPct'), diskPct: max('diskPct') };
    const network = { rttMs: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null, lossPct: max('lossPct') };
    const hostStatus = worst(level(host.cpuPct, t.cpuPct), level(host.memPct, t.memPct), level(host.diskPct, t.diskPct));
    const networkStatus = worst(level(network.rttMs, t.rttMs), level(network.lossPct, t.lossPct));
    const devicesSummary = { status: devicesStatus(online, list.length, t.devicesOfflinePct), online, total: list.length, list };

    return {
      api,
      network: { status: networkStatus, ...network },
      host: { status: hostStatus, ...host },
      devices: devicesSummary,
      status: worst(api.status, networkStatus, hostStatus, devicesSummary.status),
      thresholds: t,
    };
  }

  async centralHealth(thresholds?: EffectiveThresholds) {
    // Infraestrutura central é da plataforma: vale o limite global (ou o padrão).
    const t = thresholds ?? (await monitoringThresholds.effective(null));
    const timed = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await fn();
        return { up: true, latencyMs: Date.now() - t };
      } catch {
        return { up: false, latencyMs: null as number | null };
      }
    };
    const [db, redis] = await Promise.all([timed(() => runInTransaction((tx) => tx.$queryRaw`SELECT 1`)), timed(() => redisClient.ping())]);
    let redisMemoryMb: number | null = null;
    try {
      const info = await redisClient.info('memory');
      const used = /used_memory:(\d+)/.exec(info)?.[1];
      redisMemoryMb = used ? Math.round((Number(used) / 1_048_576) * 10) / 10 : null;
    } catch {
      redisMemoryMb = null;
    }
    const jobs = await observabilityService.getJobsStatus().catch(() => null);
    const queueList = jobs?.queues ?? [];
    const failed = queueList.reduce((acc, q) => acc + Number(q.counts.failed), 0);
    // Estado pelas falhas RECENTES: o BullMQ retém falhas por dias, e um defeito já corrigido deixava as filas em
    // ATENÇÃO até a retenção expirar. As 10 falhas mais recentes de cada fila bastam como sinal (o total segue em `failed`).
    const since = Date.now() - QUEUE_FAILURE_WINDOW_MS;
    const failedLastHour = queueList.reduce(
      (acc, q) => acc + q.recentFailedJobs.filter((j) => j.timestamp && new Date(j.timestamp).getTime() >= since).length,
      0
    );
    const waiting = queueList.reduce((acc, q) => acc + Number(q.counts.waiting), 0);
    const overdue = queueList.reduce((acc, q) => acc + Number((q as { overdue?: number }).overdue ?? 0), 0);
    const workersDown = queueList.filter((q) => q.workerRunning === false).length;
    const queuesStatus: HealthStatus =
      jobs === null
        ? 'NO_DATA'
        : workersDown > 0
          ? 'CRITICAL'
          : worst(level(waiting, t.queueWaiting), level(failedLastHour, t.queueFailedLastHour), level(overdue, t.jobsOverdue));
    return {
      database: { status: (db.up ? level(db.latencyMs, t.dbLatencyMs) : 'OFFLINE') as HealthStatus, latencyMs: db.latencyMs },
      redis: { status: (redis.up ? level(redis.latencyMs, t.redisLatencyMs) : 'OFFLINE') as HealthStatus, latencyMs: redis.latencyMs, memoryMb: redisMemoryMb },
      queues: { status: queuesStatus, waiting, failed, failedLastHour, overdue, workersDown },
    };
  }

  async companyHealth(companyId: string) {
    const [company, branches, central, thresholdsOf] = await Promise.all([
      prisma.company.findFirst({ where: { id: companyId }, select: { id: true, name: true, isActive: true } }),
      prisma.branch.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.centralHealth(),
      monitoringThresholds.forCompany(companyId),
    ]);
    if (!company) return null;
    const summaries = await Promise.all(
      branches.map(async (b) => {
        const h = await this.branchHealth(companyId, b.id, new Date(), thresholdsOf(b.id));
        return {
          id: b.id,
          name: b.name,
          status: h.status,
          api: h.api.status,
          network: h.network.status,
          host: h.host.status,
          devices: { status: h.devices.status, online: h.devices.online, total: h.devices.total },
        };
      })
    );
    return {
      company,
      central,
      branches: summaries,
      status: worst(central.database.status, central.redis.status, central.queues.status, ...summaries.map((s) => s.status)),
      generatedAt: new Date().toISOString(),
    };
  }

  async series(companyId: string, branchId: string, range: RangeKey) {
    const { ms, bucketSec } = RANGES[range];
    const since = new Date(Date.now() - ms);
    const bucket = `${bucketSec} seconds`;
    const [api, telemetry] = await Promise.all([
      runInTransaction((tx) =>
        tx.$queryRaw<Array<{ t: Date; requests: number; avgMs: number; p95Ms: number; errors: number }>>`
          SELECT date_bin(${bucket}::interval, "createdAt", TIMESTAMP '2000-01-01') AS t,
                 count(*)::int AS requests, avg("durationMs")::float AS "avgMs",
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float AS "p95Ms",
                 count(*) FILTER (WHERE "statusCode" >= 500)::int AS errors
          FROM request_logs
          WHERE "companyId" = ${companyId} AND "branchId" = ${branchId} AND "createdAt" > ${since}
          GROUP BY 1 ORDER BY 1`
      ),
      runInTransaction((tx) =>
        tx.$queryRaw<Array<{ t: Date; cpuPct: number | null; memPct: number | null; diskPct: number | null; rttMs: number | null; lossPct: number | null; devices: number }>>`
          SELECT date_bin(${bucket}::interval, "collectedAt", TIMESTAMP '2000-01-01') AS t,
                 avg("cpuLoadPct")::float AS "cpuPct", avg("memUsedPct")::float AS "memPct", max("diskUsedPct")::float AS "diskPct",
                 avg("apiRttMs")::float AS "rttMs", avg("packetLossPct")::float AS "lossPct", count(DISTINCT "deviceId")::int AS devices
          FROM device_telemetry
          WHERE "companyId" = ${companyId} AND "branchId" = ${branchId} AND "collectedAt" > ${since}
          GROUP BY 1 ORDER BY 1`
      ),
    ]);
    return {
      range,
      bucketSec,
      api: api.map((r) => ({ t: r.t, requests: r.requests, avgMs: round(r.avgMs, 0), p95Ms: round(r.p95Ms, 0), errors: r.errors })),
      telemetry: telemetry.map((r) => ({
        t: r.t, cpuPct: round(r.cpuPct), memPct: round(r.memPct), diskPct: round(r.diskPct), rttMs: round(r.rttMs, 0), lossPct: round(r.lossPct), devices: r.devices,
      })),
    };
  }

  async endpoints(companyId: string, branchId: string, range: RangeKey) {
    const t = await monitoringThresholds.effective(companyId, branchId);
    const since = new Date(Date.now() - RANGES[range].ms);
    const rows = await runInTransaction((tx) =>
      tx.$queryRaw<Array<{ method: string; route: string; requests: number; avgMs: number; p95Ms: number; errors: number }>>`
        SELECT method, route, count(*)::int AS requests, avg("durationMs")::float AS "avgMs",
               percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float AS "p95Ms",
               count(*) FILTER (WHERE "statusCode" >= 500)::int AS errors
        FROM request_logs
        WHERE "companyId" = ${companyId} AND "branchId" = ${branchId} AND "createdAt" > ${since}
        GROUP BY method, route ORDER BY "p95Ms" DESC LIMIT 50`
    );
    return rows.map((r) => ({
      ...r,
      avgMs: round(r.avgMs, 0),
      p95Ms: round(r.p95Ms, 0),
      errorRatePct: r.requests ? round((r.errors / r.requests) * 100, 2) : 0,
      status: worst(level(r.p95Ms, t.apiP95Ms), level(r.requests ? (r.errors / r.requests) * 100 : 0, t.api5xxPct)),
    }));
  }

  async incidents(companyId: string, branchId?: string, limit = 50) {
    return prisma.healthIncident.findMany({
      where: { companyId, ...(branchId ? { branchId } : {}) },
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  /**
   * Job de avaliação: abre um incidente por componente/filial quando o estado sai de NORMAL (ATTENTION/CRITICAL/OFFLINE)
   * e o encerra quando volta a NORMAL. NO_DATA não abre nem fecha (falta de coleta não é incidente nem recuperação).
   */
  async evaluateIncidents(now = new Date()) {
    const companies = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
      prisma.company.findMany({ where: { isActive: true }, select: { id: true } })
    );
    let opened = 0;
    let closed = 0;
    let alerts = { opened: 0, reopened: 0, updated: 0, closed: 0 };
    const count = (r: AlertOutcome) => {
      if (r !== 'noop') alerts = { ...alerts, [r]: alerts[r] + 1 };
    };
    for (const { id: companyId } of companies) {
      await runWithRLSContext({ companyId, userType: 'SUPER_ADMIN', branchId: null }, async () => {
        const branches = await prisma.branch.findMany({ where: { companyId, isActive: true }, select: { id: true } });
        const thresholdsOf = await monitoringThresholds.forCompany(companyId);
        for (const { id: branchId } of branches) {
          const t = thresholdsOf(branchId);
          const h = await this.branchHealth(companyId, branchId, now, t);
          for (const r of await this.evaluateBranchAlerts(companyId, branchId, h, t, now)) count(r);
          const components: Array<[string, HealthStatus, string]> = [
            ['API', h.api.status, `p95 ${h.api.p95Ms ?? '—'} ms · 5xx ${h.api.errorRatePct ?? '—'}%`],
            ['NETWORK', h.network.status, `latência ${h.network.rttMs ?? '—'} ms · perda ${h.network.lossPct ?? '—'}%`],
            ['HOST', h.host.status, `CPU ${h.host.cpuPct ?? '—'}% · RAM ${h.host.memPct ?? '—'}% · disco ${h.host.diskPct ?? '—'}%`],
            ['DEVICES', h.devices.status, `${h.devices.online}/${h.devices.total} online`],
          ];
          for (const [component, status, detail] of components) {
            if (status === 'NO_DATA') continue;
            const open = await prisma.healthIncident.findFirst({ where: { companyId, branchId, component, endedAt: null } });
            if (status === 'NORMAL') {
              if (open) {
                await prisma.healthIncident.update({ where: { id: open.id }, data: { endedAt: now } });
                closed++;
              }
            } else if (!open) {
              await prisma.healthIncident.create({ data: { companyId, branchId, component, status, detail, startedAt: now } });
              opened++;
            } else if (open.status !== status) {
              await prisma.healthIncident.update({ where: { id: open.id }, data: { status, detail } });
            }
          }
        }
      });
    }
    // Infraestrutura central (banco, cache, filas, jobs): alertas da plataforma, sem empresa.
    await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const t = await monitoringThresholds.effective(null);
      const c = await this.centralHealth(t);
      const cond = (type: string, metric: MonitoringMetric | 'workersDown', value: number | null, th: Threshold | null, status: HealthStatus, detail: string): AlertCondition =>
        ({ source: 'CENTRAL', companyId: null, branchId: null, deviceId: null, type, metric, value, threshold: th, status, detail });
      const central: AlertCondition[] = [
        cond('DATABASE_DEGRADED', 'dbLatencyMs', c.database.latencyMs, t.dbLatencyMs, c.database.status, c.database.status === 'OFFLINE' ? 'banco indisponível' : `latência ${c.database.latencyMs} ms`),
        cond('REDIS_DEGRADED', 'redisLatencyMs', c.redis.latencyMs, t.redisLatencyMs, c.redis.status, c.redis.status === 'OFFLINE' ? 'Redis indisponível' : `latência ${c.redis.latencyMs} ms`),
        cond('QUEUE_BACKLOG', 'queueWaiting', c.queues.waiting, t.queueWaiting, c.queues.status === 'NO_DATA' ? 'NO_DATA' : level(c.queues.waiting, t.queueWaiting), `${c.queues.waiting} jobs aguardando`),
        cond('QUEUE_FAILURES', 'queueFailedLastHour', c.queues.failedLastHour, t.queueFailedLastHour, c.queues.status === 'NO_DATA' ? 'NO_DATA' : level(c.queues.failedLastHour, t.queueFailedLastHour), `${c.queues.failedLastHour} falhas na última hora`),
        cond('JOB_OVERDUE', 'jobsOverdue', c.queues.overdue, t.jobsOverdue, c.queues.status === 'NO_DATA' ? 'NO_DATA' : level(c.queues.overdue, t.jobsOverdue), `${c.queues.overdue} jobs agendados atrasados`),
        cond('QUEUE_WORKER_DOWN', 'workersDown', c.queues.workersDown, null, c.queues.status === 'NO_DATA' ? 'NO_DATA' : c.queues.workersDown > 0 ? 'CRITICAL' : 'NORMAL', `${c.queues.workersDown} worker(s) parado(s)`),
      ];
      for (const a of central) count(await this.applyAlert(a, now));
    });
    return { opened, closed, alerts };
  }

  /** Condições de alerta de uma filial (valores e limites efetivos) e de cada equipamento (perda de comunicação). */
  private async evaluateBranchAlerts(companyId: string, branchId: string, h: Awaited<ReturnType<MonitoringService['branchHealth']>>, t: EffectiveThresholds, now: Date) {
    const base = { source: 'BRANCH' as const, companyId, branchId, deviceId: null };
    const metric = (type: string, m: MonitoringMetric, value: number | null, detail: string): AlertCondition => ({
      ...base, type, metric: m, value, threshold: t[m], status: level(value, t[m]), detail,
    });
    const conditions: AlertCondition[] = [
      metric('API_LATENCY', 'apiP95Ms', h.api.requests ? h.api.p95Ms : null, `p95 ${h.api.p95Ms ?? '—'} ms`),
      metric('API_ERRORS', 'api5xxPct', h.api.requests ? h.api.errorRatePct : null, `5xx ${h.api.errorRatePct ?? '—'}% de ${h.api.requests} requisições`),
      metric('HOST_CPU', 'cpuPct', h.host.cpuPct, `CPU ${h.host.cpuPct ?? '—'}%`),
      metric('HOST_MEMORY', 'memPct', h.host.memPct, `RAM ${h.host.memPct ?? '—'}%`),
      metric('HOST_DISK', 'diskPct', h.host.diskPct, `disco ${h.host.diskPct ?? '—'}%`),
      metric('NETWORK_LATENCY', 'rttMs', h.network.rttMs, `latência ${h.network.rttMs ?? '—'} ms`),
      metric('NETWORK_LOSS', 'lossPct', h.network.lossPct, `perda ${h.network.lossPct ?? '—'}%`),
    ];
    // Equipamento ativo sem contato além da janela: perda de comunicação (nunca "saudável" por falta de sinal).
    const windowMin = DEVICE_ONLINE_WINDOW_MS / 60_000;
    for (const d of h.devices.list) {
      if (d.deviceStatus !== 'ACTIVE') continue;
      const silentMin = d.lastContactAt ? Math.round((now.getTime() - new Date(d.lastContactAt).getTime()) / 60_000) : null;
      conditions.push({
        source: 'DEVICE', companyId, branchId, deviceId: d.id, type: 'DEVICE_OFFLINE', metric: 'minutesSinceContact',
        value: silentMin, threshold: { attention: windowMin, critical: windowMin }, status: d.online ? 'NORMAL' : 'OFFLINE',
        detail: `${d.name}: sem contato há ${silentMin ?? '—'} min`,
      });
    }
    const outcomes: AlertOutcome[] = [];
    for (const c of conditions) outcomes.push(await this.applyAlert(c, now));
    return outcomes;
  }

  /**
   * Um alerta por tipo+alvo. Fora do limite: abre (ou atualiza o aberto); se o mesmo alerta encerrou há menos de
   * ALERT_REOPEN_COOLDOWN_MS, reabre em vez de criar outro (sem spam por oscilação). Dentro do limite: encerra.
   * Sem dado (NO_DATA): não abre nem encerra — falta de coleta não é recuperação.
   */
  async applyAlert(c: AlertCondition, now: Date): Promise<AlertOutcome> {
    if (c.status === 'NO_DATA') return 'noop';
    // alerta EXTERNAL já foi avisado pelo próprio monitor independente: registrar aqui NÃO pode gerar uma segunda mensagem
    const notifyAlert = (a: Parameters<typeof notifyAlertBase>[0], t: Parameters<typeof notifyAlertBase>[1]) => (c.source === 'EXTERNAL' ? Promise.resolve() : notifyAlertBase(a, t));
    const key = { companyId: c.companyId, branchId: c.branchId, deviceId: c.deviceId, type: c.type };
    const open = await prisma.monitoringAlert.findFirst({ where: { ...key, endedAt: null } });
    if (c.status === 'NORMAL') {
      if (!open) return 'noop';
      const closed = await prisma.monitoringAlert.updateMany({ where: { id: open.id, endedAt: null }, data: { endedAt: now, lastSeenAt: now, value: c.value } });
      if (closed.count === 1) {
        await recordAlertEvent({ alertId: open.id, companyId: open.companyId, kind: 'AUTO_RESOLVED', note: 'a condição voltou ao normal' });
        // aviso de RECUPERAÇÃO: só vai aos canais que haviam avisado este alerta (decidido no notifier); nunca bloqueia nem lança
        void notifyAlert(
          { id: open.id, type: open.type, severity: open.severity, companyId: open.companyId, branchId: open.branchId, deviceId: open.deviceId, detail: open.detail, value: c.value, threshold: null, startedAt: open.startedAt, endedAt: now },
          'RECOVERED'
        );
      }
      return 'closed';
    }
    const threshold = c.threshold ? (c.status === 'CRITICAL' || c.status === 'OFFLINE' ? c.threshold.critical : c.threshold.attention) : null;
    const data = { severity: c.status, value: c.value, threshold, detail: c.detail, lastSeenAt: now };
    // Ciclo de tratamento (Central de Alertas): histórico e aviso só nas MUDANÇAS (abrir, reabrir, trocar de gravidade); atualizar o mesmo alerta não repete nada.
    const notifiable = (alertId: string) => ({ id: alertId, type: c.type, severity: c.status, companyId: c.companyId, branchId: c.branchId, deviceId: c.deviceId, detail: c.detail, value: c.value, threshold });
    if (open) {
      await prisma.monitoringAlert.update({ where: { id: open.id }, data });
      if (open.severity !== c.status) {
        await recordAlertEvent({ alertId: open.id, companyId: open.companyId, kind: 'SEVERITY_CHANGED', note: `${open.severity} → ${c.status}` });
        if (severityRank(c.status) > severityRank(open.severity)) void notifyAlert(notifiable(open.id), 'ESCALATED');
      }
      return 'updated';
    }
    const recent = await prisma.monitoringAlert.findFirst({
      where: { ...key, endedAt: { gt: new Date(now.getTime() - ALERT_REOPEN_COOLDOWN_MS) } },
      orderBy: { endedAt: 'desc' },
    });
    if (recent) {
      // reincidência: volta a ABERTO para tratamento (o reconhecimento anterior não vale para o novo episódio); o responsável continua
      const reopened = await prisma.monitoringAlert.updateMany({
        where: { id: recent.id, endedAt: { not: null } },
        data: { ...data, endedAt: null, occurrences: { increment: 1 }, handling: 'OPEN', acknowledgedAt: null, acknowledgedBy: null, resolvedBy: null, resolutionNote: null },
      });
      if (reopened.count === 1) {
        await recordAlertEvent({ alertId: recent.id, companyId: recent.companyId, kind: 'REOPENED', note: `${c.status}: ${c.detail}`.slice(0, 200) });
        void notifyAlert(notifiable(recent.id), 'REOPENED');
        return 'reopened';
      }
    }
    try {
      const created = await prisma.monitoringAlert.create({ data: { ...key, source: c.source, metric: c.metric, startedAt: now, ...data } });
      if (created?.id) {
        await recordAlertEvent({ alertId: created.id, companyId: created.companyId, kind: 'OPENED', note: `${c.status}: ${c.detail}`.slice(0, 200) });
        void notifyAlert(notifiable(created.id), 'OPENED');
      }
      return 'opened';
    } catch (error) {
      // outra avaliação abriu o mesmo alerta ao mesmo tempo (índice de um aberto por tipo+alvo)
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'noop';
      throw error;
    }
  }

  async alerts(scope: { companyId: string | null; branchId?: string; open?: boolean; limit?: number }) {
    return prisma.monitoringAlert.findMany({
      where: {
        companyId: scope.companyId,
        ...(scope.branchId ? { branchId: scope.branchId } : {}),
        ...(scope.open ? { endedAt: null } : {}),
      },
      orderBy: [{ endedAt: { sort: 'desc', nulls: 'first' } }, { startedAt: 'desc' }],
      take: Math.min(scope.limit ?? 100, 500),
    });
  }
}

const ALERT_REOPEN_COOLDOWN_MS = 10 * 60_000;
export type AlertOutcome = 'opened' | 'reopened' | 'updated' | 'closed' | 'noop';
export type AlertCondition = {
  /** EXTERNAL = medido pelo monitor independente (apps/monitor), que JÁ avisa por conta própria: o painel registra, mas não notifica de novo. */
  source: 'BRANCH' | 'DEVICE' | 'CENTRAL' | 'COMPANY' | 'EXTERNAL';
  companyId: string | null;
  branchId: string | null;
  deviceId: string | null;
  type: string;
  metric: string;
  value: number | null;
  threshold: Threshold | null;
  status: HealthStatus;
  detail: string;
};

export default new MonitoringService();
