import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { mfaService } from '../../src/services/MFAService';
import { encryptPlaintextSecrets } from '../../src/services/secret-migration.service';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { isSealed, openSecret } from '@ln-system/shared/utils/secret-box';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * Migração dos segredos legados em texto puro para enc:v1 (`npm run secrets:encrypt`) — prova REAL (Postgres).
 * Antes só havia a afirmação de que o segredo legado "continua funcionando até a migração"; a migração em si não tinha
 * teste. Aqui: segredos de MFA e fiscais em texto puro → modo conferência não altera nada → migração cifra, o valor
 * original abre com a chave e o login com MFA continua funcionando → segunda execução não mexe em nada.
 */
describe('Migração de segredos para enc:v1 (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const PASSWORD = 'Senha-Migra-123!';
  const email = `migra-${Date.now()}@test.local`;
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  const CERT_PASSWORD = 'senha-do-certificado-a1';
  const CSC = 'csc-token-123456';
  const totp = (s: string): string => (mfaService as any).generateTOTP(s);
  const userRow = () => bypass<any>(() => db.user.findUnique({ where: { id: fixture.userId }, select: { mfaSecret: true } }));
  const fiscalRow = () =>
    bypass<any>(() => db.fiscalConfig.findFirst({ where: { companyId: fixture.companyId }, select: { certificatePassword: true, cscToken: true } }));

  beforeAll(async () => {
    await resetAuthLimits();
    fixture = await createFixture('secmigra');
    const password = await hashPassword(PASSWORD);
    // Estado legado: segredos gravados em texto puro, como antes do secret-box.
    await bypass(() => db.user.update({ where: { id: fixture.userId }, data: { email, password, mfaSecret: TOTP_SECRET, mfaEnabled: true } }));
    await bypass(() =>
      db.fiscalConfig.create({
        data: { companyId: fixture.companyId, branchId: fixture.branchId, certificatePassword: CERT_PASSWORD, cscToken: CSC },
      })
    );
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture?.companyId) {
      const companyId = fixture.companyId;
      await bypass(() => db.fiscalConfig.deleteMany({ where: { companyId } }));
      await destroyFixture(fixture);
    }
  });

  it('modo conferência conta os segredos em texto puro e não altera nada', async () => {
    const check = await encryptPlaintextSecrets({ checkOnly: true, companyId: fixture.companyId });
    expect(check).toEqual({ mfaPlain: 1, mfaSealed: 0, fiscalPlain: 2, fiscalSealed: 0 });
    expect((await userRow()).mfaSecret).toBe(TOTP_SECRET);
    expect((await fiscalRow()).certificatePassword).toBe(CERT_PASSWORD);
  });

  it('migração cifra tudo (enc:v1), sem o valor legível no banco, e abre com a chave no valor original', async () => {
    const run = await encryptPlaintextSecrets({ companyId: fixture.companyId });
    expect(run).toEqual({ mfaPlain: 1, mfaSealed: 1, fiscalPlain: 2, fiscalSealed: 2 });

    const user = await userRow();
    const fiscal = await fiscalRow();
    for (const [stored, original] of [
      [user.mfaSecret, TOTP_SECRET],
      [fiscal.certificatePassword, CERT_PASSWORD],
      [fiscal.cscToken, CSC],
    ]) {
      expect(isSealed(stored)).toBe(true);
      expect(stored.startsWith('enc:v1:')).toBe(true);
      expect(stored).not.toContain(original);
      expect(openSecret(stored)).toBe(original);
    }
  });

  it('o login com MFA continua funcionando com o segredo migrado', async () => {
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const ok = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: login.body.mfaToken, code: totp(TOTP_SECRET), method: 'totp' });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken ?? ok.body.data?.accessToken).toBeTruthy();
  });

  it('segunda execução é idempotente: nada em texto puro, nada recifrado', async () => {
    const before = await userRow();
    const again = await encryptPlaintextSecrets({ companyId: fixture.companyId });
    expect(again).toEqual({ mfaPlain: 0, mfaSealed: 0, fiscalPlain: 0, fiscalSealed: 0 });
    expect((await userRow()).mfaSecret).toBe(before.mfaSecret);
  });
});
