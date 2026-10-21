import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hashRefreshToken } from '../../src/services/refresh-token-hash';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { policyService } from '../../src/services/policy.service';
import { clearDeviceSessionCache } from '../../src/services/device-session.service';
import { resetDeviceLimits } from '../../src/services/device-enrollment-limit';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * AUTORIZAÇÃO DE EQUIPAMENTO — fluxo completo contra o PostgreSQL real (RLS ligada):
 *   máquina nova → API alcançável → dado protegido → acesso funcional NEGADO → administrador autoriza → login e operação PERMITIDOS
 *   → administrador revoga → sessão invalidada na hora → acesso NEGADO.
 * Mais o isolamento (empresa/filial/equipamento/usuário) e a regra de uma sessão por equipamento e por usuário.
 */
describe('Autorização de equipamento (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let branchA2: string;
  let userA2: string; // usuário da filial A2
  let licenseA: string;
  let licenseB: string;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let superToken: string;
  let companyAdminToken: string;

  const PASSWORD = 'Senha-Disp-123!';
  const stamp = `dauth-${Date.now()}`;
  const emailA = `${stamp}-a@test.local`;
  const emailA2 = `${stamp}-a2@test.local`;
  const emailB = `${stamp}-b@test.local`;
  const IPS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'];

  const enroll = (name = `${stamp}-pdv`) => request(app).post('/api/device/enroll').send({ deviceName: name, deviceType: 'POS', hardwareHint: '02:AA:BB:CC:DD:01' });
  const status = (deviceId: string, deviceKey: string) => request(app).post('/api/device/status').send({ deviceId, deviceKey });
  const login = (email: string, deviceId?: string, deviceKey?: string) => request(app).post('/api/auth/login').send({ email, password: PASSWORD, deviceId, deviceKey });
  const asSuper = (r: request.Test) => r.set('Authorization', `Bearer ${superToken}`);
  const authorize = (deviceId: string, licenseId: string, branchId: string) =>
    asSuper(request(app).post(`/api/activations/enrollments/${deviceId}/authorize`)).send({ licenseId, branchId });
  const sessionsOf = (deviceId: string) => bypass<any[]>(() => db.deviceSession.findMany({ where: { deviceId } }));
  // limpeza sempre escopada pela empresa sintética do teste (guarda contra cleanup destrutivo)
  const clearSessions = () => bypass(() => db.deviceSession.deleteMany({ where: { companyId: A.companyId } }));
  const clearRefresh = () => bypass(() => db.refreshToken.deleteMany({ where: { user: { companyId: A.companyId } } }));
  const resetLimits = async () => {
    for (const ip of IPS) await resetDeviceLimits(ip);
  };

  /** Enrola e autoriza um equipamento para a licença/filial dadas; devolve id e chave. */
  const readyDevice = async (name: string, licenseId = licenseA, branchId = A.branchId) => {
    const e = await enroll(name);
    expect(e.status).toBe(201);
    const { deviceId, deviceKey } = e.body.data;
    const a = await authorize(deviceId, licenseId, branchId);
    expect(a.status).toBe(200);
    return { deviceId: deviceId as string, deviceKey: deviceKey as string };
  };

  beforeAll(async () => {
    await resetAuthLimits();
    await resetLimits();
    A = await createFixture('dauthA');
    B = await createFixture('dauthB');
    const hashed = await hashPassword(PASSWORD);
    await bypass(() => db.user.update({ where: { id: A.userId }, data: { email: emailA, password: hashed } }));
    await bypass(() => db.user.update({ where: { id: B.userId }, data: { email: emailB, password: hashed } }));
    const b2 = await bypass<any>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial 2', isActive: true } }));
    branchA2 = b2.id;
    const u2 = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: branchA2, name: 'Operador A2', email: emailA2, password: hashed, userType: 'OPERATOR', isActive: true } })
    );
    userA2 = u2.id;
    licenseA = (await bypass<any>(() => db.license.create({ data: { companyId: A.companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 8 } }))).id;
    licenseB = (await bypass<any>(() => db.license.create({ data: { companyId: B.companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 8 } }))).id;
    superToken = generateAccessToken({ userId: A.userId, email: 'sa@test.local', userType: 'SUPER_ADMIN' });
    companyAdminToken = generateAccessToken({ userId: A.userId, email: 'ca@test.local', companyId: A.companyId, branchId: A.branchId, userType: 'COMPANY_ADMIN' });
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    await resetLimits();
    // equipamentos pendentes sem empresa criados por estes testes (a fila é global)
    const pendingIds = (await bypass<{ id: string }[]>(() => db.device.findMany({ where: { licenseId: null, deviceName: { startsWith: stamp } }, select: { id: true } }))).map((d) => d.id);
    await bypass(() => db.device.deleteMany({ where: { id: { in: pendingIds } } }));
    for (const f of [A, B]) {
      if (!f?.companyId) continue;
      const companyId = f.companyId;
      await bypass(() => db.refreshToken.deleteMany({ where: { user: { companyId } } }));
      await bypass(() => db.deviceSession.deleteMany({ where: { companyId } }));
      await bypass(() => db.device.deleteMany({ where: { license: { companyId } } }));
      await bypass(() => db.license.deleteMany({ where: { companyId } }));
      if (f === A) {
        await bypass(() => db.user.deleteMany({ where: { id: userA2 } }));
        await bypass(() => db.branch.deleteMany({ where: { id: branchA2 } }));
      }
      await destroyFixture(f);
    }
  });

  describe('1. máquina nova: alcança a API, mas não usa o sistema', () => {
    let deviceId: string;
    let deviceKey: string;

    it('enrola: cria equipamento PENDENTE sem empresa/filial e devolve chave + código; no banco só o hash', async () => {
      const res = await enroll();
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      ({ deviceId, deviceKey } = res.body.data);
      expect(deviceKey).toMatch(/^dk_/);
      expect(res.body.data.enrollmentCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(res.body.data.status).toBe('PENDING');
      expect(JSON.stringify(res.body)).not.toMatch(/company|branch|license|empresa|filial/i);
      const row = await bypass<any>(() => db.device.findUnique({ where: { id: deviceId } }));
      expect(row.licenseId).toBeNull();
      expect(row.branchId).toBeNull();
      expect(row.status).toBe('PENDING');
      expect(row.secretHash).toBeTruthy();
      expect(row.secretHash).not.toBe(deviceKey);
      expect(JSON.stringify(row)).not.toContain(deviceKey);
    });

    it('rejeita corpo inválido/extra no enrolamento (400) sem criar nada', async () => {
      const before = await bypass<number>(() => db.device.count({ where: { licenseId: null } }));
      const bad = await request(app).post('/api/device/enroll').send({ deviceName: 'x', deviceType: 'POS' });
      const extra = await request(app).post('/api/device/enroll').send({ deviceName: `${stamp}-ok`, deviceType: 'POS', licenseId: licenseA, branchId: A.branchId });
      expect(bad.status).toBe(400);
      expect(extra.status).toBe(400); // o equipamento NÃO escolhe empresa nem filial
      expect(await bypass<number>(() => db.device.count({ where: { licenseId: null } }))).toBe(before);
    });

    it('status com a chave certa: PENDENTE e SÓ isso (sem dado de empresa)', async () => {
      const res = await status(deviceId, deviceKey);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['deviceId', 'deviceName', 'enrollmentCode', 'status']);
      expect(res.body.data.status).toBe('PENDING');
    });

    it('status com chave errada e com id inexistente: o MESMO 401 (não revela se o equipamento existe)', async () => {
      const wrongKey = await status(deviceId, 'dk_errada');
      const unknown = await status('00000000-0000-4000-8000-000000000000', deviceKey);
      const noBody = await request(app).post('/api/device/status').send({});
      expect(wrongKey.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(noBody.status).toBe(401);
      expect(unknown.body).toEqual(wrongKey.body);
    });

    it('login com senha CERTA a partir do equipamento pendente: 403 DEVICE_PENDING, sem token nem sessão', async () => {
      const res = await login(emailA, deviceId, deviceKey);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('DEVICE_PENDING');
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.user).toBeUndefined();
      expect(await sessionsOf(deviceId)).toHaveLength(0);
    });

    it('dado protegido sem token = 401; a chave do equipamento NÃO serve como token', async () => {
      expect((await request(app).get(`/api/products/${A.productId}`)).status).toBe(401);
      expect((await request(app).get('/api/products').set('Authorization', `Bearer ${deviceKey}`)).status).toBe(401);
      const forged = jwt.sign({ deviceId, companyId: A.companyId }, process.env.JWT_SECRET || 'test', { algorithm: 'HS256' });
      expect((await request(app).get('/api/products').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    });

    it('só o Super ADM TI vê a fila e autoriza (administrador de empresa: 403; sem token: 401)', async () => {
      const asCompanyAdmin = (r: request.Test) => r.set('Authorization', `Bearer ${companyAdminToken}`);
      expect((await asCompanyAdmin(request(app).get('/api/activations/enrollments'))).status).toBe(403);
      expect((await asCompanyAdmin(request(app).post(`/api/activations/enrollments/${deviceId}/authorize`)).send({ licenseId: licenseA, branchId: A.branchId })).status).toBe(403);
      expect((await request(app).get('/api/activations/enrollments')).status).toBe(401);
      const dev = await bypass<any>(() => db.device.findUnique({ where: { id: deviceId } }));
      expect(dev.status).toBe('PENDING');
      expect(dev.licenseId).toBeNull();
    });
  });

  describe('2. administrador autoriza → equipamento autorizado → login e operação', () => {
    let deviceId: string;
    let deviceKey: string;
    let accessToken: string;
    let refreshToken: string;

    beforeAll(async () => {
      await resetLimits();
      const e = await enroll(`${stamp}-fluxo`);
      ({ deviceId, deviceKey } = e.body.data);
    });

    it('a fila do administrador mostra o equipamento com o código para conferência', async () => {
      const res = await asSuper(request(app).get('/api/activations/enrollments'));
      expect(res.status).toBe(200);
      const row = res.body.data.find((d: any) => d.id === deviceId);
      expect(row).toBeTruthy();
      expect(row.enrollmentCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(row.secretHash).toBeUndefined();
    });

    it('licença/filial de OUTRA empresa: recusado (404) e o equipamento segue pendente', async () => {
      const wrongBranch = await authorize(deviceId, licenseA, B.branchId);
      expect(wrongBranch.status).toBe(404);
      const wrongLicense = await authorize(deviceId, '00000000-0000-4000-8000-000000000000', A.branchId);
      expect(wrongLicense.status).toBe(404);
      expect((await bypass<any>(() => db.device.findUnique({ where: { id: deviceId } }))).status).toBe('PENDING');
    });

    it('autoriza: vincula licença + filial, vira ATIVO e GERA AUDITORIA', async () => {
      auditSpy.mockClear();
      const res = await authorize(deviceId, licenseA, A.branchId);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.licenseId).toBe(licenseA);
      expect(res.body.data.branchId).toBe(A.branchId);
      const audited = auditSpy.mock.calls.filter((c) => c[0] === 'audit-log' && (c[1] as any).entity === 'Device' && (c[1] as any).entityId === deviceId);
      expect(audited).toHaveLength(1);
      expect(JSON.stringify(audited[0][1])).not.toContain(deviceKey);
    });

    it('autorizar de novo: 409 (já tratado)', async () => {
      const res = await authorize(deviceId, licenseA, A.branchId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DEVICE_NOT_PENDING');
    });

    it('status agora: ATIVO, com só o NOME da empresa e da filial', async () => {
      const res = await status(deviceId, deviceKey);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(Object.keys(res.body.data.company)).toEqual(['name']);
      expect(Object.keys(res.body.data.branch)).toEqual(['name']);
    });

    it('login sem a chave ou com chave errada: 403 DEVICE_KEY_INVALID (o id sozinho não basta)', async () => {
      const noKey = await login(emailA, deviceId);
      const wrong = await login(emailA, deviceId, 'dk_errada');
      expect(noKey.status).toBe(403);
      expect(noKey.body.error).toBe('DEVICE_KEY_INVALID');
      expect(wrong.status).toBe(403);
      expect(wrong.body.error).toBe('DEVICE_KEY_INVALID');
      expect(await sessionsOf(deviceId)).toHaveLength(0);
    });

    it('login com equipamento autorizado + chave: 200, sessão de equipamento da empresa/filial certas e token preso a ela', async () => {
      const res = await login(emailA, deviceId, deviceKey);
      expect(res.status).toBe(200);
      accessToken = res.body.accessToken;
      refreshToken = res.body.refreshToken;
      const s = await sessionsOf(deviceId);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({ status: 'ACTIVE', userId: A.userId, companyId: A.companyId, branchId: A.branchId });
      expect((jwt.decode(accessToken) as any).dsid).toBe(s[0].id);
      const rt = await bypass<any>(() => db.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } }));
      expect(rt.deviceSessionId).toBe(s[0].id);
    });

    it('operação permitida: consulta o produto da PRÓPRIA empresa', async () => {
      const res = await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
    });

    it('isolamento: o mesmo token NÃO lê produto de outra empresa', async () => {
      const res = await request(app).get(`/api/products/${B.productId}`).set('Authorization', `Bearer ${accessToken}`);
      expect([403, 404]).toContain(res.status);
    });

    it('renovação mantém a sessão de equipamento (dsid) e rotaciona o refresh token', async () => {
      const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(200);
      const newAccess = res.body.data?.accessToken ?? res.body.accessToken;
      const newRefresh = res.body.data?.refreshToken ?? res.body.refreshToken;
      const s = await sessionsOf(deviceId);
      expect((jwt.decode(newAccess) as any).dsid).toBe(s[0].id);
      accessToken = newAccess;
      refreshToken = newRefresh;
    });

    it('revoga: sessão encerrada, token e renovação param NA HORA, login recusado, status só REVOKED; gera auditoria', async () => {
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${accessToken}`)).status).toBe(200);
      auditSpy.mockClear();
      const rev = await asSuper(request(app).post(`/api/activations/devices/${deviceId}/revoke`)).send({ reason: 'Teste de revogação' });
      expect(rev.status).toBe(200);
      expect(auditSpy.mock.calls.some((c) => c[0] === 'audit-log' && (c[1] as any).entity === 'Device')).toBe(true);

      const after = await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${accessToken}`);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe('DEVICE_SESSION_ENDED');
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBeGreaterThanOrEqual(400);
      // a renovação recusada do equipamento revogado NÃO é "reuso de token roubado": as OUTRAS sessões do mesmo usuário seguem valendo
      expect((await asSuper(request(app).get('/api/activations/enrollments'))).status).toBe(200);
      const s = await sessionsOf(deviceId);
      expect(s[0].status).toBe('FORCE_ENDED');

      const again = await login(emailA, deviceId, deviceKey);
      expect(again.status).toBe(403);
      expect(again.body.error).toBe('DEVICE_REVOKED');
      const st = await status(deviceId, deviceKey);
      expect(st.body.data).toEqual({ deviceId, status: 'REVOKED', deviceName: expect.any(String) });
    });

    it('equipamento revogado precisa ser enrolado de novo (novo id e nova chave) e passa pela autorização outra vez', async () => {
      const again = await enroll(`${stamp}-reenrol`);
      expect(again.body.data.deviceId).not.toBe(deviceId);
      expect(again.body.data.deviceKey).not.toBe(deviceKey);
      const res = await login(emailA, again.body.data.deviceId, again.body.data.deviceKey);
      expect(res.status).toBe(403); // sem empresa: o login nem o reconhece
    });
  });

  describe('3. isolamento entre empresas, filiais e equipamentos', () => {
    let d1: { deviceId: string; deviceKey: string };
    let d2: { deviceId: string; deviceKey: string };
    let dB: { deviceId: string; deviceKey: string };

    beforeAll(async () => {
      await resetLimits();
      d1 = await readyDevice(`${stamp}-iso1`);
      d2 = await readyDevice(`${stamp}-iso2`);
      dB = await readyDevice(`${stamp}-isoB`, licenseB, B.branchId);
    });

    it('usuário da empresa B não entra por equipamento da empresa A (e vice-versa): DEVICE_UNKNOWN', async () => {
      const b = await login(emailB, d1.deviceId, d1.deviceKey);
      expect(b.status).toBe(403);
      expect(b.body.error).toBe('DEVICE_UNKNOWN');
      const a = await login(emailA, dB.deviceId, dB.deviceKey);
      expect(a.status).toBe(403);
      expect(a.body.error).toBe('DEVICE_UNKNOWN');
    });

    it('usuário da filial A2 não entra por equipamento da filial A1: DEVICE_BRANCH_MISMATCH', async () => {
      const res = await login(emailA2, d1.deviceId, d1.deviceKey);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('DEVICE_BRANCH_MISMATCH');
    });

    it('a chave de OUTRO equipamento não vale: id do equipamento 1 com a chave do 2', async () => {
      const res = await login(emailA, d1.deviceId, d2.deviceKey);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('DEVICE_KEY_INVALID');
      expect((await status(d1.deviceId, d2.deviceKey)).status).toBe(401);
    });

    it('um equipamento ativo = uma sessão: segundo usuário → DEVICE_BUSY; mesmo usuário em outro equipamento → USER_ALREADY_ACTIVE', async () => {
      const first = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(first.status).toBe(200);
      // outro usuário da MESMA filial no mesmo equipamento
      const colleagueHash = await hashPassword(PASSWORD);
      const colleague = await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Colega', email: `${stamp}-c@test.local`, password: colleagueHash, userType: 'OPERATOR', isActive: true } })
      );
      const busy = await login(colleague.email, d1.deviceId, d1.deviceKey);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toBe('DEVICE_BUSY');
      const other = await login(emailA, d2.deviceId, d2.deviceKey);
      expect(other.status).toBe(409);
      expect(other.body.error).toBe('USER_ALREADY_ACTIVE');
      await clearSessions();
      await clearRefresh();
      await bypass(() => db.user.delete({ where: { id: colleague.id } }));
    });

    it('logout encerra a sessão de equipamento (ENDED), o token para de valer e o equipamento fica livre para um novo login', async () => {
      const first = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(first.status).toBe(200);
      const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${first.body.accessToken}`).send({ refreshToken: first.body.refreshToken });
      expect(out.status).toBe(200);
      const s = await sessionsOf(d1.deviceId);
      expect(s.map((x) => x.status)).toEqual(['ENDED']);
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${first.body.accessToken}`)).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken: first.body.refreshToken })).status).toBeGreaterThanOrEqual(400);
      const again = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(again.status).toBe(200);
      await clearSessions();
      await clearRefresh();
    });

    it('queda/encerramento forçado do PDV (a sessão não é restaurada): o MESMO operador entra de novo no mesmo equipamento; a sessão presa é encerrada e o token dela revogado; outro operador segue DEVICE_BUSY', async () => {
      const first = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(first.status).toBe(200);
      // o processo morreu: o token só existia na memória dele, ninguém chamou /logout — a sessão de equipamento ficou ATIVA.
      const again = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(again.status).toBe(200);
      const rows = await sessionsOf(d1.deviceId);
      expect(rows.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
      expect(rows.find((s) => s.status === 'ENDED')?.endReason).toBe('SUPERSEDED_BY_RELOGIN');
      // o que sobrou da sessão presa não vale mais: access token e refresh
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${first.body.accessToken}`)).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken: first.body.refreshToken })).status).toBeGreaterThanOrEqual(400);
      // a nova sessão funciona
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${again.body.accessToken}`)).status).toBe(200);
      // outro operador NÃO herda o equipamento ocupado (isso continua exigindo o encerramento administrativo)
      const hash = await hashPassword(PASSWORD);
      const colleague = await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Colega 3', email: `${stamp}-c3@test.local`, password: hash, userType: 'OPERATOR', isActive: true } })
      );
      const busy = await login(colleague.email, d1.deviceId, d1.deviceKey);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toBe('DEVICE_BUSY');
      await clearSessions();
      await clearRefresh();
      await bypass(() => db.user.delete({ where: { id: colleague.id } }));
    });

    it('sair de OUTRO aplicativo (login sem equipamento: Balcão/Admin Web) não encerra a sessão do PDV do mesmo usuário', async () => {
      const pdv = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(pdv.status).toBe(200);
      const web = await login(emailA);
      expect(web.status).toBe(200);
      const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${web.body.accessToken}`).send({ refreshToken: web.body.refreshToken });
      expect(out.status).toBe(200);
      expect((await sessionsOf(d1.deviceId)).map((s) => s.status)).toEqual(['ACTIVE']);
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${pdv.body.accessToken}`)).status).toBe(200);
      await clearSessions();
      await clearRefresh();
    });

    it('IDOR: o administrador da empresa A NÃO encerra a sessão de equipamento da empresa B, nem bloqueia/revoga/autoriza (só Super ADM TI)', async () => {
      const bSession = await login(emailB, dB.deviceId, dB.deviceKey);
      expect(bSession.status).toBe(200);
      const asAdminA = (r: request.Test) => r.set('Authorization', `Bearer ${companyAdminToken}`);
      const forced = await asAdminA(request(app).post(`/api/activations/devices/${dB.deviceId}/force-end-session`)).send({ reason: 'tentativa cruzada' });
      expect(forced.status).toBeGreaterThanOrEqual(400);
      expect((await asAdminA(request(app).post(`/api/activations/devices/${dB.deviceId}/block`)).send({ reason: 'x' })).status).toBe(403);
      expect((await asAdminA(request(app).post(`/api/activations/devices/${dB.deviceId}/revoke`)).send({ reason: 'x' })).status).toBe(403);
      // a sessão da empresa B continua viva e o token dela segue valendo
      expect((await sessionsOf(dB.deviceId)).map((x) => x.status)).toEqual(['ACTIVE']);
      expect((await request(app).get(`/api/products/${B.productId}`).set('Authorization', `Bearer ${bSession.body.accessToken}`)).status).toBe(200);
      await bypass(() => db.deviceSession.deleteMany({ where: { companyId: B.companyId } }));
      await bypass(() => db.refreshToken.deleteMany({ where: { user: { companyId: B.companyId } } }));
    });

    it('encerramento administrativo da sessão travada derruba o token e libera o equipamento (gerente da empresa)', async () => {
      const first = await login(emailA, d1.deviceId, d1.deviceKey);
      expect(first.status).toBe(200);
      const end = await request(app)
        .post(`/api/activations/devices/${d1.deviceId}/force-end-session`)
        .set('Authorization', `Bearer ${companyAdminToken}`)
        .send({ reason: 'Teste: PDV travado' });
      expect(end.status).toBe(200);
      expect((await sessionsOf(d1.deviceId)).map((x) => x.status)).toEqual(['FORCE_ENDED']);
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${first.body.accessToken}`)).status).toBe(401);
      await clearSessions();
      await clearRefresh();
    });

    it('bloquear encerra a sessão na hora; desbloquear devolve o acesso com novo login', async () => {
      clearDeviceSessionCache();
      const ok = await login(emailA, d2.deviceId, d2.deviceKey);
      expect(ok.status).toBe(200);
      const block = await asSuper(request(app).post(`/api/activations/devices/${d2.deviceId}/block`)).send({ reason: 'Teste de bloqueio' });
      expect(block.status).toBe(200);
      expect((await request(app).get(`/api/products/${A.productId}`).set('Authorization', `Bearer ${ok.body.accessToken}`)).status).toBe(401);
      const denied = await login(emailA, d2.deviceId, d2.deviceKey);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('DEVICE_BLOCKED');
      const unblock = await asSuper(request(app).post(`/api/activations/devices/${d2.deviceId}/unblock`));
      expect(unblock.status).toBe(200);
      expect(unblock.body.data.status).toBe('ACTIVE'); // equipamento autorizado pelo enrolamento volta a ATIVO (não a pendente)
      const back = await login(emailA, d2.deviceId, d2.deviceKey);
      expect(back.status).toBe(200);
      await clearSessions();
      await clearRefresh();
    });

    it('limite de equipamentos da licença é respeitado ao autorizar (409 DEVICE_LIMIT_REACHED)', async () => {
      const lic = (await bypass<any>(() => db.license.create({ data: { companyId: A.companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 1 } }))).id;
      await readyDevice(`${stamp}-lim1`, lic);
      const e = await enroll(`${stamp}-lim2`);
      const res = await authorize(e.body.data.deviceId, lic, A.branchId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DEVICE_LIMIT_REACHED');
    });

    it('duas autorizações simultâneas do mesmo equipamento: só uma vence', async () => {
      const e = await enroll(`${stamp}-conc`);
      const results = await Promise.all([authorize(e.body.data.deviceId, licenseA, A.branchId), authorize(e.body.data.deviceId, licenseA, A.branchId)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      // integridade final: UM equipamento, ATIVO, vinculado uma vez à licença e à filial (sem duplicata, sem estado intermediário)
      const rows = await bypass<any[]>(() => db.device.findMany({ where: { id: e.body.data.deviceId } }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'ACTIVE', licenseId: licenseA, branchId: A.branchId });
    });

    it('concorrência de login: dois operadores no MESMO equipamento e o MESMO usuário em dois equipamentos ao mesmo tempo — uma só sessão ativa sobrevive em cada caso', async () => {
      const hash = await hashPassword(PASSWORD);
      const colleague = await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Colega 2', email: `${stamp}-c2@test.local`, password: hash, userType: 'OPERATOR', isActive: true } })
      );
      // (a) mesmo equipamento, dois usuários
      const sameDevice = await Promise.all([login(emailA, d1.deviceId, d1.deviceKey), login(colleague.email, d1.deviceId, d1.deviceKey)]);
      expect(sameDevice.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(sameDevice.find((r) => r.status === 409)!.body.error).toBe('DEVICE_BUSY');
      expect((await sessionsOf(d1.deviceId)).filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
      await clearSessions();
      await clearRefresh();
      // (b) mesmo usuário, dois equipamentos
      const sameUser = await Promise.all([login(emailA, d1.deviceId, d1.deviceKey), login(emailA, d2.deviceId, d2.deviceKey)]);
      expect(sameUser.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(sameUser.find((r) => r.status === 409)!.body.error).toBe('USER_ALREADY_ACTIVE');
      const active = await bypass<any[]>(() => db.deviceSession.findMany({ where: { companyId: A.companyId, userId: A.userId, status: 'ACTIVE' } }));
      expect(active).toHaveLength(1);
      await clearSessions();
      await clearRefresh();
      await bypass(() => db.refreshToken.deleteMany({ where: { user: { companyId: A.companyId, id: colleague.id } } }));
      await bypass(() => db.user.delete({ where: { id: colleague.id } }));
    });
  });

  describe('4. política da empresa: perfis que só operam o caixa por equipamento autorizado; legado sem chave', () => {
    it('padrão: login sem equipamento segue permitido (comportamento anterior preservado)', async () => {
      const res = await login(emailA);
      expect(res.status).toBe(200);
      await clearRefresh();
    });

    it('padrão (lista vazia): o caixa NÃO exige equipamento — sem fallback escondido, é a decisão 109 em aberto (testado para não mudar em silêncio)', async () => {
      const sale = await bypass<any>(() => db.sale.create({ data: { companyId: A.companyId, branchId: A.branchId, saleNumber: 880001, customerId: A.customerId, userId: A.userId, cashRegisterId: A.cashRegisterId, status: 'PENDING', subtotal: 10, totalAmount: 10 } }));
      const res = await login(emailA);
      const pay = await request(app).post('/api/payments').set('Authorization', `Bearer ${res.body.accessToken}`).send({ saleId: sale.id, paymentMethod: 'CASH', amount: 10 });
      expect(pay.status).toBe(201);
      await clearRefresh();
    });

    it('devices.requiredUserTypes=[OPERATOR]: o LOGIN segue livre (Admin Web) mas o CAIXA exige equipamento; com equipamento autorizado opera; perfil fora da lista e Super Admin não são afetados', async () => {
      const ctx = { companyId: A.companyId, userType: 'COMPANY_ADMIN' as const, branchId: null };
      await runWithRLSContext(ctx, () =>
        policyService.set({ companyId: A.companyId, key: 'devices.requiredUserTypes', value: ['OPERATOR'], reason: 'Teste: operador só opera o caixa por equipamento autorizado', userId: A.userId })
      );
      try {
        // sem equipamento: login de console OK, consulta OK, mas toda operação de caixa/venda/pagamento é negada
        const web = await login(emailA);
        expect(web.status).toBe(200);
        expect((jwt.decode(web.body.accessToken) as any).dsid).toBeUndefined();
        const asWeb = (r: request.Test) => r.set('Authorization', `Bearer ${web.body.accessToken}`);
        expect((await asWeb(request(app).get(`/api/products/${A.productId}`))).status).toBe(200);
        const sale = await bypass<any>(() => db.sale.create({ data: { companyId: A.companyId, branchId: A.branchId, saleNumber: 880002, customerId: A.customerId, userId: A.userId, cashRegisterId: A.cashRegisterId, status: 'PENDING', subtotal: 10, totalAmount: 10 } }));
        const blocked = [
          await asWeb(request(app).post('/api/payments')).send({ saleId: sale.id, paymentMethod: 'CASH', amount: 10 }),
          await asWeb(request(app).post('/api/sales')).send({}),
          await asWeb(request(app).post('/api/cash-register/open')).send({ openingAmount: 0 }),
          await asWeb(request(app).post('/api/cash-register/movement')).send({}),
        ];
        for (const r of blocked) {
          expect(r.status).toBe(403);
          expect(r.body.code).toBe('DEVICE_REQUIRED');
        }
        expect(await bypass<number>(() => db.payment.count({ where: { saleId: sale.id, companyId: A.companyId } }))).toBe(0);
        await clearRefresh();

        // com equipamento autorizado: a mesma operação passa
        const dev = await readyDevice(`${stamp}-pol`);
        const term = await login(emailA, dev.deviceId, dev.deviceKey);
        expect(term.status).toBe(200);
        const ok = await request(app).post('/api/payments').set('Authorization', `Bearer ${term.body.accessToken}`).send({ saleId: sale.id, paymentMethod: 'CASH', amount: 10 });
        expect(ok.status).toBe(201);
        await clearSessions();
        await clearRefresh();

        // perfil fora da lista (gerente) não é afetado; Super Admin (sem empresa) não passa pelo bloqueio
        const mgrToken = generateAccessToken({ userId: A.userId, email: 'm@test.local', companyId: A.companyId, branchId: A.branchId, userType: 'MANAGER' });
        const sale2 = await bypass<any>(() => db.sale.create({ data: { companyId: A.companyId, branchId: A.branchId, saleNumber: 880003, customerId: A.customerId, userId: A.userId, cashRegisterId: A.cashRegisterId, status: 'PENDING', subtotal: 5, totalAmount: 5 } }));
        expect((await request(app).post('/api/payments').set('Authorization', `Bearer ${mgrToken}`).send({ saleId: sale2.id, paymentMethod: 'CASH', amount: 5 })).status).toBe(201);
        const superRes = await request(app).post('/api/payments').set('Authorization', `Bearer ${superToken}`).send({});
        expect(superRes.body.code).not.toBe('DEVICE_REQUIRED');

        // a política é DA EMPRESA A: o operador da empresa B (sem equipamento) segue operando o caixa dele
        const opB = generateAccessToken({ userId: B.userId, email: 'opb@test.local', companyId: B.companyId, branchId: B.branchId, userType: 'OPERATOR' });
        const saleB = await bypass<any>(() => db.sale.create({ data: { companyId: B.companyId, branchId: B.branchId, saleNumber: 880004, customerId: B.customerId, userId: B.userId, cashRegisterId: B.cashRegisterId, status: 'PENDING', subtotal: 5, totalAmount: 5 } }));
        expect((await request(app).post('/api/payments').set('Authorization', `Bearer ${opB}`).send({ saleId: saleB.id, paymentMethod: 'CASH', amount: 5 })).status).toBe(201);
      } finally {
        await runWithRLSContext({ companyId: A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
          policyService.reset({ companyId: A.companyId, key: 'devices.requiredUserTypes', reason: 'Fim do teste', userId: A.userId })
        );
      }
    });

    it('equipamento LEGADO (sem chave): aceito só no conjunto fechado e antes do corte; criado depois do fechamento ou depois do corte → DEVICE_REENROLL_REQUIRED', async () => {
      const mk = (mac: string, createdAt: Date) =>
        bypass<any>(() => db.device.create({ data: { licenseId: licenseA, branchId: A.branchId, deviceName: `${stamp}-legado-${mac}`, deviceType: 'POS', status: 'ACTIVE', macAddress: mac, createdAt } }));
      const old = await mk('02:00:00:00:77:01', new Date('2026-09-01T12:00:00Z'));
      const fresh = await mk('02:00:00:00:77:02', new Date('2026-10-08T12:00:00Z')); // criado pelo fluxo antigo DEPOIS do fechamento do conjunto
      const okLegacy = await login(emailA, old.id);
      expect(okLegacy.status).toBe(200); // compatibilidade de transição preservada
      await clearSessions();
      await clearRefresh();
      const byMac = await login(emailA, '02:00:00:00:77:01');
      expect(byMac.status).toBe(200);
      await clearSessions();
      await clearRefresh();
      const closed = await login(emailA, fresh.id);
      expect(closed.status).toBe(403);
      expect(closed.body.error).toBe('DEVICE_REENROLL_REQUIRED');
      expect((await login(emailA, '02:00:00:00:77:02')).body.error).toBe('DEVICE_REENROLL_REQUIRED');
      // data de corte vencida: o próprio legado do conjunto fechado deixa de entrar
      const before = process.env.DEVICE_LEGACY_CUTOFF;
      process.env.DEVICE_LEGACY_CUTOFF = '2026-10-01T00:00:00Z';
      try {
        const cut = await login(emailA, old.id);
        expect(cut.status).toBe(403);
        expect(cut.body.error).toBe('DEVICE_REENROLL_REQUIRED');
      } finally {
        if (before === undefined) delete process.env.DEVICE_LEGACY_CUTOFF;
        else process.env.DEVICE_LEGACY_CUTOFF = before;
      }
    });
  });

  describe('5. limites das rotas públicas', () => {
    beforeAll(resetLimits);
    afterAll(resetLimits);

    it('enrolar: depois do limite por hora vem 429 com Retry-After', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) codes.push((await enroll(`${stamp}-rl${i}`)).status);
      expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
      expect(codes[10]).toBe(429);
      const last = await enroll(`${stamp}-rl-x`);
      expect(last.headers['retry-after']).toBeDefined();
    });

    it('status: chave errada repetida bloqueia o IP (429), e o limite não vaza se o equipamento existe', async () => {
      await resetLimits();
      let blocked = 0;
      for (let i = 0; i < 24; i += 1) {
        const r = await status('00000000-0000-4000-8000-000000000000', 'dk_x');
        if (r.status === 429) blocked += 1;
        else expect(r.status).toBe(401);
      }
      expect(blocked).toBeGreaterThan(0);
    });
  });
});
