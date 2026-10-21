import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { isSealed, openSecret, sealSecret } from '@ln-system/shared/utils/secret-box';
import { generateAccessToken, generateMfaEnrollmentToken } from '@ln-system/shared/utils/token';
import { isAccessTokenRevoked } from '../../src/services/access-token-revocation';
import { hashRefreshToken } from '../../src/services/refresh-token-hash';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';
import { advancedRateLimiter } from '../../src/middlewares/advancedRateLimit';

/**
 * DECISÃO 123 — MFA obrigatório para COMPANY_ADMIN, com enrolamento pela tela (Postgres e Redis reais).
 * Prova: login sem MFA devolve a credencial de configuração (e nenhuma sessão); a credencial não serve como sessão nem como token de
 * verificação; o segredo fica cifrado e só aparece uma vez; só um código válido ativa; o mesmo código não vale duas vezes; erros de
 * código contam como tentativa e bloqueiam; o perfil não desliga o próprio MFA; mudar de perfil derruba as sessões; a recuperação é
 * administrativa, com senha e motivo, auditada, e derruba as sessões; a política é pelo perfil ATUAL (inclusive na renovação).
 */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('MFA obrigatório para COMPANY_ADMIN (decisão 123)', () => {
  let A: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const PASSWORD = `Forte-${stamp}-Xk!`;
  const created: string[] = [];
  const email = (label: string) => `mfa-${label}-${stamp}@teste-cortex.local`;
  const auditJobs = () => auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1] as { action: string; entity: string; entityId: string | null; userId: string | null; newValue: string | null });
  const userByEmail = (e: string) => bypass<any>(() => db.user.findUnique({ where: { email: e } }));
  const makeUser = async (label: string, userType: string, withCompany = true) => {
    const password = await hashPassword(PASSWORD);
    const user = await bypass<any>(() =>
      db.user.create({
        data: { companyId: withCompany ? A.companyId : null, branchId: withCompany ? A.branchId : null, name: `MFA ${label}`, email: email(label), password, userType: userType as any, isActive: true },
      })
    );
    created.push(user.id);
    return user;
  };
  const login = (label: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ email: email(label), password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const setEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const clearLockAndStep = (label: string) =>
    bypass(() => db.user.update({ where: { email: email(label) }, data: { loginAttempts: 0, lockedUntil: null, mfaLastStep: null } }));

  beforeAll(async () => {
    A = await createFixture('mfaca');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    await resetAuthLimits();
  });

  beforeEach(async () => {
    await resetAuthLimits();
  });

  afterAll(async () => {
    setEnv('REQUIRE_MFA_COMPANY_ADMIN', undefined);
    setEnv('REQUIRE_MFA_PRIVILEGED', undefined);
    auditSpy.mockRestore();
    await resetAuthLimits();
    if (created.length) {
      await bypass(() => db.refreshToken.deleteMany({ where: { userId: { in: created }, OR: [{ companyId: A.companyId }, { companyId: null }] } }));
      await bypass(() => db.user.deleteMany({ where: { id: { in: created }, OR: [{ companyId: A.companyId }, { companyId: null }] } }));
    }
    if (A?.companyId) await destroyFixture(A);
  });

  // estado compartilhado entre os casos (a sequência é o fluxo real: login → configurar → entrar com código)
  let adminRefreshBeforePolicy: string;
  let secret: string;
  let backupCodes: string[];

  it('política desligada (padrão de desenvolvimento): COMPANY_ADMIN sem MFA entra normalmente', async () => {
    await makeUser('admin', 'COMPANY_ADMIN');
    setEnv('REQUIRE_MFA_COMPANY_ADMIN', 'false');
    const res = await login('admin');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    adminRefreshBeforePolicy = res.body.refreshToken;
  });

  it('política ligada: login com a senha certa e SEM MFA devolve 403 + credencial de configuração, e nenhuma sessão', async () => {
    setEnv('REQUIRE_MFA_COMPANY_ADMIN', 'true');
    const res = await login('admin');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(typeof res.body.enrollmentToken).toBe('string');
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    // senha errada continua 401 (não revela a exigência a quem não sabe a senha)
    expect((await login('admin', 'senha-errada-xyz')).status).toBe(401);
  });

  it('a credencial de configuração não serve de sessão nem de token de verificação de MFA', async () => {
    const first = await login('admin');
    const token = first.body.enrollmentToken as string;
    expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(401);
    expect((await request(app).get('/api/users').set(bearer(token))).status).toBe(401);
    const asPending = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: token, code: '123456', method: 'totp' });
    expect([400, 401]).toContain(asPending.status);
    expect(asPending.body.accessToken).toBeUndefined();
    // e uma credencial forjada / lixo é recusada nas rotas de configuração
    expect((await request(app).post('/api/auth/mfa-enrollment/begin').send({ enrollmentToken: 'lixo' })).status).toBe(401);
  });

  it('a renovação de uma sessão aberta ANTES da exigência é recusada (e o refresh token é revogado)', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: adminRefreshBeforePolicy });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const row = await bypass<any>(() => db.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(adminRefreshBeforePolicy) } }));
    expect(row.isRevoked).toBe(true);
  });

  it('configurar: o segredo sai UMA vez, fica cifrado e inativo; código errado não ativa; código certo ativa e entrega a sessão + códigos de recuperação', async () => {
    // TOTP troca de código a cada 30 s. Este teste ATIVA com o código do passo atual e o teste seguinte repete esse mesmo código esperando
    // "já utilizado": se o relógio virasse o passo entre os dois (≈ 1/3 das vezes com ~10 s de suíte), o código seria NOVO e o replay passaria
    // (200 em vez de 400) — falha intermitente do teste, não do produto. Começa só com folga suficiente no passo atual.
    const msLeftInStep = () => 30_000 - (Date.now() % 30_000);
    if (msLeftInStep() < 14_000) await new Promise((r) => setTimeout(r, msLeftInStep() + 150));
    const token = (await login('admin')).body.enrollmentToken as string;
    const begun = await request(app).post('/api/auth/mfa-enrollment/begin').send({ enrollmentToken: token });
    expect(begun.status).toBe(200);
    expect(begun.headers['cache-control']).toContain('no-store');
    secret = begun.body.data.secret;
    expect(secret).toMatch(/^[A-Z2-7]{20,}$/);
    expect(begun.body.data.otpauthUrl).toContain('otpauth://totp/');
    let row = await userByEmail(email('admin'));
    expect(row.mfaEnabled).toBe(false);
    expect(isSealed(row.mfaSecret)).toBe(true);
    expect(row.mfaSecret).not.toContain(secret);
    expect(openSecret(row.mfaSecret)).toBe(secret);

    const wrong = await request(app).post('/api/auth/mfa-enrollment/confirm').send({ enrollmentToken: token, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('MFA_CODE_INVALID');
    expect((await userByEmail(email('admin'))).mfaEnabled).toBe(false);
    const malformed = await request(app).post('/api/auth/mfa-enrollment/confirm').send({ enrollmentToken: token, code: '12ab' });
    expect(malformed.status).toBe(400);

    const ok = await request(app).post('/api/auth/mfa-enrollment/confirm').send({ enrollmentToken: token, code: totp(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeDefined();
    expect(ok.body.refreshToken).toBeDefined();
    backupCodes = ok.body.backupCodes;
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes.every((c) => /^[0-9a-f]{16}$/.test(c))).toBe(true);
    row = await userByEmail(email('admin'));
    expect(row.mfaEnabled).toBe(true);
    expect(row.mfaBackupCodes).toHaveLength(10);
    expect(row.mfaBackupCodes.some((h: string) => backupCodes.includes(h))).toBe(false); // só hash em repouso
    expect(row.mfaLastStep).not.toBeNull();
    // a sessão entregue funciona
    expect((await request(app).get('/api/auth/me').set(bearer(ok.body.accessToken))).status).toBe(200);
    // auditoria do ato, sem segredo nem código. A rota grava SEM esperar (`createAuditLog(...).catch(...)` depois de responder): lê com tentativas
    // curtas em vez de supor que o INSERT já terminou — antes, sob carga, a leitura imediata vinha vazia (falha intermitente do teste).
    let audits: any[] = [];
    for (let attempt = 0; attempt < 40 && audits.length === 0; attempt++) {
      audits = await bypass<any[]>(() => db.auditLog.findMany({ where: { entity: 'UserMfa', entityId: row.id } }));
      if (audits.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).toContain('MFA_ENROLLED');
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(JSON.stringify(audits)).not.toContain(backupCodes[0]);
  });

  it('com o MFA ativo a credencial de configuração deixa de valer (não dá para trocar o segredo por ela)', async () => {
    const stale = generateMfaEnrollmentToken({ userId: (await userByEmail(email('admin'))).id, email: email('admin') });
    const res = await request(app).post('/api/auth/mfa-enrollment/begin').send({ enrollmentToken: stale });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_ENROLLMENT_REFUSED');
    expect(openSecret((await userByEmail(email('admin'))).mfaSecret)).toBe(secret); // segredo intacto
  });

  it('o MESMO código TOTP não vale duas vezes; depois do marcador zerado o código vale uma vez', async () => {
    // o passo atual já foi consumido na ativação
    const l1 = await login('admin');
    expect(l1.body.mfaRequired).toBe(true);
    expect(l1.body.accessToken).toBeUndefined();
    const replay = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l1.body.mfaToken, code: totp(secret), method: 'totp' });
    expect(replay.status).toBe(400);
    expect(replay.body.message).toMatch(/já utilizado/);
    await clearLockAndStep('admin'); // zera tentativas e o marcador só para o teste prosseguir sem esperar 30 s
    const next = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l1.body.mfaToken, code: totp(secret), method: 'totp' });
    expect(next.status).toBe(200);
    expect(next.body.accessToken).toBeDefined();
    // usar de novo o mesmo código (mesmo passo) falha
    const l2 = await login('admin');
    const again = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l2.body.mfaToken, code: totp(secret), method: 'totp' });
    expect(again.status).toBe(400);
  });

  it('código de recuperação: vale uma vez e depois não vale mais', async () => {
    await clearLockAndStep('admin');
    const l1 = await login('admin');
    const ok = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l1.body.mfaToken, code: backupCodes[0], method: 'backup' });
    expect(ok.status).toBe(200);
    const l2 = await login('admin');
    const reuse = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l2.body.mfaToken, code: backupCodes[0], method: 'backup' });
    expect(reuse.status).toBe(400);
    expect((await userByEmail(email('admin'))).mfaBackupCodes).toHaveLength(9);
  });

  it('código errado conta como tentativa: reentrar com a senha NÃO devolve as tentativas, e o 3º erro bloqueia a conta', async () => {
    await clearLockAndStep('admin');
    const l1 = await login('admin');
    const e1 = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l1.body.mfaToken, code: '111111', method: 'totp' });
    const e2 = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l1.body.mfaToken, code: '222222', method: 'totp' });
    expect([e1.status, e2.status]).toEqual([400, 400]);
    const l2 = await login('admin'); // senha certa de novo: não zera o contador
    expect((await userByEmail(email('admin'))).loginAttempts).toBe(2);
    const e3 = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l2.body.mfaToken, code: '333333', method: 'totp' });
    expect(e3.status).toBe(400);
    expect(e3.body.message).toMatch(/bloqueada/);
    const locked = await login('admin');
    expect(locked.status).toBe(401);
    expect(locked.body.message).toMatch(/bloqueada/);
    await clearLockAndStep('admin');
  });

  it('o perfil com MFA obrigatório não desliga o próprio MFA; um perfil sem exigência pode', async () => {
    const admin = await userByEmail(email('admin'));
    const adminToken = generateAccessToken({ userId: admin.id, email: admin.email, companyId: A.companyId, userType: 'COMPANY_ADMIN' });
    const refused = await request(app).post('/api/mfa/disable').set(bearer(adminToken)).send({ password: PASSWORD });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('MFA_REQUIRED_FOR_ROLE');
    expect((await userByEmail(email('admin'))).mfaEnabled).toBe(true);

    const mgr = await makeUser('manager', 'MANAGER');
    await bypass(() => db.user.update({ where: { id: mgr.id }, data: { mfaEnabled: true, mfaSecret: sealSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), mfaBackupCodes: ['x'] } }));
    // o token de um gerente SEMPRE leva a filial dele (o login a copia do cadastro): sem ela a RLS (usuário de filial só enxerga a própria filial) não acharia o registro
    const mgrToken = generateAccessToken({ userId: mgr.id, email: mgr.email, companyId: A.companyId, branchId: A.branchId, userType: 'MANAGER' });
    const allowed = await request(app).post('/api/mfa/disable').set(bearer(mgrToken)).send({ password: PASSWORD });
    expect(allowed.status).toBe(200);
    expect((await userByEmail(email('manager'))).mfaEnabled).toBe(false);
  });

  it('novos códigos de recuperação: exigem senha E código; os antigos deixam de valer', async () => {
    await clearLockAndStep('admin');
    const admin = await userByEmail(email('admin'));
    const adminToken = generateAccessToken({ userId: admin.id, email: admin.email, companyId: A.companyId, userType: 'COMPANY_ADMIN' });
    const noCode = await request(app).post('/api/mfa/backup-codes/regenerate').set(bearer(adminToken)).send({ password: PASSWORD });
    expect(noCode.status).toBe(400);
    const badPw = await request(app).post('/api/mfa/backup-codes/regenerate').set(bearer(adminToken)).send({ password: 'errada', code: totp(secret) });
    expect(badPw.status).toBe(400);
    const ok = await request(app).post('/api/mfa/backup-codes/regenerate').set(bearer(adminToken)).send({ password: PASSWORD, code: totp(secret) });
    expect(ok.status).toBe(200);
    const fresh: string[] = ok.body.data.backupCodes;
    expect(fresh).toHaveLength(10);
    const row = await userByEmail(email('admin'));
    expect(row.mfaBackupCodes).toHaveLength(10);
    expect(fresh.some((c) => backupCodes.includes(c))).toBe(false);
    await clearLockAndStep('admin');
    const l = await login('admin');
    const old = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l.body.mfaToken, code: backupCodes[1], method: 'backup' });
    expect(old.status).toBe(400); // código antigo
    const novo = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: l.body.mfaToken, code: fresh[0], method: 'backup' });
    expect(novo.status).toBe(200);
  });

  it('mudança de perfil derruba as sessões abertas e o perfil NOVO exige MFA desde o primeiro acesso; ninguém muda o próprio perfil', async () => {
    const sa = await makeUser('sa', 'SUPER_ADMIN', false);
    const saToken = generateAccessToken({ userId: sa.id, email: sa.email, userType: 'SUPER_ADMIN' });
    const op = await makeUser('promotee', 'OPERATOR');
    const session = await login('promotee'); // OPERATOR: sem exigência
    expect(session.status).toBe(200);
    const promote = await request(app).put(`/api/users/${op.id}`).set(bearer(saToken)).send({ userType: 'COMPANY_ADMIN' });
    expect(promote.status).toBe(200);
    const rows = await bypass<any[]>(() => db.refreshToken.findMany({ where: { userId: op.id } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.isRevoked)).toBe(true);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: session.body.refreshToken })).status).toBe(401);
    expect(await isAccessTokenRevoked(session.body.accessToken, { userId: op.id, companyId: A.companyId, iat: Math.floor(Date.now() / 1000) - 1 })).toBe(true);
    const next = await login('promotee');
    expect(next.status).toBe(403);
    expect(next.body.error).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(next.body.enrollmentToken).toBeDefined();

    const admin = await userByEmail(email('admin'));
    const adminToken = generateAccessToken({ userId: admin.id, email: admin.email, companyId: A.companyId, userType: 'COMPANY_ADMIN' });
    const self = await request(app).put(`/api/users/${admin.id}`).set(bearer(adminToken)).send({ userType: 'MANAGER' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_ROLE_CHANGE');
    expect((await userByEmail(email('admin'))).userType).toBe('COMPANY_ADMIN');
  });

  it('recuperação: só SUPER_ADMIN, com a PRÓPRIA senha e um motivo; apaga o fator, derruba as sessões e audita sem segredo', async () => {
    const admin = await userByEmail(email('admin'));
    const sa = await userByEmail(email('sa'));
    const saToken = generateAccessToken({ userId: sa.id, email: sa.email, userType: 'SUPER_ADMIN' });
    const adminToken = generateAccessToken({ userId: admin.id, email: admin.email, companyId: A.companyId, userType: 'COMPANY_ADMIN' });
    const url = `/api/users/${admin.id}/mfa/reset`;

    expect((await request(app).post(url).set(bearer(adminToken)).send({ password: PASSWORD, reason: 'perdi o celular' })).status).toBe(403); // COMPANY_ADMIN não reinicia
    expect((await request(app).post(url).set(bearer(saToken)).send({ password: PASSWORD })).status).toBe(400); // sem motivo
    expect((await request(app).post(url).set(bearer(saToken)).send({ password: 'errada-xyz', reason: 'perdeu o celular' })).status).toBe(401);
    expect((await request(app).post(`/api/users/${sa.id}/mfa/reset`).set(bearer(saToken)).send({ password: PASSWORD, reason: 'tentando em mim' })).status).toBe(403); // si mesmo
    expect((await userByEmail(email('admin'))).mfaEnabled).toBe(true); // nada mudou até aqui

    await resetAuthLimits();
    await advancedRateLimiter.reset('authorizer', `user:${sa.id}`); // as recusas acima contaram no balde do autorizador
    const ok = await request(app).post(url).set(bearer(saToken)).send({ password: PASSWORD, reason: 'perdeu o aplicativo autenticador (chamado 123)' });
    expect(ok.status).toBe(200);
    const row = await userByEmail(email('admin'));
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecret).toBeNull();
    expect(row.mfaBackupCodes).toEqual([]);
    expect(row.mfaLastStep).toBeNull();
    const tokens = await bypass<any[]>(() => db.refreshToken.findMany({ where: { userId: admin.id } }));
    expect(tokens.every((t) => t.isRevoked)).toBe(true);
    expect(await isAccessTokenRevoked(adminToken, { userId: admin.id, companyId: A.companyId, iat: Math.floor(Date.now() / 1000) - 5 })).toBe(true);
    const job = auditJobs().find((j) => j.entity === 'UserMfa' && j.entityId === admin.id && (j.newValue ?? '').includes('MFA_RESET'));
    expect(job).toBeDefined();
    expect(job!.userId).toBe(sa.id); // autor
    expect(JSON.stringify(job)).not.toContain(secret);
    // e a exigência volta: o próximo login pede nova configuração
    const again = await login('admin');
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('a credencial de configuração não vale para outro perfil (SUPER_ADMIN usa o procedimento administrativo) e SUPER_ADMIN sem MFA segue barrado', async () => {
    const sa = await userByEmail(email('sa'));
    const token = generateMfaEnrollmentToken({ userId: sa.id, email: sa.email });
    const res = await request(app).post('/api/auth/mfa-enrollment/begin').send({ enrollmentToken: token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_ENROLLMENT_REFUSED');
    setEnv('REQUIRE_MFA_PRIVILEGED', 'true');
    const l = await login('sa');
    expect(l.status).toBe(403);
    expect(l.body.error).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(l.body.enrollmentToken).toBeUndefined(); // Super Admin: sem credencial de configuração pela tela
  });
});
