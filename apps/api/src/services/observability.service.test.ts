/**
 * Testes de ObservabilityService — segue o mesmo padrão de
 * dashboard.service.test.ts: mocka o Prisma Client inteiro (incluindo
 * `$queryRaw`, usado por getMetrics/computeMetrics para os percentis via
 * PERCENTILE_CONT) e alimenta com dados conhecidos.
 */

const requestLogAggregateMock = jest.fn();
const requestLogGroupByMock = jest.fn();
const requestLogFindManyMock = jest.fn();
const requestLogCountMock = jest.fn();
const queryRawMock = jest.fn();
const systemLogCountMock = jest.fn();
const systemLogFindManyMock = jest.fn();
const systemLogFindUniqueMock = jest.fn();
const paymentGroupByMock = jest.fn();
const fiscalDocumentGroupByMock = jest.fn();
const fiscalConfigCountMock = jest.fn();
const deviceCountMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    requestLog: {
      aggregate: requestLogAggregateMock,
      groupBy: requestLogGroupByMock,
      findMany: requestLogFindManyMock,
      count: requestLogCountMock,
    },
    systemLog: {
      count: systemLogCountMock,
      findMany: systemLogFindManyMock,
      findUnique: systemLogFindUniqueMock,
    },
    payment: { groupBy: paymentGroupByMock },
    fiscalDocument: { groupBy: fiscalDocumentGroupByMock },
    fiscalConfig: { count: fiscalConfigCountMock },
    device: { count: deviceCountMock },
    $queryRaw: queryRawMock,
    // `runInTransaction` (SQL cru com o contexto de RLS) abre `$transaction`: aqui o `tx` é o mesmo cliente simulado
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: queryRawMock, $executeRawUnsafe: jest.fn() }),
  })),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, __isSql: true }),
    empty: { strings: [''], values: [], __isSql: true },
  },
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: {
    remember: jest.fn(async (_key: string, _ttl: number, cb: () => Promise<any>) => cb()),
  },
  CacheTTL: { DEFAULT: 3600 },
}));

jest.mock('../config/redis', () => ({
  __esModule: true,
  redis: { ping: jest.fn().mockResolvedValue('PONG') },
  default: { ping: jest.fn().mockResolvedValue('PONG') },
}));

function makeQueueMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getFailed: jest.fn().mockResolvedValue([]),
    getDelayed: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeWorkerMock(running = true) {
  return { isRunning: jest.fn().mockReturnValue(running) };
}

const emailQueueMock = makeQueueMock();
const reportQueueMock = makeQueueMock();
const notificationQueueMock = makeQueueMock();
const auditQueueMock = makeQueueMock();
const requestMetricsQueueMock = makeQueueMock();
const systemLogQueueMock = makeQueueMock();

const emailWorkerMock = makeWorkerMock();
const reportWorkerMock = makeWorkerMock();
const notificationWorkerMock = makeWorkerMock();
const auditWorkerMock = makeWorkerMock();
const requestMetricsWorkerMock = makeWorkerMock();
const systemLogWorkerMock = makeWorkerMock();

jest.mock('../config/queue', () => ({
  emailQueue: emailQueueMock,
  reportQueue: reportQueueMock,
  notificationQueue: notificationQueueMock,
  auditQueue: auditQueueMock,
  requestMetricsQueue: requestMetricsQueueMock,
  systemLogQueue: systemLogQueueMock,
  emailWorker: emailWorkerMock,
  reportWorker: reportWorkerMock,
  notificationWorker: notificationWorkerMock,
  auditWorker: auditWorkerMock,
  requestMetricsWorker: requestMetricsWorkerMock,
  systemLogWorker: systemLogWorkerMock,
}));

import { ObservabilityService, calculatePercentile } from './observability.service';

