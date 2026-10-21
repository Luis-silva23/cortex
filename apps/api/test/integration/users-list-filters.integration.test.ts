import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import userRoutes from '../../src/routes/user.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Filtros de GET /api/users — prova REAL (HTTP + Postgres/RLS + Redis, sem
 * mock; JWT assinado com o segredo do .env).
 *
 * ACHADO DE AUDITORIA: a listagem não filtrava por perfil e devolvia 20
 * usuários de qualquer tipo por página. A tela de comissões de mecânicos
 * usava essa lista para nomear/filtrar mecânicos: numa empresa com mais de 20
 * usuários, os mecânicos fora da primeira página apareciam como um pedaço do
 * id. Agora `userType` e `isActive` filtram no servidor — e o filtro
 * continua dentro do tenant (um mecânico de outra empresa nunca aparece).
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('GET /api/users — filtros userType/isActive (integração real)', () => {
  let fixtureA: IntegrationFixture;
  let fixtureB: IntegrationFixture;
  let app: express.Express;
  let mechActiveId: string;
  let mechInactiveId: string;
  let managerId: string;
  let mechOtherTenantId: string;

  const managerToken = () =>
    generateAccessToken({
      userId: fixtureA.userId,
      email: 'manager@test.local',
      companyId: fixtureA.companyId,
      branchId: fixtureA.branchId,
      userType: 'MANAGER',
    });

  const list = async (query: string) => {
    const res = await request(app).get(`/api/users${query}`).set('Authorization', `Bearer ${managerToken()}`);
    return res;
  };
  const ids = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((u) => u.id).sort();

  const createUser = (fixture: IntegrationFixture, name: string, userType: string, isActive: boolean) =>
    bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.user.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          name,
          email: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
          password: 'not-a-real-hash',
          userType: userType as any,
          isActive,
        },
        select: { id: true },
      })
    );

  beforeAll(async () => {
    fixtureA = await createFixture('users-filters-A');
    fixtureB = await createFixture('users-filters-B');
    app = express();
    app.use(express.json());
    app.use('/api/users', userRoutes);
    app.use(errorHandler);

    mechActiveId = (await createUser(fixtureA, 'Mecanico Ativo', 'MECHANIC', true)).id;
    mechInactiveId = (await createUser(fixtureA, 'Mecanico Inativo', 'MECHANIC', false)).id;
    managerId = (await createUser(fixtureA, 'Gerente Dois', 'MANAGER', true)).id;
    mechOtherTenantId = (await createUser(fixtureB, 'Mecanico Outra Empresa', 'MECHANIC', true)).id;
  }, 30000);

  afterAll(async () => {
    // destroyFixture apaga todos os usuários da empresa.
    await destroyFixture(fixtureA);
    await destroyFixture(fixtureB);
  }, 30000);

  it('sem filtro: lista todos os usuários da empresa (comportamento anterior) e nenhum de outra', async () => {
    const res = await list('?limit=100');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([fixtureA.userId, mechActiveId, mechInactiveId, managerId].sort());
    expect(res.body.pagination.total).toBe(4);
    expect(ids(res)).not.toContain(mechOtherTenantId);
  });

  it('userType=MECHANIC: só os mecânicos DA EMPRESA (ativo e inativo), nunca os de outra empresa', async () => {
    const res = await list('?userType=MECHANIC');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([mechActiveId, mechInactiveId].sort());
    expect(res.body.pagination.total).toBe(2);
    expect(ids(res)).not.toContain(mechOtherTenantId);
  });

  it('userType=MECHANIC&isActive=true: só o mecânico ativo', async () => {
    const res = await list('?userType=MECHANIC&isActive=true');
    expect(ids(res)).toEqual([mechActiveId]);
    expect(res.body.pagination.total).toBe(1);
  });

  it('isActive=false sozinho: só o inativo (o filtro não depende de userType)', async () => {
    const res = await list('?isActive=false');
    expect(ids(res)).toEqual([mechInactiveId]);
  });

  it('a paginação conta o filtro: limit=1 com 2 mecânicos → 1 item, total 2, 2 páginas', async () => {
    const page1 = await list('?userType=MECHANIC&limit=1&page=1');
    const page2 = await list('?userType=MECHANIC&limit=1&page=2');
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.pagination).toMatchObject({ page: 1, limit: 1, total: 2, pages: 2 });
    expect(page2.body.data).toHaveLength(1);
    expect([page1.body.data[0].id, page2.body.data[0].id].sort()).toEqual([mechActiveId, mechInactiveId].sort());
  });

  it('pedir um perfil que a empresa não tem devolve lista vazia (não vaza de outras empresas)', async () => {
    const res = await list('?userType=SUPER_ADMIN');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('valor inválido é 400 e não devolve a lista inteira', async () => {
    const badType = await list('?userType=MECANICO');
    expect(badType.status).toBe(400);
    expect(badType.body.error).toMatch(/userType inválido/);
    expect(badType.body.data).toBeUndefined();

    const badActive = await list('?isActive=talvez');
    expect(badActive.status).toBe(400);
    expect(badActive.body.error).toMatch(/isActive inválido/);
  });

  it('a resposta nunca traz segredos (senha, mfaSecret)', async () => {
    const res = await list('?userType=MECHANIC');
    for (const user of res.body.data) {
      expect(user).not.toHaveProperty('password');
      expect(user).not.toHaveProperty('mfaSecret');
    }
  });

  it('SUPER_ADMIN (sem empresa) filtra em todas as empresas', async () => {
    const token = generateAccessToken({
      userId: fixtureA.userId,
      email: 'root@test.local',
      companyId: undefined as any,
      branchId: undefined as any,
      userType: 'SUPER_ADMIN',
    });
    const res = await request(app).get('/api/users?userType=MECHANIC&limit=100').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const got = ids(res);
    expect(got).toContain(mechActiveId);
    expect(got).toContain(mechOtherTenantId);
    expect(got).not.toContain(managerId);
  });
});
