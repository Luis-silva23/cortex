// Limites pequenos só para este arquivo (leitura no carregamento do módulo de limite): permitem provar o 429 sem carga.
process.env.COMMERCE_RATE_LIMIT_PER_MIN = '12';
process.env.COMMERCE_AUTH_FAILURES_PER_MIN = '6';

import express from 'express';
import request from 'supertest';
import { prisma, prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import commerceRoutes from '../../src/routes/commerce.routes';
import salesChannelsRoutes from '../../src/routes/sales-channels.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import moduleSettingsService from '../../src/services/module-settings.service';
import { signRequest } from '../../src/services/commerce/signature';
import { resetCommerceLimits } from '../../src/services/commerce/rate-limit';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * COMMERCE API — prova REAL (HTTP + Postgres + Redis + RLS): credencial de canal assinada com HMAC, catálogo só do que foi publicado,
 * pedido idempotente com preço oficial do CÓRTEX, pagamento externo separado (sem venda, sem caixa, sem estoque), administração e
 * isolamento por empresa, filial e canal. Nenhum provedor real; nenhuma chamada externa.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}
const db = prismaUnsafeBypassRLS as any;
const find = (model: string, where: any, extra: any = {}) => bypass<any>(() => db[model].findFirst({ where, ...extra }));
const findMany = (model: string, where: any, extra: any = {}) => bypass<any[]>(() => db[model].findMany({ where, ...extra }));
const count = (model: string, where: any) => bypass<number>(() => db[model].count({ where }));

const TEST_IP = '::ffff:127.0.0.1';

