/**
 * ACHADO DE AUDITORIA: returnSale fazia o MESMO estorno financeiro que
 * cancelSale (payment -> REFUNDED, CashMovement decrementando
 * expectedAmount) mas, diferente de cancelSale, não exigia NENHUMA
 * autorização além de estar autenticado no tenant — até VIEWER conseguia
 * processar um reembolso real em qualquer venda. Este arquivo cobre a
 * dupla autorização adicionada (mesmo mecanismo de cancelSale) e a lógica
 * de devolução total/parcial em si, que nunca tinha teste algum.
 */

const findFirstSaleMock = jest.fn();
const findFirstUserMock = jest.fn();
const findUniqueCashRegisterMock = jest.fn();
const saleItemUpdateManyMock = jest.fn();
const saleItemFindManyMock = jest.fn();
const saleUpdateMock = jest.fn();
const saleLockMock = jest.fn();
const stockMovementCreateMock = jest.fn();
const paymentUpdateManyMock = jest.fn();
const cashMovementCreateMock = jest.fn();
const cashRegisterUpdateMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    sale: { findFirst: findFirstSaleMock, update: saleUpdateMock },
    saleItem: { updateMany: saleItemUpdateManyMock, findMany: saleItemFindManyMock },
    user: { findFirst: findFirstUserMock },
    cashRegister: { findUnique: findUniqueCashRegisterMock, update: cashRegisterUpdateMock },
    stockMovement: { create: stockMovementCreateMock },
    payment: { updateMany: paymentUpdateManyMock },
    cashMovement: { create: cashMovementCreateMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

jest.mock('@ln-system/shared/utils/password', () => ({
  comparePassword: jest.fn(),
}));

const verifyCodeMock = jest.fn();
jest.mock('./MFAService', () => ({
  mfaService: {
    verifyCode: (...args: any[]) => verifyCodeMock(...args),
    verifyBackupCode: jest.fn().mockReturnValue({ valid: false }),
  },
}));

import { SaleService } from './sale.service';
import { comparePassword } from '@ln-system/shared/utils/password';

function baseSale(overrides: Partial<any> = {}) {
  return {
    id: 'sale-1',
    companyId: 'company-A',
    branchId: 'branch-1',
    cashRegisterId: 'register-1',
    saleNumber: 123,
    status: 'PAID',
    items: [
      { id: 'item-1', productId: 'product-1', productName: 'Óleo', quantity: 2, returnedQuantity: 0, unitPrice: 50, totalPrice: 100 },
    ],
    payments: [],
    ...overrides,
  };
}

function baseAuthorizer(overrides: Partial<any> = {}) {
  return {
    id: 'authorizer-1',
    name: 'Carlos',
    companyId: 'company-A',
    userType: 'MANAGER',
    isActive: true,
    lockedUntil: null,
    password: 'hashed',
    mfaEnabled: false,
    mfaSecret: null,
    mfaBackupCodes: [],
    ...overrides,
  };
}

function baseRequest(overrides: Partial<any> = {}) {
  return {
    id: 'sale-1',
    companyId: 'company-A',
    requesterId: 'requester-1',
    reason: 'Produto com defeito',
    authorizerNumericId: 123456,
    authorizerPassword: 'senha-correta',
    ...overrides,
  };
}

describe('SaleService.returnSale — dupla autorização (mesmo mecanismo de cancelSale)', () => {
  const service = new SaleService();

  beforeEach(() => {
    jest.clearAllMocks();
    transactionMock.mockImplementation(async (cb: any) =>
      cb({
        sale: { update: saleUpdateMock, updateMany: saleLockMock },
        saleItem: { updateMany: saleItemUpdateManyMock, findMany: saleItemFindManyMock },
        stockMovement: { create: stockMovementCreateMock },
        payment: { updateMany: paymentUpdateManyMock },
        cashRegister: { findUnique: findUniqueCashRegisterMock, update: cashRegisterUpdateMock },
        cashMovement: { create: cashMovementCreateMock },
      })
    );
    saleItemUpdateManyMock.mockResolvedValue({ count: 1 });
    saleItemFindManyMock.mockResolvedValue([{ id: 'item-1', quantity: 2, returnedQuantity: 2, unitPrice: 50, totalPrice: 100 }]);
    saleLockMock.mockResolvedValue({ count: 1 });
    saleUpdateMock.mockResolvedValue({ id: 'sale-1', status: 'RETURNED', items: [], payments: [] });
    stockMovementCreateMock.mockResolvedValue({});
    paymentUpdateManyMock.mockResolvedValue({ count: 0 });
    cashMovementCreateMock.mockResolvedValue({ id: 'mov-1' });
    cashRegisterUpdateMock.mockResolvedValue({});
    (comparePassword as jest.Mock).mockResolvedValue(true);
  });

  it('venda não encontrada', async () => {
    findFirstSaleMock.mockResolvedValueOnce(null);
    await expect(service.returnSale(baseRequest())).rejects.toThrow('Sale not found');
  });

  it('rejeita devolver venda cancelada', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale({ status: 'CANCELLED' }));
    await expect(service.returnSale(baseRequest())).rejects.toThrow('Cannot return a cancelled sale');
  });

  it('rejeita motivo vazio/curto', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    await expect(service.returnSale(baseRequest({ reason: 'ok' }))).rejects.toThrow('Reason is required');
  });

  it('rejeita autoautorização: solicitante não pode autorizar a própria devolução', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ id: 'requester-1' }));

    await expect(
      service.returnSale(baseRequest({ requesterId: 'requester-1' }))
    ).rejects.toThrow('cannot authorize their own sale return');
    expect(saleItemUpdateManyMock).not.toHaveBeenCalled();
  });

  it('rejeita autorizador sem permissão (ex: OPERATOR) — antes desta correção QUALQUER papel, inclusive VIEWER, passava direto', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ userType: 'OPERATOR' }));

    await expect(service.returnSale(baseRequest())).rejects.toThrow('does not have permission to approve');
    expect(saleItemUpdateManyMock).not.toHaveBeenCalled();
  });

  it('rejeita senha do autorizador inválida', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    (comparePassword as jest.Mock).mockResolvedValueOnce(false);

    await expect(service.returnSale(baseRequest())).rejects.toThrow('Invalid authorizer credentials');
    expect(saleItemUpdateManyMock).not.toHaveBeenCalled();
  });

  it('rejeita código MFA ausente quando autorizador tem MFA habilitado', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));

    await expect(service.returnSale(baseRequest())).rejects.toThrow('MFA code is required');
  });

  it('devolução TOTAL (sem informar items — omitindo items, como o PDV chama): devolve tudo que resta, marca pagamento REFUNDED e estorna o caixa', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ payments: [{ id: 'pay-1', status: 'APPROVED', amount: 100, paymentMethod: 'CASH' }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    findUniqueCashRegisterMock.mockResolvedValueOnce({ id: 'register-1', status: 'OPEN' });

    const result = await service.returnSale(baseRequest());

    expect(saleItemUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'item-1', returnedQuantity: { lte: 0 } },
      data: { returnedQuantity: { increment: 2 } },
    });
    expect(stockMovementCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'RETURN', quantity: 2 }) })
    );
    expect(paymentUpdateManyMock).toHaveBeenCalledWith({
      where: { saleId: 'sale-1', status: 'APPROVED' },
      data: { status: 'REFUNDED', refundedAt: expect.any(Date) },
    });
    expect(cashMovementCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        movementType: 'RETURN',
        amount: 100,
        requestedBy: 'requester-1',
        authorizedBy: 'authorizer-1', // o AUTORIZADOR, não o solicitante — achado corrigido junto
      }),
    });
    expect(result.cashAdjusted).toBe(true);
    expect(result.authorizer.name).toBe('Carlos');
  });

  it('devolução PARCIAL (informando items): NÃO marca pagamento REFUNDED (não há certeza de estorno total), mas ajusta o caixa proporcionalmente', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({
        items: [
          { id: 'item-1', productId: 'product-1', productName: 'Óleo', quantity: 4, returnedQuantity: 0, unitPrice: 50, totalPrice: 200 },
        ],
        payments: [{ id: 'pay-1', status: 'APPROVED', amount: 200, paymentMethod: 'CASH' }],
      })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    findUniqueCashRegisterMock.mockResolvedValueOnce({ id: 'register-1', status: 'OPEN' });
    saleItemFindManyMock.mockResolvedValueOnce([{ id: 'item-1', quantity: 4, returnedQuantity: 2, unitPrice: 50, totalPrice: 200 }]); // 2 de 4 devolvidos = parcial

    const result = await service.returnSale(baseRequest({ items: [{ saleItemId: 'item-1', quantity: 2 }] }));

    expect(paymentUpdateManyMock).not.toHaveBeenCalled();
    expect(cashMovementCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 100 }) }) // 2 unidades x R$50
    );
    expect(result.cashAdjusted).toBe(true);
  });

  it('rejeita devolver quantidade maior do que resta no item', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ items: [{ id: 'item-1', productId: 'p1', productName: 'Óleo', quantity: 2, returnedQuantity: 1, unitPrice: 50, totalPrice: 100 }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());

    await expect(
      service.returnSale(baseRequest({ items: [{ saleItemId: 'item-1', quantity: 5 }] }))
    ).rejects.toThrow('Return quantity exceeds remaining sold quantity');
  });

  it('rejeita quando não resta nada para devolver (venda já totalmente devolvida)', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ items: [{ id: 'item-1', productId: 'p1', productName: 'Óleo', quantity: 2, returnedQuantity: 2, unitPrice: 50, totalPrice: 100 }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());

    await expect(service.returnSale(baseRequest())).rejects.toThrow('Nothing left to return on this sale');
  });

  it('devolução concorrente do mesmo item: updateMany afeta 0 linhas quando outra devolução já commitou primeiro', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    saleItemUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(service.returnSale(baseRequest())).rejects.toThrow('Concurrent return detected');

    expect(paymentUpdateManyMock).not.toHaveBeenCalled();
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });
});
