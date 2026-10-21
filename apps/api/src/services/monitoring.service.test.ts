const getJobsStatus = jest.fn();

jest.mock('@ln-system/database', () => ({
  prisma: {},
  runInTransaction: jest.fn(async () => [{ '?column?': 1 }]),
  runWithRLSContext: jest.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}));
jest.mock('../config/redis', () => ({
  __esModule: true,
  default: { ping: jest.fn(async () => 'PONG'), info: jest.fn(async () => 'used_memory:1048576') },
}));
jest.mock('./observability.service', () => ({ __esModule: true, default: { getJobsStatus: (...a: unknown[]) => getJobsStatus(...a) } }));
// Limites padrão (sem ajuste gravado): o serviço real consultaria o banco.
jest.mock('./monitoring-thresholds.service', () => {
  const actual = jest.requireActual('./monitoring-thresholds.service');
  const defaults = Object.fromEntries(
    Object.entries(actual.MONITORING_METRICS).map(([k, v]: [string, any]) => [k, { ...v.defaults, source: 'DEFAULT' }])
  );
  return { __esModule: true, ...actual, default: { effective: async () => defaults, forCompany: async () => () => defaults } };
});

import { MonitoringService } from './monitoring.service';

const queue = (failed: number, failedAt: Date[], workerRunning = true) => ({
  queue: 'notification',
  counts: { waiting: 0, active: 0, completed: 0, failed, delayed: 0 },
  workerRunning,
  recentFailedJobs: failedAt.map((timestamp, i) => ({ id: String(i), name: 'x', failedReason: 'y', attemptsMade: 1, timestamp })),
});

describe('MonitoringService.centralHealth — estado das filas', () => {
  const service = new MonitoringService();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  it('falhas retidas antigas (defeito já corrigido) não deixam as filas em ATENÇÃO', async () => {
    getJobsStatus.mockResolvedValueOnce({ queues: [queue(173, [hoursAgo(2), hoursAgo(5)])] });
    const { queues } = await service.centralHealth();
    expect(queues).toMatchObject({ status: 'NORMAL', failed: 173, failedLastHour: 0 });
  });

  it('falha na última hora: ATENÇÃO', async () => {
    getJobsStatus.mockResolvedValueOnce({ queues: [queue(3, [hoursAgo(0.1), hoursAgo(3)])] });
    const { queues } = await service.centralHealth();
    expect(queues).toMatchObject({ status: 'ATTENTION', failedLastHour: 1 });
  });

  it('worker parado: CRÍTICO, independentemente das falhas', async () => {
    getJobsStatus.mockResolvedValueOnce({ queues: [queue(0, [], false)] });
    const { queues } = await service.centralHealth();
    expect(queues).toMatchObject({ status: 'CRITICAL', workersDown: 1 });
  });

  it('status das filas indisponível: SEM DADOS (nunca normal)', async () => {
    getJobsStatus.mockRejectedValueOnce(new Error('redis fora'));
    const { queues } = await service.centralHealth();
    expect(queues.status).toBe('NO_DATA');
  });
});
