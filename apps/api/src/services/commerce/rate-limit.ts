import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import redis from '../../config/redis';

/**
 * Limites da Commerce API. Dois baldes:
 *  - por CREDENCIAL (`keyId`): protege o CÓRTEX de um canal ruidoso ou comprometido, sem afetar os outros canais nem o PDV;
 *  - por IP, só para FALHAS de autenticação: barra a varredura de chaves.
 * Redis-backed com `insuranceLimiter` em memória: se o Redis cair, o limite continua valendo (por instância) em vez de sumir.
 * Redis aqui é só contador; nada de negócio depende dele.
 */
const perCredentialPoints = Number(process.env.COMMERCE_RATE_LIMIT_PER_MIN) || 300;
const authFailurePoints = Number(process.env.COMMERCE_AUTH_FAILURES_PER_MIN) || 20;

function build(prefix: string, points: number, duration: number) {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `commerce_${prefix}`,
    points,
    duration,
    insuranceLimiter: new RateLimiterMemory({ keyPrefix: `commerce_${prefix}_mem`, points, duration }),
  });
}

const credentialLimiter = build('cred', perCredentialPoints, 60);
const authFailureLimiter = build('authfail', authFailurePoints, 60);

export interface LimitResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
  limit: number;
}

function retryAfter(msBeforeNext: number | undefined) {
  return Math.max(1, Math.ceil((msBeforeNext ?? 1000) / 1000));
}

/** Consome 1 ponto da credencial. Erro do próprio limitador não derruba o canal: segue permitido (o seguro em memória já cobre o Redis fora). */
export async function consumeCredential(keyId: string): Promise<LimitResult> {
  try {
    const r = await credentialLimiter.consume(keyId, 1);
    return { allowed: true, retryAfterSec: 0, remaining: r.remainingPoints, limit: perCredentialPoints };
  } catch (err: any) {
    if (err && typeof err.msBeforeNext === 'number') return { allowed: false, retryAfterSec: retryAfter(err.msBeforeNext), remaining: 0, limit: perCredentialPoints };
    return { allowed: true, retryAfterSec: 0, remaining: perCredentialPoints, limit: perCredentialPoints };
  }
}

/** O IP já estourou o limite de falhas de autenticação? (não consome ponto) */
export async function isAuthBlocked(ip: string): Promise<boolean> {
  try {
    const r = await authFailureLimiter.get(ip);
    return !!r && r.consumedPoints >= authFailurePoints;
  } catch {
    return false;
  }
}

export async function noteAuthFailure(ip: string): Promise<void> {
  try {
    await authFailureLimiter.consume(ip, 1);
  } catch {
    // estourou o limite ou o contador falhou: o bloqueio é verificado por `isAuthBlocked`
  }
}

/** Só para testes: zera os contadores de uma chave. */
export async function resetCommerceLimits(keys: { keyId?: string; ip?: string }) {
  if (keys.keyId) await credentialLimiter.delete(keys.keyId).catch(() => undefined);
  if (keys.ip) await authFailureLimiter.delete(keys.ip).catch(() => undefined);
}
