/**
 * ACHADO DE AUDITORIA: TransferService.send() escrevia TRANSFER_OUT direto
 * no ledger (tx.stockMovement.create) sem nenhuma trava — a única checagem
 * era "sentQuantity <= requestedQuantity", nunca contra o saldo REAL
 * disponível na filial de origem, e sem travar a linha do produto. Isso
 * bypassava completamente `product.allowNegativeStock` (mesmo guard já
 * corrigido nesta sessão em stock.service.ts::createMovement).
 */

const findFirstTransferMock = jest.fn();
const transactionMock = jest.fn();
const queryRawMock = jest.fn().mockResolvedValue(undefined);
const findUniqueOrThrowProductMock = jest.fn();
const findFirstProductMock = jest.fn();
const findManyMovementMock = jest.fn();
const updateTransferItemMock = jest.fn();
const createMovementMock = jest.fn();
const updateTransferMock = jest.fn();

// Saldo: regra do livro em memória sobre o mock de stockMovement.findMany (ver __mocks__/stock-ledger.ts).
jest.mock('./stock-ledger');

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    transfer: { findFirst: findFirstTransferMock },
    $transaction: transactionMock,
    $queryRaw: queryRawMock,
  })),
  Prisma: {},
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: { invalidate: jest.fn().mockResolvedValue(undefined) },
}));

import { TransferService } from './transfer.service';

function baseTransfer(overrides: Partial<any> = {}) {
  return {
    id: 'transfer-1',
    companyId: 'company-A',
    fromBranchId: 'branch-A',
    toBranchId: 'branch-B',
    transferNumber: 1,
    status: 'PENDING',
    approvedBy: 'user-approver',
    items: [{ id: 'item-1', productId: 'product-1', requestedQuantity: 20, sentQuantity: null }],
    ...overrides,
  };
}

function txWith(overrides: Partial<any> = {}) {
  return {
    $queryRaw: queryRawMock,
    product: { findUniqueOrThrow: findUniqueOrThrowProductMock, findFirst: findFirstProductMock },
    stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
    stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
    transferItem: { update: updateTransferItemMock },
    transfer: { update: updateTransferMock, updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: updateTransferMock },
    ...overrides,
  };
}

describe('TransferService.send — guarda contra estoque negativo (achado de auditoria)', () => {
  const service = new TransferService();

  beforeEach(() => {
    jest.clearAllMocks();
    transactionMock.mockImplementation(async (fn: any) => fn(txWith()));
    updateTransferItemMock.mockResolvedValue({});
    createMovementMock.mockResolvedValue({});
    updateTransferMock.mockResolvedValue({ id: 'transfer-1', items: [] });
  });

  it('trava a linha do produto (FOR UPDATE) e checa o saldo antes de escrever o TRANSFER_OUT', async () => {
    findFirstTransferMock.mockResolvedValueOnce(baseTransfer());
    findUniqueOrThrowProductMock.mockResolvedValueOnce({ allowNegativeStock: false, name: 'Óleo 10w40' });
    findFirstProductMock.mockResolvedValueOnce({ id: 'product-1', minStock: 0, maxStock: null });
    findManyMovementMock.mockResolvedValueOnce([{ createdAt: new Date(), movementType: 'PURCHASE', quantity: 20 }]);

    await service.send({
      transferId: 'transfer-1',
      companyId: 'company-A',
      sentBy: 'user-1',
      items: [{ transferItemId: 'item-1', sentQuantity: 5 }],
    });

    expect(queryRawMock).toHaveBeenCalled();
    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'TRANSFER_OUT', quantity: -5 }) })
    );
  });

  it('rejeita o envio quando a quantidade excede o saldo real disponível na filial de origem, mesmo dentro do requestedQuantity', async () => {
    findFirstTransferMock.mockResolvedValueOnce(baseTransfer());
    findUniqueOrThrowProductMock.mockResolvedValueOnce({ allowNegativeStock: false, name: 'Óleo 10w40' });
    findFirstProductMock.mockResolvedValueOnce({ id: 'product-1', minStock: 0, maxStock: null });
    // Saldo real na filial de origem = apenas 3, mas requestedQuantity=20 e sentQuantity=20 passaria pela checagem antiga.
    findManyMovementMock.mockResolvedValueOnce([{ createdAt: new Date(), movementType: 'PURCHASE', quantity: 3 }]);

    await expect(
      service.send({
        transferId: 'transfer-1',
        companyId: 'company-A',
        sentBy: 'user-1',
        items: [{ transferItemId: 'item-1', sentQuantity: 20 }],
      })
    ).rejects.toThrow('Saldo insuficiente');

    expect(createMovementMock).not.toHaveBeenCalled();
  });

  it('permite exceder o saldo quando o produto tem allowNegativeStock=true (comportamento explícito preservado)', async () => {
    findFirstTransferMock.mockResolvedValueOnce(baseTransfer());
    findUniqueOrThrowProductMock.mockResolvedValueOnce({ allowNegativeStock: true, name: 'Óleo 10w40' });

    await service.send({
      transferId: 'transfer-1',
      companyId: 'company-A',
      sentBy: 'user-1',
      items: [{ transferItemId: 'item-1', sentQuantity: 20 }],
    });

    // Com allowNegativeStock=true, getBalance (e portanto findMany) nunca é consultado.
    expect(findManyMovementMock).not.toHaveBeenCalled();
    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'TRANSFER_OUT', quantity: -20 }) })
    );
  });
});
