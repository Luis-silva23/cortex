import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Entrada de `POST /api/sales` — prova REAL (HTTP + Postgres/RLS).
 *
 * ACHADO (auditoria do PDV, reproduzido): `createSaleSchema` aceitava `quantity` zero/negativa
 * e `discountAmount`/`discountPercent` negativos ou acima do total, e `createSale` nunca
 * conferia `product.isActive`. Consequências reais: venda com quantidade negativa gera total
 * negativo e ENTRADA de estoque fantasma; desconto negativo AUMENTA o preço (ou, no limite,
 * é usado para forjar valores); e o produto desativado no cadastro continuava sendo vendido
 * (o PDV o adicionava ao carrinho por SKU e por nome). O schema de item de OS já tinha sido
 * endurecido pelo mesmo motivo (`positive().finite()`); vendas ficaram de fora.
 */
describe('POST /api/sales — entrada inválida e produto inativo (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let inactiveProductId: string;
  const stamp = `sv-${Date.now()}`;

  const A = () => world.A;
  const branch = () => A().branches[1];
  const operator = () => bearer(tokenFor(A(), 1, 'OPERATOR'));

  const saleBody = (over: Record<string, unknown> = {}, itemOver: Record<string, unknown> = {}) => ({
    branchId: branch().branchId,
    cashRegisterId: A().fixture.cashRegisterId,
    notes: stamp,
    items: [{ productId: branch().productId, quantity: 1, unitPrice: 10, ...itemOver }],
    ...over,
  });

  const salesCount = () =>
    bypass<number>(() => prismaUnsafeBypassRLS.sale.count({ where: { companyId: A().companyId, notes: stamp } }));

  const stockBalance = async (productId: string) => {
    const rows = await bypass<Array<{ quantity: unknown }>>(() =>
      prismaUnsafeBypassRLS.stockMovement.findMany({ where: { companyId: A().companyId, productId } })
    );
    return rows.reduce((sum, r) => sum + Number(r.quantity), 0);
  };

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    // estoque para o produto ativo (o caixa aberto é o da fixture: um por usuário — índice único parcial)
    await bypass(() =>
      prismaUnsafeBypassRLS.stockMovement.create({
        data: { companyId: A().companyId, branchId: branch().branchId, productId: branch().productId, movementType: 'PURCHASE', quantity: 100, userId: branch().userId, unitCost: 5 },
      })
    );
    // produto desativado no cadastro, com estoque
    const inactive = await bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.product.create({
        data: { companyId: A().companyId, branchId: branch().branchId, sku: `INACT-${stamp}`, name: 'Produto Inativo', costPrice: 1, salePrice: 10, isActive: false },
      })
    );
    inactiveProductId = inactive.id;
    await bypass(() =>
      prismaUnsafeBypassRLS.stockMovement.create({
        data: { companyId: A().companyId, branchId: branch().branchId, productId: inactiveProductId, movementType: 'PURCHASE', quantity: 20, userId: branch().userId, unitCost: 1 },
      })
    );
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    // As vendas, o produto extra e o estoque saem no destroyWorld (expurgo por companyId guiado pelas FKs: discount_events
    // e demais filhos RESTRICT vêm antes). NUNCA filtrar só por uma variável que pode ficar `undefined`.
    if (world) {
      await destroyWorld(world);
    }
  }, 120000);

  const rejected: Array<[string, () => Record<string, unknown>]> = [
    ['quantidade negativa', () => saleBody({}, { quantity: -1 })],
    ['quantidade zero', () => saleBody({}, { quantity: 0 })],
    ['desconto de item negativo (aumentaria o preço)', () => saleBody({}, { discountAmount: -5 })],
    ['desconto de item maior que o total do item', () => saleBody({}, { discountAmount: 999 })],
    ['desconto percentual de item negativo', () => saleBody({}, { discountPercent: -10 })],
    ['desconto percentual de item acima de 100', () => saleBody({}, { discountPercent: 150 })],
    ['desconto global negativo', () => saleBody({ discountAmount: -5 })],
    ['desconto global percentual negativo', () => saleBody({ discountPercent: -10 })],
    ['desconto global percentual acima de 100', () => saleBody({ discountPercent: 150 })],
    ['produto INATIVO', () => saleBody({ items: [{ productId: inactiveProductId, quantity: 1, unitPrice: 10 }] })],
  ];

  it.each(rejected)('%s: 4xx, nenhuma venda gravada e o estoque não muda', async (_label, build) => {
    const before = {
      sales: await salesCount(),
      stock: await stockBalance(branch().productId),
      inactiveStock: await stockBalance(inactiveProductId),
    };

    const res = await request(app).post('/api/sales').set(operator()).send(build());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await salesCount()).toBe(before.sales);
    expect(await stockBalance(branch().productId)).toBe(before.stock);
    expect(await stockBalance(inactiveProductId)).toBe(before.inactiveStock);
  });

  it('controle: venda válida de produto ativo continua funcionando (201) e baixa o estoque', async () => {
    const before = await stockBalance(branch().productId);
    const res = await request(app).post('/api/sales').set(operator()).send(saleBody());
    expect(res.status).toBe(201);
    expect(Number(res.body.totalAmount)).toBe(10);
    expect(await stockBalance(branch().productId)).toBe(before - 1);
  });

  it('controle: desconto de item válido (dentro do total) é aceito ou recusado pela regra de alçada — nunca 5xx', async () => {
    const res = await request(app).post('/api/sales').set(operator()).send(saleBody({}, { discountAmount: 1 }));
    expect(res.status).toBeLessThan(500);
  });

  it('percentual de desconto enviado pelo cliente é ignorado: o servidor grava o percentual real do valor', async () => {
    // Desconto de 19% passa o limite livre padrão (5%, decisão do dono 2026-09-27 — docs/CORTEX/policies/DESCONTO.md).
    // O que este teste prova é o cálculo do percentual, não a alçada: a empresa libera 25% sem autorização só aqui.
    const companyId = A().companyId;
    await bypass(() =>
      prismaUnsafeBypassRLS.policySetting.create({ data: { companyId, branchId: null, key: 'discount.productFreePercent', value: 25, updatedBy: branch().userId } })
    );
    const res = await request(app)
      .post('/api/sales')
      .set(operator())
      .send(saleBody({ discountAmount: 0.9, discountPercent: 95 }, { discountAmount: 1, discountPercent: 90 }));
    await bypass(() => prismaUnsafeBypassRLS.policySetting.deleteMany({ where: { companyId, key: 'discount.productFreePercent' } }));
    expect(res.status).toBe(201);
    const sale = await bypass<any>(() => prismaUnsafeBypassRLS.sale.findUnique({ where: { id: res.body.id }, include: { items: true } }));
    expect(Number(sale.items[0].discountPercent)).toBe(10); // 1 de 10
    expect(Number(sale.discountPercent)).toBe(10); // 0,90 de 9,00
    expect(Number(sale.totalAmount)).toBe(8.1);
  });

  // ---- Contrato com o PDV (achados reproduzidos na tela real do PDV) ----------------------------
  // O PDV monta o corpo com `customerId: customer?.id || null` (venda de balcão SEM cliente é o caso
  // comum) e `partnerId` do convênio escolhido. O schema exigia `string` (rejeitava null → 400 com o
  // JSON cru do zod na tela) e NÃO tinha `partnerId` (o zod o descartava: o convênio que o operador
  // via no total nunca era aplicado pelo servidor).

  it('venda de balcão SEM cliente (customerId: null, como o PDV envia) é aceita e grava customerId nulo', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set(operator())
      .send(saleBody({ customerId: null, notes: null }));
    expect(res.status).toBe(201);
    const sale = await bypass<{ customerId: string | null }>(() => prismaUnsafeBypassRLS.sale.findUnique({ where: { id: res.body.id } }));
    expect(sale.customerId).toBeNull();
  });

  it('o convênio (partnerId) enviado pelo PDV é APLICADO pelo servidor: grava partnerId e o desconto', async () => {
    const manager = bearer(tokenFor(A(), 1, 'MANAGER'));
    const res = await request(app)
      .post('/api/sales')
      .set(manager)
      .send(saleBody({ partnerId: A().partnerId }));
    expect(res.status).toBe(201);
    const sale = await bypass<{ partnerId: string | null; partnerDiscountAmount: unknown; totalAmount: unknown }>(() =>
      prismaUnsafeBypassRLS.sale.findUnique({ where: { id: res.body.id } })
    );
    expect(sale.partnerId).toBe(A().partnerId);
    expect(Number(sale.partnerDiscountAmount)).toBeGreaterThan(0);
    expect(Number(sale.totalAmount)).toBeLessThan(10);
  });

  it('convênio de OUTRA empresa é recusado (não vaza desconto entre empresas)', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set(bearer(tokenFor(A(), 1, 'MANAGER')))
      .send(saleBody({ partnerId: world.B.partnerId }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
