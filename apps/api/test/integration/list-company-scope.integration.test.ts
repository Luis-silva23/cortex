import express from 'express';
import request from 'supertest';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import productsRoutes from '../../src/routes/products.routes';
import salesRoutes from '../../src/routes/sales.routes';
import paymentsRoutes from '../../src/routes/payments.routes';
import cashRegisterRoutes from '../../src/routes/cash-register.routes';
import productService from '../../src/services/product.service';
import saleService from '../../src/services/sale.service';
import paymentService from '../../src/services/payment.service';
import cashRegisterService from '../../src/services/cash-register.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Escopo de empresa nas listagens — prova REAL (HTTP + Postgres/RLS + Redis,
 * sem mock de banco/cache; JWT assinado com o segredo do .env).
 *
 * ACHADO DE AUDITORIA (vazamento entre empresas): products/sales/payments/
 * cash-register faziam `listX({ companyId: <do token>, ...filters })` e o
 * schema de filtro aceitava `companyId` da query string — o `...filters`
 * vinha DEPOIS e sobrescrevia a empresa do token. Nas vendas/pagamentos/caixas
 * a RLS do banco barrava o dado alheio, mas a lista de PRODUTOS é servida de
 * um cache Redis cuja chave é montada com esse companyId: a empresa B pedindo
 * `GET /api/products?companyId=<A>` recebia a lista de produtos (com preço de
 * custo e de venda) da empresa A direto do cache, sem passar pela RLS.
 */

describe('Listagens ignoram companyId da query para quem não é SUPER_ADMIN — integração real', () => {
  let fixtureA: IntegrationFixture;
  let fixtureB: IntegrationFixture;
  let app: express.Express;

  const tokenFor = (fixture: IntegrationFixture, userType: string) =>
    generateAccessToken({
      userId: fixture.userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType,
    });

  const superAdminToken = () =>
    generateAccessToken({
      userId: fixtureA.userId,
      email: 'root@test.local',
      companyId: undefined as any,
      branchId: undefined as any,
      userType: 'SUPER_ADMIN',
    });

  const productIds = (res: request.Response) => (res.body.products as Array<{ id: string }>).map((p) => p.id);

  beforeAll(async () => {
    fixtureA = await createFixture('scope-A');
    fixtureB = await createFixture('scope-B');
    app = express();
    app.use(express.json());
    app.use('/api/products', productsRoutes);
    app.use('/api/sales', salesRoutes);
    app.use('/api/payments', paymentsRoutes);
    app.use('/api/cash-register', cashRegisterRoutes);
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await destroyFixture(fixtureA);
    await destroyFixture(fixtureB);
  }, 30000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a empresa A lista os próprios produtos (e isso popula o cache da lista de A)', async () => {
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${tokenFor(fixtureA, 'OPERATOR')}`);
    expect(res.status).toBe(200);
    expect(productIds(res)).toContain(fixtureA.productId);
    expect(productIds(res)).not.toContain(fixtureB.productId);
  });

  it('a empresa B pedindo ?companyId=<A> NÃO recebe os produtos de A (nem do cache)', async () => {
    const res = await request(app)
      .get(`/api/products?companyId=${fixtureA.companyId}`)
      .set('Authorization', `Bearer ${tokenFor(fixtureB, 'OPERATOR')}`);
    expect(res.status).toBe(200);
    expect(productIds(res)).not.toContain(fixtureA.productId);
    expect(productIds(res)).toContain(fixtureB.productId);
  });

  it.each([
    ['products', '/api/products', () => jest.spyOn(productService, 'listProducts')],
    ['sales', '/api/sales', () => jest.spyOn(saleService, 'listSales')],
    ['payments', '/api/payments', () => jest.spyOn(paymentService, 'listPayments')],
    ['cash-register', '/api/cash-register/history', () => jest.spyOn(cashRegisterService, 'listCashRegisters')],
  ])('%s: o service é chamado com a empresa do TOKEN, não a da query', async (_name, path, spy) => {
    const listSpy = spy();
    const res = await request(app)
      .get(`${path}?companyId=${fixtureA.companyId}`)
      .set('Authorization', `Bearer ${tokenFor(fixtureB, 'MANAGER')}`);
    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0][0]).toMatchObject({ companyId: fixtureB.companyId });
  });

  // Mesma classe, outro caminho: o detalhe do produto é cacheado por `product:<id>`
  // (sem a empresa na chave). Quem conhece o id de um produto de outra empresa
  // (ex.: um id vazado num log/print) lia o produto — com preço de custo — do
  // cache, sem passar pela RLS nem pelo filtro de empresa da consulta.
  it('detalhe: a empresa B pedindo o produto de A pelo id recebe 404 — mesmo com o detalhe de A já no cache', async () => {
    const own = await request(app)
      .get(`/api/products/${fixtureA.productId}`)
      .set('Authorization', `Bearer ${tokenFor(fixtureA, 'OPERATOR')}`);
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(fixtureA.productId);

    const other = await request(app)
      .get(`/api/products/${fixtureA.productId}`)
      .set('Authorization', `Bearer ${tokenFor(fixtureB, 'OPERATOR')}`);
    expect(other.status).toBe(404);
    expect(other.body.id).toBeUndefined();

    // e o dono continua lendo normalmente (do cache ou não)
    const again = await request(app)
      .get(`/api/products/${fixtureA.productId}`)
      .set('Authorization', `Bearer ${tokenFor(fixtureA, 'OPERATOR')}`);
    expect(again.status).toBe(200);
  });

  it('SUPER_ADMIN continua podendo escopar a listagem por ?companyId (uso legítimo)', async () => {
    const res = await request(app)
      .get(`/api/products?companyId=${fixtureA.companyId}`)
      .set('Authorization', `Bearer ${superAdminToken()}`);
    expect(res.status).toBe(200);
    expect(productIds(res)).toContain(fixtureA.productId);
    expect(productIds(res)).not.toContain(fixtureB.productId);
  });

  it('sem ?companyId o comportamento de sempre: cada empresa vê só a própria lista', async () => {
    const b = await request(app).get('/api/products').set('Authorization', `Bearer ${tokenFor(fixtureB, 'OPERATOR')}`);
    expect(b.status).toBe(200);
    expect(productIds(b)).toContain(fixtureB.productId);
    expect(productIds(b)).not.toContain(fixtureA.productId);
  });
});
