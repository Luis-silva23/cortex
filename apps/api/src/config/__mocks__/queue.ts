/**
 * Mock global de config/queue.ts para testes — NUNCA deixar um teste
 * carregar o módulo real: ele abre conexões reais de Redis/BullMQ
 * (`new Redis(...)`, `new Worker(...)`) como efeito colateral do `require`,
 * o que trava o processo do Jest indefinidamente quando não há Redis
 * disponível no ambiente (exatamente o que aconteceu antes desta correção:
 * `Logger.security()`/`Logger.critical()` fazem `require('../config/queue')`
 * tardio, e o primeiro teste a exercitar esse caminho sem mock pendurava
 * `npm test` inteiro). Aplicado automaticamente via moduleNameMapper em
 * jest.config.js — nenhum arquivo de teste precisa mockar isto manualmente.
 */

function createMockQueue() {
  return {
    add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getFailed: jest.fn().mockResolvedValue([]),
    getRepeatableJobs: jest.fn().mockResolvedValue([]),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockWorker() {
  return {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    isRunning: jest.fn().mockReturnValue(true),
  };
}

export const emailQueue = createMockQueue();
export const reportQueue = createMockQueue();
export const notificationQueue = createMockQueue();
export const auditQueue = createMockQueue();
export const requestMetricsQueue = createMockQueue();
export const systemLogQueue = createMockQueue();
export const jobQueue = auditQueue;

/** Espelham os exports novos de config/queue.ts (readiness e desligamento ordenado). */
export const workersRunning = jest.fn().mockReturnValue(true);
export const closeQueueInfra = jest.fn().mockResolvedValue(undefined);

export const emailWorker = createMockWorker();
export const reportWorker = createMockWorker();
export const notificationWorker = createMockWorker();
export const auditWorker = createMockWorker();
export const requestMetricsWorker = createMockWorker();
export const systemLogWorker = createMockWorker();
