/**
 * Testes do PaymentService: idempotência, adaptadores honestos (PIX/TEF
 * ficam PENDING, nunca falso-APPROVED), reconciliação sem reprocessamento
 * duplicado, e proteção contra overpayment.
 */

const paymentFindUniqueMock = jest.fn();
const paymentFindFirstMock = jest.fn();
const paymentFindManyMock = jest.fn();
const paymentCreateMock = jest.fn();
const paymentUpdateMock = jest.fn();
const saleFindFirstMock = jest.fn();
const saleUpdateMock = jest.fn();
const cashMovementCreateMock = jest.fn();
const cashRegisterUpdateMock = jest.fn();
const cashRegisterFindUniqueMock = jest.fn();
const queryRawMock = jest.fn().mockResolvedValue([{ status: 'PENDING' }]); // SELECT status ... FOR UPDATE da venda
// Sem política cadastrada (retorno null), InstallmentPolicyService cai no
// padrão de 1x — todos os testes deste arquivo usam installments 1 (padrão
// implícito de processPayment quando não informado), então isso nunca
// bloqueia nenhum caso já existente.
const installmentPolicyFindFirstMock = jest.fn().mockResolvedValue(null);

jest.mock('./payment-settings.service', () => ({
  __esModule: true,
  default: { getEffective: jest.fn().mockResolvedValue({ cashDenominationControl: false, source: 'default' }) },
}));

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      payment: {
        findUnique: paymentFindUniqueMock,
        findFirst: paymentFindFirstMock,
        findMany: paymentFindManyMock,
        create: paymentCreateMock,
        update: paymentUpdateMock,
      },
      sale: {
        findFirst: saleFindFirstMock,
        update: saleUpdateMock,
      },
      cashMovement: {
        create: cashMovementCreateMock,
      },
      cashRegister: {
        update: cashRegisterUpdateMock,
        findUnique: cashRegisterFindUniqueMock,
      },
      installmentPolicy: {
        findFirst: installmentPolicyFindFirstMock,
      },
      $queryRaw: queryRawMock,
      $transaction: jest.fn(async (fn: any) =>
        fn({
          $queryRaw: queryRawMock,
          payment: { create: paymentCreateMock, update: paymentUpdateMock, findMany: paymentFindManyMock },
          sale: { update: saleUpdateMock },
          cashMovement: { create: cashMovementCreateMock },
          cashRegister: { update: cashRegisterUpdateMock, findUnique: cashRegisterFindUniqueMock },
        })
      ),
    })),
    Prisma: { Decimal: Number },
  };
});

import { PaymentService } from './payment.service';

function baseSale(overrides: Partial<any> = {}) {
  return {
    id: 'sale-1',
    companyId: 'company-A',
    branchId: 'branch-1',
    status: 'PENDING',
    totalAmount: 100,
    cashRegisterId: 'register-1',
    userId: 'user-1',
    saleNumber: 42,
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  paymentCreateMock.mockImplementation(async ({ data }: any) => ({ id: 'payment-new', ...data }));
  saleUpdateMock.mockResolvedValue({});
  cashMovementCreateMock.mockResolvedValue({});
  cashRegisterUpdateMock.mockResolvedValue({});
  cashRegisterFindUniqueMock.mockResolvedValue({ id: 'register-1', status: 'OPEN' });
  queryRawMock.mockResolvedValue([{ status: 'PENDING' }]);
  // Nenhum teste deste arquivo parte de um pagamento APPROVED pré-existente
  // (os que têm `payments` no fixture usam status PENDING) — o lock+releitura
  // dentro da transação (ver payment.service.ts) sempre relê do zero.
  paymentFindManyMock.mockResolvedValue([]);
});

