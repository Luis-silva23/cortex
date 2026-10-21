import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import redis from '../config/redis';

/**
 * Limites das rotas PÚBLICAS de enrolamento de equipamento (`/api/device/*`): quem chama ainda não tem identidade, então o freio é por
 * IP. Redis-backed com seguro em memória (se o Redis cair, o limite continua valendo por instância). Nada de negócio depende do Redis.
 *  - enrolar: poucos pedidos por IP e por hora (cada um cria uma linha pendente que alguém terá de analisar);
 *  - consultar o estado: o aplicativo consulta de tempos em tempos; o que é bloqueado é a FALHA repetida (chave errada), por IP.
 */
const enrollPerHour = Number(process.env.DEVICE_ENROLL_PER_HOUR) || 10;
const statusFailuresPerMin = Number(process.env.DEVICE_STATUS_FAILURES_PER_MIN) || 20;

function build(prefix: string, points: number, duration: number) {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `device_${prefix}`,
    points,
    duration,
    insuranceLimiter: new RateLimiterMemory({ keyPrefix: `device_${prefix}_mem`, points, duration }),
  });
}

const enrollLimiter = build('enroll', enrollPerHour, 3600);
const statusFailLimiter = build('statusfail', statusFailuresPerMin, 60);

/** Consome 1 enrolamento do IP. Devolve os segundos até poder tentar de novo quando estourou, ou 0 se passou. */
export async function consumeEnroll(ip: string): Promise<number> {
  try {
    await enrollLimiter.consume(ip, 1);
    return 0;
  } catch (err: any) {
    if (err && typeof err.msBeforeNext === 'number') return Math.max(1, Math.ceil(err.msBeforeNext / 1000));
    return 0; // erro do próprio limitador não derruba o enrolamento (o seguro em memória já cobre o Redis fora)
  }
}

export async function isStatusBlocked(ip: string): Promise<boolean> {
  try {
    const r = await statusFailLimiter.get(ip);
    return !!r && r.consumedPoints >= statusFailuresPerMin;
  } catch {
    return false;
  }
}

export async function noteStatusFailure(ip: string): Promise<void> {
  try {
    await statusFailLimiter.consume(ip, 1);
  } catch {
    // estourou o limite ou o contador falhou: o bloqueio é verificado por `isStatusBlocked`
  }
}

/** Só para teste. */
export async function resetDeviceLimits(ip: string) {
  await enrollLimiter.delete(ip).catch(() => undefined);
  await statusFailLimiter.delete(ip).catch(() => undefined);
}
