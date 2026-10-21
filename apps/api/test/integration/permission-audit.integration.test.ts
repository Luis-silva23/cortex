import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * AUDITORIA DE MUDANÇA DE PERMISSÃO: atribuir/retirar perfil de um usuário e permissão de um perfil grava PERMISSION_CHANGED
 * com autor (userId do token), alvo (entityId), escopo (filial) e a alteração (operação + ids). Antes gravava só
 * `UPDATE {"success":true}`: não dizia qual perfil nem qual filial. Quem não é administrador recebe 403 e nada é auditado.
 */
describe('Auditoria de mudança de perfil/permissão (integração real)', () => {
  let A: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  let roleId: string;
  let permissionId: string;
  let targetUserId: string;
  let adminUserId: string;

  const token = (userId: string, userType: string) =>
    generateAccessToken({ userId, email: `${userType.toLowerCase()}@test.local`, companyId: A.companyId, branchId: undefined as any, userType });
  const auth = (userId: string, userType: string) => ({ Authorization: `Bearer ${token(userId, userType)}` });
  const auditJobs = () =>
    auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1] as { action: string; entity: string; entityId: string | null; userId: string | null; newValue: string | null });

  beforeAll(async () => {
    A = await createFixture('permaudit');
    const admin = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, name: 'Admin Perm', email: `perm-admin-${stamp}@test.local`, password: 'not-a-real-hash', userType: 'COMPANY_ADMIN', isActive: true } })
    );
    adminUserId = admin.id;
    const target = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Alvo Perm', email: `perm-target-${stamp}@test.local`, password: 'not-a-real-hash', userType: 'OPERATOR', isActive: true } })
    );
    targetUserId = target.id;
    const role = await bypass<any>(() => db.role.create({ data: { companyId: A.companyId, name: `perfil-${stamp}` } }));
    roleId = role.id;
    const perm = await bypass<any>(() => db.permission.create({ data: { companyId: A.companyId, name: `modulo:acao-${stamp}` } }));
    permissionId = perm.id;
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    if (A?.companyId) {
      await bypass(() => db.userRole.deleteMany({ where: { userId: targetUserId, role: { companyId: A.companyId } } }));
      await bypass(() => db.rolePermission.deleteMany({ where: { roleId, role: { companyId: A.companyId } } }));
      await bypass(() => db.role.deleteMany({ where: { id: roleId, companyId: A.companyId } }));
      await bypass(() => db.permission.deleteMany({ where: { id: permissionId, companyId: A.companyId } }));
      await bypass(() => db.user.deleteMany({ where: { id: { in: [adminUserId, targetUserId] }, companyId: A.companyId } }));
      await destroyFixture(A);
    }
  });

  it('conceder e retirar permissão de um perfil: PERMISSION_CHANGED com perfil, permissão e operação', async () => {
    const grant = await request(app).post(`/api/roles/${roleId}/permissions`).set(auth(adminUserId, 'COMPANY_ADMIN')).send({ permissionId });
    expect(grant.status).toBe(201);
    const revoke = await request(app).delete(`/api/roles/${roleId}/permissions/${permissionId}`).set(auth(adminUserId, 'COMPANY_ADMIN'));
    expect(revoke.status).toBe(200);
    const jobs = auditJobs().filter((j) => j.entity === 'Role' && j.entityId === roleId);
    expect(jobs.map((j) => j.action)).toEqual(['PERMISSION_CHANGED', 'PERMISSION_CHANGED']);
    expect(jobs.every((j) => j.userId === adminUserId)).toBe(true); // autor
    const ops = jobs.map((j) => JSON.parse(j.newValue!));
    expect(ops[0]).toMatchObject({ operation: 'PERMISSION_GRANTED_TO_ROLE', roleId, permissionId });
    expect(ops[1]).toMatchObject({ operation: 'PERMISSION_REVOKED_FROM_ROLE', roleId, permissionId });
  });

  it('atribuir e retirar perfil de um usuário (com filial): alvo, perfil, escopo e operação ficam na auditoria', async () => {
    const assign = await request(app).post(`/api/users/${targetUserId}/roles`).set(auth(adminUserId, 'COMPANY_ADMIN')).send({ roleId, branchId: A.branchId });
    expect(assign.status).toBe(201);
    const revoke = await request(app).delete(`/api/users/${targetUserId}/roles/${roleId}`).query({ branchId: A.branchId }).set(auth(adminUserId, 'COMPANY_ADMIN'));
    expect(revoke.status).toBe(200);
    const jobs = auditJobs().filter((j) => j.entity === 'User' && j.entityId === targetUserId && j.action === 'PERMISSION_CHANGED');
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.userId === adminUserId)).toBe(true);
    const ops = jobs.map((j) => JSON.parse(j.newValue!));
    expect(ops[0]).toMatchObject({ operation: 'ROLE_ASSIGNED', targetUserId, roleId, branchId: A.branchId });
    expect(ops[1]).toMatchObject({ operation: 'ROLE_REVOKED', targetUserId, roleId, branchId: A.branchId });
  });

  it('quem não é administrador recebe 403, nada muda e nada é auditado como mudança de permissão', async () => {
    const before = auditJobs().filter((j) => j.action === 'PERMISSION_CHANGED').length;
    const r1 = await request(app).post(`/api/users/${targetUserId}/roles`).set(auth(targetUserId, 'OPERATOR')).send({ roleId });
    const r2 = await request(app).post(`/api/roles/${roleId}/permissions`).set(auth(targetUserId, 'OPERATOR')).send({ permissionId });
    const r3 = await request(app).post(`/api/users/${targetUserId}/roles`).set(auth(targetUserId, 'VIEWER')).send({ roleId });
    expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403]);
    expect(auditJobs().filter((j) => j.action === 'PERMISSION_CHANGED').length).toBe(before);
    expect(await bypass<any[]>(() => db.userRole.findMany({ where: { userId: targetUserId } }))).toHaveLength(0);
  });
});
