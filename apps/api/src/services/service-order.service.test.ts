const findFirstMock = jest.fn();
const transactionMock = jest.fn();
const userFindFirstMock = jest.fn();
const commissionRuleFindFirstMock = jest.fn();
const serviceOrderUpdateTopLevelMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    serviceOrder: { findFirst: findFirstMock, update: serviceOrderUpdateTopLevelMock },
    user: { findFirst: userFindFirstMock },
    commissionRule: { findFirst: commissionRuleFindFirstMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

const stockGetBalanceMock = jest.fn();
const stockCreateMovementMock = jest.fn();

jest.mock('./stock.service', () => ({
  __esModule: true,
  default: { getBalance: stockGetBalanceMock, createMovement: stockCreateMovementMock },
}));

// Garantia no encerramento (warranty.service.ts) lê política e itens da OS — isolada aqui; a regra real é provada em
// test/integration/warranty.integration.test.ts.
const prepareCloseDecisionMock = jest.fn();
const createWarrantyInTxMock = jest.fn();
jest.mock('./warranty.service', () => ({
  __esModule: true,
  default: {
    prepareCloseDecision: (...a: any[]) => prepareCloseDecisionMock(...a),
    createInTx: (...a: any[]) => createWarrantyInTxMock(...a),
  },
}));

// Política de comissão (policy.service.ts) lê o banco; aqui só importa se está ligada. A regra real é provada na integração.
const commissionEnabledMock = jest.fn();
jest.mock('./policy.service', () => ({
  __esModule: true,
  policyService: { get: (...a: any[]) => commissionEnabledMock(...a) },
}));

import { ServiceOrderService } from './service-order.service';

describe('ServiceOrderService.transitionStatus — máquina de estados', () => {
  const service = new ServiceOrderService();

  it('rejeita pular etapas (ENTRADA direto para EXECUCAO)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENTRADA', isPaid: false });

    await expect(
      service.transitionStatus('os-1', 'company-A', 'EXECUCAO', 'user-1')
    ).rejects.toThrow('Cannot transition from ENTRADA to EXECUCAO');
  });

  it('permite a transição sequencial correta (ENTRADA -> DIAGNOSTICO)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENTRADA', isPaid: false });
    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          update: jest.fn().mockResolvedValue({ id: 'os-1', status: 'DIAGNOSTICO' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'os-1', status: 'DIAGNOSTICO' }),
        },
        serviceOrderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      })
    );

    const result = await service.transitionStatus('os-1', 'company-A', 'DIAGNOSTICO', 'user-1');
    expect(result.status).toBe('DIAGNOSTICO');
  });

  it('NUNCA permite encerrar financeiramente (ENCERRADA) sem pagamento confirmado', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENTREGA', isPaid: false });

    await expect(
      service.transitionStatus('os-1', 'company-A', 'ENCERRADA', 'user-1')
    ).rejects.toThrow('Cannot close service order financially before payment is confirmed');
  });

  it('permite ENCERRADA quando o pagamento já foi confirmado (com a decisão de garantia gravada na mesma transação)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENTREGA', isPaid: true });
    prepareCloseDecisionMock.mockResolvedValueOnce({ decision: 'NONE' });
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          update: jest.fn().mockResolvedValue({ id: 'os-1', status: 'ENCERRADA' }),
          updateMany: updateManyMock,
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'os-1', status: 'ENCERRADA' }),
        },
        serviceOrderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      })
    );

    const result = await service.transitionStatus('os-1', 'company-A', 'ENCERRADA', 'user-1', undefined, { warranty: { decision: 'NONE' } });
    expect(result.status).toBe('ENCERRADA');
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ warrantyDecision: 'NONE' }) }));
    expect(createWarrantyInTxMock).not.toHaveBeenCalled();
  });

  it('recusa decisão de garantia fora do encerramento', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENTRADA', isPaid: false });
    await expect(
      service.transitionStatus('os-1', 'company-A', 'DIAGNOSTICO', 'user-1', undefined, { warranty: { decision: 'NONE' } })
    ).rejects.toMatchObject({ code: 'WARRANTY_ONLY_ON_CLOSE' });
  });

  it('corrida na mudança de situação responde 409 em PT-BR (não 400 em inglês)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENTRADA', isPaid: false });
    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findUniqueOrThrow: jest.fn() },
        serviceOrderStatusHistory: { create: jest.fn() },
      })
    );
    await expect(service.transitionStatus('os-1', 'company-A', 'DIAGNOSTICO', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_ORDER_STATUS_CHANGED',
      message: expect.stringMatching(/Outra pessoa alterou a situação/),
    });
  });

  it('rejeita qualquer transição a partir de um estado terminal (ENCERRADA)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status: 'ENCERRADA', isPaid: true });

    await expect(
      service.transitionStatus('os-1', 'company-A', 'EXECUCAO', 'user-1')
    ).rejects.toThrow('Cannot transition from ENCERRADA to EXECUCAO');
  });
});

