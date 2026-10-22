import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '@ln-system/shared/utils/token';

/**
 * Rate limiter configurations
 *
 * auth/mfa são chaveados por IP quando ainda não há usuário autenticado
 * (login em si), então em teste de concorrência local todos os agentes
 * batendo em localhost:3001 compartilham o MESMO balde de 5 tentativas/1h
 * de bloqueio — isso é esperado/correto em produção (um IP não deveria
 * conseguir força bruta ilimitada), mas inviabiliza simular várias
 * empresas/operadores reais a partir de uma única máquina de teste.
 * RATE_LIMIT_TEST_MODE=1 (só setado no .env de teste local, nunca em
 * produção) afrouxa esses dois limites sem remover a proteção — general/
 * upload/passwordReset continuam nos valores de produção.
 */
const TEST_MODE = process.env.RATE_LIMIT_TEST_MODE === '1';

function verifiedUserId(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  try {
    return verifyAccessToken(header.substring(7)).userId;
  } catch {
    return undefined;
  }
}

const RATE_LIMIT_CONFIGS = {
  // General API requests
  general: {
    points: 100, // Number of requests
    duration: 60, // Per 60 seconds
    blockDuration: 60, // Block for 60 seconds if exceeded
  },
  // Authentication endpoints (stricter)
  auth: {
    points: TEST_MODE ? 2000 : 5,
    duration: 900, // Per 15 minutes
    blockDuration: TEST_MODE ? 5 : 3600,
  },
  // MFA verification (very strict)
  mfa: {
    points: TEST_MODE ? 2000 : 3,
    duration: 300, // Per 5 minutes
    blockDuration: TEST_MODE ? 5 : 1800,
  },
  // Segunda autorização de operação (cancelar/devolver venda, sangria): senha/MFA de OUTRO usuário.
  // Balde próprio: antes dividia o de `mfa` com o login, e um operador bloqueava o MFA da loja inteira.
  authorizer: {
    points: TEST_MODE ? 2000 : 3,
    duration: 300,
    blockDuration: TEST_MODE ? 5 : 1800,
  },
  // File upload
  upload: {
    points: 10, // 10 uploads
    duration: 3600, // Per hour
    blockDuration: 3600,
  },
  // Password reset
  passwordReset: {
    points: 3, // 3 attempts
    duration: 3600, // Per hour
    blockDuration: 7200, // Block for 2 hours
  },
};

// Validade máxima de uma reserva de tentativa em andamento (só rede de segurança: ela é devolvida ao fim da requisição).
const HOLD_SECONDS = 30;
// Quanto o cliente espera para repetir quando há mais tentativas SIMULTÂNEAS do que o limite (não é bloqueio).
const BUSY_RETRY_SECONDS = 2;

// Tentativa que falhou (senha/código/autorizador errado, entrada inválida). 409 (sessão de dispositivo) e 429
// não são palpites e não contam.
const FAILED_ATTEMPT_STATUSES = new Set([400, 401, 403, 404, 422, 423]);

function tooManyRequests(res: Response, type: string, key: string, path: string, msBeforeNext: number) {
  const seconds = Math.max(1, Math.ceil(msBeforeNext / 1000));
  logger.warn('Rate limit exceeded:', { type, key, path, remainingMs: msBeforeNext });
  res.setHeader('Retry-After', seconds);
  res.setHeader('X-RateLimit-Remaining', 0);
  res.setHeader('X-RateLimit-Reset', new Date(Date.now() + msBeforeNext).toISOString());
  const wait = seconds >= 90 ? `${Math.ceil(seconds / 60)} minutos` : `${seconds} segundos`;
  return res.status(429).json({
    error: 'Too Many Requests',
    message: `Muitas tentativas. Tente novamente em ${wait}.`,
    retryAfter: seconds,
  });
}

class AdvancedRateLimiter {
  private limiters: Map<string, RateLimiterMemory | RateLimiterRedis>;
  private redis?: Redis;

  constructor() {
    this.limiters = new Map();
    this.initializeLimiters();
  }

