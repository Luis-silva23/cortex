import { prisma, Prisma, runInTransaction } from '@ln-system/database';
import type { Queue, Worker } from 'bullmq';
import cacheService from './cache.service';
import { resendConfig } from './monitoring-central/resend.service';
import { APP_TIME_ZONE } from '../utils/time-zone';
import { redis as redisClient } from '../config/redis';
import {
  emailQueue,
  reportQueue,
  notificationQueue,
  auditQueue,
  requestMetricsQueue,
  systemLogQueue,
  emailWorker,
  reportWorker,
  notificationWorker,
  auditWorker,
  requestMetricsWorker,
  systemLogWorker,
} from '../config/queue';

/**
 * Observabilidade de PLATAFORMA (Super ADM TI) — métricas de requisição
 * (RequestLog), logs técnicos (SystemLog), estado ao vivo das filas BullMQ
 * e alertas computados sob demanda. Nada de negócio/comercial aqui (ver
 * dashboard.service.ts para KPIs de vendas/financeiro/estoque).
 */

// ============================================
// Helpers compartilhados
// ============================================

/** Resolve a janela de consulta: default últimas `defaultHours` horas até agora. */
function resolveWindow(startDate?: string, endDate?: string, defaultHours = 24) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - defaultHours * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Percentil por interpolação linear — mesma semântica de PERCENTILE_CONT do
 * Postgres. Exportado como função pura testável isoladamente; a rota real
 * de `/metrics` NÃO usa esta função (usa `PERCENTILE_CONT` via
 * `$queryRaw`, que escala melhor para RequestLog com muitas linhas — ver
 * `computeMetrics`), mas a matemática precisa ser idêntica, então mantê-la
 * aqui e testada garante que, se algum dia for necessário um fallback em
 * memória (ex.: banco sem suporte a PERCENTILE_CONT), o comportamento já
 * está correto e coberto por teste.
 */
export function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const idx = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);

  if (lower === upper) return sortedValues[lower];

  const weight = idx - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

interface QueueDef {
  name: 'email' | 'report' | 'notification' | 'audit-log' | 'request-metrics' | 'system-log';
  queue: Queue;
  worker: Worker;
}

const QUEUE_DEFS: QueueDef[] = [
  { name: 'email', queue: emailQueue, worker: emailWorker },
  { name: 'report', queue: reportQueue, worker: reportWorker },
  { name: 'notification', queue: notificationQueue, worker: notificationWorker },
  { name: 'audit-log', queue: auditQueue, worker: auditWorker },
  { name: 'request-metrics', queue: requestMetricsQueue, worker: requestMetricsWorker },
  { name: 'system-log', queue: systemLogQueue, worker: systemLogWorker },
];

/** Lê thresholds de alerta de env vars, com defaults sensatos. Nunca lança —
 * um valor inválido em env cai no default em vez de derrubar o endpoint. */
function getAlertThresholds() {
  const num = (envVar: string | undefined, fallback: number) => {
    const parsed = Number(envVar);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    p95Ms: num(process.env.ALERT_P95_THRESHOLD_MS, 2000),
    errorRate: num(process.env.ALERT_ERROR_RATE_THRESHOLD, 0.05),
    queueBacklog: num(process.env.ALERT_QUEUE_BACKLOG_THRESHOLD, 100),
    deviceHeartbeatStaleHours: num(process.env.ALERT_DEVICE_HEARTBEAT_STALE_HOURS, 24),
  };
}

type Severity = 'ok' | 'warning' | 'critical';

/** critical acima do threshold, warning a partir de 80% do threshold. */
function severityFor(value: number, threshold: number): Severity {
  if (threshold <= 0) return value > 0 ? 'critical' : 'ok';
  if (value > threshold) return 'critical';
  if (value > threshold * 0.8) return 'warning';
  return 'ok';
}

export class ObservabilityService {
  // ============================================
  // 1. MÉTRICAS DE REQUISIÇÃO
  // ============================================

