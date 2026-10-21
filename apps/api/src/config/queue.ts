import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Logger } from '../services/logger.service';
import { processEmailJob } from '../jobs/email.job';
import { processReportJob } from '../jobs/report.job';
import { processNotificationJob } from '../jobs/notification.job';
import { processAuditJob } from '../jobs/audit.job';
import { processRequestLogJob, processSystemLogJob } from '../jobs/observability.job';
import { SCHEDULED_JOB_NAMES } from './scheduled-jobs';

// Logger é uma classe com métodos estáticos, não um singleton com getInstance().
const logger = Logger;

// `db` igual ao de config/redis.ts. Sem ele as filas ficavam sempre no db 0: a suíte de integração (REDIS_DB=1)
// publicava jobs que o worker do app em execução consumia e gravava no banco de dev (auditoria de empresas
// sintéticas falhando por FK), e os workers da suíte podiam consumir jobs reais e gravá-los no banco de teste.
const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: null,
});

// Queues
export const emailQueue = new Queue('email', {
  connection,
  prefix: 'ln-system',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: {
      age: 24 * 3600, // 24 horas
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // 7 dias
    },
  },
});

export const reportQueue = new Queue('report', {
  connection,
  prefix: 'ln-system',
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: {
      age: 7 * 24 * 3600, // 7 dias
      count: 100,
    },
    removeOnFail: {
      age: 30 * 24 * 3600, // 30 dias
    },
  },
});

export const notificationQueue = new Queue('notification', {
  connection,
  prefix: 'ln-system',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: {
      age: 24 * 3600, // 24 horas
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // 7 dias
    },
  },
});

// Fila de auditoria — usada por middleware/audit.ts (auditLog). Antes deste
// fix, o middleware referenciava uma fila `jobQueue` que nunca existiu neste
// arquivo, então toda ação auditada lançava um erro em tempo de execução.
export const auditQueue = new Queue('audit-log', {
  connection,
  prefix: 'ln-system',
  defaultJobOptions: {
    attempts: 5, // auditoria é sensível, vale mais tentativas
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
    removeOnComplete: {
      age: 30 * 24 * 3600, // 30 dias
      count: 5000,
    },
    removeOnFail: false, // nunca descartar falha de auditoria sem revisão manual (DLQ implícita)
  },
});

// Fila de métricas de requisição — alto volume, baixa criticidade individual
// (uma métrica perdida não compromete nada; um dia inteiro perdido, sim —
// por isso `attempts` baixo e `removeOnFail` finito, ao contrário da fila
// de auditoria).
export const requestMetricsQueue = new Queue('request-metrics', {
  connection,
  prefix: 'ln-system',
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: { age: 6 * 3600, count: 5000 },
    removeOnFail: { age: 24 * 3600, count: 1000 },
  },
});

// Fila de logs técnicos (segurança/integração/erros de aplicação/performance).
export const systemLogQueue = new Queue('system-log', {
  connection,
  prefix: 'ln-system',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 24 * 3600, count: 5000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
  },
});

// Workers
export const emailWorker = new Worker(
  'email',
  async (job) => {
    if (job.name === 'send-email') {
      return await processEmailJob(job);
    }
    throw new Error(`Unknown email job: ${job.name}`);
  },
  {
    connection,
    prefix: 'ln-system',
    concurrency: 5,
  }
);

export const reportWorker = new Worker(
  'report',
  async (job) => {
    if (job.name === 'generate-report') {
      return await processReportJob(job);
    }
    throw new Error(`Unknown report job: ${job.name}`);
  },
  {
    connection,
    prefix: 'ln-system',
    concurrency: 2,
  }
);

export const notificationWorker = new Worker(
  'notification',
  async (job) => {
    if (job.name === 'process-notification') {
      return await processNotificationJob(job);
    }

    // Jobs recorrentes de setupRecurringJobs (scheduler.ts): lista única em scheduled-jobs.ts. Import tardio (require)
    // para evitar dependência circular queue.ts <-> scheduler.ts.
    if (SCHEDULED_JOB_NAMES.includes(job.name)) {
      const { processScheduledJob } = require('./scheduler');
      return await processScheduledJob(job.name, job.data);
    }

    throw new Error(`Unknown notification job: ${job.name}`);
  },
  {
    connection,
    prefix: 'ln-system',
    concurrency: 10,
  }
);

export const auditWorker = new Worker(
  'audit-log',
  async (job) => {
    if (job.name === 'audit-log') {
      return await processAuditJob(job);
    }
    throw new Error(`Unknown audit job: ${job.name}`);
  },
  {
    connection,
    prefix: 'ln-system',
    concurrency: 10,
  }
);