describe('ServiceOrderService.transitionStatus — baixa de estoque na EXECUCAO', () => {
  const service = new ServiceOrderService();

  beforeEach(() => {
    stockGetBalanceMock.mockReset();
    stockCreateMovementMock.mockReset();
  });

  it('baixa estoque para itens PART com productId, mas nunca para itens SERVICE', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      osNumber: 42,
      status: 'APROVACAO',
      isPaid: false,
    });

    const partItems = [
      { id: 'item-part-1', itemType: 'PART', productId: 'prod-1', quantity: 2, isCompleted: false },
    ];

    const findManyMock = jest.fn().mockResolvedValue(partItems);
    const itemUpdateMock = jest.fn().mockResolvedValue({});
    // A baixa de estoque durante EXECUCAO precisa acontecer NA MESMA `tx`
    // que marca o item como concluído (ver comentário em
    // service-order.service.ts) — por isso `tx.stockMovement.create`, não
    // mais `stockService.createMovement` (que usaria uma transação/conexão
    // separada e quebraria a atomicidade).
    const stockMovementCreateMock = jest.fn().mockResolvedValue({});
    stockGetBalanceMock.mockResolvedValue({ balance: 10 });

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          update: jest.fn().mockResolvedValue({ id: 'os-1', status: 'EXECUCAO' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'os-1', status: 'EXECUCAO' }),
        },
        serviceOrderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
        serviceOrderItem: { findMany: findManyMock, update: itemUpdateMock },
        // SELECT … FOR UPDATE na linha do produto (trava da última unidade); a corrida real é provada em
        // test/integration/service-order-races.integration.test.ts.
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'product-lock' }]),
        stockMovement: { create: stockMovementCreateMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );

    const result = await service.transitionStatus('os-1', 'company-A', 'EXECUCAO', 'user-1');

    expect(result.status).toBe('EXECUCAO');
    // Só busca itens PART com productId preenchido e ainda não baixados.
    expect(findManyMock).toHaveBeenCalledWith({
      where: { serviceOrderId: 'os-1', itemType: 'PART', productId: { not: null }, isCompleted: false },
    });
    expect(stockMovementCreateMock).toHaveBeenCalledTimes(1);
    expect(stockMovementCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'company-A',
        branchId: 'branch-1',
        productId: 'prod-1',
        movementType: 'SALE',
        quantity: -2,
        referenceType: 'ServiceOrder',
        referenceId: 'os-1',
        userId: 'user-1',
      }),
    });
    expect(itemUpdateMock).toHaveBeenCalledWith({
      where: { id: 'item-part-1' },
      data: expect.objectContaining({ isCompleted: true }),
    });
  });

  it('não baixa estoque quando não há itens PART pendentes (ex: apenas SERVICE)', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      osNumber: 42,
      status: 'APROVACAO',
      isPaid: false,
    });

    const findManyMock = jest.fn().mockResolvedValue([]);
    const stockMovementCreateMock = jest.fn();

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          update: jest.fn().mockResolvedValue({ id: 'os-1', status: 'EXECUCAO' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'os-1', status: 'EXECUCAO' }),
        },
        serviceOrderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
        serviceOrderItem: { findMany: findManyMock, update: jest.fn() },
        // SELECT … FOR UPDATE na linha do produto (trava da última unidade); a corrida real é provada em
        // test/integration/service-order-races.integration.test.ts.
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'product-lock' }]),
        stockMovement: { create: stockMovementCreateMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );

    const result = await service.transitionStatus('os-1', 'company-A', 'EXECUCAO', 'user-1');

    expect(result.status).toBe('EXECUCAO');
    expect(stockMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita a transição quando não há saldo suficiente para uma peça', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      osNumber: 42,
      status: 'APROVACAO',
      isPaid: false,
    });

    const partItems = [
      { id: 'item-part-1', itemType: 'PART', productId: 'prod-1', quantity: 5, isCompleted: false },
    ];
    stockGetBalanceMock.mockResolvedValue({ balance: 1 });
    const stockMovementCreateMock = jest.fn();

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          update: jest.fn().mockResolvedValue({ id: 'os-1', status: 'EXECUCAO' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'os-1', status: 'EXECUCAO' }),
        },
        serviceOrderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
        serviceOrderItem: { findMany: jest.fn().mockResolvedValue(partItems), update: jest.fn() },
        // SELECT … FOR UPDATE na linha do produto (trava da última unidade); a corrida real é provada em
        // test/integration/service-order-races.integration.test.ts.
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'product-lock' }]),
        stockMovement: { create: stockMovementCreateMock },
        stockReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      })
    );

    await expect(
      service.transitionStatus('os-1', 'company-A', 'EXECUCAO', 'user-1')
    ).rejects.toThrow('Insufficient stock');
    expect(stockMovementCreateMock).not.toHaveBeenCalled();
  });
});

