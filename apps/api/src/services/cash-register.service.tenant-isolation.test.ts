/**
 * Testes de isolamento multi-tenant do CashRegisterService.
 * Ver customer.service.tenant-isolation.test.ts para a explicação da
 * estratégia (findFirst retornando null simula o filtro real do Postgres).
 *
 * addCashMovement é especialmente sensível: o comentário no próprio service
 * documenta um IDOR histórico corrigido ali (sangria/reforço em caixa de
 * outra empresa apenas acertando o cashRegisterId). Este teste é a
 * regressão que garante que a correção não seja removida por acidente.
 */

const findFirstMock = jest.fn();
const updateMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    cashRegister: { findFirst: findFirstMock, update: updateMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

import { CashRegisterService } from './cash-register.service';

describe('CashRegisterService — isolamento cross-tenant', () => {
  const service = new CashRegisterService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCashRegisterById', () => {
    it('retorna null para caixa de outra empresa', async () => {
      findFirstMock.mockResolvedValueOnce(null);

      const result = await service.getCashRegisterById('register-of-B', 'company-A');

      expect(result).toBeNull();
    });

    it('inclui companyId no WHERE', async () => {
      findFirstMock.mockResolvedValueOnce({ id: 'register-1', companyId: 'company-A' });

      await service.getCashRegisterById('register-1', 'company-A');

      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'register-1', companyId: 'company-A' }),
        })
      );
    });
  });

  describe('closeCashRegister', () => {
    it('BLOQUEIA empresa A fechando caixa da empresa B', async () => {
      findFirstMock.mockResolvedValueOnce(null);

      await expect(
        service.closeCashRegister('register-of-B', 'company-A', {
          actualAmount: 100,
          closedBy: 'user-1',
        })
      ).rejects.toThrow('Cash register not found or already closed');

      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe('addCashMovement — regressão do IDOR histórico', () => {
    // WITHDRAWAL não passa mais por addCashMovement (rejeitado antes de
    // qualquer consulta ao banco — ver CashRegisterService.requestWithdrawal,
    // que exige dupla autorização e tem sua própria suíte de isolamento
    // multi-tenant em cash-register.service.withdrawal.test.ts). Este teste
    // agora garante que a rejeição é imediata e não injeta valor não
    // consumido em findFirstMock (que vazaria para o próximo teste).
    it('rejeita WITHDRAWAL em addCashMovement sem sequer consultar o banco', async () => {
      await expect(
        service.addCashMovement({
          cashRegisterId: 'register-of-B',
          companyId: 'company-A',
          movementType: 'WITHDRAWAL',
          amount: 50,
          userId: 'attacker-user',
        })
      ).rejects.toThrow('exige autorização de um segundo usuário');

      expect(findFirstMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('BLOQUEIA empresa A lançando reforço (DEPOSIT) em caixa da empresa B', async () => {
      findFirstMock.mockResolvedValueOnce(null); // caixa não encontrado para company-A

      await expect(
        service.addCashMovement({
          cashRegisterId: 'register-of-B',
          companyId: 'company-A',
          movementType: 'DEPOSIT',
          amount: 50,
          userId: 'attacker-user',
        })
      ).rejects.toThrow('Cash register not found or already closed');

      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('a checagem de posse inclui companyId E status OPEN no WHERE', async () => {
      findFirstMock.mockResolvedValueOnce({
        id: 'register-1',
        companyId: 'company-A',
        expectedAmount: 100,
      });
      transactionMock.mockImplementationOnce(async (cb: any) =>
        cb({
          cashMovement: { create: jest.fn().mockResolvedValue({ id: 'mov-1' }) },
          cashRegister: { update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        })
      );

      await service.addCashMovement({
        cashRegisterId: 'register-1',
        companyId: 'company-A',
        movementType: 'DEPOSIT',
        amount: 50,
        userId: 'user-1',
      });

      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'register-1',
            companyId: 'company-A',
            status: 'OPEN',
          }),
        })
      );
    });
  });
});
