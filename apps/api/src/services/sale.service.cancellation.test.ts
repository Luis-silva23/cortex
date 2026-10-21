/**
 * Cancelamento de venda finalizada — dupla autorização, reversão de
 * estoque e reversão financeira (caixa). Cobre exatamente os cenários da
 * especificação: sem permissão, autoautorização bloqueada, MFA
 * inválido/ausente, dinheiro/cartão/PIX aprovados, e o caixa já fechado
 * (não deve tentar reescrever um fechamento imutável).
 */

const findFirstSaleMock = jest.fn();
const findFirstUserMock = jest.fn();
const updateUserMock = jest.fn();
const updateManyUserMock = jest.fn();
const findUniqueUserMock = jest.fn();
const findUniqueCashRegisterMock = jest.fn();
const saleUpdateManyMock = jest.fn();
const saleFindUniqueOrThrowMock = jest.fn();
const stockMovementCreateMock = jest.fn();
const paymentUpdateManyMock = jest.fn();
const cashMovementCreateMock = jest.fn();
const cashRegisterUpdateMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    sale: { findFirst: findFirstSaleMock, updateMany: saleUpdateManyMock, findUniqueOrThrow: saleFindUniqueOrThrowMock },
    user: { findFirst: findFirstUserMock, update: updateUserMock, updateMany: updateManyUserMock, findUnique: findUniqueUserMock },
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
    items: [{ id: 'item-1', productId: 'product-1', quantity: 2 }],
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
    reason: 'Cliente desistiu da compra',
    authorizerNumericId: 123456,
    authorizerPassword: 'senha-correta',
    ...overrides,
  };
}

