import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import salesRoutes from '../../src/routes/sales.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Busca de GET /api/sales — prova REAL (HTTP + Postgres/RLS, sem mock).
 *
 * ACHADO: a tela de vendas tem a caixa "Buscar por número ou cliente", mas a
 * API não tinha `search` — a tela filtrava no navegador SÓ a página carregada
 * (20 vendas): a venda #37 de um cliente aparecia como "nenhum resultado" se
 * estivesse na página 3. A busca agora é feita no servidor, dentro da empresa.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('GET /api/sales?search= — número ou nome do cliente (integração real)', () => {
  let fixtureA: IntegrationFixture;
  let fixtureB: IntegrationFixture;
  let app: express.Express;
  let saleMariaId: string;
  let saleFixtureCustomerId: string;
  let saleNoCustomerId: string;
  let saleOtherTenantId: string;

  const token = () =>
    generateAccessToken({
      userId: fixtureA.userId,
      email: 'manager@test.local',
      companyId: fixtureA.companyId,
      branchId: fixtureA.branchId,
      userType: 'MANAGER',
    });

  const list = (query: string) => request(app).get(`/api/sales?limit=100${query}`).set('Authorization', `Bearer ${token()}`);
  const ids = (res: request.Response) => (res.body.sales as Array<{ id: string }>).map((s) => s.id).sort();

  const createSale = (fixture: IntegrationFixture, saleNumber: number, customerId: string | null, status = 'PAID') =>
    bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.sale.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          saleNumber,
          customerId,
          userId: fixture.userId,
          cashRegisterId: fixture.cashRegisterId,
          status: status as any,
          subtotal: 10,
          totalAmount: 10,
        },
        select: { id: true },
      })
    );

  const createCustomer = (fixture: IntegrationFixture, name: string) =>
    bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.customer.create({ data: { companyId: fixture.companyId, name, isActive: true }, select: { id: true } })
    );

  beforeAll(async () => {
    fixtureA = await createFixture('sales-search-A');
    fixtureB = await createFixture('sales-search-B');
    app = express();
    app.use(express.json());
    app.use('/api/sales', salesRoutes);

    const maria = await createCustomer(fixtureA, 'Maria Silva');
    saleMariaId = (await createSale(fixtureA, 1001, maria.id)).id;
    saleFixtureCustomerId = (await createSale(fixtureA, 1002, fixtureA.customerId, 'CANCELLED')).id;
    saleNoCustomerId = (await createSale(fixtureA, 2003, null)).id;

    // Outra empresa, MESMO número de venda e um cliente com "Maria" no nome.
    const mariaB = await createCustomer(fixtureB, 'Maria Souza da Empresa B');
    saleOtherTenantId = (await createSale(fixtureB, 1001, mariaB.id)).id;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixtureA);
    await destroyFixture(fixtureB);
  }, 30000);

  it('sem search: todas as vendas da empresa (comportamento anterior)', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([saleMariaId, saleFixtureCustomerId, saleNoCustomerId].sort());
  });

  it('nome do cliente: parte do texto, sem diferenciar maiúsculas', async () => {
    const res = await list('&search=silva');
    expect(ids(res)).toEqual([saleMariaId]);
    expect(res.body.pagination.total).toBe(1);
  });

  it('número da venda: casa o número exato', async () => {
    const res = await list('&search=1002');
    expect(ids(res)).toEqual([saleFixtureCustomerId]);
  });

  it('número com "#" na frente (como a tela exibe) também funciona', async () => {
    const res = await list(`&search=${encodeURIComponent('#2003')}`);
    expect(ids(res)).toEqual([saleNoCustomerId]);
  });

  it('número parcial não casa (o número é inteiro; a busca é por igualdade)', async () => {
    const res = await list('&search=100');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([]);
  });

  it('nunca traz venda de outra empresa (mesmo número, cliente com o mesmo nome)', async () => {
    const byNumber = await list('&search=1001');
    expect(ids(byNumber)).toEqual([saleMariaId]);
    expect(ids(byNumber)).not.toContain(saleOtherTenantId);

    const byName = await list('&search=maria');
    expect(ids(byName)).toEqual([saleMariaId]);
  });

  it('combina com o filtro de status (E)', async () => {
    const res = await list('&search=cliente&status=CANCELLED');
    expect(ids(res)).toEqual([saleFixtureCustomerId]);

    const none = await list('&search=cliente&status=PAID');
    expect(ids(none)).toEqual([]);
  });

  it('só espaços não filtra nada', async () => {
    const res = await list('&search=%20%20');
    expect(ids(res)).toEqual([saleMariaId, saleFixtureCustomerId, saleNoCustomerId].sort());
  });
});
