import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * LOGIN NÃO REVELA QUEM EXISTE (Fase 4): antes, conta desativada ou bloqueada respondia "Conta desativada"/"Conta bloqueada" ANTES de
 * conferir a senha, e e-mail inexistente respondia na hora. Qualquer um listava os e-mails cadastrados (e quais estavam bloqueados).
 * O estado da conta só é dito a quem acertou a senha.
 */
describe('login: respostas iguais para quem não sabe a senha', () => {
  let fx: IntegrationFixture;
  let email: string;
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(errorHandler);
  const PASSWORD = 'IntegrationTest123!';
  const WRONG = 'Errada-123!xyz';

  const login = (body: Record<string, unknown>) => request(app).post('/api/auth/login').send(body);
  const messageOf = (r: request.Response) => JSON.stringify({ status: r.status, body: r.body });

  beforeAll(async () => {
    await resetAuthLimits();
    fx = await createFixture('enum');
    email = (await bypass<any>(() => db.user.findUnique({ where: { id: fx.userId }, select: { email: true } }))).email;
  }, 60000);
  afterAll(async () => {
    await resetAuthLimits();
    if (fx) await destroyFixture(fx);
  }, 60000);
  afterEach(() => resetAuthLimits());

  it('e-mail inexistente e senha errada de usuário existente respondem exatamente a mesma coisa', async () => {
    const unknown = await login({ email: `nao-existe-${Date.now()}@test.local`, password: WRONG });
    const wrong = await login({ email, password: WRONG });
    expect(unknown.status).toBe(401);
    expect(messageOf(unknown)).toBe(messageOf(wrong));
  });

  it('conta DESATIVADA: sem a senha certa responde como credencial inválida; com a senha certa diz que está desativada', async () => {
    await bypass(() => db.user.update({ where: { id: fx.userId }, data: { isActive: false } }));
    try {
      const unknown = await login({ email: `nao-existe-${Date.now()}@test.local`, password: WRONG });
      const wrongPw = await login({ email, password: WRONG });
      expect(messageOf(wrongPw)).toBe(messageOf(unknown));
      expect(JSON.stringify(wrongPw.body)).not.toMatch(/desativ/i);
      const right = await login({ email, password: PASSWORD });
      expect(right.status).toBe(401);
      expect(JSON.stringify(right.body)).toMatch(/desativ/i);
    } finally {
      await bypass(() => db.user.update({ where: { id: fx.userId }, data: { isActive: true } }));
    }
  });

  it('conta BLOQUEADA: sem a senha certa não revela o bloqueio; com a senha certa informa', async () => {
    await bypass(() => db.user.update({ where: { id: fx.userId }, data: { lockedUntil: new Date(Date.now() + 20 * 60_000) } }));
    try {
      const unknown = await login({ email: `nao-existe-${Date.now()}@test.local`, password: WRONG });
      const wrongPw = await login({ email, password: WRONG });
      expect(messageOf(wrongPw)).toBe(messageOf(unknown));
      expect(JSON.stringify(wrongPw.body)).not.toMatch(/bloquead/i);
      const right = await login({ email, password: PASSWORD });
      expect(right.status).toBe(401);
      expect(JSON.stringify(right.body)).toMatch(/bloquead/i);
    } finally {
      await bypass(() => db.user.update({ where: { id: fx.userId }, data: { lockedUntil: null, loginAttempts: 0 } }));
    }
  });

  it('conta normal com a senha certa continua entrando', async () => {
    const ok = await login({ email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken ?? ok.body.data?.accessToken).toBeTruthy();
  });

  it('usuário inexistente gasta o custo de uma conferência de senha (não responde "na hora")', async () => {
    await login({ email: `aquecer-${Date.now()}@test.local`, password: WRONG }); // calcula o hash descartável uma vez
    const t0 = Date.now();
    await login({ email: `nao-existe-${Date.now()}@test.local`, password: WRONG });
    const unknownMs = Date.now() - t0;
    // bcrypt de custo 10+ leva dezenas de ms; sem o custo equalizado a resposta saía em poucos ms. Limite folgado para não ser frágil.
    expect(unknownMs).toBeGreaterThan(20);
  });
});
