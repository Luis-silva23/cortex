/**
 * Reproduzido ao vivo (API + Redis reais): o limitador chaveava por `req.user.id`, campo que o JWT não tem
 * (o payload traz `userId`), então TODA chave caía no IP. Numa loja atrás de um IP, 3 cancelamentos/devoluções/
 * sangrias de um operador bloqueavam por 30 min o PRIMEIRO pedido de outro operador — e, por dividirem o balde
 * `mfa`, também o login com MFA de qualquer usuário da loja. Além disso toda requisição consumia tentativa,
 * inclusive as bem-sucedidas.
 */
import express from 'express';
import request from 'supertest';

type Mw = express.RequestHandler;
let rateLimitMFA: Mw;
let rateLimitAuthorizer: Mw;

beforeAll(() => {
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./advancedRateLimit');
    rateLimitMFA = mod.rateLimitMFA;
    rateLimitAuthorizer = mod.rateLimitAuthorizer;
  });
});

function app(limiter: Mw) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    const userId = req.header('x-test-user');
    if (userId) (req as any).user = { userId, userType: 'OPERATOR', companyId: 'c1' };
    next();
  });
  a.post('/op', limiter, (req, res) => res.status(req.body.ok ? 200 : 401).json({ ok: !!req.body.ok }));
  return a;
}

describe('advancedRateLimit — tentativas por usuário, só falhas contam', () => {
  it('3 falhas do operador A não bloqueiam o operador B (mesmo IP)', async () => {
    const a = app(rateLimitAuthorizer);
    for (let i = 0; i < 3; i++) await request(a).post('/op').set('x-test-user', 'user-A1').send({ ok: false }).expect(401);

    const blockedA = await request(a).post('/op').set('x-test-user', 'user-A1').send({ ok: true });
    expect(blockedA.status).toBe(429);
    expect(blockedA.body.retryAfter).toBeGreaterThan(1500);

    await request(a).post('/op').set('x-test-user', 'user-B1').send({ ok: true }).expect(200);
  });

  it('requisições bem-sucedidas não consomem tentativas', async () => {
    const a = app(rateLimitAuthorizer);
    for (let i = 0; i < 6; i++) await request(a).post('/op').set('x-test-user', 'user-OK').send({ ok: true }).expect(200);
  });

  it('o balde de autorização de operação é separado do de verificação de MFA do login', async () => {
    const auth = app(rateLimitAuthorizer);
    for (let i = 0; i < 3; i++) await request(auth).post('/op').set('x-test-user', 'user-C').send({ ok: false }).expect(401);

    await request(app(rateLimitMFA)).post('/op').send({ ok: true }).expect(200);
  });

  it('rajada paralela de palpites errados: no máximo 3 chegam a ser verificados', async () => {
    let checked = 0;
    const a = express();
    a.use((req, _res, next) => {
      (req as any).user = { userId: 'user-BURST' };
      next();
    });
    a.post('/op', rateLimitAuthorizer, (_req, res) => {
      checked++;
      res.status(401).end();
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => request(a).post('/op')));
    expect(checked).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(9);
  });

  // Achado de carga HML: >5 logins CORRETOS simultâneos do mesmo IP (NAT de loja) gastavam as reservas, passavam do limite
  // e bloqueavam o IP por 60 min. Agora o excedente simultâneo leva um 429 curto (2 s) e NADA é bloqueado.
  it('rajada de tentativas CORRETAS simultâneas do mesmo IP: excedente recebe 429 curto e ninguém fica bloqueado', async () => {
    const a = express();
    a.use(express.json());
    a.post('/op', rateLimitMFA, async (_req, res) => {
      await new Promise((r) => setTimeout(r, 60));
      res.status(200).json({ ok: true });
    });
    const burst = await Promise.all(Array.from({ length: 20 }, () => request(a).post('/op')));
    const limited = burst.filter((r) => r.status === 429);
    expect(burst.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(limited.length).toBeGreaterThan(0);
    for (const r of limited) {
      expect(r.body.code).toBe('TOO_MANY_CONCURRENT_ATTEMPTS');
      expect(r.body.retryAfter).toBeLessThanOrEqual(2);
    }
    // Sem bloqueio: logo depois, tentativas corretas em sequência passam normalmente.
    for (let i = 0; i < 6; i++) await request(a).post('/op').expect(200);
  });

  it('falhas anteriores + rajada paralela: palpites verificados nunca passam do limite (3 no MFA)', async () => {
    let checked = 0;
    const a = express();
    a.use((req, _res, next) => {
      (req as any).user = { userId: 'user-MIX' };
      next();
    });
    a.post('/op', rateLimitAuthorizer, async (_req, res) => {
      checked++;
      await new Promise((r) => setTimeout(r, 40));
      res.status(401).end();
    });
    await request(a).post('/op').expect(401);
    await request(a).post('/op').expect(401);
    await Promise.all(Array.from({ length: 10 }, () => request(a).post('/op')));
    expect(checked).toBeLessThanOrEqual(3);
    const after = await request(a).post('/op');
    expect(after.status).toBe(429);
    expect(after.body.retryAfter).toBeGreaterThan(1500);
  });

  it('sem usuário autenticado (verificação de MFA do login) o limite continua valendo por IP', async () => {
    const a = app(rateLimitMFA);
    for (let i = 0; i < 3; i++) await request(a).post('/op').send({ ok: false }).expect(401);
    await request(a).post('/op').send({ ok: true }).expect(429);
  });
});