describe('PaymentService.processPayment — idempotência', () => {
  const paymentService = new PaymentService();

  it('retorna o pagamento existente ao repetir o mesmo transactionId para a mesma venda (retry), sem criar duplicata', async () => {
    const existing = {
      id: 'payment-1',
      transactionId: 'tx-123',
      saleId: 'sale-1',
      companyId: 'company-A',
      status: 'APPROVED',
      amount: 50,
    };
    paymentFindUniqueMock.mockResolvedValueOnce(existing);

    const result = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'CASH',
      amount: 50,
      transactionId: 'tx-123',
    });

    expect(result).toBe(existing);
    expect(paymentCreateMock).not.toHaveBeenCalled();
    expect(saleFindFirstMock).not.toHaveBeenCalled();
  });

  it('rejeita quando o mesmo transactionId pertence a outra venda (colisão real, não retry)', async () => {
    const existing = {
      id: 'payment-1',
      transactionId: 'tx-123',
      saleId: 'sale-OTHER',
      companyId: 'company-A',
      status: 'APPROVED',
      amount: 50,
    };
    paymentFindUniqueMock.mockResolvedValueOnce(existing);

    await expect(
      paymentService.processPayment({
        companyId: 'company-A',
        saleId: 'sale-1',
        paymentMethod: 'CASH',
        amount: 50,
        transactionId: 'tx-123',
      })
    ).rejects.toThrow(/different sale/);

    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it('em corrida (P2002), devolve o registro criado pela requisição concorrente em vez de duplicar', async () => {
    paymentFindUniqueMock
      .mockResolvedValueOnce(null) // checagem otimista inicial: nada ainda
      .mockResolvedValueOnce({
        id: 'payment-race',
        transactionId: 'tx-race',
        saleId: 'sale-1',
        companyId: 'company-A',
        status: 'APPROVED',
        amount: 30,
      }); // após P2002: já existe

    saleFindFirstMock.mockResolvedValueOnce(baseSale());

    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    paymentCreateMock.mockRejectedValueOnce(p2002);

    const result = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'CASH',
      amount: 30,
      transactionId: 'tx-race',
    });

    expect((result as any).id).toBe('payment-race');
  });
});

describe('PaymentService.processPayment — adaptadores honestos', () => {
  const paymentService = new PaymentService();

  it('pagamento em dinheiro é aprovado imediatamente e atualiza a venda/caixa', async () => {
    saleFindFirstMock.mockResolvedValueOnce(baseSale());

    const result: any = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'CASH',
      amount: 100,
    });

    expect(result.status).toBe('APPROVED');
    expect(saleUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', paidAmount: 100 }) })
    );
    expect(cashMovementCreateMock).toHaveBeenCalled();
    // Regressão: expectedAmount do caixa precisa refletir a venda em tempo
    // real (GET /cash-register/current), não só no recálculo do fechamento.
    expect(cashRegisterUpdateMock).toHaveBeenCalledWith({
      where: { id: 'register-1' },
      data: { expectedAmount: { increment: 100 } },
    });
  });

  it('pagamento PIX vem PENDING (nunca falso-APPROVED) e não mexe no saldo da venda', async () => {
    saleFindFirstMock.mockResolvedValueOnce(baseSale());

    const result: any = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'PIX',
      amount: 100,
      transactionId: 'pix-tx-1',
    });

    expect(result.status).toBe('PENDING');
    expect(saleUpdateMock).not.toHaveBeenCalled();
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('pagamento de cartão sem TEF (manual) é aprovado de forma explícita pelo adaptador manual', async () => {
    saleFindFirstMock.mockResolvedValueOnce(baseSale());

    const result: any = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'CREDIT_CARD',
      amount: 100,
    });

    expect(result.status).toBe('APPROVED');
  });

  // REGRESSÃO (achado de auditoria de integração): um pagamento aprovado
  // para um caixa já FECHADO não pode reescrever expectedAmount/gerar
  // movimento retroativo — o caixa fechado é imutável (mesmo princípio já
  // aplicado em cancelSale). A venda ainda reflete o pagamento real.
  it('pagamento aprovado para venda de um caixa já FECHADO atualiza a venda mas não mexe no caixa', async () => {
    saleFindFirstMock.mockResolvedValueOnce(baseSale());
    cashRegisterFindUniqueMock.mockResolvedValueOnce({ id: 'register-1', status: 'CLOSED' });

    const result: any = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'CASH',
      amount: 100,
    });

    expect(result.status).toBe('APPROVED');
    expect(saleUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', paidAmount: 100 }) })
    );
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
    expect(cashRegisterUpdateMock).not.toHaveBeenCalled();
  });
});

