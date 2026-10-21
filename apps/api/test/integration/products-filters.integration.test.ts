import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import productsRoutes from '../../src/routes/products.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Filtros de GET /api/products — prova REAL (HTTP + Postgres/RLS + Redis).
 *
 * ACHADO: a tela de produtos tem os filtros "marca" e "aplicação" e os envia,
 * mas o schema de filtro da rota descartava as duas chaves — digitar uma marca
 * não filtrava nada. `isActive` vindo da query ("false") era recusado (400).
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('GET /api/products — filtros marca, aplicação e isActive (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let hondaId: string;
  let yamahaId: string;
  let inactiveHondaId: string;

  const token = () =>
    generateAccessToken({
      userId: fixture.userId,
      email: 'manager@test.local',
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType: 'MANAGER',
    });

  const list = (query: string) => request(app).get(`/api/products?limit=100${query}`).set('Authorization', `Bearer ${token()}`);
  const ids = (res: request.Response) => (res.body.products as Array<{ id: string }>).map((p) => p.id).sort();

  const createProduct = (sku: string, brand: string, application: string, isActive: boolean) =>
    bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.product.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          sku: `${sku}-${Date.now()}`,
          name: `Peça ${sku}`,
          brand,
          application,
          costPrice: 5,
          salePrice: 10,
          isActive,
        },
        select: { id: true },
      })
    );

  beforeAll(async () => {
    fixture = await createFixture('products-filters');
    app = express();
    app.use(express.json());
    app.use('/api/products', productsRoutes);

    hondaId = (await createProduct('H1', 'Honda Genuína', 'CG 160 Titan', true)).id;
    yamahaId = (await createProduct('Y1', 'Yamaha', 'Factor 150', true)).id;
    inactiveHondaId = (await createProduct('H2', 'Honda Genuína', 'CG 160 Fan', false)).id;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it('brand filtra por parte do texto, sem diferenciar maiúsculas', async () => {
    const res = await list('&brand=honda');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([hondaId, inactiveHondaId].sort());
    expect(ids(res)).not.toContain(yamahaId);
  });

  it('application filtra por parte do texto', async () => {
    const res = await list('&application=factor');
    expect(ids(res)).toEqual([yamahaId]);
  });

  it('brand + application combinam (E)', async () => {
    const res = await list('&brand=honda&application=titan');
    expect(ids(res)).toEqual([hondaId]);
  });

  it('isActive=false devolve só os inativos; isActive=true só os ativos (string da query)', async () => {
    const inactive = await list('&isActive=false');
    expect(inactive.status).toBe(200);
    expect(ids(inactive)).toEqual([inactiveHondaId]);

    const active = await list('&isActive=true&brand=honda');
    expect(ids(active)).toEqual([hondaId]);
  });

  it('isActive inválido continua 400', async () => {
    const res = await list('&isActive=talvez');
    expect(res.status).toBe(400);
  });

  it('sem filtros: comportamento anterior (todos os produtos da empresa, inclusive o do fixture)', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([fixture.productId, hondaId, yamahaId, inactiveHondaId].sort());
  });

  it('marca inexistente devolve lista vazia com total 0', async () => {
    const res = await list('&brand=naoexiste');
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
});
