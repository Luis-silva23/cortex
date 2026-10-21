/**
 * ACHADOS DE AUDITORIA (integridade de estoque em compras):
 *
 * 1) receive(): `remaining` era calculado de um snapshot do pedido lido uma
 *    vez antes do laço — o MESMO itemId repetido em `items` passava na
 *    checagem em cada entrada e incrementava em dobro (estoque inflado).
 * 2) returnToSupplier(): não validava que o produto pertence ao pedido nem
 *    limitava a quantidade ao recebido menos o já devolvido, e não era
 *    atômico (checagem e escrita fora da mesma transação/lock).
 */

const findFirstPOMock = jest.fn();
const findFirstInvoiceMock = jest.fn();
const transactionMock = jest.fn();
const createMovementGuardedMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    purchaseOrder: { findFirst: findFirstPOMock },
    invoice: { findFirst: findFirstInvoiceMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

jest.mock('./stock.service', () => ({
  __esModule: true,
  default: { createMovementGuarded: (...args: any[]) => createMovementGuardedMock(...args) },
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: { invalidate: jest.fn().mockResolvedValue(undefined) },
}));

import { PurchaseOrderService } from './purchase-order.service';

function receiveTx(items: any[]) {
  const purchaseOrderItemUpdate = jest.fn();
  const stockMovementCreate = jest.fn();
  return {
    tx: {
      $queryRaw: jest.fn(),
      purchaseOrderItem: {
        update: purchaseOrderItemUpdate,
        findMany: jest.fn().mockResolvedValue(items.map((i) => ({ ...i, receivedQuantity: i.quantity }))),
      },
      stockMovement: { create: stockMovementCreate },
      product: { update: jest.fn() },
      invoice: { create: jest.fn() },
      purchaseOrder: {
        update: jest.fn().mockResolvedValue({ id: 'po-1', items }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'po-1',
          companyId: 'company-A',
          branchId: 'branch-1',
          status: 'CONFIRMED',
          supplierId: 'supplier-1',
          items,
        }),
      },
    },
    purchaseOrderItemUpdate,
    stockMovementCreate,
  };
}

describe('PurchaseOrderService.receive — itemId repetido não pode receber em dobro', () => {
  const service = new PurchaseOrderService();
  const item = { id: 'item-1', productId: 'product-1', quantity: 10, receivedQuantity: 0, unitCost: 5 };

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstPOMock.mockResolvedValue({
      id: 'po-1',
      companyId: 'company-A',
      status: 'CONFIRMED',
      supplierId: 'supplier-1',
      items: [item],
    });
  });

  it('rejeita [{A,10},{A,10}] num item com 10 restantes (antes recebia 20)', async () => {
    const { tx, purchaseOrderItemUpdate, stockMovementCreate } = receiveTx([item]);
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));

    await expect(
      service.receive('po-1', 'company-A', {
        branchId: 'branch-1',
        userId: 'user-1',
        items: [
          { itemId: 'item-1', receivedQuantity: 10 },
          { itemId: 'item-1', receivedQuantity: 10 },
        ],
      })
    ).rejects.toThrow('Cannot receive 20 of item item-1 — only 10 remaining');

    expect(purchaseOrderItemUpdate).not.toHaveBeenCalled();
    expect(stockMovementCreate).not.toHaveBeenCalled();
  });

  it('entradas repetidas que somam dentro do restante viram UMA movimentação com o total', async () => {
    const { tx, purchaseOrderItemUpdate, stockMovementCreate } = receiveTx([item]);
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));

    await service.receive('po-1', 'company-A', {
      branchId: 'branch-1',
      userId: 'user-1',
      items: [
        { itemId: 'item-1', receivedQuantity: 4 },
        { itemId: 'item-1', receivedQuantity: 6 },
      ],
    });

    expect(purchaseOrderItemUpdate).toHaveBeenCalledTimes(1);
    expect(purchaseOrderItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { receivedQuantity: { increment: 10 } },
    });
    expect(stockMovementCreate).toHaveBeenCalledTimes(1);
    expect(stockMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantity: 10, totalCost: 50, movementType: 'PURCHASE' }),
    });
  });

  it('entrada com quantidade <= 0 continua ignorada e não abate a soma das positivas', async () => {
    const { tx, purchaseOrderItemUpdate } = receiveTx([item]);
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));

    await service.receive('po-1', 'company-A', {
      branchId: 'branch-1',
      userId: 'user-1',
      items: [
        { itemId: 'item-1', receivedQuantity: 8 },
        { itemId: 'item-1', receivedQuantity: -3 },
        { itemId: 'item-1', receivedQuantity: 0 },
      ],
    });

    expect(purchaseOrderItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { receivedQuantity: { increment: 8 } },
    });
  });

  it('item que não pertence ao pedido continua rejeitado', async () => {
    const { tx } = receiveTx([item]);
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));

    await expect(
      service.receive('po-1', 'company-A', {
        branchId: 'branch-1',
        userId: 'user-1',
        items: [{ itemId: 'item-de-outro-pedido', receivedQuantity: 1 }],
      })
    ).rejects.toThrow('does not belong to this purchase order');
  });
});

