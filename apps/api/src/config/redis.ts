import Redis from 'ioredis';
import { Logger } from '../services/logger.service';

// Este cliente é usado para cache (cache.service.ts), sessão de login e
// código MFA — NÃO para BullMQ, que abre sua própria conexão separada em
// config/queue.ts (`new Redis(...)` ali, não importa este arquivo). O
// `maxRetriesPerRequest: null` que existia aqui antes era necessário só
// para BullMQ (comandos bloqueantes) — nesta conexão ele fazia qualquer
// `await redis.get/set(...)` (inclusive dentro do try/catch de
// cache.service.ts) nunca resolver nem rejeitar enquanto o Redis estivesse
// fora do ar, travando para sempre qualquer rota que dependesse de cache
// (ex.: criação de venda, que consulta estoque via CacheService). Um limite
// finito garante que essas chamadas falhem rápido e o try/catch existente
// degrade normalmente para "sem cache".
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  // maxRetriesPerRequest baixo + fila offline desligada: um COMANDO
  // individual (get/set) falha rápido em vez de ficar pendurado enquanto o
  // Redis está fora — é isso que evita travar a requisição HTTP.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // retryStrategy é uma coisa DIFERENTE: controla a RECONEXÃO em segundo
  // plano da conexão TCP em si, não comandos individuais. `() => null`
  // (versão anterior deste arquivo) desligava isso por completo — Redis
  // cai, o cliente desiste de vez, e mesmo com o Redis voltando ao ar
  // minutos depois a API continuava reportando "disconnected" para
  // sempre, sem se recuperar sozinha (confirmado: /health preso em
  // DEGRADED com Redis já respondendo PONG). Um backoff com teto curto
  // mantém as duas coisas: comandos falham rápido, mas a conexão volta
  // sozinha assim que o Redis estiver de novo disponível.
  retryStrategy: (times: number) => Math.min(times * 200, 2000),
};

export const redis = new Redis(redisConfig);

redis.on('connect', () => {
  Logger.info('Redis conectado');
});

redis.on('error', (error) => {
  Logger.error('Erro no Redis', { error: error.message });
});

export default redis;