  async getMetrics(params: { startDate?: string; endDate?: string; route?: string }) {
    const { start, end } = resolveWindow(params.startDate, params.endDate);
    const cacheKey = `observability:metrics:${start.toISOString()}:${end.toISOString()}:${params.route || 'all'}`;
    return cacheService.remember(cacheKey, 60, () => this.computeMetrics(start, end, params.route));
  }

  /**
   * Núcleo do cálculo de métricas — extraído para ser reaproveitado por
   * `getAlerts()` (P95/taxa de erro) sem duplicar a lógica nem pagar o
   * custo de outra query. Percentis usam `PERCENTILE_CONT` via `$queryRaw`
   * (Postgres nativo) em vez de trazer todas as linhas para o Node e
   * ordenar em memória — mais barato para uma tabela de alto volume como
   * RequestLog. Os valores interpolados são passados como parâmetros do
   * tagged template (`Prisma.sql`), nunca concatenados como string —
   * seguro contra injeção mesmo vindo de `route` (query param do usuário).
   */
  private async computeMetrics(start: Date, end: Date, route?: string) {
    const baseWhere: Prisma.RequestLogWhereInput = {
      createdAt: { gte: start, lte: end },
      ...(route && { route }),
    };

    const [agg, statusGroups, byRouteAll, byRouteErrors] = await Promise.all([
      prisma.requestLog.aggregate({ where: baseWhere, _count: true, _avg: { durationMs: true } }),
      prisma.requestLog.groupBy({ by: ['statusCode'], where: baseWhere, _count: true }),
      prisma.requestLog.groupBy({ by: ['route'], where: baseWhere, _avg: { durationMs: true }, _count: true }),
      prisma.requestLog.groupBy({
        by: ['route'],
        where: { ...baseWhere, statusCode: { gte: 400 } },
        _count: true,
      }),
    ]);

    const routeCondition = route ? Prisma.sql`AND route = ${route}` : Prisma.empty;

    // `$queryRaw` FORA de `runInTransaction` roda SEM contexto de RLS (não passa pelo `$allOperations`): sob FORCE RLS devolvia ZERO linhas, em silêncio — p50/p95/p99 sempre 0 e a série
    // de requisições vazia mesmo com milhares de requisições registradas (achado de 2026-10-19). Dentro de `runInTransaction` o contexto do chamador vale também para SQL cru.
    const percentileRows = await runInTransaction((tx) =>
      tx.$queryRaw<Array<{ p50: number | null; p95: number | null; p99: number | null }>>(
        Prisma.sql`
        SELECT
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "durationMs") AS p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "durationMs") AS p99
        FROM request_logs
        WHERE "createdAt" >= ${start} AND "createdAt" <= ${end}
        ${routeCondition}
      `
      )
    );
    const pct = percentileRows[0] || { p50: null, p95: null, p99: null };

    const bucketUnit = end.getTime() - start.getTime() <= 48 * 60 * 60 * 1000 ? 'hour' : 'day';
    // Agrupa no fuso do produto (decisão 58): `createdAt` é um instante UTC (timestamp sem fuso); vira o relógio de Brasília, é cortado
    // na hora/dia de Brasília e volta a ser instante (meia-noite de Brasília = 03:00Z). Antes o corte era em UTC e o dia de Brasília
    // aparecia deslocado (ponto de 28/09 mostrado como 27/09 21:00).
    const timeRows = await runInTransaction((tx) =>
      tx.$queryRaw<Array<{ bucket: Date; count: bigint | number }>>(
        Prisma.sql`
        SELECT date_trunc(${bucketUnit}, ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIME_ZONE}) AT TIME ZONE ${APP_TIME_ZONE} AS bucket, COUNT(*) AS count
        FROM request_logs
        WHERE "createdAt" >= ${start} AND "createdAt" <= ${end}
        ${routeCondition}
        GROUP BY bucket
        ORDER BY bucket ASC
      `
      )
    );

    const requestCount = agg._count;
    const avgDurationMs = agg._avg.durationMs ?? 0;

    const statusBreakdown = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<'2xx' | '3xx' | '4xx' | '5xx', number>;
    let errorCount = 0;
    for (const g of statusGroups) {
      const bucketKey = `${Math.floor(g.statusCode / 100)}xx`;
      if (bucketKey in statusBreakdown) {
        statusBreakdown[bucketKey as keyof typeof statusBreakdown] += g._count;
      }
      if (g.statusCode >= 400) errorCount += g._count;
    }
    const errorRate = requestCount > 0 ? errorCount / requestCount : 0;

    const errorByRoute = new Map(byRouteErrors.map((r) => [r.route, r._count]));

    const topSlowestRoutes = [...byRouteAll]
      .sort((a, b) => (b._avg.durationMs ?? 0) - (a._avg.durationMs ?? 0))
      .slice(0, 10)
      .map((r) => ({ route: r.route, avgDurationMs: r._avg.durationMs ?? 0, count: r._count }));

    const topVolumeRoutes = [...byRouteAll]
      .sort((a, b) => b._count - a._count)
      .slice(0, 10)
      .map((r) => ({ route: r.route, count: r._count }));

    const topErrorRoutes = byRouteAll
      .map((r) => {
        const errCount = errorByRoute.get(r.route) || 0;
        return { route: r.route, errorCount: errCount, errorRate: r._count > 0 ? errCount / r._count : 0 };
      })
      .filter((r) => r.errorCount > 0)
      .sort((a, b) => b.errorCount - a.errorCount)
      .slice(0, 10);

    return {
      requestCount,
      avgDurationMs,
      p50: pct.p50 != null ? Number(pct.p50) : 0,
      p95: pct.p95 != null ? Number(pct.p95) : 0,
      p99: pct.p99 != null ? Number(pct.p99) : 0,
      errorRate,
      statusBreakdown,
      requestsOverTime: timeRows.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
      topSlowestRoutes,
      topVolumeRoutes,
      topErrorRoutes,
    };
  }