beforeEach(() => {
  jest.clearAllMocks();
  // Defaults inofensivos usados pela maioria dos testes que não focam
  // nesses aspectos específicos.
  requestLogAggregateMock.mockResolvedValue({ _count: 0, _avg: { durationMs: 0 } });
  requestLogGroupByMock.mockResolvedValue([]);
  queryRawMock.mockResolvedValue([{ p50: null, p95: null, p99: null }]);
  emailQueueMock.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
  reportQueueMock.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
  notificationQueueMock.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
  auditQueueMock.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
  requestMetricsQueueMock.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
  systemLogQueueMock.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
  [emailQueueMock, reportQueueMock, notificationQueueMock, auditQueueMock, requestMetricsQueueMock, systemLogQueueMock].forEach(
    (q) => q.getFailed.mockResolvedValue([])
  );
  deviceCountMock.mockResolvedValue(0);
});

// ============================================
// 1. Matemática de percentil (função pura)
// ============================================

describe('calculatePercentile', () => {
  it('calcula P50/P95/P99 corretamente por interpolação linear para valores conhecidos', () => {
    // 10 valores ordenados: 100..1000 de 100 em 100
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

    // p50 -> idx = 0.5*9 = 4.5 -> interpola entre values[4]=500 e values[5]=600 -> 550
    expect(calculatePercentile(values, 50)).toBeCloseTo(550);
    // p95 -> idx = 0.95*9 = 8.55 -> interpola entre values[8]=900 e values[9]=1000 -> 955
    expect(calculatePercentile(values, 95)).toBeCloseTo(955);
    // p99 -> idx = 0.99*9 = 8.91 -> interpola entre values[8]=900 e values[9]=1000 -> 991
    expect(calculatePercentile(values, 99)).toBeCloseTo(991);
  });

  it('retorna 0 para array vazio e o único valor para array de 1 elemento', () => {
    expect(calculatePercentile([], 95)).toBe(0);
    expect(calculatePercentile([42], 50)).toBe(42);
  });
});

// ============================================
// 2. getMetrics — pós-processamento do resultado do $queryRaw
// ============================================

describe('ObservabilityService.getMetrics', () => {
  const service = new ObservabilityService();

  it('agrega contagem/média, converte percentis do $queryRaw e monta status breakdown/top routes', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 100, _avg: { durationMs: 250 } });
    requestLogGroupByMock
      .mockResolvedValueOnce([
        { statusCode: 200, _count: 80 },
        { statusCode: 404, _count: 15 },
        { statusCode: 500, _count: 5 },
      ])
      .mockResolvedValueOnce([
        { route: '/api/products/:id', _avg: { durationMs: 900 }, _count: 60 },
        { route: '/api/sales', _avg: { durationMs: 100 }, _count: 40 },
      ])
      .mockResolvedValueOnce([{ route: '/api/products/:id', _count: 15 }]);

    // Primeira chamada de $queryRaw = percentis, segunda = série temporal
    queryRawMock.mockResolvedValueOnce([{ p50: 200, p95: 950, p99: 990 }]).mockResolvedValueOnce([
      { bucket: new Date('2026-09-06T10:00:00Z'), count: 10 },
    ]);

    const result = await service.getMetrics({ startDate: '2026-09-05T00:00:00Z', endDate: '2026-09-06T00:00:00Z' });

    expect(result.requestCount).toBe(100);
    expect(result.avgDurationMs).toBe(250);
    expect(result.p50).toBe(200);
    expect(result.p95).toBe(950);
    expect(result.p99).toBe(990);
    // (15+5)/100 = 20%
    expect(result.errorRate).toBeCloseTo(0.2);
    expect(result.statusBreakdown).toEqual({ '2xx': 80, '3xx': 0, '4xx': 15, '5xx': 5 });
    expect(result.topSlowestRoutes[0]).toEqual({ route: '/api/products/:id', avgDurationMs: 900, count: 60 });
    expect(result.topErrorRoutes[0]).toEqual({ route: '/api/products/:id', errorCount: 15, errorRate: 15 / 60 });
    expect(result.requestsOverTime).toEqual([{ bucket: new Date('2026-09-06T10:00:00Z'), count: 10 }]);
  });

  // Decisão 58: a série "requisições ao longo do tempo" é agrupada no fuso de Brasília (antes: UTC; o ponto de 28/09 aparecia como
  // 27/09 21:00). A prova com banco de verdade (virada de dia, mês e ano) está em docs/CORTEX/DECISIONS.md.
  it.each([
    ['24 horas', '2026-10-03T12:00:00Z', '2026-10-04T12:00:00Z', 'hour'],
    ['7 dias', '2026-09-27T12:00:00Z', '2026-10-04T12:00:00Z', 'day'],
  ])('agrupa a série de requisições no fuso America/Sao_Paulo (%s)', async (_label, startDate, endDate, unit) => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 0, _avg: { durationMs: null } });
    requestLogGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    queryRawMock.mockResolvedValueOnce([{ p50: null, p95: null, p99: null }]).mockResolvedValueOnce([]);

    await service.getMetrics({ startDate, endDate });

    const series = queryRawMock.mock.calls[queryRawMock.mock.calls.length - 1][0];
    const sql = series.strings.join('?');
    expect(sql).toMatch(/date_trunc\(\?, \("createdAt" AT TIME ZONE 'UTC'\) AT TIME ZONE \?\) AT TIME ZONE \? AS bucket/);
    expect(series.values.slice(0, 3)).toEqual([unit, 'America/Sao_Paulo', 'America/Sao_Paulo']);
  });

  it('retorna 0 em todos os agregados quando não há requisições no período', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 0, _avg: { durationMs: null } });
    requestLogGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    queryRawMock.mockResolvedValueOnce([{ p50: null, p95: null, p99: null }]).mockResolvedValueOnce([]);

    const result = await service.getMetrics({});

    expect(result.requestCount).toBe(0);
    expect(result.avgDurationMs).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(result.p50).toBe(0);
    expect(result.topSlowestRoutes).toEqual([]);
  });
});

