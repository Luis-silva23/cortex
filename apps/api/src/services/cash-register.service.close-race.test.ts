/**
 * Teste de regressão do achado de auditoria: `closeCashRegister` fazia o
 * `findFirst` com `status: 'OPEN'` FORA da transação e depois um
 * `tx.cashRegister.update({ where: { id } })` SEM checar status de novo —
 * um TOCTOU clássico. Duas chamadas quase simultâneas (duplo clique em
 * "Fechar Caixa", ou um retry de rede) podiam ambas passar pelo `findFirst`
 * lendo "está aberto" e ambas fechar o caixa: dois CashMovement de CLOSING
 * seriam criados, e a que commitasse por último sobrescreveria
 * silenciosamente actualAmount/difference/closedBy/notes do fechamento
 * oficial do dia.
 *
 * A correção move a checagem de status para dentro da transação, como um
 * `updateMany({ where: { id, companyId, status: 'OPEN' } })` — mesmo padrão
 * já usado em payment.service.ts::cancelPayment/refundPayment. Este teste
 * trava que a segunda chamada perde a corrida de forma limpa (erro de
 * negócio claro), não silenciosamente.
 */

const findFirstMock = jest.fn();
const updateManyMock = jest.fn();
const findUniqueOrThrowMock = jest.fn();
const cashMovementCreateMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    cashRegister: { findFirst: findFirstMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

// Política de caixa (docs/CORTEX/policies/CAIXA.md) lida no fechamento: padrão (bloqueia com pendências).
const effectiveMock = jest.fn();
jest.mock('./policy.service', () => ({ policyService: { effective: (...a: any[]) => effectiveMock(...a) } }));
const saleFindManyMock = jest.fn();
const paymentFindManyMock = jest.fn();

import { CashRegisterService, CashClosePendingError } from './cash-register.service';

describe('CashRegisterService.closeCashRegister — guarda atômica contra fechamento concorrente', () => {
  const service = new CashRegisterService();

  beforeEach(() => {
    jest.clearAllMocks();
    effectiveMock.mockResolvedValue({ 'cash.blockCloseWithPendingPayments': true, 'cash.blockCloseWithOpenSales': true, 'cash.forceCloseRoles': ['MANAGER', 'COMPANY_ADMIN'] });
    saleFindManyMock.mockResolvedValue([]);
    paymentFindManyMock.mockResolvedValue([]);
    // Simula runInTransaction chamando o callback com um tx cujo
    // cashRegister expõe updateMany/findUniqueOrThrow (não update — a
    // correção não usa mais update simples aqui).
    transactionMock.mockImplementation(async (cb: any) =>
      cb({
        cashRegister: { updateMany: updateManyMock, findUniqueOrThrow: findUniqueOrThrowMock, update: jest.fn() },
        // Movimentos relidos dentro da transação (esperado × informado): abertura de 100 = valor informado nos testes.
        cashMovement: { create: cashMovementCreateMock, findMany: jest.fn().mockResolvedValue([{ movementType: 'OPENING', amount: 100 }]) },
        sale: { findMany: saleFindManyMock },
        payment: { findMany: paymentFindManyMock },
        user: { findMany: jest.fn().mockResolvedValue([]) },
      })
    );
  });

  it('a checagem de status acontece via updateMany dentro da transação (compare-and-swap), não via update simples', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'register-1',
      companyId: 'company-A',
      status: 'OPEN',
      movements: [],
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'register-1', status: 'CLOSED', movements: [] });

    await service.closeCashRegister('register-1', 'company-A', { actualAmount: 100, closedBy: 'user-1' });

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'register-1', companyId: 'company-A', status: 'OPEN' }),
      })
    );
  });

  it('quando duas chamadas concorrentes passam pelo findFirst, a que perde a corrida no updateMany (count=0) falha com erro claro — não fecha em dobro', async () => {
    // Ambas as "chamadas" leem o mesmo estado ANTES de qualquer uma
    // commitar (a condição de corrida que o findFirst sozinho não pega).
    findFirstMock.mockResolvedValueOnce({
      id: 'register-1',
      companyId: 'company-A',
      status: 'OPEN',
      movements: [],
    });

    // A "primeira" transação a chegar no banco já fechou o registro —
    // updateMany desta chamada não encontra mais nenhuma linha com
    // status:'OPEN' para atualizar.
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.closeCashRegister('register-1', 'company-A', { actualAmount: 100, closedBy: 'user-2' })
    ).rejects.toThrow('Cash register not found or already closed');

    // Nunca cria um segundo CashMovement de CLOSING para o caixa já fechado
    // por outra transação.
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
    expect(findUniqueOrThrowMock).not.toHaveBeenCalled();
  });

  it('sucesso: cria exatamente um CashMovement de CLOSING quando ganha a corrida (count=1)', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'register-1',
      companyId: 'company-A',
      status: 'OPEN',
      movements: [{ movementType: 'OPENING', amount: 100 }],
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'register-1', status: 'CLOSED', movements: [] });
    cashMovementCreateMock.mockResolvedValueOnce({ id: 'mov-closing-1' });

    await service.closeCashRegister('register-1', 'company-A', { actualAmount: 100, closedBy: 'user-1' });

    expect(cashMovementCreateMock).toHaveBeenCalledTimes(1);
    expect(cashMovementCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'CLOSING' }) })
    );
  });

  it('pendências com a política bloqueando: 409 CASH_CLOSE_PENDING com a lista e os valores; nenhum CLOSING gravado', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'register-1', companyId: 'company-A', branchId: 'branch-1', status: 'OPEN', movements: [] });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentFindManyMock.mockResolvedValueOnce([
      { id: 'pay-1', saleId: 'sale-1', paymentMethod: 'PIX', amount: 30, createdAt: new Date(), sale: { saleNumber: 7 } },
    ]);
    saleFindManyMock.mockResolvedValueOnce([
      { id: 'sale-1', saleNumber: 7, status: 'PENDING', totalAmount: 30, paidAmount: 0, saleDate: new Date() },
    ]);

    const error = await service.closeCashRegister('register-1', 'company-A', { actualAmount: 100, closedBy: 'user-1' }).catch((e) => e);
    expect(error).toBeInstanceOf(CashClosePendingError);
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('CASH_CLOSE_PENDING');
    expect(error.details.totals).toEqual({ pendingPaymentsCount: 1, pendingPaymentsAmount: 30, openSalesCount: 1, openSalesBalance: 30 });
    expect(error.details.blockedBy).toEqual(['PENDING_PAYMENTS', 'OPEN_SALES']);
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('política desligada: fecha normalmente mesmo com venda em aberto (pendência vai para o pendingSnapshot)', async () => {
    effectiveMock.mockResolvedValueOnce({ 'cash.blockCloseWithPendingPayments': false, 'cash.blockCloseWithOpenSales': false, 'cash.forceCloseRoles': ['MANAGER'] });
    findFirstMock.mockResolvedValueOnce({ id: 'register-1', companyId: 'company-A', branchId: 'branch-1', status: 'OPEN', movements: [] });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    saleFindManyMock.mockResolvedValueOnce([{ id: 'sale-1', saleNumber: 7, status: 'PENDING', totalAmount: 30, paidAmount: 0, saleDate: new Date() }]);
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'register-1', status: 'CLOSED', movements: [] });

    await service.closeCashRegister('register-1', 'company-A', { actualAmount: 100, closedBy: 'user-1' });
    expect(cashMovementCreateMock).toHaveBeenCalledTimes(1);
  });
});
