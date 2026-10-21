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
 * Importação rastreável (import.service.ts): lote com o resultado de cada linha, simulação sem gravar, duplicidade
 * na planilha, CPF/CNPJ por dígitos, produto + estoque inicial na mesma transação, filial validada, limite de linhas,
 * auditoria com resumo. Banco real.
 */
describe('Importação em lote: lote rastreável, simulação e consistência (integração real)', () => {
  let fixture: IntegrationFixture;
  let other: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now().toString(36).toUpperCase();
  const token = (userType: string, branchId?: string) =>
    `Bearer ${generateAccessToken({ userId: fixture.userId, email: 'imp@test.local', companyId: fixture.companyId, branchId, userType })}`;
  const branchAdmin = () => token('COMPANY_ADMIN', fixture.branchId);
  const companyAdmin = () => token('COMPANY_ADMIN'); // sem filial no token
  const post = (path: string, body: object, auth = branchAdmin()) => request(app).post(`/api/import${path}`).set('Authorization', auth).send(body);
  const products = (sku: string) => bypass<any[]>(() => db.product.findMany({ where: { companyId: fixture.companyId, sku } }));
  const batches = () => bypass<any[]>(() => db.importBatch.findMany({ where: { companyId: fixture.companyId } }));

  beforeAll(async () => {
    fixture = await createFixture('impbatch');
    other = await createFixture('impbatch-other');
    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    for (const f of [fixture, other]) if (f) await destroyFixture(f);
  });

  it('simulação (dryRun): devolve o plano por linha e NÃO grava nada (nem produto, nem movimento, nem lote)', async () => {
    const before = await batches();
    const res = await post('/products?dryRun=true', { products: [{ sku: `SIM-${stamp}`, name: 'Simulado', price: 10, stock: 5 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, batchId: null, imported: 1, errors: 0 });
    expect(res.body.results[0]).toMatchObject({ row: 2, key: `SIM-${stamp}`, action: 'CREATED' });
    expect(await products(`SIM-${stamp}`)).toHaveLength(0);
    expect(await batches()).toHaveLength(before.length);
  });

  it('importação real: lote com o resultado de cada linha, movimento de estoque apontando para o lote, auditoria com resumo', async () => {
    auditSpy.mockClear();
    const sku = `LOT-${stamp}`;
    const res = await post('/products', { fileName: 'catalogo.xlsx', products: [{ sku, name: 'Produto lote', price: 20, stock: 7 }, { name: 'Sem SKU' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, errors: 1 });
    expect(res.body.details.errors[0]).toMatchObject({ row: 3, index: 3 });

    const batch = await bypass<any>(() => db.importBatch.findUnique({ where: { id: res.body.batchId } }));
    expect(batch).toMatchObject({ type: 'PRODUCTS', fileName: 'catalogo.xlsx', totalRows: 2, importedRows: 1, failedRows: 1, userId: fixture.userId });
    expect(batch.results.map((r: any) => [r.row, r.action])).toEqual([[2, 'CREATED'], [3, 'ERROR']]);

    const [product] = await products(sku);
    const movement = await bypass<any>(() => db.stockMovement.findFirst({ where: { productId: product.id } }));
    expect(movement).toMatchObject({ referenceType: 'ImportBatch', referenceId: res.body.batchId, branchId: fixture.branchId });
    expect(Number(movement.quantity)).toBe(7);

    const listed = await request(app).get('/api/import/batches').set('Authorization', branchAdmin());
    expect(listed.body.batches.map((b: any) => b.id)).toContain(res.body.batchId);
    const detail = await request(app).get(`/api/import/batches/${res.body.batchId}`).set('Authorization', branchAdmin());
    expect(detail.body.results).toHaveLength(2);

    const audit = JSON.stringify(auditSpy.mock.calls);
    expect(audit).toContain(res.body.batchId);
    expect(audit).not.toContain('Produto lote'); // resumo, não o corpo com todos os registros
  });

  it('SKU repetido NA PLANILHA: a segunda ocorrência é recusada apontando a primeira linha', async () => {
    const sku = `DUP-${stamp}`;
    const res = await post('/products', { products: [{ sku, name: 'A', price: 1 }, { sku, name: 'B', price: 2 }] });
    expect(res.body).toMatchObject({ imported: 1, errors: 1 });
    expect(res.body.details.errors[0].error).toMatch(/repetido na planilha \(primeira ocorrência na linha 2\)/);
    const [p] = await products(sku);
    expect(p.name).toBe('A');
  });

  it('estoque inicial sem filial: a LINHA inteira é recusada e o produto NÃO fica criado (mesma transação)', async () => {
    const sku = `NOBR-${stamp}`;
    const res = await post('/products', { products: [{ sku, name: 'Sem filial', price: 5, stock: 3 }] }, companyAdmin());
    expect(res.body).toMatchObject({ imported: 0, errors: 1 });
    expect(res.body.details.errors[0].error).toMatch(/Informe a filial/);
    expect(await products(sku)).toHaveLength(0);
  });

  it('administrador sem filial no token escolhe a filial DA EMPRESA; filial de outra empresa é recusada', async () => {
    const sku = `CABR-${stamp}`;
    const ok = await post('/products', { branchId: fixture.branchId, products: [{ sku, name: 'Com filial', price: 5, stock: 2 }] }, companyAdmin());
    expect(ok.body.imported).toBe(1);
    const foreign = await post('/stock', { branchId: other.branchId, stockItems: [{ sku, quantity: 9 }] }, companyAdmin());
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const stock = await post('/stock', { branchId: fixture.branchId, stockItems: [{ sku, quantity: 9 }] }, companyAdmin());
    expect(stock.body.results[0]).toMatchObject({ action: 'UPDATED', detail: { oldQuantity: 2, newQuantity: 9 } });
  });

  it('clientes: CPF com ou sem máscara é o mesmo cliente (atualiza, não duplica); CPF inválido e CPF repetido na planilha são recusados', async () => {
    const first = await post('/customers', { customers: [{ name: 'Maria Import', document: '529.982.247-25' }] });
    expect(first.body.imported).toBe(1);
    const again = await post('/customers', { customers: [{ document: '52998224725', phone: '(11) 91234-5678' }] });
    expect(again.body.results[0].action).toBe('UPDATED');
    const matches = await bypass<any[]>(() => db.customer.findMany({ where: { companyId: fixture.companyId, name: 'Maria Import' } }));
    expect(matches).toHaveLength(1);
    expect(matches[0].phone).toBe('(11) 91234-5678');

    const bad = await post('/customers', { customers: [{ name: 'CPF errado', document: '123.456.789-00' }, { name: 'X', document: '111.444.777-35' }, { name: 'Y', document: '11144477735' }] });
    expect(bad.body.results.map((r: any) => r.action)).toEqual(['ERROR', 'CREATED', 'ERROR']);
    expect(bad.body.results[0].error).toMatch(/CPF\/CNPJ inválido/);
    expect(bad.body.results[2].error).toMatch(/repetido na planilha/);
  });

  it('limite: mais de 5000 linhas é recusado antes de processar (413)', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ sku: `BIG-${i}`, name: 'x', price: 1 }));
    const res = await post('/products', { products: rows });
    expect(res.status).toBe(413);
    expect(res.body.error ?? res.body.message).toMatch(/máximo por importação é 5000/);
  });

  it('sem a permissão data:import (operador): 403', async () => {
    const res = await post('/products', { products: [{ sku: 'X', name: 'X', price: 1 }] }, token('OPERATOR', fixture.branchId));
    expect(res.status).toBe(403);
  });
});