// ============================================
// 3. getJobsStatus — lê os 6 filas/workers reais
// ============================================

describe('ObservabilityService.getJobsStatus', () => {
  const service = new ObservabilityService();

  it('lê job counts e falhas recentes das 6 filas reais e reporta o DLQ implícito de audit-log', async () => {
    auditQueueMock.getJobCounts.mockResolvedValueOnce({ waiting: 1, active: 0, completed: 50, failed: 7, delayed: 0 });
    auditQueueMock.getFailed.mockResolvedValueOnce([
      { id: 'j1', name: 'audit-log', failedReason: 'DB down', attemptsMade: 5, finishedOn: 1700000000000 },
    ]);

    const result = await service.getJobsStatus();

    expect(result.queues.map((q) => q.queue)).toEqual([
      'email',
      'report',
      'notification',
      'audit-log',
      'request-metrics',
      'system-log',
    ]);

    const auditEntry = result.queues.find((q) => q.queue === 'audit-log')!;
    expect(auditEntry.counts.failed).toBe(7);
    expect(auditEntry.recentFailedJobs).toHaveLength(1);
    expect(auditEntry.recentFailedJobs[0].failedReason).toBe('DB down');

    expect(result.deadLetterQueue.auditLogFailedCount).toBe(7);
  });

  it('reporta workerRunning=false sem lançar quando worker.isRunning() lança', async () => {
    emailWorkerMock.isRunning.mockImplementationOnce(() => {
      throw new Error('worker closed');
    });

    const result = await service.getJobsStatus();
    const emailEntry = result.queues.find((q) => q.queue === 'email')!;
    expect(emailEntry.workerRunning).toBe(false);
  });
});

// ============================================
// 4. getAlerts — severidade por threshold
// ============================================

