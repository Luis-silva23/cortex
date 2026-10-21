const findFirstProductMock = jest.fn();
const findFirstBranchMock = jest.fn();
const findManyMovementMock = jest.fn();
const createMovementMock = jest.fn();
const queryRawMock = jest.fn().mockResolvedValue(undefined);
const transactionMock = jest.fn();

// Saldo: regra do livro em memória sobre o mock de stockMovement.findMany (ver __mocks__/stock-ledger.ts).
jest.mock('./stock-ledger');

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    product: { findFirst: findFirstProductMock },
    branch: { findFirst: findFirstBranchMock },
    stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
    stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
    $queryRaw: queryRawMock,
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: { invalidate: jest.fn().mockResolvedValue(undefined) },
}));

import { StockService } from './stock.service';

function movement(overrides: Partial<any> = {}) {
  return {
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    movementType: 'PURCHASE',
    quantity: 10,
    ...overrides,
  };
}

describe('StockService.getBalance — matemática do ledger', () => {
  const service = new StockService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstProductMock.mockResolvedValue({ id: 'product-1', minStock: 5, maxStock: 100 });
  });

  it('rejeita quando o produto não pertence à empresa (isolamento cross-tenant)', async () => {
    findFirstProductMock.mockResolvedValueOnce(null);

    await expect(service.getBalance('product-of-another-company', 'company-A')).rejects.toThrow('Product not found');
  });

  it('soma entradas (PURCHASE/RETURN/TRANSFER_IN/PRODUCTION) e subtrai saídas (SALE/TRANSFER_OUT/LOSS)', async () => {
    findManyMovementMock.mockResolvedValueOnce([
      movement({ movementType: 'PURCHASE', quantity: 10 }),
      movement({ movementType: 'RETURN', quantity: 2 }),
      movement({ movementType: 'SALE', quantity: 3 }),
      movement({ movementType: 'LOSS', quantity: 1 }),
    ]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.balance).toBe(10 + 2 - 3 - 1);
    expect(result.hasMovements).toBe(true);
  });

  it('SUPPLIER_RETURN (devolução ao fornecedor) é saída — antes caía no "tipo desconhecido" e não baixava nada', async () => {
    findManyMovementMock.mockResolvedValueOnce([
      movement({ movementType: 'PURCHASE', quantity: 10 }),
      movement({ movementType: 'SUPPLIER_RETURN', quantity: 4 }),
      movement({ movementType: 'RETURN', quantity: 1 }),
    ]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.balance).toBe(10 - 4 + 1);
  });

  it('createMovement recusa SUPPLIER_RETURN que deixaria o saldo negativo (mesma trava das outras saídas)', async () => {
    const tx = {
      branch: { findFirst: jest.fn() },
      product: { findFirst: jest.fn().mockResolvedValue({ id: 'product-1', allowNegativeStock: false, name: 'Pneu', minStock: 0, maxStock: null }) },
      stockMovement: { findMany: jest.fn().mockResolvedValue([movement({ movementType: 'PURCHASE', quantity: 2 })]), create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue(undefined),
    };
    await expect(
      service.createMovementGuarded(tx as any, { companyId: 'company-A', productId: 'product-1', movementType: 'SUPPLIER_RETURN', quantity: 3, userId: 'user-1' })
    ).rejects.toThrow(/Insufficient stock/);
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('ADJUSTMENT soma o valor com sinal (positivo ou negativo), diferente das outras entradas/saídas', async () => {
    findManyMovementMock.mockResolvedValueOnce([
      movement({ movementType: 'PURCHASE', quantity: 10 }),
      movement({ movementType: 'ADJUSTMENT', quantity: -4 }),
    ]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.balance).toBe(6);
  });

  it('INVENTORY substitui o saldo pelo valor absoluto, não soma/subtrai', async () => {
    findManyMovementMock.mockResolvedValueOnce([
      movement({ movementType: 'PURCHASE', quantity: 10 }),
      movement({ movementType: 'SALE', quantity: 3 }),
      movement({ movementType: 'INVENTORY', quantity: 50 }),
      movement({ movementType: 'PURCHASE', quantity: 5 }),
    ]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.balance).toBe(55); // 50 (INVENTORY absoluto) + 5 depois
  });

  it('status NOT_INVENTORIED quando não há nenhuma movimentação', async () => {
    findManyMovementMock.mockResolvedValueOnce([]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.hasMovements).toBe(false);
    expect(result.status).toBe('NOT_INVENTORIED');
  });

  it('status OUT_OF_STOCK quando o saldo é zero ou negativo (mas já houve movimentação)', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 5 }), movement({ movementType: 'SALE', quantity: 5 })]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.balance).toBe(0);
    expect(result.status).toBe('OUT_OF_STOCK');
  });

  it('status LOW_STOCK quando o saldo é positivo mas <= minStock', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 5 })]);

    const result = await service.getBalance('product-1', 'company-A'); // minStock: 5

    expect(result.balance).toBe(5);
    expect(result.status).toBe('LOW_STOCK');
  });

  it('status OK quando o saldo está acima do minStock', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 20 })]);

    const result = await service.getBalance('product-1', 'company-A');

    expect(result.balance).toBe(20);
    expect(result.status).toBe('OK');
  });
});

