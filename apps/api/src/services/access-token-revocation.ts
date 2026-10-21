import { createHash } from 'crypto';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * REVOGAÇÃO DE ACCESS TOKEN (logout, troca de senha, desativação de usuário/empresa, suspeita de roubo de sessão).
 *
 * Duas camadas (decisão 107, 2026-10-14):
 *  - Redis = caminho rápido da checagem (uma consulta por requisição).
 *  - PostgreSQL (`access_revocations`) = fonte DURÁVEL: toda revogação é gravada lá também. Se o Redis estiver fora do ar,
 *    a checagem passa a consultar o PostgreSQL; se os DOIS estiverem fora, a requisição é recusada com 503 (nunca aceita
 *    "por falta de resposta"). Quando o Redis volta, as revogações vigentes são regravadas nele ANTES de ele voltar a ser
 *    a fonte da checagem (ressincronização) — senão um token revogado durante a queda voltaria a valer.
 * O token revogado, expirado ou inválido nunca é aceito por indisponibilidade de infraestrutura.
 */
export class AuthDependencyUnavailableError extends Error {
  readonly code = 'AUTH_DEPENDENCY_UNAVAILABLE';
  constructor() {
    super('Não foi possível verificar a sessão agora. Tente novamente em instantes.');
    this.name = 'AuthDependencyUnavailableError';
  }
}

const PLATFORM = { companyId: null, userType: 'SUPER_ADMIN', branchId: null } as const;
const REDIS_TIMEOUT_MS = Number(process.env.AUTH_REDIS_TIMEOUT_MS) > 0 ? Number(process.env.AUTH_REDIS_TIMEOUT_MS) : 750;
const DB_TIMEOUT_MS = Number(process.env.AUTH_DB_TIMEOUT_MS) > 0 ? Number(process.env.AUTH_DB_TIMEOUT_MS) : 3000;
const PROBE_INTERVAL_MS = 3000;

// Access token revogado no logout (permission-matrix.md, "Backup / Observabilidade / Saúde / Auth"). Guarda só o
// hash, até o `exp` do token.
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const key = (token: string) => `auth:revoked-access:${tokenHash(token)}`;

// Marcadores "tudo o que foi emitido até este segundo está revogado", por usuário e por empresa (troca de senha,
// desativação, bloqueio da empresa, suspeita de roubo de sessão). TTL maior que a vida de qualquer access token.
const MARKER_TTL_SECONDS = 24 * 60 * 60;
const userKey = (userId: string) => `auth:revoked-before:user:${userId}`;
const companyKey = (companyId: string) => `auth:revoked-before:company:${companyId}`;

type Kind = 'TOKEN' | 'USER' | 'COMPANY';
type Claims = { userId?: string; companyId?: string; iat?: number };

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: tempo esgotado (${ms} ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Estado do Redis nesta instância: "confiável" = a última operação funcionou e as revogações do PostgreSQL já estão nele.
// ---------------------------------------------------------------------------------------------------------------------------
let redisTrusted = true;
let lastProbeAt = 0;
let recovering: Promise<void> | null = null;

function distrustRedis(reason: string, error: unknown) {
  if (redisTrusted) {
    logger.warn('Redis indisponível para a checagem de revogação; usando o PostgreSQL até a ressincronização', { reason, error: (error as Error).message });
  }
  redisTrusted = false;
}

/** Regrava no Redis as revogações vigentes do PostgreSQL. Só depois disso o Redis volta a ser a fonte da checagem. */
export async function resyncRevocationsToRedis(now = new Date()): Promise<number> {
  const rows = await runWithRLSContext(PLATFORM, () =>
    prisma.accessRevocation.findMany({ where: { expiresAt: { gt: now } }, take: 50_000, select: { kind: true, subject: true, revokedAt: true, expiresAt: true } })
  );
  if (rows.length > 0) {
    const pipeline = redis.pipeline();
    for (const row of rows) {
      const ttl = Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000));
      if (row.kind === 'TOKEN') pipeline.set(`auth:revoked-access:${row.subject}`, '1', 'EX', ttl);
      else if (row.kind === 'USER') pipeline.set(userKey(row.subject), String(Math.floor(row.revokedAt.getTime() / 1000)), 'EX', ttl);
      else if (row.kind === 'COMPANY') pipeline.set(companyKey(row.subject), String(Math.floor(row.revokedAt.getTime() / 1000)), 'EX', ttl);
    }
    const results = await withTimeout(pipeline.exec(), REDIS_TIMEOUT_MS * 4, 'ressincronização do Redis');
    const failed = (results ?? []).find(([err]) => err);
    if (failed) throw failed[0];
  } else {
    await withTimeout(redis.ping(), REDIS_TIMEOUT_MS, 'ping do Redis');
  }
  await purgeExpired(now);
  redisTrusted = true;
  logger.info('Redis ressincronizado com as revogações do PostgreSQL', { revocations: rows.length });
  return rows.length;
}

async function purgeExpired(now: Date) {
  try {
    await runWithRLSContext(PLATFORM, () => prisma.accessRevocation.deleteMany({ where: { expiresAt: { lt: now } } }));
  } catch (error) {
    logger.warn('Não foi possível limpar revogações expiradas', { error: (error as Error).message });
  }
}

/** Com o Redis em dúvida, tenta (no máximo a cada PROBE_INTERVAL_MS, uma tentativa por vez) ressincronizar e voltar a confiar nele. */
function maybeRecover(): Promise<void> {
  const now = Date.now();
  if (recovering) return recovering;
  if (now - lastProbeAt < PROBE_INTERVAL_MS) return Promise.resolve();
  lastProbeAt = now;
  recovering = resyncRevocationsToRedis()
    .then(() => undefined)
    .catch((error) => logger.debug('Redis ainda indisponível', { error: (error as Error).message }))
    .finally(() => {
      recovering = null;
    });
  return recovering;
}