function returnTx(opts: { po: any; alreadyReturned?: number }) {
  return {
    $queryRaw: jest.fn(),
    purchaseOrder: { findFirst: jest.fn().mockResolvedValue(opts.po) },
    stockMovement: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: opts.alreadyReturned ? -opts.alreadyReturned : null } }),
    },
  };
}

describe('PurchaseOrderService.returnToSupplier — devolução limitada ao que o pedido entregou', () => {
  const service = new PurchaseOrderService();
  const receivedPo = {
    id: 'po-1',
    companyId: 'company-A',
    branchId: 'branch-pedido',
    status: 'RECEIVED',
    items: [{ id: 'item-1', productId: 'product-1', quantity: 10, receivedQuantity: 10 }],
  };
  const request = { branchId: 'branch-corpo', userId: 'user-1', productId: 'product-1', quantity: 4, reason: 'defeito' };

  beforeEach(() => {
    jest.clearAllMocks();
    createMovementGuardedMock.mockResolvedValue({ id: 'movement-1' });
  });

  it('rejeita quantidade zero, negativa ou não finita antes de abrir transação', async () => {
    for (const quantity of [0, -2, NaN, Infinity]) {
      await expect(service.returnToSupplier('po-1', 'company-A', { ...request, quantity })).rejects.toThrow(
        'Return quantity must be greater than zero'
      );
    }
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejeita produto que não faz parte do pedido (antes qualquer produto do estoque podia ser devolvido)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => cb(returnTx({ po: receivedPo })));

    await expect(
      service.returnToSupplier('po-1', 'company-A', { ...request, productId: 'produto-de-outro-pedido' })
    ).rejects.toThrow('Product is not part of this purchase order');
    expect(createMovementGuardedMock).not.toHaveBeenCalled();
  });

  it('rejeita devolver mais do que o pedido recebeu', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => cb(returnTx({ po: receivedPo })));

    await expect(service.returnToSupplier('po-1', 'company-A', { ...request, quantity: 11 })).rejects.toThrow(
      'only 10 returnable from this purchase order (received 10, already returned 0)'
    );
    expect(createMovementGuardedMock).not.toHaveBeenCalled();
  });

  it('desconta devoluções anteriores do mesmo produto/pedido (antes a devolução podia ser repetida sem teto)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => cb(returnTx({ po: receivedPo, alreadyReturned: 8 })));

    await expect(service.returnToSupplier('po-1', 'company-A', { ...request, quantity: 3 })).rejects.toThrow(
      'only 2 returnable from this purchase order (received 10, already returned 8)'
    );
  });

  it('devolução válida grava LOSS negativo na filial DO PEDIDO (não a do corpo) via createMovementGuarded na mesma transação', async () => {
    const tx = returnTx({ po: receivedPo, alreadyReturned: 6 });
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));

    const result = await service.returnToSupplier('po-1', 'company-A', { ...request, quantity: 4 });

    expect(tx.$queryRaw).toHaveBeenCalled(); // FOR UPDATE do pedido
    expect(createMovementGuardedMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        companyId: 'company-A',
        branchId: 'branch-pedido',
        productId: 'product-1',
        movementType: 'LOSS',
        quantity: -4,
        referenceType: 'PurchaseReturn',
        referenceId: 'po-1',
      })
    );
    expect(result).toEqual({ id: 'movement-1' });
  });

  it('pedido que não está RECEIVED continua rejeitado', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) =>
      cb(returnTx({ po: { ...receivedPo, status: 'CONFIRMED' } }))
    );

    await expect(service.returnToSupplier('po-1', 'company-A', request)).rejects.toThrow(
      'Can only return items from a fully received purchase order'
    );
  });
});
