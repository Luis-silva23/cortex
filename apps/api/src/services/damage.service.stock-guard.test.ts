/**
 * ACHADO DE AUDITORIA: DamageService.record() escrevia LOSS direto no
 * ledger (tx.stockMovement.create) sem nenhuma trava — bypassava
 * completamente `product.allowNegativeStock` (mesmo guard já corrigido
 * nesta sessão em stock.service.ts::createMovement), permitindo registrar
 * avaria de mais unidades do que existem fisicamente em estoque.
 */

const findFirstBranchMock = jest.fn();
const findFirstProductTopLevelMock = jest.fn();
const transactionMock = jest.fn();
const queryRawMock = jest.fn().mockResolvedValue(undefined);
const findUniqueOrThrowProductMock = jest.fn();
const findFirstProductMock = jest.fn();
const findManyMovementMock = jest.fn();
const createDamageMock = jest.fn();
const createMovementMock = jest.fn();

// Saldo: regra do livro em memória sobre o mock de stockMovement.findMany (ver __mocks__/stock-ledger.ts).
jest.mock('./stock-ledger');

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    branch: { findFirst: findFirstBranchMock },
    product: { findFirst: findFirstProductTopLevelMock },
    $transaction: transactionMock,
    $queryRaw: queryRawMock,
  })),
  Prisma: {},
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: { invalidate: jest.fn().mockResolvedValue(undefined) },
}));

import { DamageService } from './damage.service';

function txWith() {
  return {
    $queryRaw: queryRawMock,
    product: { findUniqueOrThrow: findUniqueOrThrowProductMock, findFirst: findFirstProductMock },
    stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
    damageRecord: { create: createDamageMock },
  };
}

describe('DamageService.record — guarda contra estoque negativo (achado de auditoria)', () => {
  const service = new DamageService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstBranchMock.mockResolvedValue({ id: 'branch-1' });
    findFirstProductTopLevelMock.mockResolvedValue({ id: 'product-1' });
    transactionMock.mockImplementation(async (fn: any) => fn(txWith()));
    createDamageMock.mockResolvedValue({ id: 'damage-1' });
    createMovementMock.mockResolvedValue({});
  });

  it('trava a linha do produto (FOR UPDATE) e checa o saldo antes de registrar a avaria (LOSS)', async () => {
    findUniqueOrThrowProductMock.mockResolvedValueOnce({ allowNegativeStock: false, name: 'Óleo 10w40' });
    findFirstProductMock.mockResolvedValueOnce({ id: 'product-1', minStock: 0, maxStock: null });
    findManyMovementMock.mockResolvedValueOnce([{ createdAt: new Date(), movementType: 'PURCHASE', quantity: 10 }]);

    await service.record({
      companyId: 'company-A',
      branchId: 'branch-1',
      productId: 'product-1',
      quantity: 3,
      reason: 'DAMAGED',
      recordedBy: 'user-1',
    });

    expect(queryRawMock).toHaveBeenCalled();
    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'LOSS', quantity: 3 }) })
    );
  });

  it('rejeita registrar avaria de mais unidades do que existem em estoque quando allowNegativeStock=false', async () => {
    findUniqueOrThrowProductMock.mockResolvedValueOnce({ allowNegativeStock: false, name: 'Óleo 10w40' });
    findFirstProductMock.mockResolvedValueOnce({ id: 'product-1', minStock: 0, maxStock: null });
    // Saldo real = 2, mas tenta registrar avaria de 500.
    findManyMovementMock.mockResolvedValueOnce([{ createdAt: new Date(), movementType: 'PURCHASE', quantity: 2 }]);

    await expect(
      service.record({
        companyId: 'company-A',
        branchId: 'branch-1',
        productId: 'product-1',
        quantity: 500,
        reason: 'LOST',
        recordedBy: 'user-1',
      })
    ).rejects.toThrow('Saldo insuficiente');

    expect(createMovementMock).not.toHaveBeenCalled();
    expect(createDamageMock).not.toHaveBeenCalled();
  });

  it('permite registrar avaria acima do saldo quando allowNegativeStock=true (comportamento explícito preservado)', async () => {
    findUniqueOrThrowProductMock.mockResolvedValueOnce({ allowNegativeStock: true, name: 'Óleo 10w40' });

    await service.record({
      companyId: 'company-A',
      branchId: 'branch-1',
      productId: 'product-1',
      quantity: 500,
      reason: 'THEFT',
      recordedBy: 'user-1',
    });

    expect(findManyMovementMock).not.toHaveBeenCalled();
    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'LOSS', quantity: 500 }) })
    );
  });
});
