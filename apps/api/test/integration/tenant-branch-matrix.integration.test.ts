import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { World, BranchKey, CoKey, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * BATERIA MULTI-EMPRESA / MULTI-FILIAL — a aplicação inteira (rotas reais +
 * middlewares + RLS + Postgres + Redis), não só as policies.
 *
 *   EMPRESA A → FILIAL A1, A2      EMPRESA B → FILIAL B1, B2
 *
 * Regra de isolamento (a real do banco, `rls_company_branch_match`):
 *  - REGISTROS DE FILIAL (venda, OS, orçamento, compra, produto, caixa, agenda,
 *    revisão, follow-up, avaria, inventário): o operador/gerente da filial X só
 *    enxerga os da filial X; COMPANY_ADMIN enxerga todas as filiais da SUA
 *    empresa; NINGUÉM enxerga outra empresa.
 *  - DERIVADOS de documento de filial (pagamento → venda; comissão → OS; contas a
 *    pagar/receber com `branchId`): seguem a filial do documento de origem.
 *  - CADASTROS DA EMPRESA (cliente, moto, fornecedor, categoria, convênio):
 *    compartilhados entre as filiais da empresa, nunca entre empresas.
 */

type Actor = { label: string; co: CoKey; branch: BranchKey | null; userType: string };

const ACTORS: Actor[] = [
  { label: 'A1 OPERATOR', co: 'A', branch: 1, userType: 'OPERATOR' },
  { label: 'A1 MANAGER', co: 'A', branch: 1, userType: 'MANAGER' },
  { label: 'A2 OPERATOR', co: 'A', branch: 2, userType: 'OPERATOR' },
  { label: 'B1 OPERATOR', co: 'B', branch: 1, userType: 'OPERATOR' },
  { label: 'B2 MANAGER', co: 'B', branch: 2, userType: 'MANAGER' },
  { label: 'A COMPANY_ADMIN', co: 'A', branch: null, userType: 'COMPANY_ADMIN' },
];

const companyWide = (a: Actor) => a.userType === 'COMPANY_ADMIN' || a.userType === 'SUPER_ADMIN';

describe('Multi-empresa / multi-filial — bateria completa (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;

  const tok = (a: Actor) => bearer(tokenFor(world[a.co], a.branch, a.userType));

  // dados de uma empresa/filial
  const b = (co: CoKey, br: BranchKey) => world[co].branches[br];

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
    await destroyWorld(world);
  }, 120000);

  // --------------------------------------------------------------------------
  // 1) GET por id — registros de FILIAL
  // --------------------------------------------------------------------------
  type BranchDataT = ReturnType<typeof b>;
  const BRANCH_RECORDS: Array<{ name: string; path: (d: BranchDataT) => string; id: (d: BranchDataT) => string }> = [
    { name: 'venda', path: (d) => `/api/sales/${d.saleId}`, id: (d) => d.saleId },
    { name: 'OS', path: (d) => `/api/service-orders/${d.serviceOrderId}`, id: (d) => d.serviceOrderId },
    { name: 'orçamento', path: (d) => `/api/quotes/${d.quoteId}`, id: (d) => d.quoteId },
    { name: 'pedido de compra', path: (d) => `/api/purchase-orders/${d.purchaseOrderId}`, id: (d) => d.purchaseOrderId },
    { name: 'produto', path: (d) => `/api/products/${d.productId}`, id: (d) => d.productId },
    { name: 'caixa', path: (d) => `/api/cash-register/${d.cashRegisterId}`, id: (d) => d.cashRegisterId },
    { name: 'agendamento', path: (d) => `/api/appointments/${d.appointmentId}`, id: (d) => d.appointmentId },
    { name: 'revisão', path: (d) => `/api/revisions/${d.revisionId}`, id: (d) => d.revisionId },
    { name: 'follow-up', path: (d) => `/api/follow-ups/${d.followUpId}`, id: (d) => d.followUpId },
    { name: 'avaria', path: (d) => `/api/damage/${d.damageId}`, id: (d) => d.damageId },
    { name: 'inventário', path: (d) => `/api/inventory/${d.inventoryId}`, id: (d) => d.inventoryId },
    // derivado de venda (filial da venda)
    { name: 'pagamento (por transação)', path: (d) => `/api/payments/transaction/${d.paymentTx}`, id: (d) => d.paymentTx },
  ];

  describe.each(BRANCH_RECORDS)('GET $name por id', ({ name, path, id }) => {
    const cases = ACTORS.flatMap((actor) =>
      (['A', 'B'] as CoKey[]).flatMap((co) => ([1, 2] as BranchKey[]).map((br) => ({ actor, co, br })))
    );

    it.each(cases.map((c) => [`${c.actor.label} → ${c.co}${c.br}`, c] as const))('%s', async (_label, { actor, co, br }) => {
      const target = b(co, br);
      const shouldSee = actor.co === co && (companyWide(actor) || actor.branch === br);

      const res = await request(app).get(path(target)).set(tok(actor));

      if (shouldSee) {
        expect([name, res.status]).toEqual([name, 200]);
      } else {
        // 404/403/400: qualquer recusa serve; o que NÃO pode é entregar o registro.
        expect([name, [400, 403, 404].includes(res.status)]).toEqual([name, true]);
        expect(JSON.stringify(res.body)).not.toContain(id(target));
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2) GET por id — CADASTROS DA EMPRESA (todas as filiais da mesma empresa, nunca outra empresa)
  // --------------------------------------------------------------------------
  type CompanyDataT = World['A'];
  const COMPANY_RECORDS: Array<{ name: string; path: (c: CompanyDataT) => string; id: (c: CompanyDataT) => string }> = [
    { name: 'cliente', path: (c) => `/api/customers/${c.customerId}`, id: (c) => c.customerId },
    { name: 'moto', path: (c) => `/api/motorcycles/${c.motorcycleId}`, id: (c) => c.motorcycleId },
    { name: 'fornecedor', path: (c) => `/api/suppliers/${c.supplierId}`, id: (c) => c.supplierId },
    { name: 'categoria', path: (c) => `/api/categories/${c.categoryId}`, id: (c) => c.categoryId },
    { name: 'convênio', path: (c) => `/api/partners/${c.partnerId}`, id: (c) => c.partnerId },
  ];

  describe.each(COMPANY_RECORDS)('GET $name por id', ({ name, path, id }) => {
    const cases = ACTORS.flatMap((actor) => (['A', 'B'] as CoKey[]).map((co) => ({ actor, co })));
    it.each(cases.map((c) => [`${c.actor.label} → empresa ${c.co}`, c] as const))('%s', async (_label, { actor, co }) => {
      const target = world[co];
      const res = await request(app).get(path(target)).set(tok(actor));
      if (actor.co === co) {
        expect([name, res.status]).toEqual([name, 200]);
      } else {
        expect([name, [400, 403, 404].includes(res.status)]).toEqual([name, true]);
        expect(JSON.stringify(res.body)).not.toContain(id(target));
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3) LISTAS — o que aparece para cada ator
  // --------------------------------------------------------------------------
  const LISTS: Array<{ name: string; path: string; ids: (d: BranchDataT) => string[] }> = [
    { name: 'vendas', path: '/api/sales?limit=100', ids: (d) => [d.saleId] },
    { name: 'pagamentos', path: '/api/payments?limit=100', ids: (d) => [d.paymentId, d.paymentTx] },
    { name: 'histórico de caixa', path: '/api/cash-register/history?limit=100', ids: (d) => [d.cashRegisterId] },
    { name: 'contas a pagar', path: '/api/financial/payables?limit=100', ids: (d) => [d.payableId] },
    { name: 'contas a receber', path: '/api/financial/receivables?limit=100', ids: (d) => [d.receivableId] },
    { name: 'comissões', path: '/api/mechanics/commissions?limit=100', ids: (d) => [d.commissionId] },
    { name: 'OS', path: '/api/service-orders?limit=100', ids: (d) => [d.serviceOrderId] },
    { name: 'orçamentos', path: '/api/quotes?limit=100', ids: (d) => [d.quoteId] },
    { name: 'compras', path: '/api/purchase-orders?limit=100', ids: (d) => [d.purchaseOrderId] },
    { name: 'produtos', path: '/api/products?limit=100', ids: (d) => [d.productId] },
    { name: 'agenda', path: '/api/appointments?limit=100', ids: (d) => [d.appointmentId] },
    { name: 'revisões', path: '/api/revisions?limit=100', ids: (d) => [d.revisionId] },
    { name: 'follow-ups', path: '/api/follow-ups?limit=100', ids: (d) => [d.followUpId] },
    { name: 'avarias', path: '/api/damage?limit=100', ids: (d) => [d.damageId] },
    { name: 'inventários', path: '/api/inventory?limit=100', ids: (d) => [d.inventoryId] },
  ];

  describe.each(LISTS)('lista de $name', ({ path, ids }) => {
    it.each(ACTORS.map((a) => [a.label, a] as const))('%s só vê o que é dele', async (_label, actor) => {
      const res = await request(app).get(path).set(tok(actor));
      expect([path, res.status]).toEqual([path, 200]);
      const text = JSON.stringify(res.body);

      for (const co of ['A', 'B'] as CoKey[]) {
        for (const br of [1, 2] as BranchKey[]) {
          const shouldSee = actor.co === co && (companyWide(actor) || actor.branch === br);
          for (const id of ids(b(co, br))) {
            expect([path, `${co}${br}`, id, text.includes(id)]).toEqual([path, `${co}${br}`, id, shouldSee]);
          }
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4) ESCRITAS — A1 tentando alterar A2 e B; nada pode mudar
  // --------------------------------------------------------------------------
  describe('escritas cruzadas não alteram nada', () => {
    const asA1Manager = ACTORS[1];
    const asA1Operator = ACTORS[0];

    const productRow = (id: string) => bypass<any>(() => prismaUnsafeBypassRLS.product.findFirst({ where: { id } }));

    it.each([
      ['produto de A2 (mesma empresa, outra filial)', () => b('A', 2).productId],
      ['produto de B1 (outra empresa)', () => b('B', 1).productId],
    ])('PUT/DELETE em %s → recusado e intacto', async (_label, idOf) => {
      const id = idOf();
      const before = await productRow(id);

      const put = await request(app).put(`/api/products/${id}`).set(tok(asA1Manager)).send({ name: 'HACKEADO' });
      const del = await request(app).delete(`/api/products/${id}`).set(tok(asA1Manager));

      expect([put.status, del.status].every((s) => s >= 400)).toBe(true);
      const after = await productRow(id);
      expect(after.name).toBe(before.name);
      expect(after.isActive).toBe(before.isActive);
    });

    it.each([
      ['OS de A2', () => b('A', 2).serviceOrderId],
      ['OS de B1', () => b('B', 1).serviceOrderId],
    ])('adicionar item / mudar status na %s → recusado, sem item', async (_label, idOf) => {
      const id = idOf();
      const item = await request(app)
        .post(`/api/service-orders/${id}/items`)
        .set(tok(asA1Operator))
        .send({ itemType: 'SERVICE', description: 'invasão', quantity: 1, unitPrice: 10 });
      const status = await request(app).post(`/api/service-orders/${id}/status`).set(tok(asA1Operator)).send({ toStatus: 'CANCELADA' });

      expect(item.status).toBeGreaterThanOrEqual(400);
      expect(status.status).toBeGreaterThanOrEqual(400);
      const count = await bypass<number>(() => prismaUnsafeBypassRLS.serviceOrderItem.count({ where: { serviceOrderId: id } }));
      expect(count).toBe(0);
      const os = await bypass<any>(() => prismaUnsafeBypassRLS.serviceOrder.findFirst({ where: { id } }));
      expect(os.status).not.toBe('CANCELADA');
    });

    it('cadastros de OUTRA empresa (cliente, moto, fornecedor, categoria, convênio): PUT/DELETE recusados e intactos', async () => {
      const B = world.B;
      const results = await Promise.all([
        request(app).put(`/api/customers/${B.customerId}`).set(tok(asA1Manager)).send({ name: 'HACKEADO' }),
        request(app).delete(`/api/customers/${B.customerId}`).set(tok(asA1Manager)),
        request(app).delete(`/api/motorcycles/${B.motorcycleId}`).set(tok(asA1Manager)),
        request(app).put(`/api/suppliers/${B.supplierId}`).set(tok(asA1Manager)).send({ name: 'HACKEADO' }),
        request(app).delete(`/api/categories/${B.categoryId}`).set(tok(asA1Manager)),
        request(app).put(`/api/partners/${B.partnerId}`).set(tok(asA1Manager)).send({ name: 'HACKEADO' }),
      ]);
      results.forEach((r) => expect(r.status).toBeGreaterThanOrEqual(400));

      const customer = await bypass<any>(() => prismaUnsafeBypassRLS.customer.findFirst({ where: { id: B.customerId } }));
      expect(customer.isActive).toBe(true);
      expect(customer.name).not.toBe('HACKEADO');
      expect(await bypass<any>(() => prismaUnsafeBypassRLS.motorcycle.findFirst({ where: { id: B.motorcycleId } }))).not.toBeNull();
      expect((await bypass<any>(() => prismaUnsafeBypassRLS.supplier.findFirst({ where: { id: B.supplierId } }))).name).not.toBe('HACKEADO');
      expect(await bypass<any>(() => prismaUnsafeBypassRLS.category.findFirst({ where: { id: B.categoryId } }))).not.toBeNull();
      expect((await bypass<any>(() => prismaUnsafeBypassRLS.partner.findFirst({ where: { id: B.partnerId } }))).name).not.toBe('HACKEADO');
    });

    it('companyId/branchId FORJADOS no corpo e na query são ignorados (não criam nem leem na empresa/filial alheia)', async () => {
      const A2 = b('A', 2);
      const B1 = b('B', 1);

      const sales = await request(app).get(`/api/sales?limit=100&companyId=${world.B.companyId}&branchId=${A2.branchId}`).set(tok(ACTORS[0]));
      expect(JSON.stringify(sales.body)).not.toContain(B1.saleId);
      expect(JSON.stringify(sales.body)).not.toContain(A2.saleId);
      const products = await request(app).get(`/api/products?limit=100&companyId=${world.B.companyId}`).set(tok(ACTORS[0]));
      expect(JSON.stringify(products.body)).not.toContain(B1.productId);

      const created = await request(app)
        .post('/api/customers')
        .set(tok(asA1Manager))
        .send({ name: 'Cliente Forjado', companyId: world.B.companyId });
      expect(created.status).toBeLessThan(300);
      const row = await bypass<any>(() => prismaUnsafeBypassRLS.customer.findFirst({ where: { id: created.body.id } }));
      expect(row.companyId).toBe(world.A.companyId);
    });
  });
});