describe('ServiceOrderService.registerPayment — integração financeira', () => {
  const service = new ServiceOrderService();

  beforeEach(() => {
    commissionRuleFindFirstMock.mockReset();
    commissionEnabledMock.mockReset().mockResolvedValue(true); // padrão do produto: comissão ligada
  });

  it('cria uma conta a receber já quitada, referenciando a OS, ao registrar o pagamento', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      customerId: 'customer-1',
      osNumber: 42,
      status: 'ENTREGA',
      isPaid: false,
      laborTotal: 100,
      partsTotal: 50,
      discountAmount: 10,
      mechanicId: null,
    });

    const receivableCreateMock = jest.fn().mockResolvedValue({ id: 'rec-1' });
    const serviceOrderUpdateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const serviceOrderFindUniqueOrThrowMock = jest.fn().mockResolvedValue({ id: 'os-1', isPaid: true });

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          updateMany: serviceOrderUpdateManyMock,
          findFirst: jest.fn().mockResolvedValue({ isPaid: true }),
          findUniqueOrThrow: serviceOrderFindUniqueOrThrowMock,
        },
        accountsReceivable: { create: receivableCreateMock },
      })
    );

    const result = await service.registerPayment('os-1', 'company-A', 'PIX');

    expect(result.isPaid).toBe(true);
    expect(receivableCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'company-A',
        branchId: 'branch-1',
        customerId: 'customer-1',
        amount: 140, // laborTotal + partsTotal - discountAmount
        status: 'PAID',
        referenceType: 'ServiceOrder',
        referenceId: 'os-1',
      }),
    });
    // Sem mecânico atribuído, nem consultamos regra de comissão.
    expect(commissionRuleFindFirstMock).not.toHaveBeenCalled();
  });

  it('rejeita registrar pagamento duplicado', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', isPaid: true });

    await expect(service.registerPayment('os-1', 'company-A', 'PIX')).rejects.toThrow(
      'Service order already paid'
    );
  });

  it('guarda atômica: quando duas chamadas concorrentes passam pelo findFirst, a que perde a corrida no updateMany (count=0) falha e não cria conta a receber nem comissão em dobro', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      customerId: 'customer-1',
      osNumber: 42,
      status: 'ENTREGA',
      isPaid: false, // leitura fora da transação já não vê o pagamento da outra chamada concorrente
      laborTotal: 100,
      partsTotal: 50,
      discountAmount: 10,
      mechanicId: null,
    });

    const receivableCreateMock = jest.fn();
    // A "outra" transação concorrente já commitou isPaid=true antes desta
    // chegar no updateMany — nenhuma linha com isPaid:false para atualizar.
    const serviceOrderUpdateManyMock = jest.fn().mockResolvedValue({ count: 0 });
    const serviceOrderFindUniqueOrThrowMock = jest.fn();

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          updateMany: serviceOrderUpdateManyMock,
          findFirst: jest.fn().mockResolvedValue({ isPaid: true }),
          findUniqueOrThrow: serviceOrderFindUniqueOrThrowMock,
        },
        accountsReceivable: { create: receivableCreateMock },
      })
    );

    await expect(service.registerPayment('os-1', 'company-A', 'PIX')).rejects.toThrow(
      'Service order already paid'
    );

    expect(receivableCreateMock).not.toHaveBeenCalled();
    expect(serviceOrderFindUniqueOrThrowMock).not.toHaveBeenCalled();
  });

  it.each([
    ['EXECUCAO', /só pode ser paga quando estiver PRONTO ou em ENTREGA \(situação atual: EXECUCAO\)/],
    ['CANCELADA', /OS cancelada não recebe pagamento/],
  ])('OS em %s não recebe pagamento: 409 em PT-BR', async (status, message) => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A', status, isPaid: false, laborTotal: 100, partsTotal: 0, discountAmount: 0 });
    await expect(service.registerPayment('os-1', 'company-A', 'PIX')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_ORDER_NOT_PAYABLE',
      message: expect.stringMatching(message),
    });
  });

  it('desconto (ou item) aplicado entre a leitura e o pagamento: não cobra o total velho — 409 e nada é gravado', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      customerId: 'customer-1',
      osNumber: 42,
      status: 'ENTREGA',
      isPaid: false,
      laborTotal: 100,
      partsTotal: 50,
      discountAmount: 0, // lido antes do desconto de 10 gravado por outra requisição
      mechanicId: null,
    });
    const receivableCreateMock = jest.fn();
    const serviceOrderUpdateManyMock = jest.fn().mockResolvedValue({ count: 0 });
    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          updateMany: serviceOrderUpdateManyMock,
          findFirst: jest.fn().mockResolvedValue({ isPaid: false }),
          findUniqueOrThrow: jest.fn(),
        },
        accountsReceivable: { create: receivableCreateMock },
      })
    );

    await expect(service.registerPayment('os-1', 'company-A', 'PIX')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_ORDER_CHANGED',
    });
    // O pagamento só é gravado se os totais ainda forem os lidos.
    expect(serviceOrderUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ laborTotal: 100, partsTotal: 50, discountAmount: 0 }) })
    );
    expect(receivableCreateMock).not.toHaveBeenCalled();
  });

  it('cria MechanicCommission (baseada apenas em laborTotal) quando há mecânico atribuído e regra ativa', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      customerId: 'customer-1',
      osNumber: 42,
      status: 'ENTREGA',
      isPaid: false,
      laborTotal: 200,
      partsTotal: 80,
      discountAmount: 0,
      mechanicId: 'mech-1',
    });

    commissionRuleFindFirstMock.mockResolvedValueOnce({
      id: 'rule-1',
      companyId: 'company-A',
      name: 'Comissão padrão',
      serviceType: null,
      percentage: 10,
      isActive: true,
    });

    const receivableCreateMock = jest.fn().mockResolvedValue({ id: 'rec-1' });
    const serviceOrderUpdateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const serviceOrderFindUniqueOrThrowMock = jest.fn().mockResolvedValue({ id: 'os-1', isPaid: true });
    const mechanicCommissionCreateMock = jest.fn().mockResolvedValue({ id: 'comm-1' });

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          updateMany: serviceOrderUpdateManyMock,
          findFirst: jest.fn().mockResolvedValue({ isPaid: true }),
          findUniqueOrThrow: serviceOrderFindUniqueOrThrowMock,
        },
        accountsReceivable: { create: receivableCreateMock },
        mechanicCommission: { create: mechanicCommissionCreateMock },
      })
    );

    const result = await service.registerPayment('os-1', 'company-A', 'PIX');

    expect(result.isPaid).toBe(true);
    expect(commissionRuleFindFirstMock).toHaveBeenCalledWith({
      where: { companyId: 'company-A', isActive: true },
    });
    expect(mechanicCommissionCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'company-A',
        serviceOrderId: 'os-1',
        mechanicId: 'mech-1',
        baseAmount: 200, // laborTotal apenas — comissão não incide sobre peças
        percentage: 10,
        commissionAmount: 20,
        ruleSnapshot: expect.objectContaining({ ruleId: 'rule-1', percentage: 10 }),
      }),
    });
  });

  it('política commission.enabled desligada: nem procura regra nem cria comissão, e o pagamento da OS segue normal', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1', companyId: 'company-A', branchId: 'branch-1', customerId: 'customer-1', osNumber: 42, status: 'ENTREGA',
      isPaid: false, laborTotal: 200, partsTotal: 80, discountAmount: 0, mechanicId: 'mech-1',
    });
    commissionEnabledMock.mockResolvedValueOnce(false);
    const mechanicCommissionCreateMock = jest.fn();
    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn().mockResolvedValue({ isPaid: true }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'os-1', isPaid: true }),
        },
        accountsReceivable: { create: jest.fn().mockResolvedValue({ id: 'rec-1' }) },
        mechanicCommission: { create: mechanicCommissionCreateMock },
      })
    );

    const result = await service.registerPayment('os-1', 'company-A', 'PIX');

    expect(result.isPaid).toBe(true);
    expect(commissionEnabledMock).toHaveBeenCalledWith('company-A', 'branch-1', 'commission.enabled');
    expect(commissionRuleFindFirstMock).not.toHaveBeenCalled();
    expect(mechanicCommissionCreateMock).not.toHaveBeenCalled();
  });

  it('não cria MechanicCommission quando não há regra ativa para a empresa (comissão é opcional)', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 'os-1',
      companyId: 'company-A',
      branchId: 'branch-1',
      customerId: 'customer-1',
      osNumber: 42,
      status: 'ENTREGA',
      isPaid: false,
      laborTotal: 200,
      partsTotal: 80,
      discountAmount: 0,
      mechanicId: 'mech-1',
    });

    commissionRuleFindFirstMock.mockResolvedValueOnce(null);

    const receivableCreateMock = jest.fn().mockResolvedValue({ id: 'rec-1' });
    const serviceOrderUpdateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const serviceOrderFindUniqueOrThrowMock = jest.fn().mockResolvedValue({ id: 'os-1', isPaid: true });
    const mechanicCommissionCreateMock = jest.fn();

    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        serviceOrder: {
          updateMany: serviceOrderUpdateManyMock,
          findFirst: jest.fn().mockResolvedValue({ isPaid: true }),
          findUniqueOrThrow: serviceOrderFindUniqueOrThrowMock,
        },
        accountsReceivable: { create: receivableCreateMock },
        mechanicCommission: { create: mechanicCommissionCreateMock },
      })
    );

    const result = await service.registerPayment('os-1', 'company-A', 'PIX');

    expect(result.isPaid).toBe(true);
    expect(mechanicCommissionCreateMock).not.toHaveBeenCalled();
  });
});

describe('ServiceOrderService.assignMechanic', () => {
  const service = new ServiceOrderService();

  beforeEach(() => {
    userFindFirstMock.mockReset();
  });

  it('rejeita atribuir um usuário que não é MECHANIC', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A' });
    userFindFirstMock.mockResolvedValueOnce({ id: 'user-1', companyId: 'company-A', userType: 'VIEWER' });

    await expect(service.assignMechanic('os-1', 'company-A', 'user-1')).rejects.toThrow(
      'Usuário informado não é um mecânico'
    );
  });

  it('aceita atribuir um usuário com userType MECHANIC da mesma empresa', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'os-1', companyId: 'company-A' });
    userFindFirstMock.mockResolvedValueOnce({ id: 'mech-1', companyId: 'company-A', userType: 'MECHANIC' });
    serviceOrderUpdateTopLevelMock.mockResolvedValueOnce({ id: 'os-1', mechanicId: 'mech-1' });

    const result = await service.assignMechanic('os-1', 'company-A', 'mech-1');
    expect(result.mechanicId).toBe('mech-1');
    expect(serviceOrderUpdateTopLevelMock).toHaveBeenCalledWith({
      where: { id: 'os-1' },
      data: { mechanicId: 'mech-1' },
    });
  });
});