describe('ObservabilityService.getAlerts', () => {
  const service = new ObservabilityService();

  beforeEach(() => {
    process.env.ALERT_P95_THRESHOLD_MS = '2000';
    process.env.ALERT_ERROR_RATE_THRESHOLD = '0.05';
    process.env.ALERT_QUEUE_BACKLOG_THRESHOLD = '100';
    process.env.ALERT_DEVICE_HEARTBEAT_STALE_HOURS = '24';
  });

  it('marca p95_latency como critical quando o valor excede o threshold', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 10, _avg: { durationMs: 100 } });
    requestLogGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    queryRawMock.mockResolvedValueOnce([{ p50: 100, p95: 5000, p99: 6000 }]).mockResolvedValueOnce([]);

    const alerts = await service.getAlerts();
    const p95Alert = alerts.find((a) => a.id === 'p95_latency')!;

    expect(p95Alert.severity).toBe('critical');
    expect(p95Alert.currentValue).toBe(5000);
    expect(p95Alert.threshold).toBe(2000);
  });

  it('marca p95_latency como ok quando o valor está bem abaixo do threshold', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 10, _avg: { durationMs: 100 } });
    requestLogGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    queryRawMock.mockResolvedValueOnce([{ p50: 100, p95: 200, p99: 300 }]).mockResolvedValueOnce([]);

    const alerts = await service.getAlerts();
    const p95Alert = alerts.find((a) => a.id === 'p95_latency')!;

    expect(p95Alert.severity).toBe('ok');
  });

  it('marca o backlog de uma fila como critical quando waiting+active excede o threshold', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 0, _avg: { durationMs: 0 } });
    requestLogGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    queryRawMock.mockResolvedValueOnce([{ p50: 0, p95: 0, p99: 0 }]).mockResolvedValueOnce([]);
    reportQueueMock.getJobCounts.mockResolvedValueOnce({ waiting: 80, active: 30, completed: 0, failed: 0, delayed: 0 });

    const alerts = await service.getAlerts();
    const reportBacklogAlert = alerts.find((a) => a.id === 'queue_backlog_report')!;

    expect(reportBacklogAlert.currentValue).toBe(110);
    expect(reportBacklogAlert.severity).toBe('critical');
  });

  it('marca device_heartbeat_stale como critical quando há dispositivos sem heartbeat e ok quando não há', async () => {
    requestLogAggregateMock.mockResolvedValue({ _count: 0, _avg: { durationMs: 0 } });
    requestLogGroupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([{ p50: 0, p95: 0, p99: 0 }]);

    deviceCountMock.mockResolvedValueOnce(3);
    let alerts = await service.getAlerts();
    expect(alerts.find((a) => a.id === 'device_heartbeat_stale')!.severity).toBe('critical');

    deviceCountMock.mockResolvedValueOnce(0);
    alerts = await service.getAlerts();
    expect(alerts.find((a) => a.id === 'device_heartbeat_stale')!.severity).toBe('ok');
  });

  // ----------------------------------------------------------------
  // Casos de fronteira de severityFor: exatamente no threshold (deve ser
  // 'warning', pois a regra é `value > threshold` para critical, não >=),
  // logo abaixo de 80% do threshold ('ok') e logo acima de 80% ('warning').
  // O teste original só cobria "bem acima" (critical) e "bem abaixo" (ok).
  // ----------------------------------------------------------------

  it('marca p95_latency como warning (não critical) quando o valor é EXATAMENTE igual ao threshold', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 10, _avg: { durationMs: 100 } });
    requestLogGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    // threshold default = 2000ms; valor exatamente igual ao threshold
    queryRawMock.mockResolvedValueOnce([{ p50: 100, p95: 2000, p99: 2000 }]).mockResolvedValueOnce([]);

    const alerts = await service.getAlerts();
    const p95Alert = alerts.find((a) => a.id === 'p95_latency')!;

    expect(p95Alert.severity).toBe('warning');
  });

  it('marca p95_latency como warning quando o valor está logo ACIMA de 80% do threshold, e ok logo ABAIXO', async () => {
    // threshold default = 2000ms -> 80% = 1600ms
    requestLogAggregateMock.mockResolvedValue({ _count: 10, _avg: { durationMs: 100 } });
    requestLogGroupByMock.mockResolvedValue([]);

    queryRawMock.mockResolvedValueOnce([{ p50: 100, p95: 1601, p99: 1601 }]).mockResolvedValueOnce([]);
    let alerts = await service.getAlerts();
    expect(alerts.find((a) => a.id === 'p95_latency')!.severity).toBe('warning');

    queryRawMock.mockResolvedValueOnce([{ p50: 100, p95: 1600, p99: 1600 }]).mockResolvedValueOnce([]);
    alerts = await service.getAlerts();
    // exatamente 80% do threshold: a regra é `value > threshold * 0.8`, logo
    // igual a 80% ainda é 'ok', não 'warning'.
    expect(alerts.find((a) => a.id === 'p95_latency')!.severity).toBe('ok');

    queryRawMock.mockResolvedValueOnce([{ p50: 100, p95: 1599, p99: 1599 }]).mockResolvedValueOnce([]);
    alerts = await service.getAlerts();
    expect(alerts.find((a) => a.id === 'p95_latency')!.severity).toBe('ok');
  });

  it('marca queue_backlog como critical apenas quando estritamente MAIOR que o threshold (limite exato = warning)', async () => {
    requestLogAggregateMock.mockResolvedValue({ _count: 0, _avg: { durationMs: 0 } });
    requestLogGroupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([{ p50: 0, p95: 0, p99: 0 }]);

    // threshold default = 100; waiting+active = 100 exatamente
    reportQueueMock.getJobCounts.mockResolvedValueOnce({ waiting: 100, active: 0, completed: 0, failed: 0, delayed: 0 });
    let alerts = await service.getAlerts();
    let reportBacklogAlert = alerts.find((a) => a.id === 'queue_backlog_report')!;
    expect(reportBacklogAlert.currentValue).toBe(100);
    expect(reportBacklogAlert.severity).toBe('warning');

    // 101 -> estritamente acima -> critical
    reportQueueMock.getJobCounts.mockResolvedValueOnce({ waiting: 101, active: 0, completed: 0, failed: 0, delayed: 0 });
    alerts = await service.getAlerts();
    reportBacklogAlert = alerts.find((a) => a.id === 'queue_backlog_report')!;
    expect(reportBacklogAlert.currentValue).toBe(101);
    expect(reportBacklogAlert.severity).toBe('critical');
  });

  it('marca error_rate como warning quando exatamente igual ao threshold configurado', async () => {
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 10, _avg: { durationMs: 0 } });
    // 5% de 10 = 0.5 -> usar 100 requisições para caber em contagem inteira: 5 erros / 100 = 5% = threshold default
    requestLogAggregateMock.mockReset();
    requestLogAggregateMock.mockResolvedValueOnce({ _count: 100, _avg: { durationMs: 0 } });
    requestLogGroupByMock
      .mockResolvedValueOnce([
        { statusCode: 200, _count: 95 },
        { statusCode: 500, _count: 5 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    queryRawMock.mockResolvedValueOnce([{ p50: 0, p95: 0, p99: 0 }]).mockResolvedValueOnce([]);

    const alerts = await service.getAlerts();
    const errorRateAlert = alerts.find((a) => a.id === 'error_rate')!;

    expect(errorRateAlert.currentValue).toBeCloseTo(0.05);
    expect(errorRateAlert.severity).toBe('warning');
  });
});

