import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import userRoutes from '../../src/routes/user.routes';
import { UserService } from '../../src/services/user.service';
import { jobQueue } from '../../src/config/queue';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * PUT /users/:id só edita o cadastro — prova REAL (HTTP + Postgres/RLS, JWT real).
 *
 * ACHADO: `updateUserSchema = createUserSchema.partial()` herdava `password` e
 * `companyId`. (1) `companyId` no corpo ia até o UPDATE: a RLS barrava, mas o
 * cliente recebia 500 em vez de o campo ser ignorado. (2) `password` trocava a
 * senha por um caminho paralelo ao /reset-password — SEM revogar as sessões
 * abertas (o reset revoga). Senha muda em /reset-password; empresa não muda.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('PUT /api/users/:id — campos editáveis (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let targetId: string;

  const admin = () => ({
    Authorization: `Bearer ${generateAccessToken({
      userId: A.userId,
      email: 'admin@test.local',
      companyId: A.companyId,
      branchId: A.branchId,
      userType: 'COMPANY_ADMIN',
    })}`,
  });
  const row = () => bypass<any>(() => prismaUnsafeBypassRLS.user.findFirst({ where: { id: targetId } }));

  beforeAll(async () => {
    A = await createFixture('user-upd-A');
    B = await createFixture('user-upd-B');
    app = express();
    app.use(express.json());
    app.use('/api/users', userRoutes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const created = await runWithRLSContext({ companyId: A.companyId, userType: 'COMPANY_ADMIN', branchId: A.branchId }, () =>
      new UserService().create({
        companyId: A.companyId,
        branchId: A.branchId,
        name: 'Funcionário Editável',
        email: `editavel-${Date.now()}@test.local`,
        password: 'SenhaOriginal123!',
        userType: 'OPERATOR',
      } as any)
    );
    targetId = created.id;
  }, 30000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await destroyFixture(A);
    await destroyFixture(B);
  }, 30000);

  it('nome e e-mail editam normalmente (o que a tela envia)', async () => {
    const res = await request(app).put(`/api/users/${targetId}`).set(admin()).send({ name: 'Nome Novo', userType: 'MANAGER' });
    expect(res.status).toBe(200);
    const r = await row();
    expect(r.name).toBe('Nome Novo');
    expect(r.userType).toBe('MANAGER');
  });

  it('companyId no corpo é ignorado (não 500): o usuário continua na empresa dele', async () => {
    const res = await request(app).put(`/api/users/${targetId}`).set(admin()).send({ name: 'Ainda Aqui', companyId: B.companyId });
    expect(res.status).toBe(200);
    const r = await row();
    expect(r.companyId).toBe(A.companyId);
    expect(r.name).toBe('Ainda Aqui');
  });

  it('password no corpo é ignorado: a senha só muda por /reset-password (que revoga as sessões)', async () => {
    const before = (await row()).password;
    const res = await request(app).put(`/api/users/${targetId}`).set(admin()).send({ name: 'Sem Trocar Senha', password: 'OutraSenha123!' });
    expect(res.status).toBe(200);
    expect((await row()).password).toBe(before);
  });
});
