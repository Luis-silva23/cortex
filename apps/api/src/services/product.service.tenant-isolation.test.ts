/**
 * Testes de isolamento multi-tenant do ProductService.
 *
 * getProductStock/checkStock tiveram um vazamento cross-tenant de saldo de
 * estoque documentado e corrigido no próprio service (ver comentário em
 * product.service.ts, método getProductStock): antes da correção, qualquer
 * empresa conseguia consultar o saldo de estoque de um produto de outra
 * empresa apenas acertando o UUID, pois a query de StockMovement não
 * validava a posse do produto antes. Este arquivo é a regressão para essa
 * correção — se alguém remover a checagem `productExists`, estes testes
 * devem falhar.
 */

const findFirstProductMock = jest.fn();
const updateProductMock = jest.fn();
const findManyMovementMock = jest.fn();

// Saldo: regra do livro em memória sobre o mock de stockMovement.findMany (ver __mocks__/stock-ledger.ts).
jest.mock('./stock-ledger');

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    product: { findFirst: findFirstProductMock, update: updateProductMock },
    stockMovement: { findMany: findManyMovementMock },
  })),
  Prisma: {},
}));

// Cache real usa Redis — mockamos a instância singleton exportada por
// cache.service para sempre dar "cache miss" e não tocar em infra externa.
jest.mock('./cache.service', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  },
  CacheKeys: {
    product: (id: string) => `product:${id}`,
    productStock: (id: string, branchId?: string) => `product-stock:${id}:${branchId || ''}`,
  },
  CacheTTL: {
    PRODUCTS_LIST: 300,
    PRODUCT_DETAILS: 600,
    CURRENT_STOCK: 180,
  },
}));

import { ProductService } from './product.service';

describe('ProductService — isolamento cross-tenant', () => {
  const service = new ProductService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getProductById', () => {
    it('retorna null para produto de outra empresa', async () => {
      findFirstProductMock.mockResolvedValueOnce(null);

      const result = await service.getProductById('product-of-B', 'company-A');

      expect(result).toBeNull();
    });

    it('inclui companyId no WHERE', async () => {
      findFirstProductMock.mockResolvedValueOnce({ id: 'product-1', companyId: 'company-A' });

      await service.getProductById('product-1', 'company-A');

      expect(findFirstProductMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'product-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('updateProduct', () => {
    it('BLOQUEIA empresa A atualizando produto da empresa B', async () => {
      findFirstProductMock.mockResolvedValueOnce(null);

      await expect(
        service.updateProduct('product-of-B', 'company-A', { name: 'Hackeado' } as any)
      ).rejects.toThrow('Product not found');

      expect(updateProductMock).not.toHaveBeenCalled();
    });
  });

  describe('deleteProduct', () => {
    it('BLOQUEIA empresa A desativando produto da empresa B', async () => {
      findFirstProductMock.mockResolvedValueOnce(null);

      await expect(service.deleteProduct('product-of-B', 'company-A')).rejects.toThrow(
        'Product not found'
      );

      expect(updateProductMock).not.toHaveBeenCalled();
    });
  });

  describe('getProductStock — regressão do vazamento de saldo de estoque', () => {
    it('BLOQUEIA empresa A consultando saldo de estoque de produto da empresa B', async () => {
      findFirstProductMock.mockResolvedValueOnce(null); // produto não pertence a company-A

      await expect(service.getProductStock('product-of-B', 'company-A')).rejects.toThrow(
        'Product not found'
      );

      // Se a checagem de posse fosse removida, isto seria chamado mesmo
      // sem o produto pertencer à empresa — a asserção abaixo garante que
      // a query de movimentações nunca roda antes da validação de posse.
      expect(findManyMovementMock).not.toHaveBeenCalled();
    });

    it('valida a posse do produto com companyId no WHERE antes de calcular o saldo', async () => {
      findFirstProductMock.mockResolvedValueOnce({ id: 'product-1' });
      findManyMovementMock.mockResolvedValueOnce([]);

      await service.getProductStock('product-1', 'company-A');

      expect(findFirstProductMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'product-1', companyId: 'company-A' }),
        })
      );
      expect(findManyMovementMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ productId: 'product-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('checkStock — regressão do vazamento de saldo de estoque', () => {
    it('BLOQUEIA empresa A verificando estoque de produto da empresa B', async () => {
      findFirstProductMock.mockResolvedValueOnce(null); // produto não pertence a company-A

      await expect(service.checkStock('product-of-B', 'company-A', 1)).rejects.toThrow(
        'Product not found'
      );

      expect(findManyMovementMock).not.toHaveBeenCalled();
    });
  });
});
