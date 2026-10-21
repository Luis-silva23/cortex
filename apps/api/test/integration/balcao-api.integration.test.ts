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
 * APLICATIVO BALCÃO → backend (apps/balcao): o Balcão não tem regra própria; consome as APIs oficiais. Esta suíte prova, contra o
 * PostgreSQL real (RLS ligada), o contrato de que ele depende: identificação (cliente/veículo), consulta de produto e disponível,
 * orçamento → aprovação → OS, histórico por cliente/veículo, papéis, isolamento empresa/filial e proteção contra duplicidade.
 */
describe('Balcão → backend (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let branchA2: string;
  let userA2: string;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;

  const tok = (f: IntegrationFixture, userType: string, userId = f.userId, branchId: string | null = f.branchId) =>
    generateAccessToken({ userId, email: `${userType.toLowerCase()}@test.local`, companyId: f.companyId, branchId: (branchId ?? undefined) as any, userType });
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const opA = () => as(tok(A, 'OPERATOR'));
  const items = (productId: string) => [
    { itemType: 'PART', productId, description: 'Óleo 10W30', quantity: 2, unitPrice: 10 },
    { itemType: 'SERVICE', description: 'Troca de óleo', quantity: 1, unitPrice: 35.5 },
  ];

  beforeAll(async () => {
    A = await createFixture('balcaoA');
    B = await createFixture('balcaoB');
    const b2 = await bypass<any>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial 2', isActive: true } }));
    branchA2 = b2.id;
    const u2 = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: branchA2, name: 'Balcão A2', email: `balcao-a2-${Date.now()}@test.local`, password: 'not-a-real-hash', userType: 'OPERATOR', isActive: true } })
    );
    userA2 = u2.id;
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    for (const f of [A, B]) {
      if (!f?.companyId) continue;
      // OS, orçamentos, itens e versões saem no destroyFixture (expurgo por empresa guiado pelas FKs; filhos RESTRICT vêm antes).
    }
    // o usuário e a filial extras (userA2/branchA2) saem junto no destroyFixture, depois das OS/orçamentos que os referenciam.
    for (const f of [A, B]) if (f?.companyId) await destroyFixture(f);
  });

  describe('atendimento: identificação, produto e disponível', () => {
    it('acha o cliente (busca rápida) e o veículo dele; produto por texto; disponível = saldo − reservas na filial', async () => {
      const found = await request(app).get('/api/customers/search').query({ search: 'Cliente Integra' }).set(opA());
      expect(found.status).toBe(200);
      expect(found.body.customers.map((c: any) => c.id)).toContain(A.customerId);

      const bikes = await request(app).get('/api/motorcycles').query({ customerId: A.customerId }).set(opA());
      expect(bikes.status).toBe(200);
      expect(JSON.stringify(bikes.body)).toContain(A.motorcycleId);

      const prods = await request(app).get('/api/products').query({ search: 'Produto Integra' }).set(opA());
      expect(prods.status).toBe(200);
      expect(JSON.stringify(prods.body)).toContain(A.productId);

      const av = await request(app).get('/api/stock/availability').query({ productIds: A.productId }).set(opA());
      expect(av.status).toBe(200);
      expect(av.body.items).toEqual([{ productId: A.productId, branchId: A.branchId, balance: 1000, reserved: 0, available: 1000 }]);
    });

    it('custo é dado de gestão: balcão/mecânico/visualizador veem preço de venda e NÃO o custo; gerência vê (lista, código e detalhe)', async () => {
      const asManager = as(tok(A, 'MANAGER'));
      for (const role of ['OPERATOR', 'MECHANIC', 'VIEWER']) {
        const h = as(tok(A, role));
        const list = await request(app).get('/api/products').query({ search: 'Produto Integra' }).set(h);
        const row = list.body.products.find((p: any) => p.id === A.productId);
        expect(row).toBeTruthy();
        expect('costPrice' in row).toBe(false);
        expect(row.salePrice).toBeDefined();
        const detail = await request(app).get(`/api/products/${A.productId}`).set(h);
        expect(detail.status).toBe(200);
        expect('costPrice' in detail.body).toBe(false);
      }
      const mgrList = await request(app).get('/api/products').query({ search: 'Produto Integra' }).set(asManager);
      expect('costPrice' in mgrList.body.products.find((p: any) => p.id === A.productId)).toBe(true);
      expect('costPrice' in (await request(app).get(`/api/products/${A.productId}`).set(asManager)).body).toBe(true);
    });

    it('quem recebeu perfil de COMPRAS vê o custo (negocia com fornecedor); sem o perfil, ou VIEWER, não', async () => {
      const stamp = `cost-${Date.now()}`;
      const buyer = await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Comprador', email: `${stamp}@test.local`, password: 'not-a-real-hash', userType: 'OPERATOR', isActive: true } })
      );
      const role = await bypass<any>(() => db.role.create({ data: { companyId: A.companyId, name: stamp } }));
      const perm = await bypass<any>(() => db.permission.create({ data: { companyId: A.companyId, name: 'purchases:manage' } }));
      const rolePerm = await bypass<any>(() => db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } }));
      const userRole = await bypass<any>(() => db.userRole.create({ data: { userId: buyer.id, roleId: role.id, branchId: null } }));
      try {
        const withProfile = as(tok(A, 'OPERATOR', buyer.id));
        const list = await request(app).get('/api/products').query({ search: 'Produto Integra' }).set(withProfile);
        expect('costPrice' in list.body.products.find((p: any) => p.id === A.productId)).toBe(true);
        const detail = await request(app).get(`/api/products/${A.productId}`).set(withProfile);
        expect('costPrice' in detail.body).toBe(true);
        // o mesmo perfil num VIEWER (somente leitura) não abre o custo
        const viewer = await request(app).get(`/api/products/${A.productId}`).set(as(tok(A, 'VIEWER', buyer.id)));
        expect('costPrice' in viewer.body).toBe(false);
        // outro atendente sem perfil continua sem custo
        const plain = await request(app).get(`/api/products/${A.productId}`).set(opA());
        expect('costPrice' in plain.body).toBe(false);
      } finally {
        await bypass(() => db.userRole.deleteMany({ where: { id: userRole.id } }));
        await bypass(() => db.rolePermission.deleteMany({ where: { id: rolePerm.id } }));
        await bypass(() => db.role.deleteMany({ where: { id: role.id, companyId: A.companyId } }));
        await bypass(() => db.permission.deleteMany({ where: { id: perm.id, companyId: A.companyId } }));
        await bypass(() => db.user.deleteMany({ where: { id: buyer.id, companyId: A.companyId } }));
      }
    });

    it('disponível: produto de OUTRA empresa → 404; filial de outra filial → 403; sem produtos/50+ → 400; sem token → 401', async () => {
      expect((await request(app).get('/api/stock/availability').query({ productIds: B.productId }).set(opA())).status).toBe(404);
      const opA2 = as(tok(A, 'OPERATOR', userA2, branchA2));
      expect((await request(app).get('/api/stock/availability').query({ productIds: A.productId, branchId: A.branchId }).set(opA2)).status).toBe(403);
      expect((await request(app).get('/api/stock/availability').set(opA())).status).toBe(400);
      expect((await request(app).get('/api/stock/availability').query({ productIds: Array.from({ length: 51 }, (_, i) => `p${i}`).join(',') }).set(opA())).status).toBe(400);
      expect((await request(app).get('/api/stock/availability').query({ productIds: A.productId })).status).toBe(401);
    });

    it('administrador da empresa (sem filial no token) consulta uma filial DA empresa; filial de outra empresa → 400', async () => {
      const admin = as(tok(A, 'COMPANY_ADMIN', A.userId, null));
      expect((await request(app).get('/api/stock/availability').query({ productIds: A.productId, branchId: A.branchId }).set(admin)).status).toBe(200);
      expect((await request(app).get('/api/stock/availability').query({ productIds: A.productId, branchId: B.branchId }).set(admin)).status).toBe(400);
      expect((await request(app).get('/api/stock/availability').query({ productIds: A.productId }).set(admin)).status).toBe(400);
    });
  });

  describe('orçamento → aprovação → OS, e o histórico', () => {
    let quoteId: string;
    let osId: string;

    it('cria o orçamento, envia ao cliente, o cliente aprova e vira OS (tudo pelas rotas oficiais); auditoria gerada', async () => {
      auditSpy.mockClear();
      const created = await request(app).post('/api/quotes').set(opA()).send({ branchId: A.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, items: items(A.productId) });
      expect(created.status).toBe(201);
      quoteId = created.body.id;
      expect(Number(created.body.versions[0].totalAmount)).toBe(55.5); // 2 × 10,00 + 35,50 — o TOTAL é do servidor
      expect((await request(app).post(`/api/quotes/${quoteId}/send`).set(opA()).send({ versionNumber: 1 })).status).toBe(200);
      expect((await request(app).post(`/api/quotes/${quoteId}/decide`).set(opA()).send({ versionNumber: 1, approved: true })).status).toBe(200);
      const os = await request(app).post(`/api/quotes/${quoteId}/convert`).set(opA()).send({ branchId: A.branchId, entryKilometer: 1200 });
      expect(os.status).toBe(201);
      osId = os.body.id;
      expect(auditSpy.mock.calls.some((c) => c[0] === 'audit-log' && (c[1] as any).entity === 'Quote')).toBe(true);
      const detail = await request(app).get(`/api/quotes/${quoteId}`).set(opA());
      expect(detail.body.status).toBe('CONVERTED');
      expect(detail.body.versions[0].serviceOrder.id).toBe(osId);
    });

    it('proteção contra duplicidade: converter de novo é recusado e não cria segunda OS; segundo orçamento aberto exige confirmação', async () => {
      const again = await request(app).post(`/api/quotes/${quoteId}/convert`).set(opA()).send({ branchId: A.branchId, entryKilometer: 1200 });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(await bypass<number>(() => db.serviceOrder.count({ where: { companyId: A.companyId, customerId: A.customerId } }))).toBe(1);
      const first = await request(app).post('/api/quotes').set(opA()).send({ branchId: A.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, items: items(A.productId) });
      expect(first.status).toBe(201);
      const dup = await request(app).post('/api/quotes').set(opA()).send({ branchId: A.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, items: items(A.productId) });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('OPEN_QUOTE_EXISTS');
    });

    it('histórico: OS do cliente e do veículo (e só deles); orçamentos do cliente; vendas do cliente; OS de outra empresa não aparece', async () => {
      const byCustomer = await request(app).get('/api/service-orders').query({ customerId: A.customerId }).set(opA());
      expect(byCustomer.status).toBe(200);
      expect(byCustomer.body.orders.map((o: any) => o.id)).toEqual([osId]);
      const byBike = await request(app).get('/api/service-orders').query({ motorcycleId: A.motorcycleId }).set(opA());
      expect(byBike.body.orders.map((o: any) => o.id)).toEqual([osId]);
      expect((await request(app).get('/api/service-orders').query({ customerId: B.customerId }).set(opA())).body.orders).toEqual([]); // cliente de outra empresa
      const quotes = await request(app).get('/api/quotes').query({ customerId: A.customerId }).set(opA());
      expect(quotes.status).toBe(200);
      expect(JSON.stringify(quotes.body)).toContain(quoteId);
      expect((await request(app).get('/api/sales').query({ customerId: A.customerId }).set(opA())).status).toBe(200);
    });
  });

  describe('papéis e isolamento (o backend é a autoridade)', () => {
    it('VIEWER lê mas NÃO escreve orçamento/OS (403); MECHANIC não lê vendas (403) mas lê OS', async () => {
      const viewer = as(tok(A, 'VIEWER'));
      expect((await request(app).get('/api/quotes').set(viewer)).status).toBe(200);
      expect((await request(app).post('/api/quotes').set(viewer).send({ branchId: A.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, items: items(A.productId) })).status).toBe(403);
      expect((await request(app).post('/api/service-orders').set(viewer).send({ branchId: A.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, entryKilometer: 1 })).status).toBe(403);
      const mech = as(tok(A, 'MECHANIC'));
      expect((await request(app).get('/api/sales').set(mech)).status).toBe(403);
      expect((await request(app).get('/api/service-orders').set(mech)).status).toBe(200);
    });

    it('empresa B não lê nada da empresa A por id (cliente, veículo, orçamento, OS, produto) — 404', async () => {
      const opB = as(tok(B, 'OPERATOR'));
      const osA = await bypass<any>(() => db.serviceOrder.findFirst({ where: { companyId: A.companyId } }));
      const quoteA = await bypass<any>(() => db.quote.findFirst({ where: { companyId: A.companyId } }));
      expect((await request(app).get(`/api/customers/${A.customerId}`).set(opB)).status).toBe(404);
      expect((await request(app).get(`/api/motorcycles/${A.motorcycleId}`).set(opB)).status).toBe(404);
      expect((await request(app).get(`/api/quotes/${quoteA.id}`).set(opB)).status).toBe(404);
      expect((await request(app).get(`/api/service-orders/${osA.id}`).set(opB)).status).toBe(404);
      expect((await request(app).get(`/api/products/${A.productId}`).set(opB)).status).toBe(404);
      // e não cria orçamento para cliente/veículo de outra empresa
      const forged = await request(app).post('/api/quotes').set(opB).send({ branchId: B.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, items: items(B.productId) });
      expect(forged.status).toBeGreaterThanOrEqual(400);
      expect(await bypass<number>(() => db.quote.count({ where: { companyId: B.companyId } }))).toBe(0);
    });

    it('operador de uma filial não grava na outra filial (orçamento com branchId alheio é recusado)', async () => {
      const opA2 = as(tok(A, 'OPERATOR', userA2, branchA2));
      const res = await request(app).post('/api/quotes').set(opA2).send({ branchId: A.branchId, customerId: A.customerId, motorcycleId: A.motorcycleId, items: items(A.productId), confirmNew: true });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
