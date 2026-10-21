/**
 * Teste de regressão do achado de auditoria: `reversePayable`/
 * `reverseReceivable` só se protegiam contra estorno duplicado via um
 * `findFirst` + `create` sem transação nem lock — o próprio código já
 * documentava a janela de corrida teórica (duplo clique, retry de cliente)
 * e a deixava sem correção no banco. A correção adiciona um índice único
 * parcial (`accounts_payable_one_reversal_per_reference` /
 * `accounts_receivable_one_reversal_per_reference`, migration
 * `add_accounts_reversal_unique_reference`) e trata o P2002 resultante como
 * erro de negócio claro — mesmo padrão já usado em
 * CashRegisterService.openCashRegister.
 */

class FakeP2002 extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

const payableFindFirstMock = jest.fn();
const payableCreateMock = jest.fn();
const receivableFindFirstMock = jest.fn();
const receivableCreateMock = jest.fn();
const receivableUpdateManyMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    accountsPayable: { findFirst: payableFindFirstMock, create: payableCreateMock },
    accountsReceivable: { findFirst: receivableFindFirstMock, create: receivableCreateMock, updateMany: receivableUpdateManyMock },
  })),
  Prisma: { PrismaClientKnownRequestError: FakeP2002 },
}));

import { FinancialService } from './financial.service';

describe('FinancialService.reversePayable — guarda contra estorno concorrente duplicado', () => {
  const service = new FinancialService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cria o lançamento de estorno quando não há estorno anterior nem corrida', async () => {
    payableFindFirstMock
      .mockResolvedValueOnce({ id: 'payable-1', companyId: 'company-A', status: 'PAID', amount: 100 })
      .mockResolvedValueOnce(null); // nenhum estorno existente
    payableCreateMock.mockResolvedValueOnce({ id: 'reversal-1', amount: -100 });

    const result = await service.reversePayable('payable-1', 'company-A', 'motivo');

    expect(result.id).toBe('reversal-1');
    expect(payableCreateMock).toHaveBeenCalledTimes(1);
  });

  it('rejeita pelo pre-check quando já existe um estorno (caminho comum, sem corrida)', async () => {
    payableFindFirstMock
      .mockResolvedValueOnce({ id: 'payable-1', companyId: 'company-A', status: 'PAID', amount: 100 })
      .mockResolvedValueOnce({ id: 'reversal-existing' });

    await expect(service.reversePayable('payable-1', 'company-A', 'motivo')).rejects.toThrow(
      'This account has already been reversed'
    );
    expect(payableCreateMock).not.toHaveBeenCalled();
  });

  it('guarda atômica: quando duas chamadas concorrentes passam pelo pre-check, a que perde a corrida no banco (P2002 do índice único parcial) falha com erro claro, não um 500 genérico', async () => {
    // Ambas as "chamadas" leem null no pre-check (nenhuma viu o estorno da
    // outra ainda) — exatamente a corrida que o findFirst sozinho não pega.
    payableFindFirstMock
      .mockResolvedValueOnce({ id: 'payable-1', companyId: 'company-A', status: 'PAID', amount: 100 })
      .mockResolvedValueOnce(null);
    payableCreateMock.mockRejectedValueOnce(new FakeP2002());

    await expect(service.reversePayable('payable-1', 'company-A', 'motivo')).rejects.toThrow(
      'This account has already been reversed'
    );
  });

  it('repassa qualquer outro erro do banco sem mascarar como "already reversed"', async () => {
    payableFindFirstMock
      .mockResolvedValueOnce({ id: 'payable-1', companyId: 'company-A', status: 'PAID', amount: 100 })
      .mockResolvedValueOnce(null);
    payableCreateMock.mockRejectedValueOnce(new Error('Falha de conexão com o banco'));

    await expect(service.reversePayable('payable-1', 'company-A', 'motivo')).rejects.toThrow(
      'Falha de conexão com o banco'
    );
  });
});

describe('FinancialService.reverseReceivable — guarda contra estorno concorrente duplicado', () => {
  const service = new FinancialService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cria o lançamento de estorno quando não há estorno anterior nem corrida', async () => {
    receivableFindFirstMock
      .mockResolvedValueOnce({ id: 'receivable-1', companyId: 'company-A', status: 'PAID', amount: 200 })
      .mockResolvedValueOnce(null);
    receivableCreateMock.mockResolvedValueOnce({ id: 'reversal-1', amount: -200 });

    const result = await service.reverseReceivable('receivable-1', 'company-A', 'motivo');

    expect(result.id).toBe('reversal-1');
  });

  it('guarda atômica: P2002 do índice único parcial vira erro de negócio claro', async () => {
    receivableFindFirstMock
      .mockResolvedValueOnce({ id: 'receivable-1', companyId: 'company-A', status: 'PAID', amount: 200 })
      .mockResolvedValueOnce(null);
    receivableCreateMock.mockRejectedValueOnce(new FakeP2002());

    await expect(service.reverseReceivable('receivable-1', 'company-A', 'motivo')).rejects.toThrow(
      'This account has already been reversed'
    );
  });
});

describe('FinancialService.receivePayment — baixa concorrente', () => {
  const service = new FinancialService();

  it('quem perde a corrida recebe 409 em PT-BR (não 400 com "situação changed concurrently")', async () => {
    receivableFindFirstMock.mockResolvedValueOnce({ id: 'receivable-1', companyId: 'company-A', status: 'PENDING', amount: 200 });
    receivableUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(service.receivePayment('receivable-1', 'company-A')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RECEIVABLE_STATUS_CHANGED',
      message: expect.stringMatching(/mudou ao mesmo tempo/),
    });
  });
});
