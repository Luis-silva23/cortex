import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { mfaService } from '../../src/services/MFAService';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { isSealed, openSecret } from '@ln-system/shared/utils/secret-box';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * O segredo TOTP do MFA era gravado em texto puro no banco (um dump entregava o segundo fator de todo Super Admin).
 * Agora é cifrado (secret-box) na configuração, e o login/verificação abrem o valor só na hora de conferir o código.
 * Segredo legado em texto puro continua funcionando até a migração (scripts/encrypt-secrets.ts).
 */
describe('Segredo do MFA cifrado em repouso (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let secret: string;
  const PASSWORD = 'Senha-Mfa-123!';
  const email = `mfa-${Date.now()}@test.local`;
  const totp = (s: string): string => (mfaService as any).generateTOTP(s);
  const row = () => bypass<any>(() => db.user.findUnique({ where: { id: fixture.userId }, select: { mfaSecret: true, mfaEnabled: true } }));
  const loginWithCode = async (code: string) => {
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    return request(app).post('/api/auth/verify-mfa').send({ mfaToken: login.body.mfaToken, code, method: 'totp' });
  };

  beforeAll(async () => {
    await resetAuthLimits();
    fixture = await createFixture('mfarest');
    const password = await hashPassword(PASSWORD);
    await bypass(() => db.user.update({ where: { id: fixture.userId }, data: { email, password } }));
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  // Este arquivo testa o segredo EM REPOUSO e reaproveita o mesmo código TOTP em vários casos; o anti-reuso (decisão 123) tem teste próprio
  // (mfa-company-admin.integration). Aqui só se zera o marcador do último passo consumido antes de cada caso.
  beforeEach(async () => {
    if (fixture) await bypass(() => db.user.update({ where: { id: fixture.userId }, data: { mfaLastStep: null } }));
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) await destroyFixture(fixture);
  });

  it('configuração grava o segredo cifrado; o código do app ativa o MFA', async () => {
    const token = generateAccessToken({ userId: fixture.userId, email, companyId: fixture.companyId, branchId: fixture.branchId, userType: 'COMPANY_ADMIN' });
    const setup = await request(app).post('/api/mfa/setup').set('Authorization', `Bearer ${token}`);
    expect(setup.status).toBe(200);
    secret = setup.body.data.secret;

    const stored = (await row()).mfaSecret;
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain(secret);
    expect(openSecret(stored)).toBe(secret);

    const verify = await request(app).post('/api/mfa/verify').set('Authorization', `Bearer ${token}`).send({ code: totp(secret) });
    expect(verify.status).toBe(200);
    expect((await row()).mfaEnabled).toBe(true);
  });

  it('login com MFA confere o código contra o segredo cifrado: errado recusa, certo entra', async () => {
    const wrong = await loginWithCode(totp(secret) === '000000' ? '111111' : '000000');
    expect(wrong.status).not.toBe(200);
    const ok = await loginWithCode(totp(secret));
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken ?? ok.body.data?.accessToken).toBeTruthy();
  });

  it('segredo legado em texto puro continua valendo até a migração', async () => {
    await bypass(() => db.user.update({ where: { id: fixture.userId }, data: { mfaSecret: secret } }));
    const ok = await loginWithCode(totp(secret));
    expect(ok.status).toBe(200);
  });
});