describe('SaleService.cancelSale — dupla autorização', () => {
  const service = new SaleService();

  beforeEach(() => {
    jest.clearAllMocks();
    transactionMock.mockImplementation(async (cb: any) =>
      cb({
        sale: { updateMany: saleUpdateManyMock, findUniqueOrThrow: saleFindUniqueOrThrowMock },
        stockMovement: { create: stockMovementCreateMock },
        payment: { updateMany: paymentUpdateManyMock },
        cashRegister: { findUnique: findUniqueCashRegisterMock, update: cashRegisterUpdateMock },
        cashMovement: { create: cashMovementCreateMock },
      })
    );
    saleUpdateManyMock.mockResolvedValue({ count: 1 });
    // Itens relidos dentro da transação (depois do lock de status) — é deles que sai o que repor/estornar.
    saleFindUniqueOrThrowMock.mockResolvedValue({
      id: 'sale-1',
      status: 'CANCELLED',
      items: [{ id: 'item-1', productId: 'product-1', quantity: 2, returnedQuantity: 0, unitPrice: 50, totalPrice: 100 }],
      payments: [],
    });
    stockMovementCreateMock.mockResolvedValue({});
    paymentUpdateManyMock.mockResolvedValue({ count: 0 });
    cashMovementCreateMock.mockResolvedValue({ id: 'mov-1' });
    cashRegisterUpdateMock.mockResolvedValue({});
    (comparePassword as jest.Mock).mockResolvedValue(true);
  });

  it('venda não encontrada', async () => {
    findFirstSaleMock.mockResolvedValueOnce(null);
    await expect(service.cancelSale(baseRequest())).rejects.toThrow('Sale not found');
  });

  it('rejeita cancelar venda já cancelada', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale({ status: 'CANCELLED' }));
    await expect(service.cancelSale(baseRequest())).rejects.toThrow('Sale already cancelled');
  });

  it('rejeita motivo vazio/curto', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    await expect(service.cancelSale(baseRequest({ reason: 'ok' }))).rejects.toThrow('Reason is required');
  });

  it('rejeita autoautorização: solicitante não pode autorizar o próprio cancelamento', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ id: 'requester-1' }));

    await expect(
      service.cancelSale(baseRequest({ requesterId: 'requester-1' }))
    ).rejects.toThrow('cannot authorize their own sale cancellation');
    expect(saleUpdateManyMock).not.toHaveBeenCalled();
  });

  it('rejeita autorizador sem permissão (ex: OPERATOR)', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ userType: 'OPERATOR' }));

    await expect(service.cancelSale(baseRequest())).rejects.toThrow('does not have permission to approve');
    expect(saleUpdateManyMock).not.toHaveBeenCalled();
  });

  it('rejeita senha do autorizador inválida (cancelamento sem autorização real)', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    (comparePassword as jest.Mock).mockResolvedValueOnce(false);

    await expect(service.cancelSale(baseRequest())).rejects.toThrow('Invalid authorizer credentials');
    expect(saleUpdateManyMock).not.toHaveBeenCalled();
  });

  it('rejeita código MFA ausente quando autorizador tem MFA habilitado', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));

    await expect(service.cancelSale(baseRequest())).rejects.toThrow('MFA code is required');
  });

  it('rejeita código MFA inválido/expirado', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));
    verifyCodeMock.mockReturnValueOnce({ valid: false });

    await expect(
      service.cancelSale(baseRequest({ authorizerMfaCode: '000000' }))
    ).rejects.toThrow('Invalid or expired authorizer MFA code');
  });

  it('cancela venda paga em DINHEIRO: reverte estoque, marca pagamento REFUNDED e estorna o caixa', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ payments: [{ id: 'pay-1', status: 'APPROVED', amount: 500, paymentMethod: 'CASH' }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    findUniqueCashRegisterMock.mockResolvedValueOnce({ id: 'register-1', status: 'OPEN' });

    const result = await service.cancelSale(baseRequest());

    expect(stockMovementCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'RETURN', quantity: 2 }) })
    );
    expect(paymentUpdateManyMock).toHaveBeenCalledWith({
      where: { saleId: 'sale-1', status: 'APPROVED' },
      data: { status: 'REFUNDED', refundedAt: expect.any(Date) },
    });
    expect(cashMovementCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        movementType: 'CANCELLATION',
        amount: 500,
        cashRegisterId: 'register-1',
        requestedBy: 'requester-1',
        authorizedBy: 'authorizer-1',
      }),
    });
    expect(cashRegisterUpdateMock).toHaveBeenCalledWith({
      where: { id: 'register-1' },
      data: { expectedAmount: { decrement: 500 } },
    });
    expect(result.cashAdjusted).toBe(true);
    expect(result.authorizer.name).toBe('Carlos');
  });

  it('cancela venda paga em CARTÃO: mesmo tratamento de estorno de caixa (independe do método)', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ payments: [{ id: 'pay-1', status: 'APPROVED', amount: 300, paymentMethod: 'CREDIT_CARD' }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    findUniqueCashRegisterMock.mockResolvedValueOnce({ id: 'register-1', status: 'OPEN' });

    await service.cancelSale(baseRequest());

    expect(cashMovementCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 300 }) })
    );
  });

  it('cancela venda com pagamento PIX ainda PENDING: não gera estorno de caixa (nada foi aprovado)', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ payments: [{ id: 'pay-1', status: 'PENDING', amount: 200, paymentMethod: 'PIX' }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());

    const result = await service.cancelSale(baseRequest());

    expect(cashMovementCreateMock).not.toHaveBeenCalled();
    expect(paymentUpdateManyMock).toHaveBeenCalledWith({
      where: { saleId: 'sale-1', status: { not: 'APPROVED' } },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
    expect(result.cashAdjusted).toBe(false);
  });

  it('venda paga cujo caixa já foi FECHADO: reverte estoque/pagamento mas NÃO reescreve o fechamento imutável', async () => {
    findFirstSaleMock.mockResolvedValueOnce(
      baseSale({ payments: [{ id: 'pay-1', status: 'APPROVED', amount: 500, paymentMethod: 'CASH' }] })
    );
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    findUniqueCashRegisterMock.mockResolvedValueOnce({ id: 'register-1', status: 'CLOSED' });

    const result = await service.cancelSale(baseRequest());

    expect(cashMovementCreateMock).not.toHaveBeenCalled();
    expect(cashRegisterUpdateMock).not.toHaveBeenCalled();
    expect(result.cashAdjusted).toBe(false);
    // Estoque e status do pagamento ainda são revertidos normalmente.
    expect(stockMovementCreateMock).toHaveBeenCalled();
  });

  it('nunca executa DELETE — a venda é atualizada (status CANCELLED), nunca removida', async () => {
    findFirstSaleMock.mockResolvedValueOnce(baseSale({ payments: [] }));
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());

    await service.cancelSale(baseRequest());

    expect(saleUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sale-1', status: { notIn: ['CANCELLED', 'RETURNED'] } },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      })
    );
  });

  it('cancelamento concorrente da mesma venda: updateMany afeta 0 linhas quando outra transação já cancelou primeiro', async () => {
    // Simula a corrida real: o pre-check via getSaleById (findFirstSaleMock)
    // ainda vê a venda como PAID (leu antes da outra transação commitar),
    // mas o updateMany guardado dentro da transação já não encontra mais
    // nenhuma linha elegível porque a outra transação já commitou o
    // cancelamento primeiro — é exatamente essa checagem que impede o
    // duplo estorno confirmado em teste de carga real.
    findFirstSaleMock.mockResolvedValueOnce(baseSale({ payments: [] }));
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    saleUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(service.cancelSale(baseRequest())).rejects.toThrow('Sale already cancelled');

    expect(stockMovementCreateMock).not.toHaveBeenCalled();
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });
});