  // ============================================
  // 2. ESTADO DAS FILAS (BullMQ, ao vivo — não Postgres)
  // ============================================

  async getJobsStatus() {
    const queues = await Promise.all(
      QUEUE_DEFS.map(async ({ name, queue, worker }) => {
        const [counts, failedJobs, delayedJobs] = await Promise.all([
          queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
          queue.getFailed(0, 9),
          queue.getDelayed(0, 199),
        ]);
        // Agendado/atrasado cuja hora de execução passou há mais de 5 min: nenhum worker o pegou (job atrasado).
        const overdueBefore = Date.now() - 5 * 60_000;
        const overdue = delayedJobs.filter((j) => j && (j.timestamp ?? 0) + (j.delay ?? j.opts?.delay ?? 0) < overdueBefore).length;

        let workerRunning = false;
        try {
          workerRunning = worker.isRunning();
        } catch {
          workerRunning = false;
        }

        return {
          queue: name,
          counts: {
            waiting: counts.waiting || 0,
            active: counts.active || 0,
            completed: counts.completed || 0,
            failed: counts.failed || 0,
            delayed: counts.delayed || 0,
          },
          overdue,
          workerRunning,
          recentFailedJobs: failedJobs.map((job) => ({
            id: job.id,
            name: job.name,
            failedReason: job.failedReason,
            attemptsMade: job.attemptsMade,
            timestamp: job.finishedOn
              ? new Date(job.finishedOn)
              : job.timestamp
                ? new Date(job.timestamp)
                : null,
          })),
        };
      })
    );

    const auditQueueEntry = queues.find((q) => q.queue === 'audit-log');

    return {
      queues,
      // audit-log usa removeOnFail:false (config/queue.ts) — falhas nunca
      // são descartadas automaticamente, então o `failed` desta fila É a
      // DLQ (dead-letter queue) implícita do sistema, acumulando até
      // revisão manual.
      deadLetterQueue: {
        auditLogFailedCount: auditQueueEntry?.counts.failed ?? 0,
        note:
          "audit-log usa removeOnFail:false — jobs de auditoria que falham definitivamente se acumulam até revisão manual (não há DLQ separada no BullMQ).",
      },
    };
  }

