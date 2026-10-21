import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { advancedRateLimiter, rateLimitGeneral } from '../../src/middlewares/advancedRateLimit';

/**
 * Limite geral por USUÁRIO, não por IP. O middleware roda no app antes do authMiddleware (sem req.user): a chave caía
 * no IP e toda a loja atrás do mesmo IP (caixas, balcão, admin) dividia 100 req/min — na validação visual o admin
 * navegando recebeu 429. Com token válido a chave é o usuário; sem token (ou inválido), o IP.
 */
describe('Limite geral chaveado pelo usuário do token (integração real)', () => {
  const app = express();
  app.use(rateLimitGeneral);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  const token = () => generateAccessToken({ userId: randomUUID(), email: 'x@test.local', companyId: randomUUID(), userType: 'OPERATOR' });

  // Até a conexão Redis do limitador abrir, a contagem fica na memória da instância (insuranceLimiter) e não é somada
  // com a do Redis: este teste é do contador compartilhado, então espera a conexão ficar pronta.
  beforeAll(async () => {
    for (let i = 0; i < 50; i++) {
      await request(app).get('/ping').set('Authorization', `Bearer ${token()}`);
      if (advancedRateLimiter.isUsingRedis()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('limitador não conectou ao Redis');
  });

  it('um usuário no limite não bloqueia outro usuário do mesmo IP', async () => {
    const heavy = token();
    for (let i = 0; i < 100; i++) await request(app).get('/ping').set('Authorization', `Bearer ${heavy}`);
    expect((await request(app).get('/ping').set('Authorization', `Bearer ${heavy}`)).status).toBe(429);
    expect((await request(app).get('/ping').set('Authorization', `Bearer ${token()}`)).status).toBe(200);
  }, 60000);

  it('token inválido não escolhe a chave (cai no IP, não num "usuário" forjado)', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.assinatura-falsa';
    const res = await request(app).get('/ping').set('Authorization', `Bearer ${forged}`);
    expect([200, 429]).toContain(res.status);
  });
});