// Reconexão detectada pelo próprio cliente: ressincroniza na hora (sem esperar a próxima requisição).
if (redis && typeof (redis as { on?: unknown }).on === 'function') {
  redis.on('ready', () => {
    if (!redisTrusted) {
      lastProbeAt = 0;
      void maybeRecover();
    }
  });
}

/** Só para testes: volta o estado em memória ao inicial. */
export function __resetRevocationStateForTests() {
  redisTrusted = true;
  lastProbeAt = 0;
  recovering = null;
}
export const __revocationState = () => ({ redisTrusted });

// ---------------------------------------------------------------------------------------------------------------------------
// Gravação: PostgreSQL (durável) + Redis (rápido). Falhar nos dois é erro — nunca "revogou" em silêncio.
// ---------------------------------------------------------------------------------------------------------------------------
async function persist(kind: Kind, subject: string, expiresAt: Date, revokedAt: Date) {
  await withTimeout(
    runWithRLSContext(PLATFORM, () =>
      prisma.accessRevocation.upsert({
        where: { kind_subject: { kind, subject } },
        create: { kind, subject, revokedAt, expiresAt },
        update: { revokedAt, expiresAt },
      })
    ),
    DB_TIMEOUT_MS,
    'gravação da revogação'
  );
  if (Math.random() < 0.02) void purgeExpired(revokedAt);
}

async function writeRedis(redisKey: string, value: string, ttlSeconds: number) {
  await withTimeout(redis.set(redisKey, value, 'EX', ttlSeconds), REDIS_TIMEOUT_MS, 'gravação da revogação no Redis');
}

async function revoke(kind: Kind, subject: string, redisKey: string, redisValue: string, ttlSeconds: number) {
  const revokedAt = new Date();
  const expiresAt = new Date(revokedAt.getTime() + ttlSeconds * 1000);
  const [db, cache] = await Promise.allSettled([persist(kind, subject, expiresAt, revokedAt), writeRedis(redisKey, redisValue, ttlSeconds)]);
  if (cache.status === 'rejected') distrustRedis('gravação da revogação', cache.reason);
  if (db.status === 'rejected') {
    logger.error('Não foi possível gravar a revogação no PostgreSQL', { kind, error: (db.reason as Error).message });
    // Sem a gravação durável só o Redis protege; se ele também falhou, a revogação NÃO aconteceu — quem chamou precisa saber.
    if (cache.status === 'rejected') throw new AuthDependencyUnavailableError();
  }
}

export const revokeUserAccessTokens = (userId: string) =>
  revoke('USER', userId, userKey(userId), String(Math.floor(Date.now() / 1000)), MARKER_TTL_SECONDS);
export const revokeCompanyAccessTokens = (companyId: string) =>
  revoke('COMPANY', companyId, companyKey(companyId), String(Math.floor(Date.now() / 1000)), MARKER_TTL_SECONDS);

export async function revokeAccessToken(token: string, exp: number | undefined): Promise<void> {
  const ttl = (exp ?? 0) - Math.floor(Date.now() / 1000);
  if (ttl > 0) await revoke('TOKEN', tokenHash(token), key(token), '1', ttl);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------------------------------------
async function checkRedis(token: string, claims?: Claims): Promise<boolean> {
  if ((await withTimeout(redis.exists(key(token)), REDIS_TIMEOUT_MS, 'checagem de revogação no Redis')) === 1) return true;
  if (!claims?.iat) return false;
  const markers = [claims.userId && userKey(claims.userId), claims.companyId && companyKey(claims.companyId)].filter(Boolean) as string[];
  if (markers.length === 0) return false;
  const values = await withTimeout(redis.mget(...markers), REDIS_TIMEOUT_MS, 'checagem de marcadores no Redis');
  return values.some((v) => v !== null && claims.iat! <= Number(v));
}

async function checkDatabase(token: string, claims?: Claims): Promise<boolean> {
  const subjects: { kind: Kind; subject: string }[] = [{ kind: 'TOKEN', subject: tokenHash(token) }];
  if (claims?.iat && claims.userId) subjects.push({ kind: 'USER', subject: claims.userId });
  if (claims?.iat && claims.companyId) subjects.push({ kind: 'COMPANY', subject: claims.companyId });
  const rows = await withTimeout(
    runWithRLSContext(PLATFORM, () =>
      prisma.accessRevocation.findMany({ where: { expiresAt: { gt: new Date() }, OR: subjects }, select: { kind: true, revokedAt: true } })
    ),
    DB_TIMEOUT_MS,
    'checagem de revogação no PostgreSQL'
  );
  return rows.some((r) => r.kind === 'TOKEN' || (claims?.iat !== undefined && claims.iat <= Math.floor(r.revokedAt.getTime() / 1000)));
}

/**
 * O access token foi revogado? Redis fora do ar NÃO significa "não revogado": consulta o PostgreSQL. Se nenhuma das duas
 * fontes responder, lança `AuthDependencyUnavailableError` (o middleware responde 503, nunca 401 e nunca "passa").
 */
export async function isAccessTokenRevoked(token: string, claims?: Claims): Promise<boolean> {
  if (!redisTrusted) await maybeRecover();
  if (redisTrusted) {
    try {
      return await checkRedis(token, claims);
    } catch (error) {
      distrustRedis('checagem de revogação', error);
    }
  }
  try {
    return await checkDatabase(token, claims);
  } catch (error) {
    logger.error('Não foi possível verificar a revogação da sessão (Redis e PostgreSQL indisponíveis)', { error: (error as Error).message });
    throw new AuthDependencyUnavailableError();
  }
}
