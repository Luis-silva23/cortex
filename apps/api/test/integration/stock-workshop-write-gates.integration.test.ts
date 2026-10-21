import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import inventoryRoutes from '../../src/routes/inventory.routes';
import transfersRoutes from '../../src/routes/transfers.routes';
import serviceOrdersRoutes from '../../src/routes/service-orders.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Trava de papel nas escritas de estoque e oficina — prova REAL (HTTP +
 * Postgres/RLS + Redis, sem mock; JWT assinado com o segredo real do .env).
 *
 * ACHADO DE AUDITORIA: inventory/transfers/service-orders não tinham trava de
 * papel nas escritas — VIEWER (só-leitura no resto do sistema) conseguia
 * criar OS, adicionar item, mover o status, abrir inventário e solicitar
 * transferência. Aqui cada tentativa bloqueada é conferida NO BANCO (nada
 * gravado, nada alterado) e o operador real segue trabalhando.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Trava de papel nas escritas de estoque e oficina — integração real', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let serviceOrderId: string;

  const viewerId = '33333333-3333-4333-8333-333333333333';
  const tokenFor = (userType: string, userId: string) =>
    generateAccessToken({
      userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType,
    });

  const countOS = () => bypass<number>(() => prismaUnsafeBypassRLS.serviceOrder.count({ where: { companyId: fixture.companyId } }));
  const countInventories = () => bypass<number>(() => prismaUnsafeBypassRLS.inventory.count({ where: { companyId: fixture.companyId } }));
  const countTransfers = () => bypass<number>(() => prismaUnsafeBypassRLS.transfer.count({ where: { companyId: fixture.companyId } }));

  beforeAll(async () => {
    fixture = await createFixture('stock-workshop-gates');
    // o escopo de filiais vem do BANCO (users.branchId + vínculos): o VIEWER precisa existir de verdade na filial do fixture
    await bypass(() => prismaUnsafeBypassRLS.user.create({
      data: { id: viewerId, companyId: fixture.companyId, branchId: fixture.branchId, name: 'Viewer escopo', email: `viewer-escopo-${Date.now()}@test.local`, password: 'not-a-real-hash', userType: 'VIEWER', isActive: true },
    }));
    app = express();
    app.use(express.json());
    app.use('/api/inventory', inventoryRoutes);
    app.use('/api/transfers', transfersRoutes);
    app.use('/api/service-orders', serviceOrdersRoutes);
  }, 30000);

  afterAll(async () => {
    // destroyFixture não conhece as sessões de inventário (FK para a filial).
    await bypass(() => prismaUnsafeBypassRLS.inventory.deleteMany({ where: { companyId: fixture.companyId } }));
    await destroyFixture(fixture);
  }, 30000);

  it('OPERATOR (usuário real) abre OS e inventário normalmente', async () => {
    const token = tokenFor('OPERATOR', fixture.userId);

    const os = await request(app)
      .post('/api/service-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: fixture.branchId, customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, entryKilometer: 1200 });
    expect(os.status).toBe(201);
    expect(os.body.status).toBe('ENTRADA');
    serviceOrderId = os.body.id;

    const inventory = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: fixture.branchId });
    expect(inventory.status).toBe(201);

    expect(await countOS()).toBe(1);
    expect(await countInventories()).toBe(1);
  });

  it('VIEWER não cria OS, não adiciona item e não move o status (403) — o banco fica intacto', async () => {
    const token = tokenFor('VIEWER', viewerId);
    const osBefore = await countOS();

    const create = await request(app)
      .post('/api/service-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: fixture.branchId, customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, entryKilometer: 50 });
    expect(create.status).toBe(403);
    expect(await countOS()).toBe(osBefore);

    const item = await request(app)
      .post(`/api/service-orders/${serviceOrderId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'PART', productId: fixture.productId, description: 'Peça', quantity: 5, unitPrice: 10 });
    expect(item.status).toBe(403);
    const items = await bypass<number>(() => prismaUnsafeBypassRLS.serviceOrderItem.count({ where: { serviceOrderId } }));
    expect(items).toBe(0);

    const status = await request(app)
      .post(`/api/service-orders/${serviceOrderId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ toStatus: 'CANCELADA', notes: 'tentativa de VIEWER' });
    expect(status.status).toBe(403);
    const os = await bypass<any>(() => prismaUnsafeBypassRLS.serviceOrder.findFirst({ where: { id: serviceOrderId } }));
    expect(os.status).toBe('ENTRADA');
  });

  it('VIEWER não abre inventário nem solicita transferência (403) — nada é gravado', async () => {
    const token = tokenFor('VIEWER', viewerId);
    const inventoriesBefore = await countInventories();
    const transfersBefore = await countTransfers();

    const inventory = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: fixture.branchId });
    expect(inventory.status).toBe(403);

    const transfer = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ fromBranchId: fixture.branchId, toBranchId: fixture.branchId, items: [{ productId: fixture.productId, quantity: 1 }] });
    expect(transfer.status).toBe(403);

    expect(await countInventories()).toBe(inventoriesBefore);
    expect(await countTransfers()).toBe(transfersBefore);
  });

  it('VIEWER continua podendo LER OS, inventários e transferências (200)', async () => {
    const token = tokenFor('VIEWER', viewerId);

    expect((await request(app).get(`/api/service-orders/${serviceOrderId}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/inventory').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/transfers').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });
});