describe('StockService.createMovement — guarda contra estoque negativo (achado de auditoria)', () => {
  const service = new StockService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstBranchMock.mockResolvedValue({ id: 'branch-1' });
    createMovementMock.mockImplementation(async ({ data }: any) => ({ id: 'movement-new', ...data }));
    transactionMock.mockImplementation(async (fn: any) =>
      fn({
        $queryRaw: queryRawMock,
        product: { findFirst: findFirstProductMock },
        branch: { findFirst: findFirstBranchMock },
        stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );
  });

  it('trava a linha do produto (FOR UPDATE) antes de checar o saldo — mesmo padrão de adjustStock/transferStock', async () => {
    findFirstProductMock.mockResolvedValue({ id: 'product-1', allowNegativeStock: false, name: 'Óleo 10w40', minStock: 0, maxStock: null });
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);

    await service.createMovement({ companyId: 'company-A', productId: 'product-1', movementType: 'PURCHASE', quantity: 5, userId: 'user-1' });

    expect(queryRawMock).toHaveBeenCalled();
  });

  it('rejeita uma saída (LOSS) que deixaria o saldo negativo quando allowNegativeStock=false — mesmo com movementType/quantity arbitrários vindos direto do body de POST /stock/movement', async () => {
    findFirstProductMock.mockResolvedValue({ id: 'product-1', allowNegativeStock: false, name: 'Óleo 10w40', minStock: 0, maxStock: null });
    // Saldo atual = 10 (uma única compra). Uma LOSS de -500 tentaria deixar o saldo em -490.
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);

    await expect(
      service.createMovement({ companyId: 'company-A', productId: 'product-1', movementType: 'LOSS', quantity: -500, userId: 'user-1' })
    ).rejects.toThrow('Insufficient stock');

    expect(createMovementMock).not.toHaveBeenCalled();
  });

  it('permite a mesma saída quando allowNegativeStock=true (comportamento explícito do produto, preservado)', async () => {
    findFirstProductMock.mockResolvedValue({ id: 'product-1', allowNegativeStock: true, name: 'Óleo 10w40', minStock: 0, maxStock: null });
    // allowNegativeStock=true pula a checagem de saldo inteira — getBalance()
    // nunca é chamado, então NÃO enfileiramos findManyMovementMock aqui
    // (enfileirar um valor nunca consumido vazaria para o próximo teste
    // que chame findManyMovementMock, num describe block diferente).

    const result = await service.createMovement({
      companyId: 'company-A',
      productId: 'product-1',
      movementType: 'LOSS',
      quantity: -500,
      userId: 'user-1',
    });

    expect(result).toBeDefined();
    expect(createMovementMock).toHaveBeenCalled();
  });

  it('permite uma saída que NÃO deixa o saldo negativo (dentro do disponível)', async () => {
    findFirstProductMock.mockResolvedValue({ id: 'product-1', allowNegativeStock: false, name: 'Óleo 10w40', minStock: 0, maxStock: null });
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);

    await service.createMovement({ companyId: 'company-A', productId: 'product-1', movementType: 'SALE', quantity: 4, userId: 'user-1' });

    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'SALE', quantity: 4 }) })
    );
  });

  it('devolução ao fornecedor (purchase-order.service.ts::returnToSupplier usa LOSS negativo): também é bloqueada se exceder o saldo disponível', async () => {
    findFirstProductMock.mockResolvedValue({ id: 'product-1', allowNegativeStock: false, name: 'Peça X', minStock: 0, maxStock: null });
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 3 })]);

    await expect(
      service.createMovement({
        companyId: 'company-A',
        productId: 'product-1',
        movementType: 'LOSS',
        quantity: -10, // devolvendo mais do que os 3 recebidos
        referenceType: 'PurchaseReturn',
        userId: 'user-1',
      })
    ).rejects.toThrow('Insufficient stock');
  });

  it('INVENTORY nunca é bloqueado (é sempre um valor absoluto, nunca negativo por construção)', async () => {
    findFirstProductMock.mockResolvedValue({ id: 'product-1', allowNegativeStock: false, name: 'Produto novo', minStock: 0, maxStock: null });
    findManyMovementMock.mockResolvedValueOnce([]); // nenhuma movimentação ainda

    await service.createMovement({ companyId: 'company-A', productId: 'product-1', movementType: 'INVENTORY', quantity: 50, userId: 'user-1' });

    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'INVENTORY', quantity: 50 }) })
    );
  });

  it('rejeita quando o produto não pertence à empresa (isolamento cross-tenant preservado)', async () => {
    findFirstProductMock.mockResolvedValueOnce(null);

    await expect(
      service.createMovement({ companyId: 'company-A', productId: 'product-of-another-company', movementType: 'PURCHASE', quantity: 5, userId: 'user-1' })
    ).rejects.toThrow('Product not found');
  });
});

