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
 * VÁRIOS CÓDIGOS DE BARRAS POR PRODUTO (integração real, RLS ligada). Provas: vários códigos resolvem o MESMO produto; zeros à
 * esquerda preservados (texto); um código = um produto (409 BARCODE_IN_USE em criar, editar, adicionar e importar); desativar
 * tira da leitura sem apagar histórico; trocar o principal desativa o anterior; permissões e isolamento entre empresas;
 * a identidade do produto (id, SKU) não muda por causa dos códigos.
 */
describe('Códigos de barras múltiplos por produto (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const created: Array<{ companyId: string; id: string }> = [];

  const tok = (f: IntegrationFixture, userType: string) =>
    generateAccessToken({ userId: f.userId, email: `${userType.toLowerCase()}@test.local`, companyId: f.companyId, branchId: f.branchId as any, userType });
  const as = (f: IntegrationFixture, userType: string) => ({ Authorization: `Bearer ${tok(f, userType)}` });
  const admin = (f: IntegrationFixture) => as(f, 'COMPANY_ADMIN');
  const scan = (f: IntegrationFixture, code: string) => request(app).get(`/api/products/search/${encodeURIComponent(code)}`).set(as(f, 'OPERATOR'));
  const newProduct = async (f: IntegrationFixture, label: string, barcode?: string) => {
    const r = await request(app)
      .post('/api/products')
      .set(admin(f))
      .send({ sku: `BC-${stamp}-${label}`, name: `Produto barras ${label}`, costPrice: 5, salePrice: 10, unit: 'UN', ...(barcode !== undefined ? { barcode } : {}) });
    if (r.status === 201) created.push({ companyId: f.companyId, id: r.body.id });
    return r;
  };

  beforeAll(async () => {
    A = await createFixture('barcodesA');
    B = await createFixture('barcodesB');
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
      const ids = created.filter((c) => c.companyId === f.companyId).map((c) => c.id);
      await bypass(() => db.productBarcode.deleteMany({ where: { companyId: f.companyId, productId: { in: ids } } }));
      await bypass(() => db.product.deleteMany({ where: { companyId: f.companyId, id: { in: ids } } }));
      await destroyFixture(f);
    }
  });

  it('criar produto com código de barras: texto preservado (zeros à esquerda), vira o principal e aparece na lista de códigos', async () => {
    const r = await newProduct(A, 'zeros', '0001234567890');
    expect(r.status).toBe(201);
    expect(r.body.barcode).toBe('0001234567890');
    const list = await request(app).get(`/api/products/${r.body.id}/barcodes`).set(as(A, 'OPERATOR'));
    expect(list.status).toBe(200);
    expect(list.body.barcodes).toEqual([expect.objectContaining({ code: '0001234567890', isActive: true, isPrimary: true })]);
    const read = await scan(A, '0001234567890');
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(r.body.id);
    expect((await scan(A, '1234567890')).status).toBe(404); // sem os zeros NÃO é o mesmo código
  });

  it('vários códigos para o mesmo produto: todos resolvem o MESMO produto; id e SKU não mudam', async () => {
    const p = await newProduct(A, 'multi', '7891000100001');
    expect(p.status).toBe(201);
    const add = await request(app).post(`/api/products/${p.body.id}/barcodes`).set(admin(A)).send({ code: '7891000100002' });
    expect(add.status).toBe(201);
    expect(add.body.barcode).toMatchObject({ code: '7891000100002', isActive: true });
    const add3 = await request(app).post(`/api/products/${p.body.id}/barcodes`).set(admin(A)).send({ code: '00012345' });
    expect(add3.status).toBe(201);
    for (const code of ['7891000100001', '7891000100002', '00012345']) {
      const r = await scan(A, code);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(p.body.id);
      expect(r.body.sku).toBe(p.body.sku);
    }
    const detail = await request(app).get(`/api/products/${p.body.id}`).set(as(A, 'OPERATOR'));
    expect(detail.body.barcode).toBe('7891000100001'); // principal continua o primeiro
    // a busca textual também acha pelo código secundário
    const search = await request(app).get('/api/products').query({ search: '00012345' }).set(as(A, 'OPERATOR'));
    expect(search.body.products.map((x: any) => x.id)).toContain(p.body.id);
  });

  it('um código = um produto: criar, editar e adicionar com código de OUTRO produto → 409 BARCODE_IN_USE, nada é gravado', async () => {
    const owner = await newProduct(A, 'owner', '7892000200001');
    const other = await newProduct(A, 'other');
    expect(other.status).toBe(201);

    const dupCreate = await newProduct(A, 'dup', '7892000200001');
    expect(dupCreate.status).toBe(409);
    expect(dupCreate.body.code).toBe('BARCODE_IN_USE');
    expect(await bypass<any[]>(() => db.product.findMany({ where: { companyId: A.companyId, sku: `BC-${stamp}-dup` } }))).toHaveLength(0);

    const dupEdit = await request(app).put(`/api/products/${other.body.id}`).set(admin(A)).send({ barcode: '7892000200001' });
    expect(dupEdit.status).toBe(409);
    expect(dupEdit.body.code).toBe('BARCODE_IN_USE');
    expect((await bypass<any>(() => db.product.findUnique({ where: { id: other.body.id } }))).barcode).toBeNull();

    const dupAdd = await request(app).post(`/api/products/${other.body.id}/barcodes`).set(admin(A)).send({ code: '7892000200001' });
    expect(dupAdd.status).toBe(409);
    expect(dupAdd.body.code).toBe('BARCODE_IN_USE');

    expect((await scan(A, '7892000200001')).body.id).toBe(owner.body.id); // continua do dono
  });

  it('desativar tira o código da leitura sem apagar nada; reativar devolve; o principal desativado passa para o próximo', async () => {
    const p = await newProduct(A, 'toggle', '7893000300001');
    const second = await request(app).post(`/api/products/${p.body.id}/barcodes`).set(admin(A)).send({ code: '7893000300002' });
    const rows = (await request(app).get(`/api/products/${p.body.id}/barcodes`).set(admin(A))).body.barcodes;
    const primary = rows.find((r: any) => r.isPrimary);
    expect(primary.code).toBe('7893000300001');

    const off = await request(app).patch(`/api/products/${p.body.id}/barcodes/${primary.id}`).set(admin(A)).send({ isActive: false });
    expect(off.status).toBe(200);
    expect((await scan(A, '7893000300001')).status).toBe(404); // desativado não lê
    expect((await scan(A, '7893000300002')).body.id).toBe(p.body.id);
    expect((await bypass<any>(() => db.product.findUnique({ where: { id: p.body.id } }))).barcode).toBe('7893000300002'); // novo principal
    // histórico preservado: a linha continua lá, inativa
    expect(await bypass<any[]>(() => db.productBarcode.findMany({ where: { id: primary.id, isActive: false } }))).toHaveLength(1);

    const on = await request(app).patch(`/api/products/${p.body.id}/barcodes/${primary.id}`).set(admin(A)).send({ isActive: true });
    expect(on.status).toBe(200);
    expect((await scan(A, '7893000300001')).body.id).toBe(p.body.id);
    expect(second.status).toBe(201);
    expect((await request(app).patch(`/api/products/${p.body.id}/barcodes/${primary.id}`).set(admin(A)).send({})).status).toBe(400);
  });

  it('trocar o código principal na edição desativa o anterior (histórico) e o produto segue o mesmo (id e SKU)', async () => {
    const p = await newProduct(A, 'swap', '7894000400001');
    const upd = await request(app).put(`/api/products/${p.body.id}`).set(admin(A)).send({ barcode: '7894000400009' });
    expect(upd.status).toBe(200);
    expect(upd.body.id).toBe(p.body.id);
    expect(upd.body.sku).toBe(p.body.sku);
    expect((await scan(A, '7894000400009')).body.id).toBe(p.body.id);
    expect((await scan(A, '7894000400001')).status).toBe(404);
    const rows = (await request(app).get(`/api/products/${p.body.id}/barcodes`).set(admin(A))).body.barcodes;
    expect(rows.map((r: any) => [r.code, r.isActive]).sort()).toEqual([['7894000400001', false], ['7894000400009', true]]);
  });

  it('duplicata LEGADA (só em products.barcode, sem linha na tabela) segue ambígua: 409 CODE_AMBIGUOUS, nunca um produto ao acaso', async () => {
    const code = `LEG-${stamp}`;
    const first = await newProduct(A, 'legA', code);
    expect(first.status).toBe(201);
    const legacy = await bypass<any>(() =>
      db.product.create({ data: { companyId: A.companyId, sku: `BC-${stamp}-legB`, name: 'Legado duplicado', barcode: code, costPrice: 1, salePrice: 2, unit: 'UN', isActive: true } })
    );
    created.push({ companyId: A.companyId, id: legacy.id });
    const r = await scan(A, code);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CODE_AMBIGUOUS');
  });

  it('entrada inválida: vazio, só espaços e maior que 64 caracteres → 400 BARCODE_INVALID', async () => {
    const p = await newProduct(A, 'invalid');
    for (const code of ['', '   ', 'x'.repeat(65)]) {
      const r = await request(app).post(`/api/products/${p.body.id}/barcodes`).set(admin(A)).send({ code });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('BARCODE_INVALID');
    }
    expect((await request(app).post(`/api/products/${p.body.id}/barcodes`).set(admin(A)).send({})).status).toBe(400);
  });

  it('permissões e empresa: atendente/visualizador não escrevem (403); leitura ok; outra empresa não vê nem altera (404) e pode usar o MESMO texto no seu cadastro', async () => {
    const p = await newProduct(A, 'perm', '7895000500001');
    for (const role of ['OPERATOR', 'MECHANIC', 'VIEWER']) {
      const w = await request(app).post(`/api/products/${p.body.id}/barcodes`).set(as(A, role)).send({ code: '7895000500002' });
      expect(w.status).toBe(403);
    }
    expect((await request(app).get(`/api/products/${p.body.id}/barcodes`).set(as(A, 'VIEWER'))).status).toBe(200);
    expect((await scan(A, '7895000500002')).status).toBe(404); // nada foi gravado

    // empresa B: produto de A não existe para ela
    expect((await request(app).get(`/api/products/${p.body.id}/barcodes`).set(admin(B))).status).toBe(404);
    expect((await request(app).post(`/api/products/${p.body.id}/barcodes`).set(admin(B)).send({ code: '7895000500003' })).status).toBe(404);
    const rowsBefore = await bypass<any[]>(() => db.productBarcode.findMany({ where: { productId: p.body.id } }));
    expect(rowsBefore).toHaveLength(1);
    // o mesmo texto em OUTRA empresa é outro cadastro
    const b = await newProduct(B, 'same', '7895000500001');
    expect(b.status).toBe(201);
    expect((await scan(B, '7895000500001')).body.id).toBe(b.body.id);
    expect((await scan(A, '7895000500001')).body.id).toBe(p.body.id);
  });

  it('importação: prévia aponta o conflito de código e não grava; a linha válida preserva zeros e passa a ler pelo código', async () => {
    const owner = await newProduct(A, 'impowner', '7896000600001');
    expect(owner.status).toBe(201);
    const payload = {
      products: [
        { sku: `BC-${stamp}-imp1`, name: 'Importado conflito', price: 12, barcode: '7896000600001' },
        { sku: `BC-${stamp}-imp2`, name: 'Importado zeros', price: 15, barcode: '0007896000600002' },
      ],
    };
    const preview = await request(app).post('/api/import/products').query({ dryRun: 'true' }).set(admin(A)).send(payload);
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.errors).toBe(1);
    expect(preview.body.details.errors[0].error).toMatch(/já pertence ao produto/);
    expect(await bypass<any[]>(() => db.product.findMany({ where: { companyId: A.companyId, sku: { in: [`BC-${stamp}-imp1`, `BC-${stamp}-imp2`] } } }))).toHaveLength(0);

    const real = await request(app).post('/api/import/products').set(admin(A)).set('Idempotency-Key', `imp-${stamp}`).send(payload);
    expect(real.status).toBe(200);
    expect(real.body.imported).toBe(1);
    expect(real.body.errors).toBe(1);
    const imported = await bypass<any>(() => db.product.findFirst({ where: { companyId: A.companyId, sku: `BC-${stamp}-imp2` } }));
    created.push({ companyId: A.companyId, id: imported.id });
    expect(imported.barcode).toBe('0007896000600002');
    expect((await scan(A, '0007896000600002')).body.id).toBe(imported.id);
    // o dono do código conflitante não foi tocado
    expect((await scan(A, '7896000600001')).body.id).toBe(owner.body.id);
  });
});
