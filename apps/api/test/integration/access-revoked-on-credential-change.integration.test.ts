import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Troca de senha, desativação do usuário e bloqueio da empresa encerram TAMBÉM os access tokens já emitidos (antes só
 * os refresh tokens eram revogados e o access token seguia valendo até 15 min). Token emitido depois volta a valer.
 */
describe('Access token emitido antes da mudança de credencial deixa de valer (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const operatorToken = () =>
    generateAccessToken({ userId: fixture.userId, email: 'op@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'OPERATOR' });
  const adminToken = () => generateAccessToken({ userId: fixture.userId, email: 'ca@test.local', companyId: fixture.companyId, userType: 'COMPANY_ADMIN' });
  const superToken = () => generateAccessToken({ userId: fixture.userId, email: 'sa@test.local', userType: 'SUPER_ADMIN' });
  const me = (token: string) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const nextSecond = () => new Promise((r) => setTimeout(r, 1100)); // iat tem resolução de segundo

  beforeAll(async () => {
    fixture = await createFixture('credrevoke');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) await destroyFixture(fixture);
  });

  it('redefinição de senha: o token antigo do usuário deixa de valer; um token novo vale', async () => {
    const old = operatorToken();
    expect((await me(old)).status).toBe(200);
    await nextSecond();
    const res = await request(app).post(`/api/users/${fixture.userId}/reset-password`).set('Authorization', `Bearer ${adminToken()}`).send({ password: 'Nova-Senha-123!' });
    expect(res.status).toBeLessThan(300);
    expect((await me(old)).status).toBe(401);
    await nextSecond();
    expect((await me(operatorToken())).status).toBe(200);
  });

  it('desativação do usuário: o token antigo deixa de valer', async () => {
    await nextSecond();
    const old = operatorToken();
    await nextSecond();
    const res = await request(app).post(`/api/users/${fixture.userId}/toggle-active`).set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBeLessThan(300);
    expect((await me(old)).status).toBe(401);
    await request(app).post(`/api/users/${fixture.userId}/toggle-active`).set('Authorization', `Bearer ${adminToken()}`);
  });

  it('bloqueio da empresa: tokens antigos da empresa deixam de valer', async () => {
    await nextSecond();
    const old = operatorToken();
    await nextSecond();
    const res = await request(app).post(`/api/companies/${fixture.companyId}/toggle-active`).set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBeLessThan(300);
    expect((await me(old)).status).toBe(401);
    await request(app).post(`/api/companies/${fixture.companyId}/toggle-active`).set('Authorization', `Bearer ${superToken()}`);
  });
});
