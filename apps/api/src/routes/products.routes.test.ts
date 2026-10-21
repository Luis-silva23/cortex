/**
 * ACHADO DE AUDITORIA: criar/editar/apagar produto não tinha NENHUMA trava
 * de papel — qualquer usuário autenticado do tenant (inclusive VIEWER)
 * podia reescrever `salePrice` via PUT /:id, reabrindo o mesmo ataque de
 * preço arbitrário que sale.service.ts já havia fechado no checkout
 * (unitPrice = Number(product.salePrice) só é uma garantia real se
 * ninguém sem autorização puder reescrever esse salePrice). Mesmo padrão
 * já usado em suppliers.routes.ts: GET permanece aberto (uso operacional
 * legítimo, ex.: busca de produto no PDV), escrita agora exige Gerência+.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

const listProductsMock = jest.fn().mockResolvedValue({ products: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getProductByIdMock = jest.fn().mockResolvedValue({ id: 'product-1', name: 'Óleo 10w40', salePrice: 50 });
const createProductMock = jest.fn().mockResolvedValue({ id: 'product-new', name: 'Produto Novo', salePrice: 50 });
const updateProductMock = jest.fn().mockResolvedValue({ id: 'product-1', name: 'Produto Atualizado' });
const deleteProductMock = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/product.service', () => ({
  __esModule: true,
  default: {
    listProducts: (...args: any[]) => listProductsMock(...args),
    getProductById: (...args: any[]) => getProductByIdMock(...args),
    createProduct: (...args: any[]) => createProductMock(...args),
    updateProduct: (...args: any[]) => updateProductMock(...args),
    deleteProduct: (...args: any[]) => deleteProductMock(...args),
  },
}));

jest.mock('@ln-system/database', () => ({
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import productsRoutes from './products.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/products', productsRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('products.routes — guarda de papel em escrita (achado de auditoria: bypass de preço via cadastro)', () => {
  const app = buildApp();

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])(
    'bloqueia %s de criar produto (POST) com 403 — nunca chega a salvar um salePrice arbitrário',
    async (userType) => {
      verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

      const res = await request(app)
        .post('/api/products')
        .set('Authorization', 'Bearer t')
        .send({ sku: 'SKU-1', name: 'Produto Hostil', costPrice: 10, salePrice: 0.01, unit: 'UN' });

      expect(res.status).toBe(403);
      expect(createProductMock).not.toHaveBeenCalled();
    }
  );

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])(
    'bloqueia %s de editar produto (PUT) com 403 — o bypass de preço específico do achado',
    async (userType) => {
      verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

      const res = await request(app)
        .put('/api/products/product-1')
        .set('Authorization', 'Bearer t')
        .send({ salePrice: 0.01 });

      expect(res.status).toBe(403);
      expect(updateProductMock).not.toHaveBeenCalled();
    }
  );

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])('bloqueia %s de apagar produto (DELETE) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app).delete('/api/products/product-1').set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(deleteProductMock).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s criar, editar e apagar produto', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const postRes = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer t')
      .send({ sku: 'SKU-1', name: 'Produto Legítimo', costPrice: 10, salePrice: 20, unit: 'UN' });
    expect(postRes.status).toBe(201);

    const putRes = await request(app)
      .put('/api/products/product-1')
      .set('Authorization', 'Bearer t')
      .send({ salePrice: 25 });
    expect(putRes.status).toBe(200);

    const deleteRes = await request(app).delete('/api/products/product-1').set('Authorization', 'Bearer t');
    expect(deleteRes.status).toBe(200);
  });

  it('NÃO restringe leitura — qualquer usuário autenticado do tenant continua podendo listar/buscar produtos (ex.: PDV)', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/products').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);
    expect(listProductsMock).toHaveBeenCalledTimes(1);

    const getRes = await request(app).get('/api/products/product-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
    expect(getProductByIdMock).toHaveBeenCalledTimes(1);
  });
});
