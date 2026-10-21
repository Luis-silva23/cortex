import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import importRoutes from '../../src/routes/import.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Importação em lote — prova REAL (HTTP + Postgres/RLS, sem mock; JWT real).
 *
 * ACHADOS DE AUDITORIA:
 * - o template "básico" da tela não tem coluna SKU; a rota fazia
 *   `findFirst({ where: { companyId, sku: undefined } })` (o Prisma ignora
 *   `undefined`), casava o PRIMEIRO produto da empresa e o sobrescrevia a cada
 *   linha do arquivo;
 * - a tela manda price/stock/category e a rota lia costPrice/salePrice/...;
 * - estoque: a busca é explícita (SKU, depois código de barras) e exige um
 *   identificador. (Testado: no código original uma linha só com barcode
 *   inexistente NÃO casava produto — não era defeito confirmado.)
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Importação em lote — nenhuma linha casa "qualquer registro" (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let originalProduct: any;

  // SUPER_ADMIN passa no gate `data:import` (as demais permissões dependem de
  // dados de RBAC que este ambiente não semeia).
  const token = () =>
    generateAccessToken({
      userId: fixture.userId,
      email: 'super@test.local',
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType: 'SUPER_ADMIN',
    });

  const post = (path: string, body: unknown) =>
    request(app).post(`/api/import${path}`).set('Authorization', `Bearer ${token()}`).send(body as any);

  const productBySku = (sku: string) =>
    bypass<any>(() => prismaUnsafeBypassRLS.product.findFirst({ where: { companyId: fixture.companyId, sku } }));
  const productCount = () => bypass<number>(() => prismaUnsafeBypassRLS.product.count({ where: { companyId: fixture.companyId } }));
  const movementCount = () => bypass<number>(() => prismaUnsafeBypassRLS.stockMovement.count({ where: { companyId: fixture.companyId } }));

  beforeAll(async () => {
    fixture = await createFixture('import-routes');
    app = express();
    app.use(express.json());
    app.use('/api/import', importRoutes);
    // Valores que o "padrão" antigo (0 / 'UN') destruiria.
    await bypass(() =>
      prismaUnsafeBypassRLS.product.update({ where: { id: fixture.productId }, data: { minStock: 7, maxStock: 70, unit: 'CX' } })
    );
    originalProduct = await bypass<any>(() => prismaUnsafeBypassRLS.product.findFirst({ where: { id: fixture.productId } }));
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it('linhas SEM SKU (o template básico da tela) são recusadas e NÃO tocam no primeiro produto da empresa', async () => {
    const before = await productCount();

    const res = await post('/products', {
      products: [
        { name: 'Sem SKU A', price: '99,90', stock: '5' },
        { name: 'Sem SKU B', price: 10 },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toBe(2);
    expect(res.body.details.errors[0].error).toMatch(/SKU/);

    const after = await bypass<any>(() => prismaUnsafeBypassRLS.product.findFirst({ where: { id: fixture.productId } }));
    expect(after.name).toBe(originalProduct.name);
    expect(after.minStock).toBe(7);
    expect(after.maxStock).toBe(70);
    expect(after.unit).toBe('CX');
    expect(Number(after.salePrice)).toBe(Number(originalProduct.salePrice));
    expect(await productCount()).toBe(before);
  });

  it('com SKU: cria usando os nomes que a tela manda (price/stock/category), com aviso de custo e estoque inicial', async () => {
    const movementsBefore = await movementCount();

    const res = await post('/products', {
      products: [{ sku: 'IMP-1', name: 'Óleo 10W40', price: '45,50', stock: '10', category: 'Lubrificantes', barcode: '7891112223334' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toBe(0);
    expect(res.body.details.warnings.map((w: any) => w.warning).join(' ')).toMatch(/Custo não informado/);

    const created = await productBySku('IMP-1');
    expect(created.name).toBe('Óleo 10W40');
    expect(Number(created.salePrice)).toBe(45.5);
    expect(Number(created.costPrice)).toBe(0);
    expect(created.categoryId).toBeTruthy();
    const category = await bypass<any>(() => prismaUnsafeBypassRLS.category.findFirst({ where: { id: created.categoryId } }));
    expect(category.name).toBe('Lubrificantes');
    expect(await movementCount()).toBe(movementsBefore + 1);
  });

  it('atualizar por SKU altera SÓ o que veio na linha (minStock/maxStock/unit existentes ficam intactos)', async () => {
    const before = await productBySku('IMP-1');
    await bypass(() =>
      prismaUnsafeBypassRLS.product.update({ where: { id: before.id }, data: { minStock: 7, maxStock: 70, unit: 'CX' } })
    );

    const res = await post('/products', { products: [{ sku: 'IMP-1', price: 50 }] });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const updated = await productBySku('IMP-1');
    expect(Number(updated.salePrice)).toBe(50);
    expect(updated.name).toBe('Óleo 10W40');
    expect(updated.minStock).toBe(7);
    expect(updated.maxStock).toBe(70);
    expect(updated.unit).toBe('CX');
  });

  it('estoque: linha só com código de barras que não existe é recusada e NENHUM produto tem o saldo alterado', async () => {
    const movementsBefore = await movementCount();

    const res = await post('/stock', { stockItems: [{ barcode: '0000000000000', quantity: 3 }] });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toBe(1);
    expect(res.body.details.errors[0].error).toMatch(/não encontrado/);
    expect(await movementCount()).toBe(movementsBefore);
  });

  it('estoque: linha sem SKU e sem código de barras é recusada', async () => {
    const res = await post('/stock', { stockItems: [{ quantity: 3 }] });
    expect(res.body.errors).toBe(1);
    expect(res.body.details.errors[0].error).toMatch(/SKU ou código de barras/);
  });

  it('estoque: por SKU ajusta o saldo do produto certo; só por código de barras também acha o produto certo', async () => {
    const bySku = await post('/stock', { stockItems: [{ sku: originalProduct.sku, quantity: 990 }] });
    expect(bySku.body.imported).toBe(1);
    expect(bySku.body.details.imported[0]).toMatchObject({ sku: originalProduct.sku, oldQuantity: 1000, newQuantity: 990 });

    const byBarcode = await post('/stock', { stockItems: [{ barcode: '7891112223334', quantity: 4 }] });
    expect(byBarcode.body.imported).toBe(1);
    expect(byBarcode.body.details.imported[0]).toMatchObject({ sku: 'IMP-1', oldQuantity: 10, newQuantity: 4 });
  });

  it('clientes: aceita `zipcode` (nome da tela), descarta strings vazias e recusa e-mail inválido', async () => {
    const res = await post('/customers', {
      customers: [
        { name: 'Cliente Import', document: '999.111.222-71', zipcode: '01000-000', email: '', phone: '' },
        { name: 'Email Ruim', email: 'nao-e-email' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toBe(1);
    expect(res.body.details.errors[0].error).toMatch(/email/);

    const customer = await bypass<any>(() =>
      prismaUnsafeBypassRLS.customer.findFirst({ where: { companyId: fixture.companyId, document: '999.111.222-71' } })
    );
    expect(customer.zipCode).toBe('01000-000');
    expect(customer.email).toBeNull();
    expect(customer.phone).toBeNull();
  });

  it('clientes: "atualizar" por documento sem coluna de nome altera só o telefone; cliente novo sem nome é recusado', async () => {
    const res = await post('/customers', {
      customers: [
        { document: '999.111.222-71', phone: '(11) 98765-4321' },
        { phone: '(11) 90000-0000' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toBe(1);
    expect(res.body.details.errors[0].error).toMatch(/Nome é obrigatório/);

    const customer = await bypass<any>(() =>
      prismaUnsafeBypassRLS.customer.findFirst({ where: { companyId: fixture.companyId, document: '999.111.222-71' } })
    );
    expect(customer.name).toBe('Cliente Import');
    expect(customer.phone).toBe('(11) 98765-4321');
    expect(customer.zipCode).toBe('01000-000');
  });
});
