import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * DECISÃO 157 — SENHA TEMPORÁRIA E TROCA DE SENHA PELO PRÓPRIO USUÁRIO (Postgres e Redis reais, papel real de execução).
 * Prova: a senha definida por um administrador é temporária e NENHUMA sessão sai enquanto não for trocada; a credencial de troca não serve como sessão, como token de MFA
 * nem como credencial de enrolamento; errar a senha atual conta como tentativa e bloqueia; a nova senha segue a política; a troca derruba as sessões e a senha antiga para
 * de valer; com MFA ativo o segundo fator vem ANTES da troca; a redefinição pelo administrador volta a exigir troca; papel de filial não altera senha nem a exigência
 * nem por SQL direto; a auditoria registra a troca sem senha.
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

describe('senha temporária e troca de senha (decisão 157)', () => {
  let A: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let adminToken: string;
  const stamp = Date.now();
  const TEMP = 'Temp-4821-ab';
  const FINAL = `Nova-Forte-${stamp}-ok`;
  const created: string[] = [];
  const email = (label: string) => `pwc-${label}-${stamp}@teste-cortex.local`;
  const auditJobs = () => auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1] as { action: string; entity: string; entityId: string | null; userId: string | null; newValue: string | null });
  const userByEmail = (e: string) => bypass<any>(() => db.user.findUnique({ where: { email: e } }));
  const makeUser = async (label: string, userType: string, extra: Record<string, unknown> = {}, password = TEMP) => {
    const hash = await hashPassword(password);
    const user = await bypass<any>(() =>
      db.user.create({
        data: { companyId: A.companyId, branchId: A.branchId, name: `PWC ${label}`, email: email(label), password: hash, userType: userType as any, isActive: true, ...extra },
      })
    );
    created.push(user.id);
    return user;
  };
  const login = (label: string, password: string) => request(app).post('/api/auth/login').send({ email: email(label), password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const complete = (passwordChangeToken: string, currentPassword: string, newPassword: string) =>
    request(app).post('/api/auth/password-change/complete').send({ passwordChangeToken, currentPassword, newPassword });
  const asBranchRole = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: A.companyId, branchId: A.branchId, userType: 'MANAGER' }, fn);

  beforeAll(async () => {
    A = await createFixture('pwchange');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const admin = await makeUser('admin', 'COMPANY_ADMIN', {}, `Admin-${stamp}-Forte1`);
    adminToken = generateAccessToken({ userId: admin.id, email: admin.email, companyId: A.companyId, branchId: A.branchId, userType: 'COMPANY_ADMIN' } as any);
    await resetAuthLimits();
  });

  beforeEach(async () => {
    await resetAuthLimits();
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    await resetAuthLimits();
    if (created.length) {
      await bypass(() => db.refreshToken.deleteMany({ where: { userId: { in: created }, OR: [{ companyId: A.companyId }, { companyId: null }] } }));
      await bypass(() => db.user.deleteMany({ where: { id: { in: created }, OR: [{ companyId: A.companyId }, { companyId: null }] } }));
    }
    if (A?.companyId) await destroyFixture(A);
  });

  let changeToken: string;
  let opId: string;

  it('o administrador cria o usuário pela API: a senha é TEMPORÁRIA por padrão; com requirePasswordChange:false entra direto', async () => {
    const res = await request(app).post('/api/users').set(bearer(adminToken)).send({ name: 'Operador PWC', email: email('op'), password: TEMP, userType: 'OPERATOR', branchId: A.branchId });
    expect(res.status).toBe(201);
    opId = res.body.data.id;
    created.push(opId);
    expect((await userByEmail(email('op'))).mustChangePassword).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('mustChangePassword'); // a flag não vaza no cadastro devolvido

    const semTroca = await request(app).post('/api/users').set(bearer(adminToken)).send({ name: 'Sem troca', email: email('direct'), password: TEMP, userType: 'OPERATOR', branchId: A.branchId, requirePasswordChange: false });
    expect(semTroca.status).toBe(201);
    created.push(semTroca.body.data.id);
    expect((await login('direct', TEMP)).status).toBe(200);
  });

  it('login com a senha temporária: 403 PASSWORD_CHANGE_REQUIRED + credencial, e NENHUMA sessão; senha errada segue 401', async () => {
    const res = await login('op', TEMP);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(typeof res.body.passwordChangeToken).toBe('string');
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    changeToken = res.body.passwordChangeToken;
    expect((await login('op', 'senha-errada-xyz')).status).toBe(401); // não revela a pendência a quem não sabe a senha
  });

  it('a credencial de troca não serve de sessão, de token de MFA nem de credencial de enrolamento; um access token comum não serve para trocar', async () => {
    expect((await request(app).get('/api/auth/me').set(bearer(changeToken))).status).toBe(401);
    expect((await request(app).get('/api/users').set(bearer(changeToken))).status).toBe(401);
    expect((await request(app).post('/api/auth/verify-mfa').send({ mfaToken: changeToken, code: '123456', method: 'totp' })).status).toBe(401);
    expect((await request(app).post('/api/auth/mfa-enrollment/begin').send({ enrollmentToken: changeToken })).status).toBe(401);
    expect((await complete(adminToken, TEMP, FINAL)).status).toBe(401);
    expect((await complete('lixo', TEMP, FINAL)).status).toBe(401);
  });

  it('senha atual errada: 401 e conta como tentativa; ao atingir o limite a conta é bloqueada (403 ACCOUNT_LOCKED) e a senha não muda', async () => {
    await makeUser('lock', 'OPERATOR', { mustChangePassword: true });
    const token = (await login('lock', TEMP)).body.passwordChangeToken as string;
    let last = 0;
    for (let i = 0; i < 10 && last !== 403; i++) {
      const res = await complete(token, 'errada-errada-1', FINAL);
      last = res.status;
      if (last !== 403) expect(res.body.error).toBe('INVALID_CURRENT_PASSWORD');
    }
    expect(last).toBe(403);
    const row = await userByEmail(email('lock'));
    expect(row.lockedUntil).not.toBeNull();
    const refused = await complete(token, TEMP, FINAL);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('ACCOUNT_LOCKED');
    expect((await userByEmail(email('lock'))).mustChangePassword).toBe(true); // nada mudou
  });

  it('nova senha fora da política: 400 WEAK_PASSWORD (curta, sem número, sem letra, igual à atual, comum, contendo o e-mail) e a senha NÃO muda', async () => {
    const local = `pwc-op-${stamp}`;
    for (const weak of ['Curta1', 'somenteletrasaqui', '1234567890123', TEMP, 'senha12345', `xx${local}9`]) {
      await resetAuthLimits(); // o limitador de abuso por IP (5 tentativas) é do produto e está certo; aqui a pergunta é a política
      const res = await complete(changeToken, TEMP, weak);
      expect({ weak, status: res.status, code: res.body.error }).toEqual({ weak, status: 400, code: 'WEAK_PASSWORD' });
    }
    expect((await login('op', TEMP)).status).toBe(403); // continua pendente, com a mesma senha temporária
  });

  it('troca correta: 200, a senha temporária para de valer e a nova entra com sessão; a credencial não troca de novo', async () => {
    const res = await complete(changeToken, TEMP, FINAL);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FINAL);
    const row = await userByEmail(email('op'));
    expect(row.mustChangePassword).toBe(false);
    expect(row.passwordChangedAt).not.toBeNull();
    expect((await login('op', TEMP)).status).toBe(401);
    const ok = await login('op', FINAL);
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeDefined();
    const again = await complete(changeToken, FINAL, `Outra-${stamp}-Senha9`);
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('PASSWORD_CHANGE_REFUSED'); // não está mais pendente
  });

  it('a auditoria registra a troca e NUNCA a senha', async () => {
    const rows = await bypass<any[]>(() => db.auditLog.findMany({ where: { companyId: A.companyId, entity: 'User', entityId: opId } }));
    const changed = rows.filter((r) => /PASSWORD_CHANGED/.test(String(r.newValue)));
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(changed[0].newValue)).toEqual({ operation: 'PASSWORD_CHANGED', via: 'first-access' });
    const everything = JSON.stringify([rows, auditJobs()]);
    for (const secret of [TEMP, FINAL]) expect(everything).not.toContain(secret);
  });

  it('troca voluntária (/change-password): exige sessão, a senha atual e a política; derruba o access token e o refresh token anteriores', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // o teste anterior revogou os tokens do usuário: a revogação tem granularidade de SEGUNDO (iat <= revokedAt)
    const session = await login('op', FINAL);
    const { accessToken, refreshToken } = session.body;
    expect((await request(app).post('/api/auth/change-password').send({ currentPassword: FINAL, newPassword: `Mais-${stamp}-Nova1` })).status).toBe(401);
    expect((await request(app).post('/api/auth/change-password').set(bearer(accessToken)).send({ currentPassword: 'errada-errada-1', newPassword: `Mais-${stamp}-Nova1` })).status).toBe(401);
    expect((await request(app).post('/api/auth/change-password').set(bearer(accessToken)).send({ currentPassword: FINAL, newPassword: 'curta' })).status).toBe(400);
    const newer = `Mais-${stamp}-Nova1`;
    expect((await request(app).post('/api/auth/change-password').set(bearer(accessToken)).send({ currentPassword: FINAL, newPassword: newer })).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(accessToken))).status).toBe(401); // sessão antiga revogada
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(401);
    expect((await login('op', FINAL)).status).toBe(401);
    expect((await login('op', newer)).status).toBe(200);
  });

  it('administrador da empresa segue a régua do Super Admin ao trocar a própria senha: 12 caracteres e 3 tipos (o operador, 10 com letra e número)', async () => {
    const current = `Adm2-${stamp}-Forte1`;
    await makeUser('admpol', 'COMPANY_ADMIN', {}, current);
    const { accessToken } = (await login('admpol', current)).body;
    expect(accessToken).toBeTruthy();
    const change = (newPassword: string) => request(app).post('/api/auth/change-password').set(bearer(accessToken)).send({ currentPassword: current, newPassword });
    const short = await change('Abcdefg123'); // 10 caracteres: vale para operador, não para administrador
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/administrador.*12/i);
    expect((await change('abcdefghijkl1234')).body.message).toMatch(/3 tipos/);
    expect((await change(`Abcdefghijkl-${stamp}`)).status).toBe(200);
  });

  it('a redefinição pelo administrador volta a exigir a troca; com requirePasswordChange:false não exige', async () => {
    const res = await request(app).post(`/api/users/${opId}/reset-password`).set(bearer(adminToken)).send({ password: 'Temp-777-xyz' });
    expect(res.status).toBe(200);
    const pending = await login('op', 'Temp-777-xyz');
    expect(pending.status).toBe(403);
    expect(pending.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(app).post(`/api/users/${opId}/reset-password`).set(bearer(adminToken)).send({ password: 'Temp-888-xyz', requirePasswordChange: false });
    expect((await login('op', 'Temp-888-xyz')).status).toBe(200);
  });

  it('com MFA ativo o segundo fator vem ANTES da troca: o login pede o código e só depois entrega a credencial de troca', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    await makeUser('mfa', 'COMPANY_ADMIN', { mfaEnabled: true, mfaSecret: sealSecret(secret), mustChangePassword: true });
    const first = await login('mfa', TEMP);
    expect(first.status).toBe(200);
    expect(first.body.mfaRequired).toBe(true);
    expect(first.body.passwordChangeToken).toBeUndefined(); // quem só sabe a senha temporária não troca a senha
    const verified = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: first.body.mfaToken, code: totp(secret), method: 'totp' });
    expect(verified.status).toBe(403);
    expect(verified.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(verified.body.accessToken).toBeUndefined();
    expect((await complete(verified.body.passwordChangeToken, TEMP, FINAL)).status).toBe(200);

    await bypass(() => db.user.update({ where: { email: email('mfa') }, data: { mfaLastStep: null, loginAttempts: 0, lockedUntil: null } }));
    const next = await login('mfa', FINAL);
    expect(next.body.mfaRequired).toBe(true);
    const session = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: next.body.mfaToken, code: totp(secret, Date.now() + 30_000), method: 'totp' });
    expect(session.status).toBe(200);
    expect(session.body.accessToken).toBeDefined();
  });

  it('papel de filial não altera a senha, a exigência de troca nem a data da senha de um colega, nem por SQL direto; a administração segue livre', async () => {
    const colleague = await makeUser('colleague', 'OPERATOR', { mustChangePassword: true });
    for (const data of [{ mustChangePassword: false }, { password: 'not-a-real-hash' }, { passwordChangedAt: new Date() }]) {
      await expect(asBranchRole(() => prisma.user.update({ where: { id: colleague.id }, data }))).rejects.toThrow(/papel de filial/);
    }
    expect((await userByEmail(email('colleague'))).mustChangePassword).toBe(true); // nada mudou
    const adminUpdate = await runWithRLSContext({ companyId: A.companyId, branchId: null, userType: 'COMPANY_ADMIN' }, () => prisma.user.update({ where: { id: colleague.id }, data: { mustChangePassword: false } }));
    expect(adminUpdate.mustChangePassword).toBe(false);
  });
});
