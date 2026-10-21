import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * Falha de login não ia para audit_logs (só para SystemLog, legível apenas pelo Super Admin).
 */
describe('Falha de login é auditada sem gravar a senha (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let email: string;
  const WRONG = 'Senha-Errada-9f3k!';

  beforeAll(async () => {
    await resetAuthLimits();
    fixture = await createFixture('loginaudit');
    email = (await bypass<any>(() => db.user.findUnique({ where: { id: fixture.userId }, select: { email: true } }))).email;
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
  });
  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  });

  const failures = () =>
    bypass<any[]>(() => db.auditLog.findMany({ where: { action: 'LOGIN_FAILED', entityId: fixture.userId }, orderBy: { createdAt: 'desc' } }));

  it('senha errada de usuário existente: LOGIN_FAILED com a empresa dele, sem a senha', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password: WRONG });
    expect(res.status).toBe(401);

    let rows: any[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await failures();
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].companyId).toBe(fixture.companyId);
    expect(rows[0].newValue).toContain('Credenciais inválidas');
    expect(rows[0].newValue).not.toContain(WRONG);
  });

  it('e-mail/senha que não são texto (objeto NoSQL, array) dão 400, nunca 500', async () => {
    for (const body of [
      { email: { $ne: null }, password: { $ne: null } },
      { email, password: ['a'] },
      { numericId: 1234567, password: { x: 1 } },
    ]) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status).toBe(400);
    }
  });
});
