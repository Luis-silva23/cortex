import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * REFERÊNCIA CRUZADA ENTRE EMPRESAS EM `product_barcodes` E `product_images` (Postgres real, papel da aplicação com RLS).
 * Antes: a FK era só (productId) → products(id) e a RLS da linha filha só olha o `companyId` DA PRÓPRIA LINHA. A checagem de FK do PostgreSQL
 * não passa pela RLS, então uma sessão da empresa A conseguia gravar `(companyId = A, productId = <produto da empresa B>)`: a linha ficava
 * "da A" apontando para o produto da B (e, com ON DELETE CASCADE/RESTRICT, passava a travar ou apagar junto com o produto da B).
 * Agora: FK composta (companyId, productId) → products(companyId, id), alvo da chave única composta `products_companyId_id_key`.
 */
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

// PNG 1×1 válido de verdade não é necessário aqui (a tabela só confere mime/tamanho/dimensões); bytes sintéticos bastam para a restrição.
const fakeImage = (companyId: string, productId: string) => ({
  companyId,
  productId,
  mimeType: 'image/png',
  byteSize: 8,
  width: 1,
  height: 1,
  sha256: 'a'.repeat(64),
  data: Buffer.from('synthetic'),
});

describe('product_barcodes / product_images: o produto tem que ser da MESMA empresa da linha (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  const barcodeIds: string[] = [];
  const imageIds: string[] = [];
  const stamp = Date.now();

  beforeAll(async () => {
    A = await createFixture('pcsA');
    B = await createFixture('pcsB');
  });

  afterAll(async () => {
    if (barcodeIds.length && A && B) {
      await bypass(() => db.productBarcode.deleteMany({ where: { id: { in: barcodeIds }, companyId: { in: [A.companyId, B.companyId] } } }));
    }
    if (imageIds.length && A && B) {
      await bypass(() => db.productImage.deleteMany({ where: { id: { in: imageIds }, companyId: { in: [A.companyId, B.companyId] } } }));
    }
    if (A) await destroyFixture(A);
    if (B) await destroyFixture(B);
  });

  it('estrutura: FKs compostas existem, as FKs simples antigas saíram e há chave única (companyId, id) em products', async () => {
    const rows = await bypass<Array<{ conname: string; def: string }>>(() =>
      db.$queryRawUnsafe(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('product_barcodes'::regclass, 'product_images'::regclass)`
      )
    );
    const defs = rows.map((r) => r.def.replace(/\s+/g, ' '));
    expect(defs.some((d) => /FOREIGN KEY \("companyId", "productId"\) REFERENCES products\("companyId", id\)/.test(d))).toBe(true);
    expect(defs.filter((d) => /FOREIGN KEY \("companyId", "productId"\)/.test(d))).toHaveLength(2); // uma em cada tabela
    expect(defs.some((d) => /^FOREIGN KEY \("productId"\) REFERENCES products\(id\)/.test(d))).toBe(false);
    const idx = await bypass<Array<{ n: number }>>(() =>
      db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'products_companyId_id_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%'`)
    );
    expect(idx[0].n).toBe(1);
  });

  it('INSERT cruzado: a empresa A NÃO consegue gravar código de barras apontando para o produto da empresa B', async () => {
    await expect(
      asCompany(A.companyId, () => prisma.productBarcode.create({ data: { companyId: A.companyId, productId: B.productId, code: `X-${stamp}-1` } }))
    ).rejects.toMatchObject({ code: 'P2003' });
    const leaked = await bypass<any[]>(() => db.productBarcode.findMany({ where: { companyId: A.companyId, productId: B.productId } }));
    expect(leaked).toHaveLength(0);
  });

  it('INSERT cruzado: a empresa A NÃO consegue gravar imagem apontando para o produto da empresa B', async () => {
    await expect(asCompany(A.companyId, () => prisma.productImage.create({ data: fakeImage(A.companyId, B.productId) }))).rejects.toMatchObject({ code: 'P2003' });
    const leaked = await bypass<any[]>(() => db.productImage.findMany({ where: { companyId: A.companyId, productId: B.productId } }));
    expect(leaked).toHaveLength(0);
  });

  it('INSERT legítimo continua funcionando (mesma empresa) — código de barras e imagem', async () => {
    const bc = await asCompany(A.companyId, () => prisma.productBarcode.create({ data: { companyId: A.companyId, productId: A.productId, code: `OK-${stamp}-A` } }));
    barcodeIds.push(bc.id);
    const img = await asCompany(A.companyId, () => prisma.productImage.create({ data: fakeImage(A.companyId, A.productId) }));
    imageIds.push(img.id);
    expect(bc.productId).toBe(A.productId);
    expect(img.productId).toBe(A.productId);
  });

  it('UPDATE cruzado: mover o código/imagem da A para o produto da B é recusado, e a linha não muda', async () => {
    const bc = await bypass<any>(() => db.productBarcode.findFirst({ where: { id: { in: barcodeIds }, companyId: A.companyId } }));
    await expect(asCompany(A.companyId, () => prisma.productBarcode.update({ where: { id: bc.id }, data: { productId: B.productId } }))).rejects.toMatchObject({ code: 'P2003' });
    const img = await bypass<any>(() => db.productImage.findFirst({ where: { id: { in: imageIds }, companyId: A.companyId } }));
    await expect(asCompany(A.companyId, () => prisma.productImage.update({ where: { id: img.id }, data: { productId: B.productId } }))).rejects.toMatchObject({ code: 'P2003' });
    // trocar o companyId da linha para o da B também não escapa: a RLS (WITH CHECK) recusa antes mesmo da FK
    await expect(asCompany(A.companyId, () => prisma.productBarcode.update({ where: { id: bc.id }, data: { companyId: B.companyId } }))).rejects.toBeTruthy();
    const after = await bypass<any>(() => db.productBarcode.findUnique({ where: { id: bc.id } }));
    expect(after.companyId).toBe(A.companyId);
    expect(after.productId).toBe(A.productId);
  });

  it('leitura: a empresa B não enxerga as linhas da A (RLS segue valendo)', async () => {
    const seenByB = await asCompany(B.companyId, () => prisma.productBarcode.findMany({ where: { id: { in: barcodeIds } } }));
    expect(seenByB).toHaveLength(0);
    const imgSeenByB = await asCompany(B.companyId, () => prisma.productImage.findMany({ where: { id: { in: imageIds } } }));
    expect(imgSeenByB).toHaveLength(0);
  });

  it('DELETE: apagar o produto com código de barras é RESTRICT; com imagem é CASCADE (regras anteriores preservadas)', async () => {
    // produto próprio com os dois filhos, criado só para este caso
    const p = await bypass<any>(() =>
      db.product.create({ data: { companyId: A.companyId, sku: `PCS-${stamp}`, name: 'Produto PCS', costPrice: 1, salePrice: 2, isActive: true } })
    );
    const bc = await asCompany(A.companyId, () => prisma.productBarcode.create({ data: { companyId: A.companyId, productId: p.id, code: `DEL-${stamp}` } }));
    const img = await asCompany(A.companyId, () => prisma.productImage.create({ data: fakeImage(A.companyId, p.id) }));
    barcodeIds.push(bc.id);
    imageIds.push(img.id);
    // código de barras segura (RESTRICT): dentro do lote do `bypass` o erro vem como PrismaClientUnknownRequestError com o texto do PostgreSQL
    await expect(bypass(() => db.product.delete({ where: { id: p.id } }))).rejects.toThrow(/violates RESTRICT setting of foreign key constraint \W*product_barcodes_companyId_productId_fkey/);
    await bypass(() => db.productBarcode.delete({ where: { id: bc.id } }));
    await bypass(() => db.product.delete({ where: { id: p.id } }));
    const imgLeft = await bypass<any[]>(() => db.productImage.findMany({ where: { id: img.id } }));
    expect(imgLeft).toHaveLength(0); // a imagem foi junto (CASCADE)
  });

  it('dados existentes: nenhuma linha de nenhuma das duas tabelas aponta para produto de outra empresa', async () => {
    const r = await bypass<Array<{ n: number }>>(() =>
      db.$queryRawUnsafe(
        `SELECT (SELECT count(*) FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId")::int
              + (SELECT count(*) FROM product_images i JOIN products p ON p.id = i."productId" WHERE p."companyId" <> i."companyId")::int AS n`
      )
    );
    expect(r[0].n).toBe(0);
  });
});