  private initializeLimiters() {
    // Try to use Redis if available. Aceita tanto REDIS_URL quanto as
    // variáveis REDIS_HOST/PORT/PASSWORD/DB usadas pelo resto da API
    // (config/redis.ts) — antes só REDIS_URL era checado e, como essa
    // variável nunca existiu no .env do projeto, este limiter sempre caía
    // silenciosamente para memória, mesmo com Redis disponível.
    const hasRedisConfig = !!(process.env.REDIS_URL || process.env.REDIS_HOST);

    if (hasRedisConfig) {
      try {
        // maxRetriesPerRequest/enableOfflineQueue baixos: sem isso, o
        // default do ioredis (20 retries com backoff crescente) faz
        // QUALQUER rota protegida por este limiter (login, MFA, retirada
        // de caixa, cancelamento) travar 10s+ quando o Redis cai no meio
        // da operação, mesmo com o try/catch abaixo (que só roda depois
        // que a promise finalmente rejeita). Confirmado o travamento
        // real: POST /auth/login levou 8s+ com Redis derrubado antes
        // desta correção. `retryStrategy` com backoff curto (não `() =>
        // null`) é o que faz a conexão voltar sozinha quando o Redis
        // volta — `() => null` desliga a reconexão de vez, e sem isso a
        // API ficava permanentemente presa em "desconectado" mesmo com o
        // Redis já respondendo de novo (confirmado também).
        const connectionOptions = {
          maxRetriesPerRequest: 1,
          retryStrategy: (times: number) => Math.min(times * 200, 2000),
          enableOfflineQueue: false,
        };
        this.redis = process.env.REDIS_URL
          ? new Redis(process.env.REDIS_URL, connectionOptions)
          : new Redis({
              host: process.env.REDIS_HOST || 'localhost',
              port: parseInt(process.env.REDIS_PORT || '6379', 10),
              password: process.env.REDIS_PASSWORD || undefined,
              db: parseInt(process.env.REDIS_DB || '0', 10),
              ...connectionOptions,
            });

        // Sem listener próprio, um evento 'error' não tratado num
        // EventEmitter do Node derruba o processo — mesmo padrão de
        // config/redis.ts, só loga (o catch em getMiddleware() já cobre a
        // degradação da requisição em si).
        this.redis.on('error', (error) => {
          logger.warn('Rate limiter Redis error (degradando para a próxima requisição tratar via catch)', {
            error: error.message,
          });
        });

        // Create Redis-based limiters
        //
        // ACHADO (caos controlado, Redis derrubado com a API no ar): todo erro do Redis caía no `catch` de
        // getMiddleware e a requisição passava — 8 senhas erradas seguidas, 8 × 401, nenhum 429. A proteção contra
        // força bruta sumia justamente com o Redis fora. `insuranceLimiter` conta em memória (por instância) enquanto
        // o Redis não responde e volta sozinho para o Redis quando ele retorna.
        Object.entries(RATE_LIMIT_CONFIGS).forEach(([key, config]) => {
          this.limiters.set(
            key,
            new RateLimiterRedis({
              storeClient: this.redis!,
              keyPrefix: `ratelimit_${key}`,
              points: config.points,
              duration: config.duration,
              blockDuration: config.blockDuration,
              insuranceLimiter: new RateLimiterMemory({
                keyPrefix: `ratelimit_${key}_insurance`,
                points: config.points,
                duration: config.duration,
                blockDuration: config.blockDuration,
              }),
            })
          );
        });

        // Reservas de tentativas em andamento (ver failureCountingMiddleware): balde curto, sem bloqueio longo.
        Object.entries(RATE_LIMIT_CONFIGS).forEach(([key, config]) => {
          this.limiters.set(
            `${key}:hold`,
            new RateLimiterRedis({
              storeClient: this.redis!,
              keyPrefix: `ratelimit_${key}_hold`,
              points: config.points,
              duration: HOLD_SECONDS,
              insuranceLimiter: new RateLimiterMemory({ keyPrefix: `ratelimit_${key}_hold_insurance`, points: config.points, duration: HOLD_SECONDS }),
            })
          );
        });

        logger.info('Rate limiter initialized with Redis');
      } catch {
        logger.warn('Failed to connect to Redis, using memory-based rate limiter');
        this.initializeMemoryLimiters();
      }
    } else {
      this.initializeMemoryLimiters();
    }
  }

