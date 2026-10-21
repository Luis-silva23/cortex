import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import branchRoutes from '../../src/routes/branch.routes';
import { jobQueue } from '../../src/config/queue';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Cadastro de filial — prova REAL (HTTP + Postgres/RLS, JWT real).
 *
 * Auditoria do achado "cadastro de filial por SUPER_ADMIN sem companyId":
 * a API já exige `companyId` do SUPER_ADMIN, mas a tela nunca o enviava (e
 * mostrava "Nova Filial" a todo papel, com o erro genérico "Erro ao criar
 * filial"). Aqui o que se trava é o CONTRATO da API — quem cria, em qual
 * empresa, e o que acontece nos casos de borda (empresa inexistente, limite de
 * filiais da licença) — para que a tela possa se apoiar nele.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('POST /api/branches — quem cria, em qual empresa (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;

  const token = (f: IntegrationFixture | null, userType: string) =>
    generateAccessToken({
      userId: (f ?? A).userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: (f ? f.companyId : undefined) as any,
      branchId: (f ? f.branchId : undefined) as any,
      userType,
    });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const branchesOf = (companyId: string) => bypass<any[]>(() => prismaUnsafeBypassRLS.branch.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }));

  beforeAll(async () => {
    A = await createFixture('branch-scope-A');
    B = await createFixture('branch-scope-B');
    app = express();
    app.use(express.json());
    app.use('/api/branches', branchRoutes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 30000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await bypass(() => prismaUnsafeBypassRLS.license.deleteMany({ where: { companyId: { in: [A.companyId, B.companyId] } } }));
    await destroyFixture(A);
    await destroyFixture(B);
  }, 30000);

  beforeEach(() => auditSpy.mockClear());

  it('SUPER_ADMIN sem companyId: 400 claro e nada é criado', async () => {
    const before = (await branchesOf(A.companyId)).length + (await branchesOf(B.companyId)).length;
    const res = await request(app).post('/api/branches').set(auth(token(null, 'SUPER_ADMIN'))).send({ name: 'Filial X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
    expect((await branchesOf(A.companyId)).length + (await branchesOf(B.companyId)).length).toBe(before);
  });

  it('SUPER_ADMIN com companyId: cria NAQUELA empresa (e o audit fica com ela)', async () => {
    const res = await request(app).post('/api/branches').set(auth(token(null, 'SUPER_ADMIN'))).send({ name: 'Filial Norte', companyId: B.companyId });
    expect(res.status).toBe(201);
    expect(res.body.data.companyId).toBe(B.companyId);
    expect((await branchesOf(B.companyId)).map((b) => b.name)).toContain('Filial Norte');
    expect((await branchesOf(A.companyId)).map((b) => b.name)).not.toContain('Filial Norte');
    expect(auditSpy.mock.calls[0][1].companyId).toBe(B.companyId);
  });

  it('SUPER_ADMIN com empresa que não existe: erro de negócio (4xx), não 500', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set(auth(token(null, 'SUPER_ADMIN')))
      .send({ name: 'Filial Fantasma', companyId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error ?? res.body.message).toMatch(/Empresa n[ãa]o encontrada/);
  });

  it('COMPANY_ADMIN cria na PRÓPRIA empresa; o companyId de outra empresa no corpo é ignorado', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set(auth(token(A, 'COMPANY_ADMIN')))
      .send({ name: 'Filial Sul', companyId: B.companyId });
    expect(res.status).toBe(201);
    expect(res.body.data.companyId).toBe(A.companyId);
    expect((await branchesOf(B.companyId)).map((b) => b.name)).not.toContain('Filial Sul');
  });

  it.each(['MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'])('%s não cria filial (403) e nada é gravado', async (userType) => {
    const before = (await branchesOf(A.companyId)).length;
    const res = await request(app).post('/api/branches').set(auth(token(A, userType))).send({ name: `Filial ${userType}` });
    expect(res.status).toBe(403);
    expect((await branchesOf(A.companyId)).length).toBe(before);
  });

  it('limite de filiais da licença: recusa com mensagem de negócio (4xx) que a tela consegue mostrar', async () => {
    const current = (await branchesOf(A.companyId)).length;
    await bypass(() =>
      prismaUnsafeBypassRLS.license.create({
        data: { companyId: A.companyId, licenseType: 'BASIC', status: 'ACTIVE', maxBranches: current },
      })
    );

    const res = await request(app).post('/api/branches').set(auth(token(A, 'COMPANY_ADMIN'))).send({ name: 'Filial Além do Limite' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error ?? res.body.message).toMatch(/Limite de filiais/);
    expect((await branchesOf(A.companyId)).length).toBe(current);
  });
});
