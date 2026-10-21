import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import purchaseOrderService from '../../src/services/purchase-order.service';
import purchaseOrdersRoutes from '../../src/routes/purchase-orders.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Listagem de pedidos de compra — prova REAL (HTTP + Postgres/RLS, sem mock).
 *
 * ACHADO: a tela de compras tem a coluna "Itens" (`order.items?.length`), mas
 * a listagem da API só incluía o fornecedor — a coluna mostrava "-" em TODOS os
 * pedidos. A listagem agora devolve a contagem (`_count.items`) sem carregar as
 * linhas de cada pedido.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('GET /api/purchase-orders — contagem de itens (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let poTwoItemsId: string;
  let poOneItemId: string;

  // SUPER_ADMIN só para passar pelo requirePermission (a empresa sintética não
  // tem perfil RBAC); o token leva a empresa do fixture, e é ela que a rota usa.
  const token = () =>
    generateAccessToken({
      userId: fixture.userId,
      email: 'root@test.local',
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType: 'SUPER_ADMIN',
    });

  beforeAll(async () => {
    fixture = await createFixture('po-list');
    app = express();
    app.use(express.json());
    app.use('/api/purchase-orders', purchaseOrdersRoutes);

    const other = await bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.product.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          sku: `INT-po-list-${Date.now()}`,
          name: 'Segundo produto',
          costPrice: 1,
          salePrice: 2,
          isActive: true,
        },
        select: { id: true },
      })
    );

    const create = (items: Array<{ productId: string; quantity: number; unitCost: number }>) =>
      runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: fixture.branchId }, () =>
        purchaseOrderService.create({
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          supplierId: fixture.supplierId,
          items,
        })
      );

    poTwoItemsId = (
      await create([
        { productId: fixture.productId, quantity: 2, unitCost: 5 },
        { productId: other.id, quantity: 1, unitCost: 3 },
      ])
    ).id;
    poOneItemId = (await create([{ productId: fixture.productId, quantity: 4, unitCost: 5 }])).id;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it('cada pedido traz a quantidade de itens', async () => {
    const res = await request(app).get('/api/purchase-orders').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);

    const byId = new Map<string, any>(res.body.orders.map((o: any) => [o.id, o]));
    expect(byId.get(poTwoItemsId)._count.items).toBe(2);
    expect(byId.get(poOneItemId)._count.items).toBe(1);
  });

  it('a listagem continua trazendo o fornecedor e não carrega as linhas dos itens', async () => {
    const res = await request(app).get('/api/purchase-orders').set('Authorization', `Bearer ${token()}`);
    const order = res.body.orders.find((o: any) => o.id === poOneItemId);
    expect(order.supplier).toMatchObject({ id: fixture.supplierId });
    expect(order.items).toBeUndefined();
  });
});
