/**
 * Testes de retenção/limpeza de logs (`cleanupOldLogs`, chamada internamente
 * por `processScheduledJob('cleanup-old-logs', ...)` — a função em si não é
 * exportada). Objetivo: travar que os três `deleteMany` (AuditLog/SystemLog/
 * RequestLog) usam `createdAt: { lt: <cutoff> }` com o cutoff relativo correto
 * por env var (com os defaults documentados em scheduler.ts), para que uma
 * futura edição não apague dados recentes por engano nem pare de apagar nada.
 *
 * `scheduler.ts` chama `setupRecurringJobs()` como efeito colateral no
 * import do módulo — por isso `notificationQueue` (e tudo mais que o módulo
 * toca no import) precisa estar mockado ANTES do `import` do módulo.
 */

const auditLogDeleteManyMock = jest.fn().mockResolvedValue({ count: 0 });
const systemLogDeleteManyMock = jest.fn().mockResolvedValue({ count: 0 });
const requestLogDeleteManyMock = jest.fn().mockResolvedValue({ count: 0 });
const idempotencyDeleteManyMock = jest.fn().mockResolvedValue({ count: 0 });

jest.mock('@ln-system/database', () => ({
  prisma: {
    auditLog: { deleteMany: auditLogDeleteManyMock },
    systemLog: { deleteMany: systemLogDeleteManyMock },
    requestLog: { deleteMany: requestLogDeleteManyMock },
      deviceTelemetry: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      healthIncident: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    idempotencyKey: { deleteMany: idempotencyDeleteManyMock },
  },
  runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn(),
  // expurgo de audit_logs roda numa transação que liga `app.audit_purge` (audit_logs é append-only)
  runInTransaction: (fn: (tx: unknown) => unknown) =>
    fn({ $executeRaw: jest.fn().mockResolvedValue(1), auditLog: { deleteMany: auditLogDeleteManyMock } }),
}));

jest.mock('../services/logger.service', () => ({
  Logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    job: jest.fn(),
  },
}));

const notificationQueueMock = {
  getRepeatableJobs: jest.fn().mockResolvedValue([]),
  removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
  add: jest.fn().mockResolvedValue(undefined),
};

jest.mock('./queue', () => ({
  notificationQueue: notificationQueueMock,
}));

jest.mock('../jobs/notification.job', () => ({
  checkExpiringLicenses: jest.fn().mockResolvedValue(undefined),
  checkLowStockProducts: jest.fn().mockResolvedValue(undefined),
}));

import { processScheduledJob } from './scheduler';

const FIXED_NOW = new Date('2026-09-06T12:00:00.000Z').getTime();

function daysBeforeNow(days: number): Date {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Compara datas por dia. `scheduler.ts` usa `new Date()` + `.setDate(...)`
 * (fuso horário LOCAL, não UTC) para calcular o cutoff, então a comparação
 * também precisa usar os getters locais — comparar em UTC daria falso
 * negativo em qualquer fuso diferente de UTC+0.
 */
function expectSameDay(actual: Date, expected: Date) {
  expect(actual.getFullYear()).toBe(expected.getFullYear());
  expect(actual.getMonth()).toBe(expected.getMonth());
  expect(actual.getDate()).toBe(expected.getDate());
}

describe('scheduler cleanupOldLogs (via processScheduledJob("cleanup-old-logs"))', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // `new Date()` (usado por scheduler.ts) não respeita um `Date.now`
    // sobrescrito manualmente no V8 — é preciso fake timers para congelar
    // o "agora" de verdade.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(FIXED_NOW);
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AUDIT_LOG_RETENTION_DAYS;
    delete process.env.SYSTEM_LOG_RETENTION_DAYS;
    delete process.env.REQUEST_LOG_RETENTION_DAYS;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('usa os defaults: AuditLog 90 dias, SystemLog 90 dias, RequestLog 30 dias', async () => {
    await processScheduledJob('cleanup-old-logs', {});

    expect(auditLogDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(systemLogDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(requestLogDeleteManyMock).toHaveBeenCalledTimes(1);

    const auditArg = auditLogDeleteManyMock.mock.calls[0][0];
    const systemArg = systemLogDeleteManyMock.mock.calls[0][0];
    const requestArg = requestLogDeleteManyMock.mock.calls[0][0];

    // Formato do filtro: createdAt: { lt: <cutoff> } — nunca gt/gte (que
    // apagaria os dados ERRADOS, os recentes em vez dos antigos) e nunca
    // sem filtro (que apagaria a tabela inteira).
    expect(Object.keys(auditArg.where)).toEqual(['createdAt']);
    expect(Object.keys(auditArg.where.createdAt)).toEqual(['lt']);
    expect(auditArg.where.createdAt.lt).toBeInstanceOf(Date);

    expectSameDay(auditArg.where.createdAt.lt, daysBeforeNow(90));
    expectSameDay(systemArg.where.createdAt.lt, daysBeforeNow(90));
    expectSameDay(requestArg.where.createdAt.lt, daysBeforeNow(30));

    // RequestLog (alto volume, sem valor de compliance) tem retenção
    // estritamente menor que AuditLog/SystemLog (dados de auditoria/segurança).
    expect(requestArg.where.createdAt.lt.getTime()).toBeGreaterThan(auditArg.where.createdAt.lt.getTime());
    expect(requestArg.where.createdAt.lt.getTime()).toBeGreaterThan(systemArg.where.createdAt.lt.getTime());
  });

  it('expurga as Idempotency-Keys VENCIDAS (expiresAt < agora) — nunca as vigentes, nunca sem filtro', async () => {
    await processScheduledJob('cleanup-old-logs', {});

    expect(idempotencyDeleteManyMock).toHaveBeenCalledTimes(1);
    const arg = idempotencyDeleteManyMock.mock.calls[0][0];
    expect(Object.keys(arg.where)).toEqual(['expiresAt']);
    expect(Object.keys(arg.where.expiresAt)).toEqual(['lt']);
    expect(arg.where.expiresAt.lt.getTime()).toBe(FIXED_NOW);
  });

  it('respeita AUDIT_LOG_RETENTION_DAYS/SYSTEM_LOG_RETENTION_DAYS/REQUEST_LOG_RETENTION_DAYS quando configuradas', async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = '180';
    process.env.SYSTEM_LOG_RETENTION_DAYS = '45';
    process.env.REQUEST_LOG_RETENTION_DAYS = '7';

    await processScheduledJob('cleanup-old-logs', {});

    const auditArg = auditLogDeleteManyMock.mock.calls[0][0];
    const systemArg = systemLogDeleteManyMock.mock.calls[0][0];
    const requestArg = requestLogDeleteManyMock.mock.calls[0][0];

    expectSameDay(auditArg.where.createdAt.lt, daysBeforeNow(180));
    expectSameDay(systemArg.where.createdAt.lt, daysBeforeNow(45));
    expectSameDay(requestArg.where.createdAt.lt, daysBeforeNow(7));
  });

  it('não apaga nada além do que o cutoff determina: o cutoff nunca é uma data futura', async () => {
    await processScheduledJob('cleanup-old-logs', {});

    const now = new Date(FIXED_NOW);
    for (const mock of [auditLogDeleteManyMock, systemLogDeleteManyMock, requestLogDeleteManyMock]) {
      const arg = mock.mock.calls[0][0];
      expect(arg.where.createdAt.lt.getTime()).toBeLessThan(now.getTime());
    }
  });
});
