import { createHash } from 'crypto';
import { deflateSync } from 'zlib';
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
 * DECISÃO 122 — imagem OPCIONAL do produto (PostgreSQL real, duas empresas).
 * Prova: produto sem imagem segue igual; upload válido guarda a imagem SANEADA (sem EXIF); troca substitui (uma linha); remoção; formato
 * inválido, polígloto, grande demais e base64 ruim são recusados; empresa B não vê, não troca nem apaga a imagem da empresa A; só Gerência+
 * escreve; a entrega é inerte (tipo fixo, nosniff, sandbox).
 */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, tail]);
};
const png = (shade = 0, extra: Buffer[] = [], trailing?: Buffer) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.from([0, shade, shade, shade, shade, shade, shade, 0, shade, shade, shade, shade, shade, shade]))),
    chunk('IEND'),
    ...(trailing ? [trailing] : []),
  ]);
};
const seg = (marker: number, data: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
};
const jpegWithExif = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPS-LATITUDE-23.55S', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34]),
    Buffer.from([0xff, 0xd9]),
  ]);
const b64 = (b: Buffer) => b.toString('base64');

describe('Imagem opcional do produto (decisão 122)', () => {
  let A: IntegrityFixture;
  let B: IntegrityFixture;
  type IntegrityFixture = IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const tok = (userType: string, fx: IntegrationFixture) => `Bearer ${generateAccessToken({ userId: fx.userId, email: 'u@test.local', userType, companyId: fx.companyId, branchId: fx.branchId })}`;
  const admin = () => tok('COMPANY_ADMIN', A);
  const adminB = () => tok('COMPANY_ADMIN', B);
  const put = (productId: string, auth: string, body: unknown) => request(app).put(`/api/products/${productId}/image`).set('Authorization', auth).send(body as object);
  const mkProduct = (fx: IntegrationFixture, label: string) =>
    bypass<any>(() => db.product.create({ data: { companyId: fx.companyId, branchId: fx.branchId, sku: `IMG-${stamp}-${label}`, name: `Produto imagem ${label}`, costPrice: 5, salePrice: 10, isActive: true } }));

  beforeAll(async () => {
    A = await createFixture('imgA');
    B = await createFixture('imgB');
    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 60000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (A?.companyId) await destroyFixture(A);
    if (B?.companyId) await destroyFixture(B);
  }, 60000);

  it('produto SEM imagem: cadastro, edição e leitura funcionam como antes; a imagem simplesmente não existe', async () => {
    const created = await request(app).post('/api/products').set('Authorization', admin()).send({ sku: `IMG-${stamp}-sem`, name: 'Produto sem foto', costPrice: 5, salePrice: 10, unit: 'UN' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).put(`/api/products/${id}`).set('Authorization', admin()).send({ name: 'Produto sem foto (editado)' })).status).toBe(200);
    expect((await request(app).get(`/api/products/${id}`).set('Authorization', admin())).status).toBe(200);
    const meta = await request(app).get(`/api/products/${id}/image/meta`).set('Authorization', admin());
    expect(meta.status).toBe(200);
    expect(meta.body.image).toBeNull();
    const img = await request(app).get(`/api/products/${id}/image`).set('Authorization', admin());
    expect(img.status).toBe(404);
    expect(img.body.code).toBe('IMAGE_NOT_FOUND');
  });

  it('upload válido: guarda a imagem SANEADA (mesmo PNG, sem blocos de texto) e entrega inerte, com ETag e 304', async () => {
    const p = await mkProduct(A, 'ok');
    const original = png(10, [chunk('tEXt', Buffer.from('Author\0Fulano de Tal'))]);
    const res = await put(p.id, admin(), { contentBase64: b64(original) });
    expect(res.status).toBe(200);
    expect(res.body.image).toMatchObject({ mimeType: 'image/png', width: 2, height: 2 });
    const stored = await bypass<any>(() => db.productImage.findUnique({ where: { productId: p.id } }));
    expect(stored.companyId).toBe(A.companyId);
    expect(stored.data.includes(Buffer.from('Fulano de Tal'))).toBe(false); // metadado não foi guardado
    expect(stored.sha256).toBe(createHash('sha256').update(stored.data).digest('hex'));

    const get = await request(app).get(`/api/products/${p.id}/image`).set('Authorization', admin());
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-security-policy']).toContain('sandbox');
    expect(get.headers['content-disposition']).toMatch(/^inline/);
    expect(Buffer.from(get.body).equals(Buffer.from(stored.data))).toBe(true);
    const cached = await request(app).get(`/api/products/${p.id}/image`).set('Authorization', admin()).set('If-None-Match', get.headers.etag);
    expect(cached.status).toBe(304);
  });

  it('JPEG com EXIF/GPS: a localização NÃO é guardada; aceita o prefixo data: da tela', async () => {
    const p = await mkProduct(A, 'jpg');
    const res = await put(p.id, admin(), { contentBase64: `data:image/jpeg;base64,${b64(jpegWithExif())}` });
    expect(res.status).toBe(200);
    expect(res.body.image.mimeType).toBe('image/jpeg');
    const stored = await bypass<any>(() => db.productImage.findUnique({ where: { productId: p.id } }));
    expect(stored.data.includes(Buffer.from('GPS-LATITUDE'))).toBe(false);
  });

  it('substituição: a nova imagem troca a anterior (continua UMA linha) e a remoção apaga', async () => {
    const p = await mkProduct(A, 'troca');
    const first = await put(p.id, admin(), { contentBase64: b64(png(1)) });
    const second = await put(p.id, admin(), { contentBase64: b64(png(200)) });
    expect(first.body.image.sha256).not.toBe(second.body.image.sha256);
    expect(await bypass<number>(() => db.productImage.count({ where: { productId: p.id } }))).toBe(1);
    const get = await request(app).get(`/api/products/${p.id}/image`).set('Authorization', admin());
    expect(get.headers.etag).toBe(`"${second.body.image.sha256}"`);
    const del = await request(app).delete(`/api/products/${p.id}/image`).set('Authorization', admin());
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(1);
    expect((await request(app).get(`/api/products/${p.id}/image`).set('Authorization', admin())).status).toBe(404);
    expect((await request(app).delete(`/api/products/${p.id}/image`).set('Authorization', admin())).body.removed).toBe(0); // idempotente
    expect(await bypass<number>(() => db.productImage.count({ where: { productId: p.id } }))).toBe(0);
  });

  it('arquivos inválidos: SVG/HTML/GIF/EXE disfarçados (415), polígloto (400), grande demais (413), base64 ruim e vazio (400) — nada é gravado', async () => {
    const p = await mkProduct(A, 'ruim');
    const expectRefused = async (content: unknown, status: number, code: string) => {
      const res = await put(p.id, admin(), { contentBase64: content });
      expect([content === '' ? 'vazio' : 'amostra', res.status, res.body.code]).toEqual([content === '' ? 'vazio' : 'amostra', status, code]);
    };
    await expectRefused(b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), 415, 'IMAGE_TYPE_UNSUPPORTED');
    await expectRefused(b64(Buffer.from('<html><script>alert(1)</script></html>')), 415, 'IMAGE_TYPE_UNSUPPORTED');
    await expectRefused(b64(Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00', 'latin1')), 415, 'IMAGE_TYPE_UNSUPPORTED');
    await expectRefused(b64(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)])), 415, 'IMAGE_TYPE_UNSUPPORTED');
    await expectRefused(b64(png(0, [], Buffer.from('<script>alert(1)</script>'))), 400, 'IMAGE_TRAILING_DATA');
    await expectRefused(b64(Buffer.concat([png(), Buffer.alloc(1_100_000, 7)])), 413, 'IMAGE_TOO_LARGE');
    await expectRefused('isto não é base64 !!!', 400, 'IMAGE_INVALID');
    await expectRefused('', 400, 'IMAGE_REQUIRED');
    const noBody = await put(p.id, admin(), {});
    expect(noBody.status).toBe(400);
    expect(await bypass<number>(() => db.productImage.count({ where: { productId: p.id } }))).toBe(0);
  });

  it('acesso cruzado: a empresa B não vê, não troca, não apaga nem consulta a imagem do produto da empresa A (404)', async () => {
    const p = await mkProduct(A, 'cruz');
    expect((await put(p.id, admin(), { contentBase64: b64(png(5)) })).status).toBe(200);
    expect((await put(p.id, adminB(), { contentBase64: b64(png(99)) })).status).toBe(404);
    expect((await request(app).get(`/api/products/${p.id}/image`).set('Authorization', adminB())).status).toBe(404);
    expect((await request(app).get(`/api/products/${p.id}/image/meta`).set('Authorization', adminB())).status).toBe(404);
    expect((await request(app).delete(`/api/products/${p.id}/image`).set('Authorization', adminB())).status).toBe(404);
    // a imagem da A continua intacta
    const stored = await bypass<any>(() => db.productImage.findUnique({ where: { productId: p.id } }));
    expect(stored.companyId).toBe(A.companyId);
    expect((await request(app).get(`/api/products/${p.id}/image`).set('Authorization', admin())).status).toBe(200);
  });

  it('papéis: Gerência+ escreve; operador e consulta só leem (403 ao enviar ou remover); sem login 401', async () => {
    const p = await mkProduct(A, 'papel');
    expect((await put(p.id, tok('MANAGER', A), { contentBase64: b64(png(7)) })).status).toBe(200);
    expect((await put(p.id, tok('OPERATOR', A), { contentBase64: b64(png(8)) })).status).toBe(403);
    expect((await put(p.id, tok('VIEWER', A), { contentBase64: b64(png(9)) })).status).toBe(403);
    expect((await request(app).delete(`/api/products/${p.id}/image`).set('Authorization', tok('OPERATOR', A))).status).toBe(403);
    expect((await request(app).get(`/api/products/${p.id}/image`).set('Authorization', tok('OPERATOR', A))).status).toBe(200); // o PDV pode exibir
    expect((await request(app).put(`/api/products/${p.id}/image`).send({ contentBase64: b64(png()) })).status).toBe(401);
    const audits = auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => JSON.stringify(c[1]));
    expect(audits.some((a) => a.includes('IMAGE_SET'))).toBe(true);
    expect(audits.join(' ')).not.toContain('contentBase64'); // a auditoria não leva o arquivo
  });
});