describe('StockService.adjustStock — lock + releitura dentro da transação', () => {
  const service = new StockService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstProductMock.mockResolvedValue({ id: 'product-1', minStock: 0, maxStock: null });
    findFirstBranchMock.mockResolvedValue({ id: 'branch-1' });
    createMovementMock.mockImplementation(async ({ data }: any) => ({ id: 'movement-new', ...data }));
    transactionMock.mockImplementation(async (fn: any) =>
      fn({
        $queryRaw: queryRawMock,
        product: { findFirst: findFirstProductMock },
        branch: { findFirst: findFirstBranchMock },
        stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );
  });

  it('trava a linha do produto (FOR UPDATE) antes de reler o saldo', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);

    await service.adjustStock({ companyId: 'company-A', branchId: 'branch-1', productId: 'product-1', newQuantity: 15, reason: 'Contagem', userId: 'user-1' });

    expect(queryRawMock).toHaveBeenCalled();
  });

  // Sem filial o saldo vinha da soma de todas as filiais e o movimento era gravado
  // com filial NULL (fora do saldo de qualquer filial) — o ajuste é sempre de uma filial.
  it('sem branchId recusa ANTES de abrir transação ou gravar (o saldo seria o total da empresa)', async () => {
    await expect(
      service.adjustStock({ companyId: 'company-A', productId: 'product-1', newQuantity: 15, reason: 'Contagem', userId: 'user-1' })
    ).rejects.toThrow('branchId é obrigatório');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(createMovementMock).not.toHaveBeenCalled();
  });

  it('cria um ADJUSTMENT com a diferença assinada entre o saldo relido e a nova quantidade', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);

    await service.adjustStock({ companyId: 'company-A', branchId: 'branch-1', productId: 'product-1', newQuantity: 7, reason: 'Perda não registrada', userId: 'user-1' });

    expect(createMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'ADJUSTMENT', quantity: -3 }) })
    );
  });

  it('rejeita quando a nova quantidade é igual ao saldo relido (nada a ajustar)', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);

    await expect(
      service.adjustStock({ companyId: 'company-A', branchId: 'branch-1', productId: 'product-1', newQuantity: 10, reason: 'x', userId: 'user-1' })
    ).rejects.toThrow('New quantity is the same as current balance');
    expect(createMovementMock).not.toHaveBeenCalled();
  });
});