describe('Commerce API — integração real', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let branchA2: string;
  let app: express.Express;
  let channelA: string;
  let channelA2: string; // segundo canal da mesma empresa (isolamento entre canais)
  let channelB: string;
  type Cred = { id: string; keyId: string; secret: string };
  let credA: Cred; // todos os escopos
  let credCatalog: Cred; // só leitura de catálogo
  let credA2: Cred; // do segundo canal da empresa A
  let credB: Cred;
  let baseline: { sale: number; payment: number; stock: number; cash: number };

  const token = (fx: IntegrationFixture, userType: string) =>
    generateAccessToken({ userId: fx.userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: (userType === 'COMPANY_ADMIN' ? undefined : fx.branchId) as any, userType });
  const as = (fx: IntegrationFixture, userType: string) => ({ Authorization: `Bearer ${token(fx, userType)}` });
  const adminCtx = <T>(fx: IntegrationFixture, fn: () => Promise<T>) => runWithRLSContext({ companyId: fx.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
  const setModule = (fx: IntegrationFixture, isEnabled: boolean) =>
    adminCtx(fx, () => moduleSettingsService.setEnabled({ companyId: fx.companyId, module: 'CANAIS', isEnabled, actorId: fx.userId, reason: 'teste' } as any));

  // ---------- chamada assinada ----------
  function signed(cred: Pick<Cred, 'keyId' | 'secret'>, method: string, path: string, body?: unknown, over: { tsOffsetSec?: number; secret?: string } = {}) {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000) + (over.tsOffsetSec ?? 0);
    return {
      raw,
      headers: {
        'X-Cortex-Key': cred.keyId,
        'X-Cortex-Timestamp': String(ts),
        'X-Cortex-Signature': signRequest(over.secret ?? cred.secret, { timestampSec: ts, method, path, rawBody: raw }),
      } as Record<string, string>,
    };
  }
  function call(cred: Pick<Cred, 'keyId' | 'secret'>, method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}, over: { tsOffsetSec?: number; secret?: string } = {}) {
    const { raw, headers } = signed(cred, method, path, body, over);
    let r: any = (request(app) as any)[method.toLowerCase()](path).set(headers).set(extra);
    if (raw) r = r.set('Content-Type', 'application/json').send(raw);
    return r;
  }
  let keyCounter = 0;
  const idem = () => ({ 'Idempotency-Key': `test-${Date.now()}-${++keyCounter}` });

  async function newCred(fx: IntegrationFixture, channelId: string, scopes: string[], label = 'credencial de teste'): Promise<Cred> {
    const r = await request(app).post(`/sales-channels/${channelId}/api-credentials`).set(as(fx, 'COMPANY_ADMIN')).send({ label, scopes });
    expect(r.status).toBe(201);
    return { id: r.body.credential.id, keyId: r.body.credential.keyId, secret: r.body.secret };
  }
  const ALL = ['CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE'];

  const orderBody = (id: string, over: Record<string, unknown> = {}) => ({
    externalOrderId: id,
    items: [
      { sku: 'CM-OK', quantity: 2, unitPrice: 10 },
      { sku: 'CM-COMP', quantity: 1, unitPrice: 7.5 },
    ],
    total: 27.5,
    ...over,
  });
  const counts = async (fx: IntegrationFixture) => ({
    sale: await count('sale', { companyId: fx.companyId }),
    payment: await count('payment', { companyId: fx.companyId }),
    stock: await count('stockMovement', { companyId: fx.companyId }),
    cash: await count('cashMovement', { cashRegisterId: fx.cashRegisterId }),
  });

  beforeAll(async () => {
    [A, B] = await Promise.all([createFixture('cmA'), createFixture('cmB')]);
    await Promise.all([setModule(A, true), setModule(B, true)]);
    const b2 = await bypass<{ id: string }>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial A2', isHeadquarter: false, isActive: true } }));
    branchA2 = b2.id;

    app = express();
    app.use('/commerce/v1', commerceRoutes);
    app.use('/sales-channels', express.json(), salesChannelsRoutes);
    app.use(errorHandler);

    const mk = async (fx: IntegrationFixture, name: string, branchId: string | null = fx.branchId) => {
      const c = await request(app).post('/sales-channels').set(as(fx, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO', displayName: name, branchId });
      expect(c.status).toBe(201);
      const act = await request(app).patch(`/sales-channels/${c.body.id}`).set(as(fx, 'COMPANY_ADMIN')).send({ isActive: true });
      expect(act.status).toBe(200);
      return c.body.id as string;
    };
    channelA = await mk(A, 'Loja Online A');
    channelA2 = await mk(A, 'Loja Online A (2)');
    channelB = await mk(B, 'Loja Online B');

    // Produtos da empresa A (filial A.branchId), com estoque no livro
    const category = await adminCtx(A, () => prisma.category.create({ data: { companyId: A.companyId, name: 'Peças', isActive: true } }));
    const mkProduct = (sku: string, price: number, stock: number, extra: Record<string, unknown> = {}) =>
      adminCtx(A, async () => {
        const p = await prisma.product.create({ data: { companyId: A.companyId, branchId: A.branchId, sku, name: `Produto ${sku}`, costPrice: 1, salePrice: price, isActive: true, ...extra } as any });
        if (stock > 0) await prisma.stockMovement.create({ data: { companyId: A.companyId, branchId: A.branchId, productId: p.id, movementType: 'PURCHASE', quantity: stock, userId: A.userId } });
        return p;
      });
    await mkProduct('CM-OK', 10, 10, { categoryId: category.id, description: 'Peça de teste', brand: 'Marca' });
    await mkProduct('CM-LOW', 49.9, 0);
    await mkProduct('CM-UNPUB', 5, 5);
    await mkProduct('CM-INACT', 5, 5, { isActive: false });
    await mkProduct('CM-COMP', 7.5, 4, { branchId: null }); // produto da empresa toda, com saldo (movimento) na filial A
    const other = await adminCtx(A, () => prisma.product.create({ data: { companyId: A.companyId, branchId: branchA2, sku: 'CM-OTHER', name: 'Produto de outra filial', costPrice: 1, salePrice: 3, isActive: true } }));
    // Produto da empresa B com o MESMO sku e outro preço
    await runWithRLSContext({ companyId: B.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
      prisma.product.create({ data: { companyId: B.companyId, branchId: B.branchId, sku: 'CM-OK', name: 'Produto B', costPrice: 1, salePrice: 99, isActive: true } })
    );

    // Publica no canal A (CM-UNPUB fica de fora de propósito); CM-OTHER e CM-INACT entram por vínculo direto para provar o filtro de leitura
    const pub = await request(app).put(`/sales-channels/${channelA}/products`).set(as(A, 'COMPANY_ADMIN')).send({ skus: ['CM-OK', 'CM-LOW', 'CM-COMP', 'CM-INACT'], published: true });
    expect(pub.status).toBe(200);
    await bypass(() => db.channelProductLink.create({ data: { companyId: A.companyId, branchId: A.branchId, channelId: channelA, productId: other.id, published: true } }));
    const pubB = await request(app).put(`/sales-channels/${channelB}/products`).set(as(B, 'COMPANY_ADMIN')).send({ skus: ['CM-OK'], published: true });
    expect(pubB.status).toBe(200);

    credA = await newCred(A, channelA, ALL, 'completa');
    credCatalog = await newCred(A, channelA, ['CATALOG_READ'], 'catálogo');
    credA2 = await newCred(A, channelA2, ALL, 'canal 2');
    credB = await newCred(B, channelB, ALL, 'empresa B');
    baseline = await counts(A);
  }, 90000);

  afterEach(async () => {
    await resetCommerceLimits({ ip: TEST_IP });
    for (const c of [credA, credCatalog, credA2, credB]) if (c) await resetCommerceLimits({ keyId: c.keyId });
  });

  afterAll(async () => {
    const ids = [A.companyId, B.companyId];
    await bypass(() => db.idempotencyKey.deleteMany({ where: { companyId: { in: ids } } }));
    await bypass(() => db.channelEvent.deleteMany({ where: { companyId: { in: ids } } }));
    await Promise.all([destroyFixture(A), destroyFixture(B)]);
  }, 60000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('administração das credenciais', () => {
    it('só o administrador da empresa emite; gerente, operador, visualizador e mecânico recebem 403', async () => {
      for (const t of ['MANAGER', 'OPERATOR', 'VIEWER', 'MECHANIC']) {
        const r = await request(app).post(`/sales-channels/${channelA}/api-credentials`).set(as(A, t)).send({ label: 'rótulo', scopes: ['CATALOG_READ'] });
        expect(r.status).toBe(403);
      }
    });

    it('o segredo aparece uma única vez; a listagem não o devolve; no banco só há texto cifrado', async () => {
      const created = await request(app).post(`/sales-channels/${channelA}/api-credentials`).set(as(A, 'COMPANY_ADMIN')).send({ label: 'segredo', scopes: ['CATALOG_READ'] });
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toContain('no-store');
      const { secret } = created.body;
      expect(secret).toMatch(/^cs_/);
      expect(created.body.credential.keyId).toMatch(/^ck_[0-9a-f]{20}$/);

      const listed = await request(app).get(`/sales-channels/${channelA}/api-credentials`).set(as(A, 'COMPANY_ADMIN'));
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(secret);
      expect(JSON.stringify(listed.body)).not.toContain('secretEncrypted');
      expect(listed.body.data.find((c: any) => c.id === created.body.credential.id).secretHint).toBe(`••••${secret.slice(-4)}`);

      const row = await find('channelApiCredential', { id: created.body.credential.id });
      expect(row.secretEncrypted.startsWith('enc:v1:')).toBe(true);
      expect(row.secretEncrypted).not.toContain(secret);
      const events = await findMany('channelEvent', { channelId: channelA, type: 'API_CREDENTIAL_CREATED' });
      expect(JSON.stringify(events)).not.toContain(secret);

      await request(app).delete(`/sales-channels/${channelA}/api-credentials/${created.body.credential.id}`).set(as(A, 'COMPANY_ADMIN'));
    });

    it('canal que não usa a Commerce API (iFood) ou sem filial não emite credencial; escopo e validade inválidos são recusados', async () => {
      const ifood = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'IFOOD', displayName: 'Delivery', branchId: A.branchId });
      expect((await request(app).post(`/sales-channels/${ifood.body.id}/api-credentials`).set(as(A, 'COMPANY_ADMIN')).send({ label: 'rótulo', scopes: ['CATALOG_READ'] })).body.code).toBe('CHANNEL_TYPE_NOT_SUPPORTED');
      const noBranch = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO', displayName: 'Sem filial' });
      expect((await request(app).post(`/sales-channels/${noBranch.body.id}/api-credentials`).set(as(A, 'COMPANY_ADMIN')).send({ label: 'rótulo', scopes: ['CATALOG_READ'] })).body.code).toBe('CHANNEL_BRANCH_REQUIRED');
      expect((await request(app).post(`/sales-channels/${channelA}/api-credentials`).set(as(A, 'COMPANY_ADMIN')).send({ label: 'rótulo', scopes: ['ADMIN_TUDO'] })).status).toBe(400);
      expect((await request(app).post(`/sales-channels/${channelA}/api-credentials`).set(as(A, 'COMPANY_ADMIN')).send({ label: 'rótulo', scopes: ['CATALOG_READ'], expiresAt: '2020-01-01T00:00:00.000Z' })).status).toBe(400);
    });

    it('revogar é imediato e idempotente; trocar emite uma nova e deixa a antiga vencer logo', async () => {
      const c = await newCred(A, channelA, ['CATALOG_READ'], 'para revogar');
      expect((await call(c, 'GET', '/commerce/v1/categories')).status).toBe(200);
      const rev = await request(app).delete(`/sales-channels/${channelA}/api-credentials/${c.id}`).set(as(A, 'COMPANY_ADMIN'));
      expect(rev.status).toBe(200);
      expect(rev.body.revokedAt).toBeTruthy();
      expect((await request(app).delete(`/sales-channels/${channelA}/api-credentials/${c.id}`).set(as(A, 'COMPANY_ADMIN'))).status).toBe(200);
      expect((await call(c, 'GET', '/commerce/v1/categories')).status).toBe(401);

      const old = await newCred(A, channelA, ['CATALOG_READ'], 'para trocar');
      const rot = await request(app).post(`/sales-channels/${channelA}/api-credentials/${old.id}/rotate`).set(as(A, 'COMPANY_ADMIN')).send({ overlapHours: 2 });
      expect(rot.status).toBe(201);
      expect((await call({ keyId: rot.body.credential.keyId, secret: rot.body.secret }, 'GET', '/commerce/v1/categories')).status).toBe(200);
      const oldRow = await find('channelApiCredential', { id: old.id });
      expect(oldRow.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 3600_000 + 5000);
      expect((await call(old, 'GET', '/commerce/v1/categories')).status).toBe(200); // ainda vale durante a sobreposição
      await bypass(() => db.channelApiCredential.updateMany({ where: { id: { in: [old.id, rot.body.credential.id] } }, data: { revokedAt: new Date() } }));
    });

    it('a conexão do canal só vira CONECTADO na primeira chamada assinada válida (validação real), nunca por salvar a credencial', async () => {
      const ch = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO', displayName: 'Estado de conexão', branchId: A.branchId });
      const id = ch.body.id as string;
      expect(ch.body.connectionStatus).toBe('NOT_CONFIGURED');
      const c = await newCred(A, id, ['CATALOG_READ'], 'conexão');
      expect((await find('salesChannel', { id })).connectionStatus).toBe('UNVALIDATED'); // credencial salva não conecta
      expect((await request(app).patch(`/sales-channels/${id}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: true })).status).toBe(200); // canal de entrada: ativar não exige provedor
      expect((await call(c, 'GET', '/commerce/v1/categories')).status).toBe(200);
      for (let i = 0; i < 20 && (await find('salesChannel', { id })).connectionStatus !== 'CONNECTED'; i++) await new Promise((r) => setTimeout(r, 100));
      const row = await find('salesChannel', { id });
      expect(row.connectionStatus).toBe('CONNECTED');
      expect(row.lastSyncAt).toBeTruthy();
      expect((await findMany('channelEvent', { channelId: id, type: 'CONNECTION_VALIDATED' })).length).toBe(1);
      await bypass(() => db.channelApiCredential.updateMany({ where: { id: c.id }, data: { revokedAt: new Date() } }));
    });

    it('a empresa B não vê nem emite credencial de um canal da empresa A (404)', async () => {
      expect((await request(app).get(`/sales-channels/${channelA}/api-credentials`).set(as(B, 'COMPANY_ADMIN'))).status).toBe(404);
      expect((await request(app).post(`/sales-channels/${channelA}/api-credentials`).set(as(B, 'COMPANY_ADMIN')).send({ label: 'rótulo', scopes: ['CATALOG_READ'] })).status).toBe(404);
      expect((await request(app).delete(`/sales-channels/${channelA}/api-credentials/${credA.id}`).set(as(B, 'COMPANY_ADMIN'))).status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('autenticação por credencial de canal (HMAC)', () => {
    const path = '/commerce/v1/products?limit=1';

    it('sem cabeçalhos, chave desconhecida, assinatura errada, carimbo velho e corpo adulterado: o MESMO 401', async () => {
      const bodies: any[] = [];
      bodies.push((await request(app).get(path)).body);
      bodies.push((await call({ keyId: 'ck_' + '0'.repeat(20), secret: 'cs_x' }, 'GET', path)).body);
      bodies.push((await call(credA, 'GET', path, undefined, {}, { secret: 'cs_errado' })).body);
      bodies.push((await call(credA, 'GET', path, undefined, {}, { tsOffsetSec: -3600 })).body);
      const tampered = await (async () => {
        const { headers } = signed(credA, 'POST', '/commerce/v1/orders', { a: 1 });
        return request(app).post('/commerce/v1/orders').set(headers).set(idem()).set('Content-Type', 'application/json').send({ a: 2 });
      })();
      bodies.push(tampered.body);
      for (const b of bodies) {
        expect(b.error.code).toBe('UNAUTHORIZED');
        expect(b.error.message).toBe(bodies[0].error.message);
        expect(b.requestId).toBeTruthy();
      }
    });

    it('credencial válida acessa; escopo insuficiente é 403', async () => {
      expect((await call(credA, 'GET', path)).status).toBe(200);
      const noScope = await call(credCatalog, 'POST', '/commerce/v1/orders', orderBody('AUTH-SCOPE-1'), idem());
      expect(noScope.status).toBe(403);
      expect(noScope.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('credencial vencida é recusada', async () => {
      const c = await newCred(A, channelA, ['CATALOG_READ'], 'vence');
      await bypass(() => db.channelApiCredential.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
      expect((await call(c, 'GET', path)).status).toBe(401);
    });

    it('canal desativado ou módulo desligado: 403 e nada é processado; religar volta ao normal', async () => {
      await request(app).patch(`/sales-channels/${channelA2}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: false });
      const off = await call(credA2, 'GET', path);
      expect(off.status).toBe(403);
      expect(off.body.error.code).toBe('CHANNEL_DISABLED');
      await request(app).patch(`/sales-channels/${channelA2}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: true });
      expect((await call(credA2, 'GET', path)).status).toBe(200);

      await setModule(A, false);
      expect((await call(credA, 'GET', path)).body.error.code).toBe('CHANNEL_DISABLED');
      await setModule(A, true);
      expect((await call(credA, 'GET', path)).status).toBe(200);
    });

    it('falhas seguidas de autenticação bloqueiam o IP (429), mesmo com credencial válida', async () => {
      for (let i = 0; i < 6; i++) expect((await call({ keyId: 'ck_' + '1'.repeat(20), secret: 'cs_x' }, 'GET', path)).status).toBe(401);
      const blocked = await call(credA, 'GET', path);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });

    it('limite por credencial: passa o limite, 429 com Retry-After; outra credencial não é afetada', async () => {
      const c = await newCred(A, channelA, ['CATALOG_READ'], 'limitada');
      let last: any;
      for (let i = 0; i < 12; i++) {
        last = await call(c, 'GET', '/commerce/v1/categories');
        expect(last.status).toBe(200);
      }
      expect(last.headers['x-ratelimit-remaining']).toBe('0');
      const over = await call(c, 'GET', '/commerce/v1/categories');
      expect(over.status).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await call(credA, 'GET', '/commerce/v1/categories')).status).toBe(200);
      await resetCommerceLimits({ keyId: c.keyId });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('catálogo (só o publicado, sem dado interno)', () => {
    it('lista só produtos publicados, ativos e da filial do canal (ou da empresa toda), sem custo nem ids internos', async () => {
      const r = await call(credA, 'GET', '/commerce/v1/products?limit=100');
      expect(r.status).toBe(200);
      const skus = r.body.data.map((p: any) => p.sku).sort();
      expect(skus).toEqual(['CM-COMP', 'CM-LOW', 'CM-OK']); // sem CM-UNPUB (não publicado), CM-INACT (inativo) e CM-OTHER (outra filial)
      const ok = r.body.data.find((p: any) => p.sku === 'CM-OK');
      expect(ok).toMatchObject({ name: 'Produto CM-OK', price: 10, currency: 'BRL', inStock: true, category: { name: 'Peças' } });
      for (const p of r.body.data) {
        expect(p).not.toHaveProperty('costPrice');
        expect(p).not.toHaveProperty('id');
        expect(p).not.toHaveProperty('companyId');
        expect(p).not.toHaveProperty('branchId');
      }
      expect(r.body.pagination.total).toBe(3);
    });

    it('disponibilidade: em estoque ou não; a quantidade só aparece se o canal configurou; margem de segurança desconta', async () => {
      let r = await call(credA, 'GET', '/commerce/v1/products/CM-OK');
      expect(r.body.data.inStock).toBe(true);
      expect(r.body.data).not.toHaveProperty('availableQuantity');
      expect((await call(credA, 'GET', '/commerce/v1/products/CM-LOW')).body.data.inStock).toBe(false);

      await request(app).patch(`/sales-channels/${channelA}`).set(as(A, 'COMPANY_ADMIN')).send({ config: { exposeStockQuantity: true, stockSafetyMargin: 3 } });
      r = await call(credA, 'GET', '/commerce/v1/products/CM-OK');
      expect(r.body.data.availableQuantity).toBe(7); // 10 no livro − margem 3
      expect((await call(credA, 'GET', '/commerce/v1/products/CM-COMP')).body.data.availableQuantity).toBe(1); // 4 − 3
      await request(app).patch(`/sales-channels/${channelA}`).set(as(A, 'COMPANY_ADMIN')).send({ config: null });
    });

    it('produto não publicado, inativo, de outra filial ou inexistente: 404 indistinguível; sku de outra empresa não vaza', async () => {
      const codes = [];
      for (const sku of ['CM-UNPUB', 'CM-INACT', 'CM-OTHER', 'NAO-EXISTE']) {
        const r = await call(credA, 'GET', `/commerce/v1/products/${sku}`);
        expect(r.status).toBe(404);
        codes.push(r.body.error.code);
      }
      expect(new Set(codes).size).toBe(1);
      // mesmo sku 'CM-OK' existe na empresa B com preço 99: cada credencial vê só o da própria empresa
      expect((await call(credA, 'GET', '/commerce/v1/products/CM-OK')).body.data.price).toBe(10);
      expect((await call(credB, 'GET', '/commerce/v1/products/CM-OK')).body.data.price).toBe(99);
    });

    it('o outro canal da mesma empresa não vê o que não foi publicado para ele', async () => {
      const r = await call(credA2, 'GET', '/commerce/v1/products');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);
    });

    it('busca, paginação e categorias; parâmetros inválidos viram 400', async () => {
      const q = await call(credA, 'GET', '/commerce/v1/products?q=cm-lo');
      expect(q.body.data.map((p: any) => p.sku)).toEqual(['CM-LOW']);
      const p1 = await call(credA, 'GET', '/commerce/v1/products?limit=2&page=1');
      const p2 = await call(credA, 'GET', '/commerce/v1/products?limit=2&page=2');
      expect(p1.body.data).toHaveLength(2);
      expect(p2.body.data).toHaveLength(1);
      expect((await call(credA, 'GET', '/commerce/v1/products?limit=1000')).status).toBe(400);
      expect((await call(credA, 'GET', '/commerce/v1/products?page=0')).status).toBe(400);
      const cats = await call(credA, 'GET', '/commerce/v1/categories');
      expect(cats.body.data.map((c: any) => c.name)).toEqual(['Peças']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('pedido externo (não é venda)', () => {
    it('cria com o preço oficial, estado RECEIVED, itens gravados — e NÃO cria venda, pagamento, estoque nem caixa', async () => {
      const before = await counts(A);
      const r = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-1', { customer: { name: 'Maria', email: 'maria@example.com' }, notes: 'entregar à tarde' }), idem());
      expect(r.status).toBe(201);
      expect(r.body.replayed).toBe(false);
      expect(r.body.data).toMatchObject({ orderId: 'ORD-1', status: 'RECEIVED', paymentStatus: 'UNKNOWN', total: 27.5, currency: 'BRL' });
      expect(r.body.data.items).toHaveLength(2);
      expect(await counts(A)).toEqual(before);

      const row = await find('externalOrder', { externalOrderId: 'ORD-1', channelId: channelA }, { include: { items: true } });
      expect(row).toMatchObject({ companyId: A.companyId, branchId: A.branchId, source: 'COMMERCE_API', saleId: null });
      expect(Number(row.totalAmount)).toBe(27.5);
      expect(row.items).toHaveLength(2);
      expect(row.correlationId).toBeTruthy();
      const ev = await findMany('channelEvent', { channelId: channelA, type: 'ORDER_RECEIVED' });
      expect(ev.some((e) => e.data?.externalOrderId === 'ORD-1')).toBe(true);
    });

    it('empresa e filial vêm da credencial: campos enviados pelo canal são recusados', async () => {
      const r = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-INJ', { companyId: B.companyId, branchId: branchA2 }), idem());
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_REQUEST');
      expect(await count('externalOrder', { externalOrderId: 'ORD-INJ' })).toBe(0);
    });

    it('Idempotency-Key é obrigatória e validada; mesma chave + mesmo corpo devolve a MESMA resposta; mesma chave + corpo diferente é 422', async () => {
      expect((await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-IK'))).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-IK'), { 'Idempotency-Key': 'curta' })).status).toBe(400);
      const key = { 'Idempotency-Key': `fixa-${Date.now()}` };
      const first = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-IK'), key);
      const again = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-IK'), key);
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.body.data.cortexOrderId).toBe(first.body.data.cortexOrderId);
      expect(await count('externalOrder', { externalOrderId: 'ORD-IK' })).toBe(1);
      const diff = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-IK', { notes: 'outro' }), key);
      expect(diff.status).toBe(422);
    });

    it('mesmo pedido com outra chave: mesmo conteúdo = repetição (200, replayed); conteúdo diferente = 409', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-DUP'), idem());
      const same = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-DUP'), idem());
      expect(same.status).toBe(200);
      expect(same.body.replayed).toBe(true);
      const changed = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-DUP', { items: [{ sku: 'CM-OK', quantity: 3, unitPrice: 10 }], total: 30 }), idem());
      expect(changed.status).toBe(409);
      expect(changed.body.error.code).toBe('ORDER_CONFLICT');
      expect(await count('externalOrder', { externalOrderId: 'ORD-DUP' })).toBe(1);
    });

    it('cinco requisições simultâneas do mesmo pedido criam um só', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-RACE'), idem())));
      expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await count('externalOrder', { externalOrderId: 'ORD-RACE' })).toBe(1);
      expect(await count('externalOrderItem', { order: { externalOrderId: 'ORD-RACE' } })).toBe(2);
    });

    it('preço diferente do oficial: 422 com os itens; total diferente: 422; nada é gravado', async () => {
      const price = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-PRICE', { items: [{ sku: 'CM-OK', quantity: 1, unitPrice: 9 }], total: 9 }), idem());
      expect(price.status).toBe(422);
      expect(price.body.error.code).toBe('PRICE_MISMATCH');
      expect(price.body.error.details.items[0]).toEqual({ sku: 'CM-OK', channelUnitPrice: 9, currentPrice: 10 });
      const total = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-TOTAL', { total: 1 }), idem());
      expect(total.body.error.code).toBe('TOTAL_MISMATCH');
      expect(await count('externalOrder', { externalOrderId: { in: ['ORD-PRICE', 'ORD-TOTAL'] } })).toBe(0);
    });

    it('produto não publicado, inativo, de outra filial ou inexistente: 422 PRODUCT_UNAVAILABLE', async () => {
      for (const sku of ['CM-UNPUB', 'CM-INACT', 'CM-OTHER', 'NAO-EXISTE']) {
        const r = await call(credA, 'POST', '/commerce/v1/orders', orderBody(`ORD-U-${sku}`, { items: [{ sku, quantity: 1, unitPrice: 5 }], total: 5 }), idem());
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('PRODUCT_UNAVAILABLE');
      }
    });

    it('SKU repetido, JSON inválido e corpo grande demais', async () => {
      const dup = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-SKU', { items: [{ sku: 'CM-OK', quantity: 1, unitPrice: 10 }, { sku: 'CM-OK', quantity: 1, unitPrice: 10 }], total: 20 }), idem());
      expect(dup.status).toBe(400);
      const bad = await call(credA, 'POST', '/commerce/v1/orders', '{"externalOrderId": ', idem());
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_JSON');
      const big = await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-BIG', { notes: 'x'.repeat(300_000) }), idem());
      expect(big.status).toBe(413);
    });

    it('consulta: só o próprio canal; outro canal da empresa, a empresa B e pedido inexistente recebem 404', async () => {
      const mine = await call(credA, 'GET', '/commerce/v1/orders/ORD-1');
      expect(mine.status).toBe(200);
      expect(mine.body.data.orderId).toBe('ORD-1');
      expect((await call(credA2, 'GET', '/commerce/v1/orders/ORD-1')).status).toBe(404);
      expect((await call(credB, 'GET', '/commerce/v1/orders/ORD-1')).status).toBe(404);
      expect((await call(credA, 'GET', '/commerce/v1/orders/NAO-EXISTE')).status).toBe(404);
      expect((await call(credCatalog, 'GET', '/commerce/v1/orders/ORD-1')).status).toBe(403);
    });

    it('cancelar antes de aceitar: vai a CANCELLED, repetir é inofensivo; depois não aceita mais mudança', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('ORD-CAN'), idem());
      const c1 = await call(credA, 'POST', '/commerce/v1/orders/ORD-CAN/cancel', { reason: 'cliente desistiu' }, idem());
      expect(c1.status).toBe(200);
      expect(c1.body.data).toMatchObject({ status: 'CANCELLED', statusReason: 'cliente desistiu' });
      expect((await call(credA, 'POST', '/commerce/v1/orders/ORD-CAN/cancel', {}, idem())).body.data.status).toBe('CANCELLED');
      const cached = await find('externalOrder', { externalOrderId: 'ORD-CAN', channelId: channelA });
      expect(cached.status).toBe('CANCELLED');
      expect((await call(credA, 'POST', '/commerce/v1/orders/NAO-EXISTE/cancel', {}, idem())).status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('pagamento externo (separado do pedido, da venda e do caixa)', () => {
    const ev = (orderId: string, body: Record<string, unknown>) => call(credA, 'POST', `/commerce/v1/orders/${orderId}/payment-events`, body);
    const orderRow = (id: string) => find('externalOrder', { externalOrderId: id, channelId: channelA });

    it('fluxo PENDING → CONFIRMED: o pedido fica com pagamento confirmado, mas NÃO vira venda e nada entra no caixa ou no estoque', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('PAY-1'), idem());
      const before = await counts(A);
      const p = await ev('PAY-1', { eventId: 'e1', providerRef: 'R1', status: 'PENDING', amount: 27.5 });
      expect(p.status).toBe(201);
      expect(p.body.data).toMatchObject({ outcome: 'CREATED', paymentStatus: 'PENDING' });
      const c = await ev('PAY-1', { eventId: 'e2', providerRef: 'R1', status: 'CONFIRMED', amount: 27.5 });
      expect(c.body.data).toMatchObject({ outcome: 'UPDATED', paymentStatus: 'CONFIRMED' });
      const row = await orderRow('PAY-1');
      expect(row).toMatchObject({ paymentStatus: 'CONFIRMED', status: 'RECEIVED', saleId: null });
      expect(await counts(A)).toEqual(before);
    });

    it('evento repetido (mesmo eventId) é DUPLICATE; evento mais antigo é STALE; regressão de estado é ignorada', async () => {
      const dup = await ev('PAY-1', { eventId: 'e2', providerRef: 'R1', status: 'CONFIRMED', amount: 27.5 });
      expect(dup.status).toBe(200);
      expect(dup.body.data.outcome).toBe('DUPLICATE');
      const stale = await ev('PAY-1', { eventId: 'e3', providerRef: 'R1', status: 'REFUNDED', amount: 27.5, occurredAt: '2020-01-01T00:00:00.000Z' });
      expect(stale.body.data.outcome).toBe('STALE');
      const regress = await ev('PAY-1', { eventId: 'e4', providerRef: 'R1', status: 'PENDING', amount: 27.5 });
      expect(regress.body.data).toMatchObject({ outcome: 'IGNORED', reason: 'INVALID_TRANSITION' });
      expect((await orderRow('PAY-1')).paymentStatus).toBe('CONFIRMED');
      expect(await count('externalPayment', { order: { externalOrderId: 'PAY-1' } })).toBe(1);
    });

    it('estorno: CONFIRMED → REFUNDED, e o pedido passa a REFUNDED; REFUNDED é final', async () => {
      const r = await ev('PAY-1', { eventId: 'e5', providerRef: 'R1', status: 'REFUNDED', amount: 27.5 });
      expect(r.body.data).toMatchObject({ outcome: 'UPDATED', paymentStatus: 'REFUNDED' });
      const back = await ev('PAY-1', { eventId: 'e6', providerRef: 'R1', status: 'CONFIRMED', amount: 27.5 });
      expect(back.body.data.outcome).toBe('IGNORED');
      expect((await orderRow('PAY-1')).paymentStatus).toBe('REFUNDED');
    });

    it('recusado e nova tentativa com outra referência: o pedido fica CONFIRMED quando a nova é confirmada', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('PAY-2'), idem());
      await ev('PAY-2', { eventId: 'f1', providerRef: 'T1', status: 'FAILED', amount: 27.5 });
      expect((await orderRow('PAY-2')).paymentStatus).toBe('FAILED');
      await ev('PAY-2', { eventId: 'f2', providerRef: 'T2', status: 'CONFIRMED', amount: 27.5 });
      expect((await orderRow('PAY-2')).paymentStatus).toBe('CONFIRMED');
      expect((await ev('PAY-2', { eventId: 'f3', providerRef: 'T1', status: 'CONFIRMED', amount: 27.5 })).body.data.reason).toBe('INVALID_TRANSITION'); // FAILED é final
    });

    it('valor confirmado diferente do total NÃO confirma o pedido e gera alerta', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('PAY-3'), idem());
      await ev('PAY-3', { eventId: 'g1', providerRef: 'V1', status: 'CONFIRMED', amount: 20 });
      expect((await orderRow('PAY-3')).paymentStatus).toBe('PENDING');
      const warn = await findMany('channelEvent', { channelId: channelA, type: 'PAYMENT_AMOUNT_MISMATCH' });
      expect(warn.some((e) => e.data?.externalOrderId === 'PAY-3')).toBe(true);
    });

    it('pagamento confirmado em pedido cancelado é REGISTRADO (nunca descartado) e vira alerta; o pedido continua cancelado', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('PAY-4'), idem());
      await call(credA, 'POST', '/commerce/v1/orders/PAY-4/cancel', {}, idem());
      await ev('PAY-4', { eventId: 'h1', providerRef: 'X1', status: 'CONFIRMED', amount: 27.5 });
      const row = await orderRow('PAY-4');
      expect(row.status).toBe('CANCELLED');
      expect(row.paymentStatus).toBe('CONFIRMED');
      expect(await count('externalPayment', { order: { externalOrderId: 'PAY-4' } })).toBe(1);
      const warn = await findMany('channelEvent', { channelId: channelA, type: 'PAYMENT_ON_CLOSED_ORDER' });
      expect(warn.some((e) => e.data?.externalOrderId === 'PAY-4')).toBe(true);
    });

    it('a mesma referência de pagamento não pode ser usada em outro pedido', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('PAY-5'), idem());
      const r = await ev('PAY-5', { eventId: 'i1', providerRef: 'R1', status: 'PENDING', amount: 27.5 });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('PAYMENT_REF_IN_USE');
    });

    it('cinco eventos idênticos simultâneos geram um só pagamento', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('PAY-6'), idem());
      const results = await Promise.all(Array.from({ length: 5 }, () => ev('PAY-6', { eventId: 'j1', providerRef: 'C1', status: 'CONFIRMED', amount: 27.5 })));
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.body.data.outcome === 'CREATED')).toHaveLength(1);
      expect(results.filter((r) => r.body.data.outcome === 'DUPLICATE')).toHaveLength(4);
      expect(await count('externalPayment', { order: { externalOrderId: 'PAY-6' } })).toBe(1);
      expect(await count('channelInboundEvent', { channelId: channelA, externalEventId: 'j1' })).toBe(1);
    });

    it('validação: corpo fechado, valor com 3 casas, estado inválido e pedido inexistente', async () => {
      expect((await ev('PAY-6', { eventId: 'k1', providerRef: 'Z', status: 'CONFIRMED', amount: 1, extra: true })).status).toBe(400);
      expect((await ev('PAY-6', { eventId: 'k2', providerRef: 'Z', status: 'CONFIRMED', amount: 1.123 })).status).toBe(400);
      expect((await ev('PAY-6', { eventId: 'k3', providerRef: 'Z', status: 'UNKNOWN', amount: 1 })).status).toBe(400);
      expect((await ev('NAO-EXISTE', { eventId: 'k4', providerRef: 'Z', status: 'PENDING', amount: 1 })).status).toBe(404);
      expect((await call(credCatalog, 'POST', '/commerce/v1/orders/PAY-6/payment-events', { eventId: 'k5', providerRef: 'Z', status: 'PENDING', amount: 1 })).status).toBe(403);
    });

    it('depois de tudo isso, nenhuma venda, pagamento do balcão, movimento de caixa ou de estoque foi criado', async () => {
      expect(baseline.sale).toBe(0);
      expect(await counts(A)).toEqual(baseline); // nada mudou desde o preparo, depois de dezenas de pedidos e eventos de pagamento
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('administração: publicação e pedidos', () => {
    it('publicar e despublicar; SKU de outra filial ou inexistente volta em unknownSkus; despublicar tira do catálogo', async () => {
      const r = await request(app).put(`/sales-channels/${channelA}/products`).set(as(A, 'COMPANY_ADMIN')).send({ skus: ['CM-UNPUB', 'CM-OTHER', 'NAO-EXISTE'], published: true });
      expect(r.status).toBe(200);
      expect(r.body.updated).toBe(1);
      expect(r.body.unknownSkus.sort()).toEqual(['CM-OTHER', 'NAO-EXISTE']);
      expect((await call(credA, 'GET', '/commerce/v1/products/CM-UNPUB')).status).toBe(200);
      await request(app).put(`/sales-channels/${channelA}/products`).set(as(A, 'COMPANY_ADMIN')).send({ skus: ['CM-UNPUB'], published: false });
      expect((await call(credA, 'GET', '/commerce/v1/products/CM-UNPUB')).status).toBe(404);
      const list = await request(app).get(`/sales-channels/${channelA}/products?published=true`).set(as(A, 'COMPANY_ADMIN'));
      expect(list.body.data.some((p: any) => p.sku === 'CM-UNPUB')).toBe(false);
      expect((await request(app).put(`/sales-channels/${channelA}/products`).set(as(A, 'COMPANY_ADMIN')).send({ skus: [], published: true })).status).toBe(400);
      expect((await request(app).put(`/sales-channels/${channelA}/products`).set(as(A, 'MANAGER')).send({ skus: ['CM-OK'], published: true })).status).toBe(403);
    });

    it('lista, detalha (com pagamentos) e filtra pedidos; só a empresa dona enxerga', async () => {
      const list = await request(app).get(`/sales-channels/${channelA}/orders?status=RECEIVED&limit=100`).set(as(A, 'COMPANY_ADMIN'));
      expect(list.status).toBe(200);
      expect(list.body.data.every((o: any) => o.status === 'RECEIVED')).toBe(true);
      const one = list.body.data.find((o: any) => o.orderId === 'PAY-1');
      const detail = await request(app).get(`/sales-channels/${channelA}/orders/${one.cortexOrderId}`).set(as(A, 'COMPANY_ADMIN'));
      expect(detail.status).toBe(200);
      expect(detail.body.data.payments[0]).toMatchObject({ providerRef: 'R1', status: 'REFUNDED' });
      expect((await request(app).get(`/sales-channels/${channelA}/orders/${one.cortexOrderId}`).set(as(B, 'COMPANY_ADMIN'))).status).toBe(404);
      expect((await request(app).get(`/sales-channels/${channelA}/orders`).set(as(B, 'COMPANY_ADMIN'))).status).toBe(404);
    });

    it('recusar e cancelar pelo administrador: motivo obrigatório, guarda de estado e histórico', async () => {
      await call(credA, 'POST', '/commerce/v1/orders', orderBody('ADM-1'), idem());
      const o = await find('externalOrder', { externalOrderId: 'ADM-1', channelId: channelA });
      const noReason = await request(app).post(`/sales-channels/${channelA}/orders/${o.id}/reject`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(noReason.status).toBe(400);
      const rej = await request(app).post(`/sales-channels/${channelA}/orders/${o.id}/reject`).set(as(A, 'COMPANY_ADMIN')).send({ reason: 'sem estoque físico' });
      expect(rej.status).toBe(200);
      expect(rej.body.data).toMatchObject({ status: 'REJECTED', statusReason: 'sem estoque físico' });
      const cancelAfter = await request(app).post(`/sales-channels/${channelA}/orders/${o.id}/cancel`).set(as(A, 'COMPANY_ADMIN')).send({ reason: 'tentando cancelar' });
      expect(cancelAfter.status).toBe(409);
      expect(cancelAfter.body.code).toBe('INVALID_ORDER_STATE');
      expect((await request(app).post(`/sales-channels/${channelA}/orders/${o.id}/reject`).set(as(A, 'MANAGER')).send({ reason: 'x y z' })).status).toBe(403);
      const events = await findMany('channelEvent', { channelId: channelA, type: 'ORDER_REJECTED' });
      expect(events.some((e) => e.data?.externalOrderId === 'ADM-1' && e.actorId === A.userId)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('isolamento no banco (RLS) para o contexto de canal', () => {
    it('o contexto de canal da empresa B não enxerga pedidos, itens, pagamentos, vínculos nem credenciais da empresa A', async () => {
      const seen = await runWithRLSContext({ companyId: B.companyId, userType: 'CHANNEL', branchId: B.branchId }, async () => ({
        orders: await prisma.externalOrder.count({ where: { companyId: A.companyId } }),
        items: await prisma.externalOrderItem.count({ where: { companyId: A.companyId } }),
        payments: await prisma.externalPayment.count({ where: { companyId: A.companyId } }),
        links: await prisma.channelProductLink.count({ where: { companyId: A.companyId } }),
        creds: await prisma.channelApiCredential.count({ where: { companyId: A.companyId } }),
      }));
      expect(seen).toEqual({ orders: 0, items: 0, payments: 0, links: 0, creds: 0 });
    });

    it('o contexto de canal da empresa A mas de OUTRA filial também não enxerga os pedidos da filial do canal', async () => {
      const seen = await runWithRLSContext({ companyId: A.companyId, userType: 'CHANNEL', branchId: branchA2 }, async () => ({
        orders: await prisma.externalOrder.count({ where: { companyId: A.companyId } }),
        payments: await prisma.externalPayment.count({ where: { companyId: A.companyId } }),
        creds: await prisma.channelApiCredential.count({ where: { companyId: A.companyId } }),
      }));
      expect(seen).toEqual({ orders: 0, payments: 0, creds: 0 });
    });

    it('o contexto de canal da filial certa enxerga os próprios pedidos', async () => {
      const n = await runWithRLSContext({ companyId: A.companyId, userType: 'CHANNEL', branchId: A.branchId }, () => prisma.externalOrder.count({ where: { channelId: channelA } }));
      expect(n).toBeGreaterThan(5);
    });
  });
});
