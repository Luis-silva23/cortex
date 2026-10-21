import { Router, Request, Response } from 'express';
import { prisma } from '@ln-system/database';
import { redis as redisClient } from '../config/redis';
import { workersRunning } from '../config/queue';
import { isShuttingDown } from '../config/shutdown';

const router = Router();

// Cada verificação tem prazo curto e previsível: a sonda nunca pendura (um banco ou Redis fora do ar vira "caiu", não "travou").
const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// ioredis é configurado com maxRetriesPerRequest: null (exigido pelo BullMQ para comandos bloqueantes) — isso faz redis.ping() esperar
// para sempre enquanto o Redis estiver indisponível, em vez de rejeitar. O prazo garante que a sonda responda "degraded" rápido.
const pingRedis = () => withTimeout(redisClient.ping().then(() => undefined), CHECK_TIMEOUT_MS, 'Redis ping');
// `SELECT 1` no Postgres: o pool frio ou a rede ruim não deixam a sonda pendurada.
const pingDatabase = () => withTimeout(Promise.resolve(prisma.$queryRaw`SELECT 1`).then(() => undefined), CHECK_TIMEOUT_MS, 'Database ping');

const ok = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false
  );

/**
 * @route   GET /api/health
 * @desc    Estado detalhado (banco, Redis, workers). 200 só com tudo de pé e fora de desligamento; 503 caso contrário.
 * @access  Public (sem dado de negócio, sem detalhe técnico de erro)
 */
router.get('/', async (_req: Request, res: Response) => {
  const draining = isShuttingDown();
  const [database, redis] = await Promise.all([ok(pingDatabase()), ok(pingRedis())]);
  const workers = workersRunning();

  const healthy = database && redis && workers && !draining;
  res.status(healthy ? 200 : 503).json({
    uptime: process.uptime(),
    message: draining ? 'DRAINING' : healthy ? 'OK' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    services: {
      database: database ? 'connected' : 'disconnected',
      redis: redis ? 'connected' : 'disconnected',
      // `queue` = a conexão da fila (Redis) está de pé; `workers` = os processadores de fila estão rodando neste processo.
      queue: redis ? 'connected' : 'disconnected',
      workers: workers ? 'running' : 'stopped',
    },
  });
});

/**
 * @route   GET /api/health/ready
 * @desc    Prontidão: a instância pode receber tráfego? Banco, Redis e workers de pé e fora de desligamento. Durante o desligamento
 *          responde 503 para o balanceador tirar a instância da rotação ANTES de o HTTP fechar.
 * @access  Public
 */
router.get('/ready', async (_req: Request, res: Response) => {
  if (isShuttingDown()) return res.status(503).json({ status: 'draining' });
  const [database, redis] = await Promise.all([ok(pingDatabase()), ok(pingRedis())]);
  const workers = workersRunning();
  if (database && redis && workers) return res.status(200).json({ status: 'ready' });
  // Só diz QUAL dependência está fora; nunca a mensagem do erro (pode trazer host, usuário ou detalhe de conexão).
  return res.status(503).json({ status: 'not ready', failing: [!database && 'database', !redis && 'redis', !workers && 'workers'].filter(Boolean) });
});

/**
 * @route   GET /api/health/live
 * @desc    Vida: o processo responde. Não consulta dependência (um banco fora do ar não deve fazer o orquestrador REINICIAR a API).
 *          Continua 200 durante o desligamento (o processo ainda está drenando).
 * @access  Public
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive' });
});

export default router;
