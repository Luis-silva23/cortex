process.env.AUTH_REDIS_TIMEOUT_MS = '80'; // lido na carga do módulo: prova o caminho de "Redis pendurado" sem esperar 750 ms
import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { redis } from '../../src/config/redis';
import { authMiddleware } from '../../src/middleware/auth';
import {
  AuthDependencyUnavailableError,
  __resetRevocationStateForTests,
  __revocationState,
  isAccessTokenRevoked,
  resyncRevocationsToRedis,
  revokeAccessToken,
  revokeUserAccessTokens,
} from '../../src/services/access-token-revocation';

/**
 * DECISÃO 107 — revogação de sessão com Redis indisponível (Redis e PostgreSQL reais).
 * Antes: Redis fora = `isAccessTokenRevoked` devolvia false (falha aberta): uma sessão revogada voltava a valer.
 * Agora: Redis fora → consulta o PostgreSQL (`access_revocations`); os dois fora → 503 (nunca aceita, nunca 401).
 * A indisponibilidade é SIMULADA nos comandos do cliente Redis (o servidor real não é derrubado para não afetar o ambiente).
 */
const PLATFORM = { companyId: null, userType: 'SUPER_ADMIN', branchId: null } as const;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Revogação de sessão com Redis indisponível (decisão 107)', () => {
  const app = express();
  app.get('/ping', authMiddleware, (req, res) => res.json({ ok: true, userId: req.user?.userId }));
  const userId = () => `user-outage-${Math.random().toString(36).slice(2)}`;
  const newToken = (uid = userId()) => generateAccessToken({ userId: uid, email: `${uid}@test.local`, userType: 'COMPANY_ADMIN', companyId: `co-${uid}` });
  const get = (token: string) => request(app).get('/ping').set('Authorization', `Bearer ${token}`);
  const spies: jest.SpyInstance[] = [];
  const touched: { kind: string; subject: string }[] = [];

  const redisDown = () => {
    const boom = () => Promise.reject(new Error('Connection is closed.'));
    spies.push(
      jest.spyOn(redis, 'exists').mockImplementation(boom as any),
      jest.spyOn(redis, 'mget').mockImplementation(boom as any),
      jest.spyOn(redis, 'set').mockImplementation(boom as any),
      jest.spyOn(redis, 'ping').mockImplementation(boom as any),
      jest.spyOn(redis, 'pipeline').mockImplementation((() => {
        throw new Error('Connection is closed.');
      }) as any)
    );
  };
  const redisHangs = () => {
    const never = () => new Promise(() => undefined);
    spies.push(jest.spyOn(redis, 'exists').mockImplementation(never as any), jest.spyOn(redis, 'mget').mockImplementation(never as any), jest.spyOn(redis, 'set').mockImplementation(never as any));
  };
  const restore = () => {
    while (spies.length) spies.pop()!.mockRestore();
  };
  const dbDown = () => spies.push(jest.spyOn((prisma as any).accessRevocation, 'findMany').mockRejectedValue(new Error("Can't reach database server")));

  beforeEach(() => {
    __resetRevocationStateForTests();
  });
  afterEach(() => {
    restore();
  });
  afterAll(async () => {
    restore();
    if (touched.length) {
      const rows = await runWithRLSContext(PLATFORM, () => prisma.accessRevocation.findMany({ where: { OR: touched.map((t) => ({ kind: t.kind, subject: t.subject })) }, select: { id: true } }));
      if (rows.length) await runWithRLSContext(PLATFORM, () => prisma.accessRevocation.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }));
    }
    for (const t of touched) if (t.kind === 'TOKEN') await redis.del(`auth:revoked-access:${t.subject}`).catch(() => undefined);
  });

  it('Redis disponível: token válido passa; token revogado é recusado (401 "Sessão encerrada")', async () => {
    const ok = newToken();
    expect((await get(ok)).status).toBe(200);
    const revoked = newToken();
    await revokeAccessToken(revoked, (jwt.decode(revoked) as any).exp);
    touched.push({ kind: 'TOKEN', subject: sha(revoked) });
    const res = await get(revoked);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Sessão encerrada');
  });

  it('toda revogação também fica gravada no PostgreSQL (fonte durável)', async () => {
    const token = newToken();
    await revokeAccessToken(token, (jwt.decode(token) as any).exp);
    touched.push({ kind: 'TOKEN', subject: sha(token) });
    const row = await runWithRLSContext(PLATFORM, () => prisma.accessRevocation.findUnique({ where: { kind_subject: { kind: 'TOKEN', subject: sha(token) } } }));
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('REDIS FORA: token já revogado CONTINUA recusado (antes voltava a valer) e token válido continua passando (sem bloqueio global)', async () => {
    const revoked = newToken();
    await revokeAccessToken(revoked, (jwt.decode(revoked) as any).exp);
    touched.push({ kind: 'TOKEN', subject: sha(revoked) });
    const valid = newToken();

    redisDown();
    const denied = await get(revoked);
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe('Sessão encerrada');
    const allowed = await get(valid);
    expect(allowed.status).toBe(200);
    expect(__revocationState().redisTrusted).toBe(false);
  });

  it('REDIS PENDURADO (timeout): cai no PostgreSQL em poucos ms e responde; revogado segue recusado', async () => {
    const revoked = newToken();
    await revokeAccessToken(revoked, (jwt.decode(revoked) as any).exp);
    touched.push({ kind: 'TOKEN', subject: sha(revoked) });
    redisHangs();
    const started = Date.now();
    expect((await get(revoked)).status).toBe(401);
    expect((await get(newToken())).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('revogação feita COM O REDIS FORA vale (PostgreSQL) e, quando o Redis volta, é regravada nele ANTES de ele voltar a ser a fonte', async () => {
    const token = newToken();
    redisDown();
    await revokeAccessToken(token, (jwt.decode(token) as any).exp); // não lança: o PostgreSQL gravou
    touched.push({ kind: 'TOKEN', subject: sha(token) });
    expect((await get(token)).status).toBe(401); // Redis fora: PostgreSQL decide
    restore(); // o Redis "voltou" mas NÃO tem a chave (foi gravada só no PostgreSQL)
    expect(await redis.exists(`auth:revoked-access:${sha(token)}`)).toBe(0);

    // a próxima checagem vê o Redis em dúvida, ressincroniza e só então volta a confiar nele
    await sleep(3100);
    expect(await isAccessTokenRevoked(token, jwt.decode(token) as any)).toBe(true);
    expect(await redis.exists(`auth:revoked-access:${sha(token)}`)).toBe(1);
    expect(__revocationState().redisTrusted).toBe(true);
    expect((await get(token)).status).toBe(401);
  });

  it('marcador de usuário (troca de senha/desativação) feito com o Redis fora derruba os tokens EMITIDOS ANTES e não os emitidos depois', async () => {
    const uid = userId();
    const before = newToken(uid);
    await sleep(1100);
    redisDown();
    await revokeUserAccessTokens(uid);
    touched.push({ kind: 'USER', subject: uid });
    await sleep(1100);
    const after = newToken(uid);
    expect((await get(before)).status).toBe(401);
    expect((await get(after)).status).toBe(200);
  });

  it('Redis E PostgreSQL fora: 503 AUTH_UNAVAILABLE com Retry-After — nunca aceita, nunca 401', async () => {
    const token = newToken();
    redisDown();
    dbDown();
    const res = await get(token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_UNAVAILABLE');
    expect(res.headers['retry-after']).toBeDefined();
    await expect(isAccessTokenRevoked(token, jwt.decode(token) as any)).rejects.toBeInstanceOf(AuthDependencyUnavailableError);
  });

  it('revogar com os DOIS fora lança (não "revoga" em silêncio)', async () => {
    const token = newToken();
    redisDown();
    spies.push(jest.spyOn((prisma as any).accessRevocation, 'upsert').mockRejectedValue(new Error('db down')));
    await expect(revokeAccessToken(token, (jwt.decode(token) as any).exp)).rejects.toBeInstanceOf(AuthDependencyUnavailableError);
  });

  it('token expirado ou com assinatura inválida é 401 mesmo com o Redis fora (nunca aceito por indisponibilidade)', async () => {
    const uid = userId();
    const expired = jwt.sign({ userId: uid, email: 'a@b.c', userType: 'OPERATOR' }, process.env.JWT_SECRET!, { expiresIn: -30, jwtid: 'x' } as jwt.SignOptions);
    const forged = jwt.sign({ userId: uid, email: 'a@b.c', userType: 'OPERATOR' }, 'outro-segredo-qualquer-com-mais-de-32-caracteres!!', { expiresIn: '5m' });
    redisDown();
    expect((await get(expired)).status).toBe(401);
    expect((await get(forged)).status).toBe(401);
    expect((await request(app).get('/ping')).status).toBe(401);
  });

  it('ressincronização é idempotente e devolve a contagem de revogações vigentes', async () => {
    const token = newToken();
    await revokeAccessToken(token, (jwt.decode(token) as any).exp);
    touched.push({ kind: 'TOKEN', subject: sha(token) });
    const first = await resyncRevocationsToRedis();
    const second = await resyncRevocationsToRedis();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBeGreaterThanOrEqual(first);
    expect(await redis.exists(`auth:revoked-access:${sha(token)}`)).toBe(1);
  });
});