describe('StockService.transferStock — lock + releitura antes de decrementar a origem', () => {
  const service = new StockService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstProductMock.mockResolvedValue({ id: 'product-1', minStock: 0, maxStock: null });
    findFirstBranchMock.mockResolvedValue({ id: 'branch-1' });
    createMovementMock.mockImplementation(async ({ data }: any) => ({ id: 'movement-new', ...data }));
    transactionMock.mockImplementation(async (fn: any) =>
      fn({
        $queryRaw: queryRawMock,
        product: { findFirst: findFirstProductMock },
        branch: { findFirst: findFirstBranchMock },
        stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );
  });

  // REGRESSÃO (achado de auditoria de integração): fromBranchId/toBranchId
  // não eram validados contra a empresa — StockMovement.branchId é um
  // String solto no schema, sem FK, então nada no banco barrava um
  // branchId de outra empresa (ou inválido) sendo gravado no ledger.
  it('rejeita quando fromBranchId não pertence à empresa do requisitante', async () => {
    findFirstBranchMock.mockResolvedValueOnce(null); // fromBranchId não encontrado nesta empresa

    await expect(
      service.transferStock({
        companyId: 'company-A',
        productId: 'product-1',
        fromBranchId: 'branch-of-another-company',
        toBranchId: 'branch-B',
        quantity: 1,
        userId: 'user-1',
      })
    ).rejects.toThrow('not found in this company');
    expect(createMovementMock).not.toHaveBeenCalled();
  });

  it('rejeita quando toBranchId não pertence à empresa do requisitante', async () => {
    findFirstBranchMock.mockResolvedValueOnce({ id: 'branch-A' }).mockResolvedValueOnce(null);

    await expect(
      service.transferStock({
        companyId: 'company-A',
        productId: 'product-1',
        fromBranchId: 'branch-A',
        toBranchId: 'branch-of-another-company',
        quantity: 1,
        userId: 'user-1',
      })
    ).rejects.toThrow('not found in this company');
    expect(createMovementMock).not.toHaveBeenCalled();
  });

  it('rejeita quando o saldo relido na filial de origem é insuficiente', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 3 })]);

    await expect(
      service.transferStock({
        companyId: 'company-A',
        productId: 'product-1',
        fromBranchId: 'branch-A',
        toBranchId: 'branch-B',
        quantity: 5,
        userId: 'user-1',
      })
    ).rejects.toThrow('Insufficient stock at source branch. Available: 3');
    expect(createMovementMock).not.toHaveBeenCalled();
  });

  it('cria TRANSFER_OUT (negativo) na origem e TRANSFER_IN (positivo) no destino, referenciando um ao outro', async () => {
    findManyMovementMock.mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 10 })]);
    createMovementMock.mockResolvedValueOnce({ id: 'out-movement' }).mockResolvedValueOnce({ id: 'in-movement' });

    const result = await service.transferStock({
      companyId: 'company-A',
      productId: 'product-1',
      fromBranchId: 'branch-A',
      toBranchId: 'branch-B',
      quantity: 4,
      userId: 'user-1',
    });

    expect(createMovementMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ movementType: 'TRANSFER_OUT', quantity: -4, branchId: 'branch-A' }) })
    );
    expect(createMovementMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          movementType: 'TRANSFER_IN',
          quantity: 4,
          branchId: 'branch-B',
          referenceId: 'out-movement',
        }),
      })
    );
    expect(result.outMovement.id).toBe('out-movement');
    expect(result.inMovement.id).toBe('in-movement');
  });
});

describe('StockService.performInventory — uma transação travada por item', () => {
  const service = new StockService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstProductMock.mockResolvedValue({ id: 'product-1', minStock: 0, maxStock: null });
    createMovementMock.mockImplementation(async ({ data }: any) => ({ id: 'movement-new', ...data }));
    transactionMock.mockImplementation(async (fn: any) =>
      fn({
        $queryRaw: queryRawMock,
        product: { findFirst: findFirstProductMock },
        stockMovement: { findMany: findManyMovementMock, create: createMovementMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );
  });

  it('abre uma transação travada por produto e reporta previousBalance/difference a partir do saldo relido', async () => {
    findManyMovementMock
      .mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 20 })]) // product-1
      .mockResolvedValueOnce([movement({ movementType: 'PURCHASE', quantity: 5 })]); // product-2

    const results = await service.performInventory({
      companyId: 'company-A',
      items: [
        { productId: 'product-1', countedQuantity: 18 },
        { productId: 'product-2', countedQuantity: 5 },
      ],
      userId: 'user-1',
    });

    expect(transactionMock).toHaveBeenCalledTimes(2); // uma transação por item, não uma para o lote inteiro
    expect(results[0]).toMatchObject({ productId: 'product-1', previousBalance: 20, countedQuantity: 18, difference: -2 });
    expect(results[1]).toMatchObject({ productId: 'product-2', previousBalance: 5, countedQuantity: 5, difference: 0 });
  });
});
