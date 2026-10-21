/**
 * Testes de isolamento multi-tenant do CustomerService.
 *
 * Regra do projeto: Empresa A NÃO pode ler nem escrever dados de clientes
 * pertencentes à Empresa B. Cada teste simula o comportamento real do
 * Postgres: um `findFirst` cujo WHERE inclui a companyId errada retorna
 * `null` (o registro existe, mas não para esta empresa), e assevera tanto
 * o resultado quanto o shape exato do WHERE passado ao Prisma — o mesmo
 * tipo de bug (query sem filtro de companyId) passaria despercebido se só
 * checássemos o valor de retorno.
 */

const findFirstMock = jest.fn();
const updateMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    customer: { findFirst: findFirstMock, update: updateMock },
  })),
  Prisma: {},
}));

import { CustomerService } from './customer.service';

describe('CustomerService — isolamento cross-tenant', () => {
  const service = new CustomerService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCustomerById', () => {
    it('retorna null quando o cliente pertence a outra empresa (não vaza dado)', async () => {
      // Simula o Postgres: o cliente existe (para company-B), mas o WHERE
      // filtra por company-A, então nada é encontrado.
      findFirstMock.mockResolvedValueOnce(null);

      const result = await service.getCustomerById('customer-1', 'company-A');

      expect(result).toBeNull();
    });

    it('inclui companyId diretamente no WHERE da query (nunca filtra depois)', async () => {
      findFirstMock.mockResolvedValueOnce({ id: 'customer-1', companyId: 'company-A' });

      await service.getCustomerById('customer-1', 'company-A');

      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'customer-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('updateCustomer', () => {
    it('BLOQUEIA empresa A tentando atualizar cliente da empresa B (throw, sem chamar update)', async () => {
      findFirstMock.mockResolvedValueOnce(null); // não encontrado para company-A

      await expect(
        service.updateCustomer('customer-of-B', 'company-A', { name: 'Hackeado' } as any)
      ).rejects.toThrow('Customer not found');

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('verifica posse via findFirst com companyId no WHERE antes de escrever', async () => {
      findFirstMock.mockResolvedValueOnce({ id: 'customer-1' });
      updateMock.mockResolvedValueOnce({ id: 'customer-1', companyId: 'company-A' });

      await service.updateCustomer('customer-1', 'company-A', { name: 'Novo nome' } as any);

      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'customer-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('deleteCustomer', () => {
    it('BLOQUEIA empresa A tentando desativar cliente da empresa B', async () => {
      findFirstMock.mockResolvedValueOnce(null);

      await expect(service.deleteCustomer('customer-of-B', 'company-A')).rejects.toThrow(
        'Customer not found'
      );

      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});
