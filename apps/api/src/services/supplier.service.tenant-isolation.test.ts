/**
 * Testes de isolamento multi-tenant do SupplierService.
 * Ver customer.service.tenant-isolation.test.ts para a explicação da
 * estratégia (findFirst retornando null simula o filtro real do Postgres).
 */

const findFirstMock = jest.fn();
const updateMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    supplier: { findFirst: findFirstMock, update: updateMock },
  })),
  Prisma: {},
}));

import { SupplierService } from './supplier.service';

describe('SupplierService — isolamento cross-tenant', () => {
  const service = new SupplierService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getById', () => {
    it('retorna null para fornecedor de outra empresa', async () => {
      findFirstMock.mockResolvedValueOnce(null);

      const result = await service.getById('supplier-of-B', 'company-A');

      expect(result).toBeNull();
    });

    it('inclui companyId no WHERE', async () => {
      findFirstMock.mockResolvedValueOnce({ id: 'supplier-1', companyId: 'company-A' });

      await service.getById('supplier-1', 'company-A');

      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'supplier-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('update', () => {
    it('BLOQUEIA empresa A atualizando fornecedor da empresa B', async () => {
      findFirstMock.mockResolvedValueOnce(null);

      await expect(
        service.update('supplier-of-B', 'company-A', { name: 'Hackeado' } as any)
      ).rejects.toThrow('Supplier not found');

      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('BLOQUEIA empresa A desativando fornecedor da empresa B', async () => {
      findFirstMock.mockResolvedValueOnce(null);

      await expect(service.deactivate('supplier-of-B', 'company-A')).rejects.toThrow(
        'Supplier not found'
      );

      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});
