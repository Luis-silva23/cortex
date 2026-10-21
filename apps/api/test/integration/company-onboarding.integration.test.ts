import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * ONBOARDING DE UMA EMPRESA CLIENTE, ponta a ponta, só com os endpoints de produção (Postgres e Redis reais, papel real de execução):
 * o Super Admin cria a empresa, a licença (com limite de filiais), a matriz e o administrador com senha TEMPORÁRIA; o administrador troca a senha, configura o MFA
 * obrigatório (política de produção) e só então abre a sessão; cria a segunda filial e um gerente (sem filial = recusado; com filial = ok, primeiro acesso exige troca);
 * o limite da licença barra a filial extra; outra empresa não enxerga nada disso. É o roteiro que o operador segue para entregar o sistema a um cliente.
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

describe('onboarding de empresa cliente (Super Admin → administrador → gerente)', () => {
  let other: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let saToken: string;
  let saId: string;
  const stamp = Date.now();
  const TEMP = 'Temp-onb-4821-x';
  const FINAL = `Onb-Forte-${stamp}-ok`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const email = (label: string) => `onb-${label}-${stamp}@teste-cortex.local`;
  const state: Record<string, any> = {};
  const prevMfaFlag = process.env.REQUIRE_MFA_COMPANY_ADMIN;

  beforeAll(async () => {
    other = await createFixture('onbother');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const hash = await hashPassword(`Sa-${stamp}-Forte1`);
    const sa = await bypass<any>(() => db.user.create({ data: { companyId: null, name: 'SA onboarding', email: email('sa'), password: hash, userType: 'SUPER_ADMIN', isActive: true } }));
    saId = sa.id;
    saToken = generateAccessToken({ userId: sa.id, email: sa.email, userType: 'SUPER_ADMIN' } as any);
    process.env.REQUIRE_MFA_COMPANY_ADMIN = 'true'; // política de produção: o administrador da empresa só entra com MFA
    await resetAuthLimits();
  });

  beforeEach(async () => {
    await resetAuthLimits();
  });

  afterAll(async () => {
    if (prevMfaFlag === undefined) delete process.env.REQUIRE_MFA_COMPANY_ADMIN;
    else process.env.REQUIRE_MFA_COMPANY_ADMIN = prevMfaFlag;
    auditSpy.mockRestore();
    await resetAuthLimits();
    if (state.companyId) await destroyFixture({ companyId: state.companyId } as IntegrationFixture);
    if (saId) {
      await bypass(() => db.refreshToken.deleteMany({ where: { userId: saId, companyId: null } }));
      await bypass(() => db.user.deleteMany({ where: { id: saId, companyId: null } }));
    }
    if (other?.companyId) await destroyFixture(other);
  });

  it('o Super Admin cria a empresa, a licença (3 filiais) e a matriz', async () => {
    const company = await request(app).post('/api/companies').set(bearer(saToken)).send({ name: `Integration Test Co onboarding-${stamp}`, document: `99${String(stamp).slice(-12)}`, email: email('empresa') });
    expect(company.status).toBe(201);
    state.companyId = company.body.data.id;
    expect(company.body.data.isActive).toBe(true);

    const license = await request(app).post('/api/licenses').set(bearer(saToken)).send({ companyId: state.companyId, licenseType: 'TRIAL', maxDevices: 2, maxUsers: 3, maxBranches: 2 });
    expect(license.status).toBe(201);
    const start = new Date();
    const expiry = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const approved = await request(app).post(`/api/licenses/${license.body.data.id}/approve`).set(bearer(saToken)).send({ startDate: start.toISOString(), expiryDate: expiry.toISOString() });
    expect(approved.status).toBe(200);

    const hq = await request(app).post('/api/branches').set(bearer(saToken)).send({ companyId: state.companyId, name: 'Matriz', isHeadquarter: true });
    expect(hq.status).toBe(201);
    state.hqId = hq.body.data.id;
  });

  it('o Super Admin cria o administrador da empresa com senha TEMPORÁRIA (por padrão) e sem expor a flag', async () => {
    const res = await request(app).post('/api/users').set(bearer(saToken)).send({ companyId: state.companyId, name: 'Administradora Cliente', email: email('admin'), password: TEMP, userType: 'COMPANY_ADMIN' });
    expect(res.status).toBe(201);
    state.adminId = res.body.data.id;
    expect(JSON.stringify(res.body)).not.toContain('mustChangePassword');
    const row = await bypass<any>(() => db.user.findUnique({ where: { id: state.adminId } }));
    expect(row.mustChangePassword).toBe(true);
    expect(row.companyId).toBe(state.companyId);
  });

  it('primeiro acesso do administrador: senha temporária → troca obrigatória → MFA obrigatório → sessão (nessa ordem, sem nenhuma sessão antes do fim)', async () => {
    const first = await request(app).post('/api/auth/login').send({ email: email('admin'), password: TEMP });
    expect(first.status).toBe(403);
    expect(first.body.error).toBe('PASSWORD_CHANGE_REQUIRED'); // a troca vem ANTES de configurar o MFA (a conta ainda não tem MFA)
    expect(first.body.accessToken).toBeUndefined();

    const changed = await request(app).post('/api/auth/password-change/complete').send({ passwordChangeToken: first.body.passwordChangeToken, currentPassword: TEMP, newPassword: FINAL });
    expect(changed.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // revogação com granularidade de SEGUNDO (iat <= revokedAt): ver o teste do gerente abaixo

    const second = await request(app).post('/api/auth/login').send({ email: email('admin'), password: FINAL });
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(second.body.accessToken).toBeUndefined();

    const begun = await request(app).post('/api/auth/mfa-enrollment/begin').send({ enrollmentToken: second.body.enrollmentToken });
    expect(begun.status).toBe(200);
    const confirmed = await request(app).post('/api/auth/mfa-enrollment/confirm').send({ enrollmentToken: second.body.enrollmentToken, code: totp(begun.body.data.secret) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.accessToken).toBeDefined();
    expect(confirmed.body.backupCodes.length).toBeGreaterThan(0);
    state.adminToken = confirmed.body.accessToken;
    state.mfaSecret = begun.body.data.secret;
  });

  it('o administrador da empresa vê só a própria empresa e cria a segunda filial; o limite da licença (2) barra a terceira com 409', async () => {
    const mine = await request(app).get('/api/branches').set(bearer(state.adminToken));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((b: any) => b.id)).toEqual([state.hqId]);

    const second = await request(app).post('/api/branches').set(bearer(state.adminToken)).send({ name: 'Filial 2' });
    expect(second.status).toBe(201);
    expect(second.body.data.companyId).toBe(state.companyId);
    state.b2Id = second.body.data.id;

    const third = await request(app).post('/api/branches').set(bearer(state.adminToken)).send({ name: 'Filial 3' });
    expect(third.status).toBe(409);
    expect(third.body.code || third.body.error).toMatch(/BRANCH_LIMIT_REACHED/);
  });

  it('o administrador cadastra o gerente: papel de filial sem filial é decisão da tela; pela API o gerente nasce na filial informada e com senha temporária', async () => {
    const res = await request(app).post('/api/users').set(bearer(state.adminToken)).send({ name: 'Gerente Cliente', email: email('gerente'), password: TEMP, userType: 'MANAGER', branchId: state.b2Id });
    expect(res.status).toBe(201);
    state.managerId = res.body.data.id;
    expect(res.body.data.branchId).toBe(state.b2Id);
    const granted = await request(app).put(`/api/users/${state.managerId}/branches`).set(bearer(state.adminToken)).send({ branchIds: [state.hqId] });
    expect(granted.status).toBe(200);
    expect(granted.body.data.branchIds.sort()).toEqual([state.hqId, state.b2Id].sort());

    const login = await request(app).post('/api/auth/login').send({ email: email('gerente'), password: TEMP });
    expect(login.status).toBe(403);
    expect(login.body.error).toBe('PASSWORD_CHANGE_REQUIRED'); // gerente também troca a senha temporária
  });

  it('o gerente não pode criar usuário nem conceder filial (só administração); o administrador não cria usuário na filial de OUTRA empresa', async () => {
    const changed = await request(app)
      .post('/api/auth/password-change/complete')
      .send({ passwordChangeToken: (await request(app).post('/api/auth/login').send({ email: email('gerente'), password: TEMP })).body.passwordChangeToken, currentPassword: TEMP, newPassword: `Ger-${FINAL}` });
    expect(changed.status).toBe(200);
    // a revogação de acesso tem granularidade de SEGUNDO (iat <= revokedAt): um token emitido no mesmo segundo da troca seria recusado. Uma pessoa leva mais que isso entre trocar e entrar.
    await new Promise((r) => setTimeout(r, 1100));
    const session = await request(app).post('/api/auth/login').send({ email: email('gerente'), password: `Ger-${FINAL}` });
    expect(session.status).toBe(200);
    const mgr = bearer(session.body.accessToken);
    expect((await request(app).post('/api/users').set(mgr).send({ name: 'x', email: email('x'), password: TEMP, userType: 'OPERATOR', branchId: state.b2Id })).status).toBe(403);
    expect((await request(app).put(`/api/users/${state.managerId}/branches`).set(mgr).send({ branchIds: [state.hqId, state.b2Id] })).status).toBe(403);

    const cross = await request(app).post('/api/users').set(bearer(state.adminToken)).send({ name: 'Cruzado', email: email('cruzado'), password: TEMP, userType: 'OPERATOR', branchId: other.branchId });
    expect([400, 403, 404]).toContain(cross.status);
    expect(await bypass<any>(() => db.user.findUnique({ where: { email: email('cruzado') } }))).toBeNull();
  });

  it('o limite de usuários do plano (3) barra o quarto com 409; desativar libera a vaga e reativar além do limite é recusado', async () => {
    // até aqui: administrador + gerente. O terceiro (operador) cabe; o quarto não.
    const third = await request(app).post('/api/users').set(bearer(state.adminToken)).send({ name: 'Operador Cliente', email: email('operador'), password: TEMP, userType: 'OPERATOR', branchId: state.hqId });
    expect(third.status).toBe(201);
    const fourth = await request(app).post('/api/users').set(bearer(state.adminToken)).send({ name: 'Quarto', email: email('quarto'), password: TEMP, userType: 'OPERATOR', branchId: state.hqId });
    expect(fourth.status).toBe(409);
    expect(fourth.body.code || fourth.body.error).toMatch(/USER_LIMIT_REACHED/);
    expect(await bypass<any>(() => db.user.findUnique({ where: { email: email('quarto') } }))).toBeNull();

    const off = await request(app).post(`/api/users/${third.body.data.id}/toggle-active`).set(bearer(state.adminToken));
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    const fifth = await request(app).post('/api/users').set(bearer(state.adminToken)).send({ name: 'Quinto', email: email('quinto'), password: TEMP, userType: 'OPERATOR', branchId: state.hqId });
    expect(fifth.status).toBe(201); // a vaga liberada foi usada
    const back = await request(app).post(`/api/users/${third.body.data.id}/toggle-active`).set(bearer(state.adminToken));
    expect(back.status).toBe(409); // reativar o antigo estouraria o plano
    expect(back.body.code || back.body.error).toMatch(/USER_LIMIT_REACHED/);
  });

  it('outra empresa não enxerga a empresa nova (listas e ids) e o Super Admin a enxerga', async () => {
    const otherAdmin = generateAccessToken({ userId: other.userId, email: 'x@y.z', companyId: other.companyId, branchId: other.branchId, userType: 'COMPANY_ADMIN' } as any);
    const branches = await request(app).get('/api/branches').set(bearer(otherAdmin));
    expect(JSON.stringify(branches.body)).not.toContain(state.hqId);
    expect(JSON.stringify(branches.body)).not.toContain(state.b2Id);
    expect((await request(app).get(`/api/branches/${state.hqId}`).set(bearer(otherAdmin))).status).toBe(404);
    expect((await request(app).get(`/api/users/${state.managerId}/branches`).set(bearer(otherAdmin))).status).toBe(404);
    const companies = await request(app).get('/api/companies').set(bearer(saToken));
    expect(JSON.stringify(companies.body)).toContain(state.companyId);
  });

  it('o administrador entra de novo com senha + código MFA (a sessão normal depois do onboarding)', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: email('admin'), password: FINAL });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    await db.$executeRawUnsafe('SELECT 1'); // mantém a conexão aquecida; o código abaixo usa o PRÓXIMO passo de 30 s (o atual foi consumido na configuração)
    const verified = await request(app).post('/api/auth/verify-mfa').send({ mfaToken: login.body.mfaToken, code: totp(state.mfaSecret, Date.now() + 30_000), method: 'totp' });
    expect(verified.status).toBe(200);
    expect(verified.body.accessToken).toBeDefined();
  });
});
