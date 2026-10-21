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
 * Recusas de regra de negócio que saíam como 500 "Erro interno" (service lançava Error puro e a rota repassava ao
 * errorHandler): filial inexistente/única, perfil de sistema, filial de outra empresa no usuário. Cada recusa precisa
 * do status certo, com a mensagem, e sem alterar o banco.
 */
describe('Recusas de regra de negócio com status 4xx (integração real)', () => {
  let fixture: IntegrationFixture;
  let other: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  let systemRoleId: string;

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const branchOf = (id: string) => bypass<any>(() => db.branch.findUnique({ where: { id } }));

  beforeAll(async () => {
    fixture = await createFixture('refusal');
    other = await createFixture('refusal-other');
    token = generateAccessToken({ userId: fixture.userId, email: 'refusal@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'COMPANY_ADMIN' });
    systemRoleId = (await bypass<any>(() => db.role.create({ data: { name: `Sistema ${Date.now()}`, companyId: fixture.companyId, isSystem: true } }))).id;
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
      await bypass(() => db.role.deleteMany({ where: { companyId } }));
      await destroyFixture(fixture);
    }
    if (other?.companyId) await destroyFixture(other);
  });

  it('PUT /branches/:id de outra empresa: 404', async () => {
    const res = await as(request(app).put(`/api/branches/${other.branchId}`)).send({ name: 'Invasão' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Filial não encontrada');
    expect((await branchOf(other.branchId)).name).not.toBe('Invasão');
  });

  it('POST /branches/:id/toggle-active na única filial ativa: 409, segue ativa', async () => {
    const res = await as(request(app).post(`/api/branches/${fixture.branchId}/toggle-active`));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/única filial ativa/);
    expect((await branchOf(fixture.branchId)).isActive).toBe(true);
  });

  it('DELETE /branches/:id na única filial: 409, segue existindo', async () => {
    const res = await as(request(app).delete(`/api/branches/${fixture.branchId}`));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/única filial/);
    expect(await branchOf(fixture.branchId)).not.toBeNull();
  });

  it('PUT e DELETE /roles/:id em perfil de sistema: 403, perfil intacto', async () => {
    const put = await as(request(app).put(`/api/roles/${systemRoleId}`)).send({ name: 'Renomeado' });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('Perfis de sistema não podem ser editados');
    const del = await as(request(app).delete(`/api/roles/${systemRoleId}`));
    expect(del.status).toBe(403);
    expect(del.body.error).toBe('Perfis de sistema não podem ser excluídos');
    const role = await bypass<any>(() => db.role.findUnique({ where: { id: systemRoleId } }));
    expect(role.name).not.toBe('Renomeado');
  });

  it('PUT /users/:id apontando para filial de outra empresa: 400, usuário intacto', async () => {
    const res = await as(request(app).put(`/api/users/${fixture.userId}`)).send({ branchId: other.branchId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Filial não encontrada nesta empresa');
    const user = await bypass<any>(() => db.user.findUnique({ where: { id: fixture.userId } }));
    expect(user.branchId).toBe(fixture.branchId);
  });
});
