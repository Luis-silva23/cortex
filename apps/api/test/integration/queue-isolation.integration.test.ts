import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { auditQueue } from '../../src/config/queue';

/**
 * As filas da suíte de integração ficam no Redis db de teste (REDIS_DB=1, setupIntegrationEnv.ts), como cache e rate
 * limit. Antes as filas ignoravam REDIS_DB e ficavam no db 0: o worker do app de dev consumia os jobs da suíte (e
 * vice-versa), gravando auditoria no banco errado.
 */
describe('Isolamento das filas BullMQ da suíte de integração', () => {
  it('a conexão das filas usa o REDIS_DB de teste', async () => {
    const client = await auditQueue.client;
    expect(String(process.env.REDIS_DB)).not.toBe('0');
    expect(client.options.db).toBe(Number(process.env.REDIS_DB));
  });

  it('um job publicado pela suíte não aparece na fila do db 0 (a do app em execução)', async () => {
    const jobId = `isolation-probe-${Date.now()}`;
    // Atrasado: nenhum worker o processa durante o teste.
    const job = await auditQueue.add('isolation-probe', { jobId }, { jobId, delay: 60_000 });
    const devConnection = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
      maxRetriesPerRequest: null,
    });
    const devQueue = new Queue('audit-log', { connection: devConnection, prefix: 'ln-system' });
    try {
      expect(await devQueue.getJob(jobId)).toBeUndefined();
      expect(await auditQueue.getJob(jobId)).toBeDefined();
    } finally {
      await job.remove();
      await devQueue.close();
      await devConnection.quit();
    }
  });
});