  private initializeMemoryLimiters() {
    Object.entries(RATE_LIMIT_CONFIGS).forEach(([key, config]) => {
      this.limiters.set(
        key,
        new RateLimiterMemory({
          keyPrefix: `ratelimit_${key}`,
          points: config.points,
          duration: config.duration,
          blockDuration: config.blockDuration,
        })
      );
    });

    Object.entries(RATE_LIMIT_CONFIGS).forEach(([key, config]) => {
      this.limiters.set(
        `${key}:hold`,
        new RateLimiterMemory({ keyPrefix: `ratelimit_${key}_hold`, points: config.points, duration: HOLD_SECONDS })
      );
    });

    logger.info('Rate limiter initialized with memory storage');
  }

  /**
   * Get rate limiter middleware
   */
  getMiddleware(type: keyof typeof RATE_LIMIT_CONFIGS, options: { countOnlyFailures?: boolean } = {}) {
    const limiter = this.limiters.get(type);

    if (!limiter) {
      logger.error(`Rate limiter not found for type: ${type}`);
      return (_req: Request, _res: Response, next: NextFunction) => next();
    }

    if (options.countOnlyFailures) return this.failureCountingMiddleware(type, limiter);

    return async (req: Request, res: Response, next: NextFunction) => {
      // O payload do JWT traz `userId` (não `id`): com `user.id` toda chave caía no IP e operadores da
      // mesma loja dividiam o balde. O limite geral roda no app ANTES do authMiddleware (sem req.user):
      // o usuário vem do Bearer verificado; token ausente ou inválido cai no IP.
      const userId = (req as any).user?.userId ?? verifiedUserId(req);
      const key = userId ? `user:${userId}` : req.ip || 'unknown';

      try {
        await limiter.consume(key);

        // Add rate limit info to response headers
        const limiterRes = await limiter.get(key);
        if (limiterRes) {
          res.setHeader('X-RateLimit-Limit', RATE_LIMIT_CONFIGS[type].points);
          res.setHeader(
            'X-RateLimit-Remaining',
            Math.max(0, RATE_LIMIT_CONFIGS[type].points - limiterRes.consumedPoints)
          );
          res.setHeader(
            'X-RateLimit-Reset',
            new Date(Date.now() + limiterRes.msBeforeNext).toISOString()
          );
        }

        return next();
      } catch (error: any) {
        if (error.msBeforeNext) {
          return tooManyRequests(res, type, key, req.path, error.msBeforeNext);
        }

        logger.error('Rate limiter error:', error);
        return next(); // Allow request on error
      }
    };
  }