  // ============================================
  // 3. HEALTH CHECK DETALHADO (autenticado)
  // ============================================

  async getDetailedHealth() {
    const services = { database: 'unknown', redis: 'unknown' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      services.database = 'connected';
    } catch {
      services.database = 'disconnected';
    }

    try {
      await redisClient.ping();
      services.redis = 'connected';
    } catch {
      services.redis = 'disconnected';
    }

    const workers = QUEUE_DEFS.map(({ name, worker }) => {
      let running = false;
      try {
        running = worker.isRunning();
      } catch {
        running = false;
      }
      return { queue: name, running };
    });

    const fiscalConfigCount = await prisma.fiscalConfig.count();

    const integrations = {
      // apps/api/src/jobs/email.job.ts apenas loga no console (simulateEmailSend)
      // — não há integração real com nenhum provedor de email neste ambiente.
      emailProvider: (process.env.RESEND_TRANSACTIONAL === 'true' && resendConfig().configured ? 'resend' : 'simulated') as 'resend' | 'simulated',
      // Nenhum payment-adapter fala com um gateway real (ver payment-adapters/).
      paymentGateway: 'none' as const,
      // Verdadeiro só quando pelo menos uma empresa/filial configurou um
      // provedor fiscal — hoje isso não implica emissão funcional, já que
      // o único adapter selecionável é o UnconfiguredFiscalAdapter.
      fiscalConfigExists: fiscalConfigCount > 0,
    };

    const allWorkersRunning = workers.every((w) => w.running);
    const status =
      services.database === 'connected' && services.redis === 'connected' && allWorkersRunning
        ? 'healthy'
        : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services,
      workers,
      integrations,
    };
  }

  // ============================================
  // 4. SEGURANÇA (SystemLog categoria 'security')
  // ============================================

  async getSecurityStats(params: { startDate?: string; endDate?: string }) {
    const { start, end } = resolveWindow(params.startDate, params.endDate);
    const baseWhere: Prisma.SystemLogWhereInput = { category: 'security', createdAt: { gte: start, lte: end } };

    const [failedLogins, accountsLocked, loginAttemptsOnLockedAccounts, recentEvents, allEventsMetadata] =
      await Promise.all([
        prisma.systemLog.count({ where: { ...baseWhere, event: 'LOGIN_FAILED' } }),
        prisma.systemLog.count({ where: { ...baseWhere, event: 'ACCOUNT_LOCKED' } }),
        prisma.systemLog.count({ where: { ...baseWhere, event: 'LOGIN_ATTEMPT_WHILE_LOCKED' } }),
        prisma.systemLog.findMany({
          where: baseWhere,
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { event: true, message: true, userId: true, createdAt: true },
        }),
        prisma.systemLog.findMany({ where: baseWhere, select: { metadata: true } }),
      ]);

    // `ipAddress` é passado como campo extra em Logger.security(...) (ver
    // auth.service.ts) e cai em `metadata` (ver persistSystemLog em
    // logger.service.ts, que só nomeia requestId/companyId/branchId/
    // userId/device/durationMs/errorMessage/stackTrace como campos de
    // primeira classe — o resto vira metadata JSON).
    const ipCounts = new Map<string, number>();
    for (const row of allEventsMetadata) {
      const ip = (row.metadata as any)?.ipAddress;
      if (typeof ip === 'string' && ip.length > 0) {
        ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
      }
    }
    const topOffendingIPs = [...ipCounts.entries()]
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      period: { start, end },
      failedLogins,
      accountsLocked,
      loginAttemptsOnLockedAccounts,
      topOffendingIPs,
      recentEvents,
    };
  }

  // ============================================
  // 5. INTEGRAÇÕES (TEF/PIX + Fiscal)
  // ============================================

  async getIntegrationStats(params: { startDate?: string; endDate?: string }) {
    const { start, end } = resolveWindow(params.startDate, params.endDate);

    // PIX sempre passa pelo pending-manual-adapter; cartão só conta como
    // "TEF" quando tem nsuTef/nsuHost preenchido (ver schema.prisma Payment)
    // — cartão manual sem esses campos não é uma integração de verdade.
    const tefPixWhere: Prisma.PaymentWhereInput = {
      createdAt: { gte: start, lte: end },
      OR: [
        { paymentMethod: 'PIX' },
        {
          paymentMethod: { in: ['DEBIT_CARD', 'CREDIT_CARD'] },
          OR: [{ nsuTef: { not: null } }, { nsuHost: { not: null } }],
        },
      ],
    };

    const [tefPixByStatus, fiscalByStatus, integrationFailureLogCount] = await Promise.all([
      prisma.payment.groupBy({ by: ['paymentMethod', 'status'], where: tefPixWhere, _count: true }),
      prisma.fiscalDocument.groupBy({
        by: ['status'],
        where: { createdAt: { gte: start, lte: end } },
        _count: true,
      }),
      prisma.systemLog.count({ where: { category: 'integration', createdAt: { gte: start, lte: end } } }),
    ]);

    return {
      period: { start, end },
      tefPix: tefPixByStatus.map((p) => ({ method: p.paymentMethod, status: p.status, count: p._count })),
      fiscal: fiscalByStatus.map((f) => ({ status: f.status, count: f._count })),
      integrationFailureLogCount,
    };
  }

  // ============================================
  // 6. LOGS (tela de Logs do Super Admin)
  // ============================================

  async listSystemLogs(filters: {
    startDate?: string;
    endDate?: string;
    level?: string;
    category?: string;
    service?: string;
    event?: string;
    requestId?: string;
    userId?: string;
    companyId?: string;
    branchId?: string;
    device?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 50;

    const where: Prisma.SystemLogWhereInput = {
      ...(filters.level && { level: filters.level }),
      ...(filters.category && { category: filters.category }),
      ...(filters.service && { service: filters.service }),
      ...(filters.event && { event: { contains: filters.event, mode: 'insensitive' } }),
      ...(filters.requestId && { requestId: filters.requestId }),
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.companyId && { companyId: filters.companyId }),
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(filters.device && { device: filters.device }),
      ...((filters.startDate || filters.endDate) && {
        createdAt: {
          ...(filters.startDate && { gte: new Date(filters.startDate) }),
          ...(filters.endDate && { lte: new Date(filters.endDate) }),
        },
      }),
    };

    const [data, total] = await Promise.all([
      prisma.systemLog.findMany({
        where,
        // stackTrace fica de fora da listagem de propósito (pode ser grande
        // e não é necessário para escanear a lista) — só no detalhe
        // (getSystemLogById).
        select: {
          id: true,
          level: true,
          category: true,
          service: true,
          event: true,
          message: true,
          requestId: true,
          companyId: true,
          branchId: true,
          userId: true,
          device: true,
          durationMs: true,
          errorMessage: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.systemLog.count({ where }),
    ]);

    return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getSystemLogById(id: string) {
    return prisma.systemLog.findUnique({ where: { id } });
  }

  async listRequestLogs(filters: {
    startDate?: string;
    endDate?: string;
    route?: string;
    statusCode?: number;
    method?: string;
    requestId?: string;
    companyId?: string;
    branchId?: string;
    userId?: string;
    device?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 50;

    const where: Prisma.RequestLogWhereInput = {
      ...(filters.route && { route: filters.route }),
      ...(filters.statusCode !== undefined && { statusCode: filters.statusCode }),
      ...(filters.method && { method: filters.method }),
      ...(filters.requestId && { requestId: filters.requestId }),
      ...(filters.companyId && { companyId: filters.companyId }),
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.device && { device: filters.device }),
      ...((filters.startDate || filters.endDate) && {
        createdAt: {
          ...(filters.startDate && { gte: new Date(filters.startDate) }),
          ...(filters.endDate && { lte: new Date(filters.endDate) }),
        },
      }),
    };

    const [data, total] = await Promise.all([
      prisma.requestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.requestLog.count({ where }),
    ]);

    return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ============================================
  // 7. ALERTAS (computados sob demanda — sem entrega/notificação)
  // ============================================

  /**
   * Calcula o ESTADO atual de cada alerta a partir de thresholds
   * configuráveis via env. Escopo deliberadamente limitado a leitura: NÃO
   * envia email/webhook/notificação nem agenda nada — isso é uma pipeline
   * de entrega de alertas separada, fora do escopo desta tarefa.
   */
  async getAlerts() {
    const thresholds = getAlertThresholds();
    const { start, end } = resolveWindow(undefined, undefined, 24);

    const [metrics, jobsStatus] = await Promise.all([this.computeMetrics(start, end), this.getJobsStatus()]);

    const staleCutoff = new Date(Date.now() - thresholds.deviceHeartbeatStaleHours * 60 * 60 * 1000);
    const staleDeviceCount = await prisma.device.count({
      where: {
        status: 'ACTIVE',
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleCutoff } }],
      },
    });

    const alerts: Array<{
      id: string;
      name: string;
      severity: Severity;
      currentValue: number;
      threshold: number;
      message: string;
    }> = [];

    alerts.push({
      id: 'p95_latency',
      name: 'Latência P95 (24h)',
      severity: severityFor(metrics.p95, thresholds.p95Ms),
      currentValue: metrics.p95,
      threshold: thresholds.p95Ms,
      message: `P95 de requisições nas últimas 24h: ${metrics.p95.toFixed(0)}ms (limite: ${thresholds.p95Ms}ms)`,
    });

    alerts.push({
      id: 'error_rate',
      name: 'Taxa de erro (24h)',
      severity: severityFor(metrics.errorRate, thresholds.errorRate),
      currentValue: metrics.errorRate,
      threshold: thresholds.errorRate,
      message: `Taxa de erro nas últimas 24h: ${(metrics.errorRate * 100).toFixed(2)}% (limite: ${(
        thresholds.errorRate * 100
      ).toFixed(2)}%)`,
    });

    for (const q of jobsStatus.queues) {
      const backlog = q.counts.waiting + q.counts.active;
      alerts.push({
        id: `queue_backlog_${q.queue}`,
        name: `Backlog da fila ${q.queue}`,
        severity: severityFor(backlog, thresholds.queueBacklog),
        currentValue: backlog,
        threshold: thresholds.queueBacklog,
        message: `Fila ${q.queue}: ${backlog} job(s) aguardando/em execução (limite: ${thresholds.queueBacklog})`,
      });
    }

    const auditFailedCount = jobsStatus.deadLetterQueue.auditLogFailedCount;
    alerts.push({
      id: 'dlq_audit_log',
      name: 'DLQ de auditoria (audit-log)',
      severity: severityFor(auditFailedCount, thresholds.queueBacklog),
      currentValue: auditFailedCount,
      threshold: thresholds.queueBacklog,
      message: `${auditFailedCount} job(s) de auditoria falharam e aguardam revisão manual (removeOnFail:false)`,
    });

    alerts.push({
      id: 'device_heartbeat_stale',
      name: 'Dispositivos sem heartbeat',
      severity: staleDeviceCount > 0 ? 'critical' : 'ok',
      currentValue: staleDeviceCount,
      threshold: 0,
      message: `${staleDeviceCount} dispositivo(s) ATIVO(s) sem heartbeat há mais de ${thresholds.deviceHeartbeatStaleHours}h`,
    });

    return alerts;
  }
}

export default new ObservabilityService();
