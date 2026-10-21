import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * SUPER_ADMIN × contexto de empresa — prova REAL (HTTP + Postgres/RLS).
 *
 * O JWT do SUPER_ADMIN não tem `companyId`. Antes, as rotas de empresa usavam
 * `user.companyId` (undefined) direto: o Prisma ignora `undefined` no `where`, então
 *   - as listas devolviam dados de TODAS as empresas misturados (clientes, vendas,
 *     pagamentos, contas...);
 *   - criar registro sem empresa gerava erro do Prisma com o CAMINHO DO ARQUIVO do
 *     servidor na resposta;
 *   - `POST /users` de OPERATOR sem companyId gravava um usuário de empresa órfão.
 * Regra do produto: o SUPER_ADMIN administra o que é global, mas o que é de UMA
 * empresa/filial exige alvo EXPLÍCITO (?companyId= ou X-Company-Id), e o alvo é validado.
 */

const COMPANY_ROUTES = [
  '/api/customers', '/api/motorcycles', '/api/products', '/api/categories', '/api/suppliers', '/api/partners',
  '/api/sales?limit=100', '/api/service-orders?limit=100', '/api/quotes', '/api/purchase-orders', '/api/appointments',
  '/api/revisions', '/api/follow-ups', '/api/damage', '/api/inventory', '/api/financial/payables',
  '/api/financial/receivables', '/api/mechanics/commissions', '/api/cash-register/history', '/api/dashboard/stock',
  '/api/dashboard/sales', '/api/dashboard/workshop', '/api/discount-rules', '/api/installment-policies',
  '/api/commission-rules', '/api/transfers',
];

describe('SUPER_ADMIN: alvo de empresa explícito em rotas de empresa (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const createdUserIds: string[] = [];

  const saToken = () =>
    generateAccessToken({ userId: world.A.fixture.userId, email: 'sa@test.local', userType: 'SUPER_ADMIN' } as any);
  const sa = () => bearer(saToken());

  const companyIdsIn = (body: unknown): Set<string> => {
    const found = new Set<string>();
    const walk = (v: any, depth = 0) => {
      if (!v || depth > 8) return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      if (typeof v === 'object') {
        if (typeof v.companyId === 'string') found.add(v.companyId);
        Object.values(v).forEach((x) => walk(x, depth + 1));
      }
    };
    walk(body);
    return found;
  };

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await bypass(() => prismaUnsafeBypassRLS.user.deleteMany({ where: { id: { in: createdUserIds } } }));
    await destroyWorld(world);
  }, 120000);

  describe.each(COMPANY_ROUTES)('GET %s', (url) => {
    it('sem empresa-alvo: 400 COMPANY_CONTEXT_REQUIRED e nenhum dado de nenhuma empresa', async () => {
      const res = await request(app).get(url).set(sa());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COMPANY_CONTEXT_REQUIRED');
      expect(companyIdsIn(res.body).size).toBe(0);
    });

    it('com a empresa A como alvo: só enxerga dados da A (nunca da B nem de outra empresa)', async () => {
      const res = await request(app).get(url).set(sa()).set('X-Company-Id', world.A.companyId);
      expect({ status: res.status, body: res.status === 200 ? '<ok>' : res.body }).toEqual({ status: 200, body: '<ok>' });
      for (const id of companyIdsIn(res.body)) expect(id).toBe(world.A.companyId);
    });
  });

  it('alvo por ?companyId= funciona igual ao cabeçalho, e a B não enxerga nada da A', async () => {
    const res = await request(app).get(`/api/customers?companyId=${world.B.companyId}`).set(sa());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(world.A.companyId);
    expect(JSON.stringify(res.body)).toContain(world.B.companyId);
  });

  it('empresa-alvo inexistente ou malformada é recusada (404/400), sem cair em outra empresa', async () => {
    const missing = await request(app).get('/api/customers').set(sa()).set('X-Company-Id', '00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('COMPANY_NOT_FOUND');
    const bad = await request(app).get('/api/customers').set(sa()).set('X-Company-Id', "x' OR '1'='1");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_COMPANY_CONTEXT');
  });

  it('escrita sem alvo: 400, NADA é gravado e a resposta não expõe caminho de arquivo nem erro do Prisma', async () => {
    const name = `SA-sem-alvo-${Date.now()}`;
    const res = await request(app).post('/api/categories').set(sa()).send({ name });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMPANY_CONTEXT_REQUIRED');
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|invocation|node_modules|C:\\|\.ts:\d+/i);
    const persisted = await bypass(() => prismaUnsafeBypassRLS.category.count({ where: { name } }));
    expect(persisted).toBe(0);
  });

  it('escrita com alvo: grava na empresa-alvo (e só nela)', async () => {
    const name = `SA-com-alvo-${Date.now()}`;
    const res = await request(app).post('/api/categories').set(sa()).set('X-Company-Id', world.B.companyId).send({ name });
    expect(res.status).toBe(201);
    const rows = (await bypass(() => prismaUnsafeBypassRLS.category.findMany({ where: { name } }))) as Array<{ companyId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(world.B.companyId);
  });

  it('rotas de plataforma continuam globais para o SUPER_ADMIN (sem alvo)', async () => {
    for (const url of ['/api/companies', '/api/users', '/api/dashboard/super-admin', '/api/licenses']) {
      const res = await request(app).get(url).set(sa());
      expect(res.status).toBe(200);
    }
  });

  it('POST /users de usuário de empresa sem companyId: 400 (não cria órfão); com companyId: 201 na empresa certa', async () => {
    const email = `sa-ctx-${Date.now()}@test.local`;
    const body = { name: 'SA Ctx', email, password: 'Abcdef1!xyz', userType: 'OPERATOR' };

    const orphan = await request(app).post('/api/users').set(sa()).send(body);
    expect(orphan.status).toBe(400);
    expect(orphan.body.code).toBe('COMPANY_CONTEXT_REQUIRED');
    expect(await bypass(() => prismaUnsafeBypassRLS.user.count({ where: { email } }))).toBe(0);

    const ok = await request(app).post('/api/users').set(sa()).send({ ...body, companyId: world.A.companyId });
    expect(ok.status).toBe(201);
    createdUserIds.push(ok.body.data.id);
    expect(ok.body.data.companyId).toBe(world.A.companyId);
  });

  it('usuário comum NÃO consegue trocar de empresa com X-Company-Id / ?companyId= (o token manda)', async () => {
    const a1 = bearer(tokenFor(world.A, 1, 'MANAGER'));
    const res = await request(app)
      .get(`/api/customers?companyId=${world.B.companyId}`)
      .set(a1)
      .set('X-Company-Id', world.B.companyId);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(world.B.companyId);
    expect(body).toContain(world.A.companyId);
  });
});