  /**
   * Limite de TENTATIVAS QUE FALHAM (login, MFA, segunda autorização).
   *
   * Antes: reservava 1 ponto por requisição ANTES de processar e devolvia só se desse certo. Com limite 5 e 6+ logins
   * corretos SIMULTÂNEOS do mesmo IP (abertura de loja atrás de um NAT), o 6º reserva passava do limite e acionava o
   * bloqueio de 60 min para o IP inteiro — castigando quem acertou a senha.
   *
   * Agora são dois baldes: (1) FALHAS, o limite e o bloqueio de sempre, só gastos por tentativa que falhou; (2) RESERVAS
   * em andamento, curto e sem bloqueio. Admite a tentativa só se `falhas + reservas em voo <= limite`, então o número de
   * palpites que chegam a ser verificados continua nunca passando do limite (rajada paralela de palpites errados), mas
   * o excedente simultâneo de quem pode estar certo recebe um 429 de poucos segundos — nunca o bloqueio longo.
   * A resposta só é enviada depois de contabilizar a falha: o cliente não ganha corrida contra o contador.
   */
  private failureCountingMiddleware(type: keyof typeof RATE_LIMIT_CONFIGS, failures: RateLimiterMemory | RateLimiterRedis) {
    const hold = this.limiters.get(`${type}:hold`);
    const { points, blockDuration } = RATE_LIMIT_CONFIGS[type];

    return async (req: Request, res: Response, next: NextFunction) => {
      const userId = (req as any).user?.userId ?? verifiedUserId(req);
      const key = userId ? `user:${userId}` : req.ip || 'unknown';
      let holding = false;

      const busy = () => {
        logger.warn('Rate limit: tentativas simultâneas acima do limite (sem bloqueio)', { type, key, path: req.path });
        res.setHeader('Retry-After', BUSY_RETRY_SECONDS);
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Muitas tentativas ao mesmo tempo. Aguarde ${BUSY_RETRY_SECONDS} segundos e tente novamente.`,
          code: 'TOO_MANY_CONCURRENT_ATTEMPTS',
          retryAfter: BUSY_RETRY_SECONDS,
        });
      };

      try {
        const state = await failures.get(key);
        const failed = state?.consumedPoints ?? 0;
        if (state && failed >= points) return tooManyRequests(res, type, key, req.path, state.msBeforeNext);

        if (hold) {
          let held = 0;
          try {
            held = (await hold.consume(key)).consumedPoints;
            holding = true;
          } catch (error: any) {
            if (!error?.msBeforeNext) throw error;
            await hold.reward(key, 1).catch(() => undefined);
            return busy();
          }
          if (failed + held > points) {
            holding = false;
            await hold.reward(key, 1).catch(() => undefined);
            return busy();
          }
        }

        res.setHeader('X-RateLimit-Limit', points);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, points - failed));

        if (holding) {
          let settled: Promise<void> | undefined;
          const settle = () =>
            (settled ??= (async () => {
              try {
                // `notAGuess`: a rota recusou por motivo que NÃO é palpite de credencial (ex.: equipamento ainda não autorizado, depois
                // de a senha estar certa) — senão um PDV pendente bloquearia por IP todos os operadores da loja.
                if (FAILED_ATTEMPT_STATUSES.has(res.statusCode) && !res.locals?.notAGuess) {
                  const r = await failures.consume(key).catch(() => null);
                  if (r && r.consumedPoints >= points) await failures.block(key, blockDuration).catch(() => undefined);
                }
              } finally {
                await hold!.reward(key, 1).catch(() => undefined);
              }
            })());
          const end = res.end.bind(res) as (...args: any[]) => Response;
          res.end = ((...args: any[]) => {
            settle().finally(() => end(...args));
            return res;
          }) as typeof res.end;
          res.on('close', () => void settle());
        }

        return next();
      } catch (error: any) {
        if (error?.msBeforeNext) return tooManyRequests(res, type, key, req.path, error.msBeforeNext);
        logger.error('Rate limiter error:', error);
        return next(); // Allow request on error
      }
    };
  }

  /**
   * O contador está no Redis (compartilhado entre instâncias)? Enquanto a conexão não abre, ou se o Redis cair, a
   * contagem vai para a memória desta instância (insuranceLimiter) — o limite continua valendo, mas não é somado com o
   * das outras instâncias nem com o que já estava no Redis.
   */
  isUsingRedis(): boolean {
    return this.redis?.status === 'ready';
  }

  /** Fecha a conexão Redis do limitador (desligamento ordenado, config/shutdown.ts). Sem Redis, não faz nada. */
  async close(): Promise<void> {
    if (!this.redis) return;
    await this.redis.quit().catch(() => this.redis?.disconnect());
  }

  /**
   * Reset rate limit for a specific key
   */
  async reset(type: keyof typeof RATE_LIMIT_CONFIGS, key: string): Promise<void> {
    const limiter = this.limiters.get(type);
    if (limiter) {
      await limiter.delete(key);
    }
  }

  /**
   * Get remaining points for a key
   */
  async getRemaining(
    type: keyof typeof RATE_LIMIT_CONFIGS,
    key: string
  ): Promise<number | null> {
    const limiter = this.limiters.get(type);
    if (!limiter) return null;

    const res = await limiter.get(key);
    if (!res) return RATE_LIMIT_CONFIGS[type].points;

    return Math.max(0, RATE_LIMIT_CONFIGS[type].points - res.consumedPoints);
  }
}

export const advancedRateLimiter = new AdvancedRateLimiter();

// Export middleware functions
export const rateLimitGeneral = advancedRateLimiter.getMiddleware('general');
export const rateLimitAuth = advancedRateLimiter.getMiddleware('auth', { countOnlyFailures: true });
export const rateLimitMFA = advancedRateLimiter.getMiddleware('mfa', { countOnlyFailures: true });
export const rateLimitAuthorizer = advancedRateLimiter.getMiddleware('authorizer', { countOnlyFailures: true });
export const rateLimitUpload = advancedRateLimiter.getMiddleware('upload');
export const rateLimitPasswordReset = advancedRateLimiter.getMiddleware('passwordReset');
