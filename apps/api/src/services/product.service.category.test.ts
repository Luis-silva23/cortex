/**
 * ACHADOS DE AUDITORIA (produtos):
 * 1) criar produto sem categoria mandava `categoryId: ''`; o schema aceitava a
 *    string vazia e o Prisma a gravava, violando products_categoryId_fkey → 400
 *    (o formulário do admin-web sempre falhava sem categoria);
 * 2) editar para "Sem categoria" mandava `null`, que o schema rejeitava (400),
 *    e o formulário lia `status` (que não existe) em vez de `isActive`, que o
 *    schema de edição descartava;
 * 3) `categoryId` de OUTRA empresa passava (a FK só exige que a linha exista).
 */

const findFirstProductMock = jest.fn();
const createProductMock = jest.fn();
const updateProductMock = jest.fn();
const findFirstCategoryMock = jest.fn();
const findFirstBranchMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    product: { findFirst: findFirstProductMock, create: createProductMock, update: updateProductMock },
    category: { findFirst: findFirstCategoryMock },
    branch: { findFirst: findFirstBranchMock },
  })),
  Prisma: {},
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  },
  CacheKeys: { product: (id: string) => `product:${id}` },
  CacheTTL: { PRODUCTS_LIST: 300, PRODUCT_DETAILS: 600 },
}));

import { productSchema, updateProductSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { ProductService } from './product.service';

const base = { companyId: 'company-A', sku: 'SKU-1', name: 'Filtro', costPrice: 5, salePrice: 10, unit: 'UN' };

describe('productSchema — categoryId', () => {
  it("'' (sem categoria no formulário) vira ausente — não vai para o banco como string vazia", () => {
    expect(productSchema.parse({ ...base, categoryId: '' }).categoryId).toBeUndefined();
    expect(productSchema.parse({ ...base, categoryId: '   ' }).categoryId).toBeUndefined();
  });

  it('um id de categoria segue como veio', () => {
    expect(productSchema.parse({ ...base, categoryId: 'cat-1' }).categoryId).toBe('cat-1');
    expect(productSchema.parse(base).categoryId).toBeUndefined();
  });
});

describe('updateProductSchema — categoryId e isActive', () => {
  it('null remove a categoria (antes era 400)', () => {
    expect(updateProductSchema.parse({ categoryId: null }).categoryId).toBeNull();
  });

  it("'' também remove (formulário)", () => {
    expect(updateProductSchema.parse({ categoryId: '' }).categoryId).toBeNull();
  });

  it('omitir categoryId não mexe na categoria', () => {
    expect('categoryId' in updateProductSchema.parse({ name: 'Novo nome' })).toBe(false);
  });

  it('isActive é aceito (ativar/desativar pelo formulário) e só como boolean', () => {
    expect(updateProductSchema.parse({ isActive: false }).isActive).toBe(false);
    expect(() => updateProductSchema.parse({ isActive: 'INACTIVE' })).toThrow();
  });

  it('companyId continua fora da edição (não dá para trocar o dono do produto)', () => {
    expect('companyId' in updateProductSchema.parse({ companyId: 'company-B', name: 'x' })).toBe(false);
  });
});

describe('ProductService — categoria precisa ser da empresa', () => {
  const service = new ProductService();

  beforeEach(() => {
    jest.clearAllMocks();
    createProductMock.mockResolvedValue({ id: 'p1' });
    updateProductMock.mockResolvedValue({ id: 'p1' });
    findFirstProductMock.mockResolvedValue({ id: 'p1' });
  });

  it('criar com categoria de OUTRA empresa é rejeitado e nada é gravado', async () => {
    findFirstCategoryMock.mockResolvedValueOnce(null);

    await expect(service.createProduct({ ...base, categoryId: 'cat-de-B' } as any)).rejects.toThrow(
      'Categoria informada não existe nesta empresa'
    );
    expect(findFirstCategoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cat-de-B', companyId: 'company-A' } })
    );
    expect(createProductMock).not.toHaveBeenCalled();
  });

  it('criar com categoria da própria empresa funciona', async () => {
    findFirstCategoryMock.mockResolvedValueOnce({ id: 'cat-1' });
    await service.createProduct({ ...base, categoryId: 'cat-1' } as any);
    expect(createProductMock).toHaveBeenCalledTimes(1);
  });

  it('criar sem categoria nem consulta categorias', async () => {
    await service.createProduct(base as any);
    expect(findFirstCategoryMock).not.toHaveBeenCalled();
    expect(createProductMock).toHaveBeenCalledTimes(1);
  });

  it('editar: categoryId null remove a categoria sem consultar', async () => {
    await service.updateProduct('p1', 'company-A', { categoryId: null } as any);
    expect(findFirstCategoryMock).not.toHaveBeenCalled();
    expect(updateProductMock).toHaveBeenCalledTimes(1);
  });

  it('editar: categoria de OUTRA empresa é rejeitada e nada é gravado', async () => {
    findFirstCategoryMock.mockResolvedValueOnce(null);

    await expect(service.updateProduct('p1', 'company-A', { categoryId: 'cat-de-B' } as any)).rejects.toThrow(
      'Categoria informada não existe nesta empresa'
    );
    expect(updateProductMock).not.toHaveBeenCalled();
  });

  it('editar sem mexer na categoria não consulta categorias (ex.: só isActive)', async () => {
    await service.updateProduct('p1', 'company-A', { isActive: false } as any);
    expect(findFirstCategoryMock).not.toHaveBeenCalled();
    expect(updateProductMock).toHaveBeenCalledWith(expect.objectContaining({ data: { isActive: false } }));
  });
});