// ============================================
// 5. listSystemLogs — combinação de filtros no `where`
// ============================================

describe('ObservabilityService.listSystemLogs', () => {
  const service = new ObservabilityService();

  it('combina apenas os filtros informados no where do Prisma', async () => {
    systemLogFindManyMock.mockResolvedValueOnce([]);
    systemLogCountMock.mockResolvedValueOnce(0);

    await service.listSystemLogs({
      level: 'ERROR',
      category: 'security',
      event: 'LOGIN',
      companyId: 'company-A',
      startDate: '2026-09-01T00:00:00Z',
      page: 2,
      limit: 20,
    });

    expect(systemLogFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          level: 'ERROR',
          category: 'security',
          event: { contains: 'LOGIN', mode: 'insensitive' },
          companyId: 'company-A',
          createdAt: { gte: new Date('2026-09-01T00:00:00Z') },
        },
        skip: 20,
        take: 20,
      })
    );
  });

  it('não filtra por nenhum campo quando nenhum filtro é informado (apenas paginação default)', async () => {
    systemLogFindManyMock.mockResolvedValueOnce([]);
    systemLogCountMock.mockResolvedValueOnce(0);

    const result = await service.listSystemLogs({});

    expect(systemLogFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 50 })
    );
    expect(result.pagination).toEqual({ page: 1, limit: 50, total: 0, pages: 0 });
  });

  it('limita `limit` a no máximo 200', async () => {
    systemLogFindManyMock.mockResolvedValueOnce([]);
    systemLogCountMock.mockResolvedValueOnce(0);

    await service.listSystemLogs({ limit: 500 });

    expect(systemLogFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });
});
