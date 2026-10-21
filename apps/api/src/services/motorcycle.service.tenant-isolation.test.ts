/**
 * Testes de isolamento multi-tenant do MotorcycleService.
 * Ver customer.service.tenant-isolation.test.ts para a explicação da
 * estratégia (findFirst retornando null simula o filtro real do Postgres).
 */

const findFirstCustomerMock = jest.fn();
const findFirstMotoMock = jest.fn();
const updateMotoMock = jest.fn();
const createMotoMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    customer: { findFirst: findFirstCustomerMock },
    motorcycle: { findFirst: findFirstMotoMock, update: updateMotoMock, create: createMotoMock },
  })),
  Prisma: {},
}));

import { MotorcycleService } from './motorcycle.service';

describe('MotorcycleService — isolamento cross-tenant', () => {
  const service = new MotorcycleService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('BLOQUEIA vincular moto a cliente de outra empresa', async () => {
      findFirstCustomerMock.mockResolvedValueOnce(null); // cliente não pertence a company-A

      await expect(
        service.create({
          companyId: 'company-A',
          customerId: 'customer-of-B',
          brand: 'Honda',
          model: 'CG',
          kilometerReading: 0,
        })
      ).rejects.toThrow('Customer not found');

      expect(createMotoMock).not.toHaveBeenCalled();
    });

    it('valida o cliente com companyId no WHERE antes de criar', async () => {
      findFirstCustomerMock.mockResolvedValueOnce({ id: 'customer-1' });
      createMotoMock.mockResolvedValueOnce({ id: 'moto-1' });

      await service.create({
        companyId: 'company-A',
        customerId: 'customer-1',
        brand: 'Honda',
        model: 'CG',
        kilometerReading: 0,
      });

      expect(findFirstCustomerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'customer-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('getById', () => {
    it('retorna null para moto de outra empresa', async () => {
      findFirstMotoMock.mockResolvedValueOnce(null);

      const result = await service.getById('moto-of-B', 'company-A');

      expect(result).toBeNull();
    });

    it('inclui companyId no WHERE', async () => {
      findFirstMotoMock.mockResolvedValueOnce({ id: 'moto-1', companyId: 'company-A' });

      await service.getById('moto-1', 'company-A');

      expect(findFirstMotoMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'moto-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('update', () => {
    it('BLOQUEIA empresa A atualizando moto da empresa B', async () => {
      findFirstMotoMock.mockResolvedValueOnce(null);

      await expect(
        service.update('moto-of-B', 'company-A', { brand: 'Hackeado' } as any)
      ).rejects.toThrow('Motorcycle not found');

      expect(updateMotoMock).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('BLOQUEIA empresa A desativando moto da empresa B', async () => {
      findFirstMotoMock.mockResolvedValueOnce(null);

      await expect(service.deactivate('moto-of-B', 'company-A')).rejects.toThrow(
        'Motorcycle not found'
      );

      expect(updateMotoMock).not.toHaveBeenCalled();
    });
  });
});
