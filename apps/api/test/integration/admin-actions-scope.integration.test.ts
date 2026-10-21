import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Ações de ADMINISTRAÇÃO da empresa (usuários, perfis, filiais, convênios) só valem dentro da empresa do token.
 * COMPANY_ADMIN de A contra alvos de B: recusado e linha idêntica. Perfil de B não pode ser atribuído a usuário de A.
 * Controles positivos dentro de A provam que os corpos são válidos. Escalada dentro da empresa: MANAGER/OPERATOR não
 * administram usuários nem perfis, nem os próprios.
 */
describe('Administração da empresa não atravessa empresas nem sobe privilégio (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let roleA: string;
  let roleB: string;
  let permB: string;
  const stamp = `aa-${Date.now()}`;

  const A = () => world.A;
  const B = () => world.B;
  const adminA = () => bearer(tokenFor(A(), null, 'COMPANY_ADMIN'));
  const snap = (model: string, id: string) => bypass<any>(() => (db as any)[model].findUnique({ where: { id } })).then((r) => JSON.stringify(r));
  const userB = () => B().branches[2].userId;
  const userA2 = () => A().branches[2].userId;

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    roleA = (await bypass<any>(() => db.role.create({ data: { companyId: A().companyId, name: `${stamp}-A` } }))).id;
    roleB = (await bypass<any>(() => db.role.create({ data: { companyId: B().companyId, name: `${stamp}-B` } }))).id;
    permB = (await bypass<any>(() => db.permission.create({ data: { companyId: B().companyId, name: `${stamp}:perm` } }))).id;
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) {
      for (const companyId of [A().companyId, B().companyId]) {
        await bypass(() => db.userRole.deleteMany({ where: { role: { companyId } } }));
        await bypass(() => db.rolePermission.deleteMany({ where: { role: { companyId } } }));
        await bypass(() => db.role.deleteMany({ where: { companyId, name: { startsWith: stamp } } }));
        await bypass(() => db.permission.deleteMany({ where: { companyId, name: { startsWith: stamp } } }));
      }
      await destroyWorld(world);
    }
  }, 120000);

  const CROSS: Array<[string, 'post' | 'put' | 'delete', () => string, () => object, string, () => string]> = [
    ['editar usuário', 'put', () => `/api/users/${userB()}`, () => ({ name: 'HACKEADO', userType: 'COMPANY_ADMIN' }), 'user', userB],
    ['excluir usuário', 'delete', () => `/api/users/${userB()}`, () => ({}), 'user', userB],
    ['redefinir senha', 'post', () => `/api/users/${userB()}/reset-password`, () => ({ password: 'Nova-Senha-123!' }), 'user', userB],
    ['ativar/desativar usuário', 'post', () => `/api/users/${userB()}/toggle-active`, () => ({}), 'user', userB],
    ['desbloquear usuário', 'post', () => `/api/users/${userB()}/unlock`, () => ({}), 'user', userB],
    ['atribuir perfil próprio a usuário de B', 'post', () => `/api/users/${userB()}/roles`, () => ({ roleId: roleA }), 'user', userB],
    ['editar perfil de B', 'put', () => `/api/roles/${roleB}`, () => ({ name: 'HACKEADO' }), 'role', () => roleB],
    ['excluir perfil de B', 'delete', () => `/api/roles/${roleB}`, () => ({}), 'role', () => roleB],
    ['anexar permissão ao perfil de B', 'post', () => `/api/roles/${roleB}/permissions`, () => ({ permissionId: permB }), 'role', () => roleB],
    ['editar filial de B', 'put', () => `/api/branches/${B().branches[2].branchId}`, () => ({ name: 'HACKEADA' }), 'branch', () => B().branches[2].branchId],
    ['ativar/desativar filial de B', 'post', () => `/api/branches/${B().branches[2].branchId}/toggle-active`, () => ({}), 'branch', () => B().branches[2].branchId],
    ['excluir filial de B', 'delete', () => `/api/branches/${B().branches[2].branchId}`, () => ({}), 'branch', () => B().branches[2].branchId],
    ['ativar/desativar convênio de B', 'post', () => `/api/partners/${B().partnerId}/toggle-active`, () => ({}), 'partner', () => B().partnerId],
  ];

  it.each(CROSS)('COMPANY_ADMIN de A: %s → recusado e intacto', async (_name, method, path, body, model, id) => {
    const before = await snap(model, id());
    const res = await (request(app) as any)[method](path()).set(adminA()).send(body());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await snap(model, id())).toBe(before);
  });

  it('perfil de B não é atribuído a usuário de A', async () => {
    const res = await request(app).post(`/api/users/${userA2()}/roles`).set(adminA()).send({ roleId: roleB });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await bypass<number>(() => db.userRole.count({ where: { userId: userA2(), roleId: roleB } }))).toBe(0);
  });

  it('permissão de B não entra em perfil de A', async () => {
    const res = await request(app).post(`/api/roles/${roleA}/permissions`).set(adminA()).send({ permissionId: permB });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await bypass<number>(() => db.rolePermission.count({ where: { roleId: roleA, permissionId: permB } }))).toBe(0);
  });

  it.each(['MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'])('%s não administra usuários nem perfis (nem os próprios)', async (userType) => {
    const self = A().branches[1].userId;
    const auth = bearer(tokenFor(A(), 1, userType));
    const before = await snap('user', self);
    const calls = await Promise.all([
      request(app).put(`/api/users/${self}`).set(auth).send({ userType: 'COMPANY_ADMIN' }),
      request(app).post(`/api/users/${self}/roles`).set(auth).send({ roleId: roleA }),
      request(app).post('/api/users').set(auth).send({ name: 'x', email: `${stamp}-${userType}@test.local`, password: 'Senha-Forte-123!', userType: 'COMPANY_ADMIN' }),
      request(app).post('/api/roles').set(auth).send({ name: `${stamp}-${userType}` }),
      request(app).post(`/api/roles/${roleA}/permissions`).set(auth).send({ permissionId: permB }),
    ]);
    calls.forEach((r) => expect(r.status).toBe(403));
    expect(await snap('user', self)).toBe(before);
    expect(await bypass<number>(() => db.userRole.count({ where: { userId: self, roleId: roleA } }))).toBe(0);
  });

  describe('controles positivos dentro de A', () => {
    it('editar usuário, redefinir senha e atribuir perfil de A a usuário de A', async () => {
      expect((await request(app).put(`/api/users/${userA2()}`).set(adminA()).send({ name: 'Operador A2 editado' })).status).toBeLessThan(300);
      expect((await request(app).post(`/api/users/${userA2()}/reset-password`).set(adminA()).send({ password: 'Nova-Senha-123!' })).status).toBeLessThan(300);
      expect((await request(app).post(`/api/users/${userA2()}/roles`).set(adminA()).send({ roleId: roleA })).status).toBeLessThan(300);
    });
    it('editar perfil, filial e convênio de A', async () => {
      expect((await request(app).put(`/api/roles/${roleA}`).set(adminA()).send({ name: `${stamp}-A2` })).status).toBeLessThan(300);
      expect((await request(app).put(`/api/branches/${A().branches[2].branchId}`).set(adminA()).send({ name: 'Filial A2 editada' })).status).toBeLessThan(300);
      expect((await request(app).post(`/api/partners/${A().partnerId}/toggle-active`).set(adminA()).send({})).status).toBeLessThan(300);
    });
  });
});