describe('PaymentService.reconcilePayment', () => {
  const paymentService = new PaymentService();

  it('não reprocessa um pagamento já em estado final (APPROVED)', async () => {
    const approved = {
      id: 'payment-1',
      companyId: 'company-A',
      status: 'APPROVED',
      transactionId: 'tx-1',
      paymentMethod: 'PIX',
      amount: 100,
      sale: baseSale(),
    };
    paymentFindFirstMock.mockResolvedValueOnce(approved);

    const result = await paymentService.reconcilePayment('payment-1', 'company-A');

    expect(result).toBe(approved);
    expect(saleUpdateMock).not.toHaveBeenCalled();
    expect(paymentUpdateMock).not.toHaveBeenCalled();
  });

  it('um PIX PENDING continua PENDING após reconciliar (adaptador sem gateway real é honesto, não inventa aprovação)', async () => {
    const pending = {
      id: 'payment-2',
      companyId: 'company-A',
      status: 'PENDING',
      transactionId: 'tx-2',
      paymentMethod: 'PIX',
      amount: 100,
      paidAt: null,
      authorizationCode: null,
      nsuHost: null,
      nsuTef: null,
      sale: baseSale({ payments: [{ id: 'payment-2', status: 'PENDING', amount: 100 }] }),
    };
    paymentFindFirstMock.mockResolvedValueOnce(pending);

    const result = await paymentService.reconcilePayment('payment-2', 'company-A');

    expect(result).toBe(pending);
    expect(paymentUpdateMock).not.toHaveBeenCalled();
    expect(saleUpdateMock).not.toHaveBeenCalled();
  });
});

describe('PaymentService.processPayment — overpayment', () => {
  const paymentService = new PaymentService();

  it('rejeita pagamento em cartão que excede o saldo restante da venda', async () => {
    saleFindFirstMock.mockResolvedValueOnce(baseSale({ totalAmount: 100 }));

    await expect(
      paymentService.processPayment({
        companyId: 'company-A',
        saleId: 'sale-1',
        paymentMethod: 'CREDIT_CARD',
        amount: 150,
      })
    ).rejects.toThrow(/exceeds remaining balance/);

    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it('dinheiro acima do restante: aplica só o restante e registra o troco à parte', async () => {
    saleFindFirstMock.mockResolvedValueOnce(baseSale({ totalAmount: 100 }));

    const result: any = await paymentService.processPayment({
      companyId: 'company-A',
      saleId: 'sale-1',
      paymentMethod: 'CASH',
      amount: 120,
    });

    expect(result.status).toBe('APPROVED');
    expect(paymentCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 100, receivedAmount: 120, changeAmount: 20 }) })
    );
    expect(saleUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paidAmount: 100, changeAmount: { increment: 20 } }) })
    );
  });

  it('REGRESSÃO (corrida): releitura dentro da transação travada pega uma aprovação concorrente que a checagem otimista não via', async () => {
    // A checagem otimista (fora da transação) enxerga a venda AINDA sem
    // nenhum pagamento aprovado — exatamente o que uma 2ª requisição
    // concorrente veria antes da 1ª comitar.
    saleFindFirstMock.mockResolvedValueOnce(baseSale({ totalAmount: 100, payments: [] }));
    // Mas, dentro da transação (após o `SELECT ... FOR UPDATE` serializar
    // com a 1ª requisição, já comitada), a releitura mostra que a venda já
    // foi totalmente paga por outro pagamento aprovado enquanto esta
    // requisição esperava o lock.
    paymentFindManyMock.mockResolvedValueOnce([{ amount: 100 }]);

    await expect(
      paymentService.processPayment({
        companyId: 'company-A',
        saleId: 'sale-1',
        paymentMethod: 'CASH',
        amount: 50,
      })
    ).rejects.toThrow(/already fully paid \(concurrent payment approved first\)/);

    expect(paymentCreateMock).not.toHaveBeenCalled();
    expect(saleUpdateMock).not.toHaveBeenCalled();
    expect(cashRegisterUpdateMock).not.toHaveBeenCalled();
  });

  it('rejeita qualquer pagamento adicional quando a venda já está totalmente coberta (aprovado + pendente)', async () => {
    saleFindFirstMock.mockResolvedValueOnce(
      baseSale({
        totalAmount: 100,
        payments: [{ id: 'p-existing', status: 'PENDING', amount: 100 }],
      })
    );

    await expect(
      paymentService.processPayment({
        companyId: 'company-A',
        saleId: 'sale-1',
        paymentMethod: 'CASH',
        amount: 10,
      })
    ).rejects.toThrow(/already fully paid/);
  });
});
