const findFirstPOMock = jest.fn();
const findFirstInvoiceMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    purchaseOrder: { findFirst: findFirstPOMock },
    invoice: { findFirst: findFirstInvoiceMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

jest.mock('./stock.service', () => ({ __esModule: true, default: { createMovement: jest.fn() } }));

import { PurchaseOrderService } from './purchase-order.service';

describe('PurchaseOrderService.receive — regras de recebimento', () => {
  const service = new PurchaseOrderService();

  it('rejeita receber quando o pedido não está CONFIRMED', async () => {
    findFirstPOMock.mockResolvedValueOnce({
      id: 'po-1',
      companyId: 'company-A',
      status: 'DRAFT',
      items: [],
    });

    await expect(
      service.receive('po-1', 'company-A', { branchId: 'branch-1', userId: 'user-1', items: [] })
    ).rejects.toThrow('must be CONFIRMED before receiving');
  });

  it('rejeita receber mais do que o restante do item (evita duplicidade/erro de digitação)', async () => {
    findFirstPOMock.mockResolvedValueOnce({
      id: 'po-1',
      companyId: 'company-A',
      status: 'CONFIRMED',
      supplierId: 'supplier-1',
      items: [{ id: 'item-1', productId: 'product-1', quantity: 10, receivedQuantity: 8, unitCost: 5 }],
    });
    // A validação de quantidade restante roda DENTRO do callback de
    // $transaction — sem este mock invocar o callback de fato, ele nunca
    // executava e a promise resolvia como `undefined` em vez de rejeitar
    // (falso positivo: o teste "passava" mesmo que a checagem real tivesse
    // sido removida do service). `purchaseOrder.findUniqueOrThrow` releitura
    // o mesmo estado (fix de concorrência: recebimento agora relê o pedido
    // com lock dentro da transação em vez de confiar na leitura de fora).
    transactionMock.mockImplementationOnce(async (cb: any) =>
      cb({
        $queryRaw: jest.fn(),
        purchaseOrderItem: { update: jest.fn() },
        stockMovement: { create: jest.fn() },
        invoice: { create: jest.fn() },
        purchaseOrder: {
          update: jest.fn(),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: 'po-1',
            companyId: 'company-A',
            branchId: 'branch-1',
            status: 'CONFIRMED',
            supplierId: 'supplier-1',
            items: [{ id: 'item-1', productId: 'product-1', quantity: 10, receivedQuantity: 8, unitCost: 5 }],
          }),
        },
      })
    );

    await expect(
      service.receive('po-1', 'company-A', {
        branchId: 'branch-1',
        userId: 'user-1',
        items: [{ itemId: 'item-1', receivedQuantity: 5 }], // só restam 2
      })
    ).rejects.toThrow('only 2 remaining');
  });

  it('rejeita nota fiscal duplicada (mesmo fornecedor + número + série)', async () => {
    findFirstPOMock.mockResolvedValueOnce({
      id: 'po-1',
      companyId: 'company-A',
      status: 'CONFIRMED',
      supplierId: 'supplier-1',
      items: [{ id: 'item-1', productId: 'product-1', quantity: 10, receivedQuantity: 0, unitCost: 5 }],
    });
    findFirstInvoiceMock.mockResolvedValueOnce({ id: 'existing-invoice' }); // já existe

    await expect(
      service.receive('po-1', 'company-A', {
        branchId: 'branch-1',
        userId: 'user-1',
        items: [{ itemId: 'item-1', receivedQuantity: 10 }],
        invoice: {
          invoiceNumber: '123',
          series: '1',
          accessKey: 'a'.repeat(44),
          issueDate: new Date(),
          totalAmount: 50,
        },
      })
    ).rejects.toThrow('Duplicate invoice');
  });
});