// Alias mantido para compatibilidade com o nome já usado em middleware/audit.ts.
export const jobQueue = auditQueue;

export const requestMetricsWorker = new Worker(
  'request-metrics',
  async (job) => {
    if (job.name === 'request-log') {
      return await processRequestLogJob(job);
    }
    throw new Error(`Unknown request-metrics job: ${job.name}`);
  },
  { connection, prefix: 'ln-system', concurrency: 10 }
);

export const systemLogWorker = new Worker(
  'system-log',
  async (job) => {
    if (job.name === 'system-log') {
      return await processSystemLogJob(job);
    }
    throw new Error(`Unknown system-log job: ${job.name}`);
  },
  { connection, prefix: 'ln-system', concurrency: 10 }
);

requestMetricsWorker.on('failed', (job, error) => {
  // Não usa logger.error aqui de propósito: um erro aqui não deve, por sua
  // vez, tentar reenfileirar outro system-log (evita loop). Console é
  // suficiente para esta fila de baixa criticidade.
  console.error('Request metrics job failed', { jobId: job?.id, error: error.message });
});

systemLogWorker.on('failed', (job, error) => {
  console.error('System log job failed', { jobId: job?.id, error: error.message });
});

// Event handlers
emailWorker.on('completed', (job) => {
  logger.job(job.name, 'completed', { jobId: job.id });
});

emailWorker.on('failed', (job, error) => {
  logger.error('Email job failed', {
    jobId: job?.id,
    name: job?.name,
    error: error.message,
  });
});

reportWorker.on('completed', (job) => {
  logger.job(job.name, 'completed', { jobId: job.id });
});

reportWorker.on('failed', (job, error) => {
  logger.error('Report job failed', {
    jobId: job?.id,
    name: job?.name,
    error: error.message,
  });
});

notificationWorker.on('completed', (job) => {
  logger.job(job.name, 'completed', { jobId: job.id });
});

notificationWorker.on('failed', (job, error) => {
  logger.error('Notification job failed', {
    jobId: job?.id,
    name: job?.name,
    error: error.message,
  });
});

auditWorker.on('completed', (job) => {
  logger.job(job.name, 'completed', { jobId: job.id });
});

auditWorker.on('failed', (job, error) => {
  // Falha de auditoria é séria: loga como erro para ficar visível em
  // dashboards/alertas, não apenas nos logs de job comuns.
  logger.error('AUDIT JOB FAILED — registro de auditoria pode ter sido perdido', {
    jobId: job?.id,
    name: job?.name,
    data: job?.data,
    error: error.message,
  });
});

/** Workers vivos? (readiness: um processo sem worker aceita HTTP mas nunca processa auditoria, relatório nem rotinas.) */
export function workersRunning(): boolean {
  return [emailWorker, reportWorker, notificationWorker, auditWorker, requestMetricsWorker, systemLogWorker].every((w) => w.isRunning() && !w.closing);
}

/**
 * Encerramento ORDENADO das filas, chamado por `config/shutdown.ts` DEPOIS que o HTTP foi drenado (antes, este arquivo tinha o seu
 * próprio handler de SIGTERM que chamava `process.exit(0)` assim que os workers fechavam e matava requisições em andamento).
 * `worker.close()` espera os jobs ativos terminarem; o prazo total é do orquestrador de desligamento.
 */
export async function closeQueueInfra(): Promise<void> {
  logger.info('Encerrando workers e filas...');
  await Promise.all([emailWorker.close(), reportWorker.close(), notificationWorker.close(), auditWorker.close(), requestMetricsWorker.close(), systemLogWorker.close()]);
  await Promise.all([emailQueue.close(), reportQueue.close(), notificationQueue.close(), auditQueue.close(), requestMetricsQueue.close(), systemLogQueue.close()]);
  await connection.quit().catch(() => connection.disconnect());
}

// Só sob Jest (suíte de integração): os 6 workers acima nascem na importação e, sem isto, continuam vivos DEPOIS do arquivo de teste,
// consumindo jobs dos arquivos seguintes com um cliente do banco já fechado — que reconecta e vaza o pool (era a causa do "Too many
// database connections opened" intermitente; ver test/integration/pgSafeEnvironment.js). Em produção nada disto existe.
if (process.env.JEST_WORKER_ID) (globalThis as { __ln_queue_close?: () => Promise<void> }).__ln_queue_close = closeQueueInfra;

logger.info('Queue workers initialized', {
  queues: ['email', 'report', 'notification', 'audit-log'],
});
