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
 * LEITURA DE CÓDIGO (`GET /api/products/search/:code`, usado pelo PDV e pelo Balcão ao ler SKU/código de barras): o código tem
 * de resolver para UM produto. Antes a consulta era `findFirst` com `OR(sku, barcode)` sem ordem: um código que era o SKU de um
 * produto e o código de barras de outro devolvia um dos dois ao acaso (venda do produto errado, com o preço e o estoque errados),
 * e dois produtos ativos com o mesmo código de barras idem. Agora: ambiguidade entre produtos ATIVOS recusa (409 CODE_AMBIGUOUS);
 * ativo vence inativo; sem ambiguidade, o produto certo. A identidade do produto (id e SKU da empresa) não depende do código lido.
 */
describe('Resolução de SKU/código de barras (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const created: string[] = [];

  const auth = (f: IntegrationFixture) => ({
    Authorization: `Bearer ${generateAccessToken({ userId: f.userId, email: 'op@test.local', companyId: f.companyId, branchId: f.branchId as any, userType: 'OPERATOR' })}`,
  });
  const mk = async (f: IntegrationFixture, data: { sku: string; barcode?: string | null; name: string; isActive?: boolean }) => {
    const p = await bypass<any>(() =>
      db.product.create({
        data: { companyId: f.companyId, sku: data.sku, barcode: data.barcode ?? null, name: data.name, costPrice: 5, salePrice: 10, unit: 'UN', isActive: data.isActive ?? true },
      })
    );
    created.push(p.id);
    return p;
  };
  const scan = (f: IntegrationFixture, code: string) => request(app).get(`/api/products/search/${encodeURIComponent(code)}`).set(auth(f));

  beforeAll(async () => {
    A = await createFixture('codesA');
    B = await createFixture('codesB');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    for (const f of [A, B]) {
      if (f?.companyId) await bypass(() => db.product.deleteMany({ where: { companyId: f.companyId, id: { in: created } } }));
    }
    for (const f of [A, B]) if (f?.companyId) await destroyFixture(f);
  });

  it('código único: SKU exato e código de barras exato resolvem o MESMO produto', async () => {
    const p = await mk(A, { sku: `SKU-${stamp}-1`, barcode: `789${stamp}1`, name: 'Pastilha única' });
    const bySku = await scan(A, p.sku);
    const byBar = await scan(A, p.barcode);
    expect(bySku.status).toBe(200);
    expect(byBar.status).toBe(200);
    expect(bySku.body.id).toBe(p.id);
    expect(byBar.body.id).toBe(p.id);
  });

  it('o mesmo texto como SKU de um produto e código de barras de OUTRO é ambíguo: recusa (409), não escolhe ao acaso', async () => {
    const code = `COD-${stamp}-2`;
    await mk(A, { sku: code, name: 'Produto cujo SKU é o código' });
    await mk(A, { sku: `SKU-${stamp}-2b`, barcode: code, name: 'Produto cujo código de barras é o mesmo texto' });
    const r = await scan(A, code);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CODE_AMBIGUOUS');
  });

  it('dois produtos ATIVOS com o mesmo código de barras: recusa (409)', async () => {
    const code = `789${stamp}3`;
    await mk(A, { sku: `SKU-${stamp}-3a`, barcode: code, name: 'Duplicado A' });
    await mk(A, { sku: `SKU-${stamp}-3b`, barcode: code, name: 'Duplicado B' });
    const r = await scan(A, code);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CODE_AMBIGUOUS');
  });

  it('ativo vence inativo com o mesmo código; só inativo devolve o inativo (o PDV avisa que está inativo)', async () => {
    const code = `789${stamp}4`;
    const inactive = await mk(A, { sku: `SKU-${stamp}-4a`, barcode: code, name: 'Antigo', isActive: false });
    const active = await mk(A, { sku: `SKU-${stamp}-4b`, barcode: code, name: 'Atual' });
    expect((await scan(A, code)).body.id).toBe(active.id);

    const onlyInactive = await mk(A, { sku: `SKU-${stamp}-4c`, barcode: `789${stamp}5`, name: 'Só inativo', isActive: false });
    const r = await scan(A, onlyInactive.barcode);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(onlyInactive.id);
    expect(r.body.isActive).toBe(false);
    expect(inactive.id).not.toBe(active.id);
  });

  it('o código de OUTRA empresa não resolve; mesmo texto em empresas diferentes resolve cada um no seu tenant', async () => {
    const code = `789${stamp}6`;
    const pa = await mk(A, { sku: `SKU-${stamp}-6a`, barcode: code, name: 'Tenant A' });
    const pb = await mk(B, { sku: `SKU-${stamp}-6b`, barcode: code, name: 'Tenant B' });
    expect((await scan(A, code)).body.id).toBe(pa.id);
    expect((await scan(B, code)).body.id).toBe(pb.id);
    const only = await mk(B, { sku: `SKU-${stamp}-6c`, name: 'Só do B' });
    expect((await scan(A, only.sku)).status).toBe(404);
  });

  it('código inexistente → 404', async () => {
    expect((await scan(A, `NAO-EXISTE-${stamp}`)).status).toBe(404);
  });
});
