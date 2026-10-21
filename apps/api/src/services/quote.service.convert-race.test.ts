/**
 * Teste de regressão do achado de auditoria em
 * QuoteService.convertToServiceOrder: `ServiceOrder` tem DUAS constraints
 * únicas que podem colidir num P2002 — `quoteVersionId` (@unique) e
 * `@@unique([branchId, osNumber])` — mas o código antigo tratava QUALQUER
 * P2002 como "esta versão já foi convertida", mesmo quando a colisão real
 * era em osNumber (uma OS de OUTRO orçamento/venda concorrente na mesma
 * filial, sem nenhuma relação com esta conversão). Mesma classe de corrida
 * já corrigida (retry+jitter) em service-order.service.ts::create(), que
 * inclusive já documentava esse risco específico aqui sem corrigi-lo.
 */

const quoteFindFirstMock = jest.fn();
const quoteVersionFindFirstMock = jest.fn();
const serviceOrderFindFirstMock = jest.fn();
const branchFindFirstMock = jest.fn().mockResolvedValue({ id: 'branch-1' });
const transactionMock = jest.fn();

class FakeP2002 extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    quote: { findFirst: quoteFindFirstMock },
    quoteVersion: { findFirst: quoteVersionFindFirstMock },
    serviceOrder: { findFirst: serviceOrderFindFirstMock },
    branch: { findFirst: branchFindFirstMock },
    $transaction: transactionMock,
  })),
  Prisma: { PrismaClientKnownRequestError: FakeP2002 },
}));

import { QuoteService } from './quote.service';

function baseQuote() {
  return { id: 'quote-1', companyId: 'company-A', customerId: 'cust-1', motorcycleId: 'moto-1', status: 'APPROVED', quoteNumber: 10 };
}

function baseApprovedVersion() {
  return { id: 'version-1', quoteId: 'quote-1', versionNumber: 1, isApproved: true, items: [] };
}

function txWithServiceOrderCreate(serviceOrderCreateImpl: (...args: any[]) => any) {
  return async (cb: any) =>
    cb({
      // A numeração de osNumber agora é lida DENTRO da transação, atrás de
      // um `pg_advisory_xact_lock` (ver quote.service.ts) — por isso o `tx`
      // simulado precisa de `$executeRaw` e do mesmo `findFirst` de antes.
      // A ordem das respostas de `serviceOrderFindFirstMock` não muda:
      // existingLink (fora da tx) → lastOs (dentro da tx) → re-checagem.
      $executeRaw: jest.fn().mockResolvedValue(1),
      serviceOrder: {
        findFirst: serviceOrderFindFirstMock,
        create: serviceOrderCreateImpl,
        update: jest.fn().mockResolvedValue({ id: 'os-1', items: [] }),
      },
      serviceOrderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      serviceOrderItem: { create: jest.fn().mockResolvedValue({}) },
      quote: { update: jest.fn().mockResolvedValue({}) },
    });
}

describe('QuoteService.convertToServiceOrder — guarda contra corrida na numeração de OS', () => {
  const service = new QuoteService();

  beforeEach(() => {
    jest.clearAllMocks();
    branchFindFirstMock.mockResolvedValue({ id: 'branch-1' });
  });

  it('caminho feliz: sem colisão, converte em uma única tentativa', async () => {
    quoteFindFirstMock.mockResolvedValueOnce(baseQuote());
    quoteVersionFindFirstMock.mockResolvedValueOnce(baseApprovedVersion());
    serviceOrderFindFirstMock
      .mockResolvedValueOnce(null) // existingLink: ainda não convertido
      .mockResolvedValueOnce({ osNumber: 41 }); // lastOs

    const createMock = jest.fn().mockResolvedValue({ id: 'os-1' });
    transactionMock.mockImplementationOnce(txWithServiceOrderCreate(createMock));

    await service.convertToServiceOrder('quote-1', 'company-A', {
      branchId: 'branch-1',
      entryKilometer: 1000,
      userId: 'user-1',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ osNumber: 42 }) }));
  });

  it('colisão em osNumber (OS de outro orçamento/venda concorrente): tenta de novo com o próximo número, NÃO reporta "já convertida"', async () => {
    quoteFindFirstMock.mockResolvedValueOnce(baseQuote());
    quoteVersionFindFirstMock.mockResolvedValueOnce(baseApprovedVersion());
    serviceOrderFindFirstMock
      .mockResolvedValueOnce(null) // existingLink inicial: ainda não convertido
      .mockResolvedValueOnce({ osNumber: 41 }) // lastOs, 1ª tentativa
      .mockResolvedValueOnce(null) // re-checagem de existingLink no catch: NÃO foi esta versão que colidiu
      .mockResolvedValueOnce({ osNumber: 42 }); // lastOs, 2ª tentativa (já reflete o osNumber=42 que a concorrente usou)

    const createMock = jest
      .fn()
      .mockRejectedValueOnce(new FakeP2002()) // 1ª tentativa: colide em osNumber com outra OS
      .mockResolvedValueOnce({ id: 'os-1' }); // 2ª tentativa: sucesso

    transactionMock
      .mockImplementationOnce(txWithServiceOrderCreate(createMock))
      .mockImplementationOnce(txWithServiceOrderCreate(createMock));

    const result = await service.convertToServiceOrder('quote-1', 'company-A', {
      branchId: 'branch-1',
      entryKilometer: 1000,
      userId: 'user-1',
    });

    expect(result).toBeDefined();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ osNumber: 42 }) }));
    expect(createMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ osNumber: 43 }) }));
  });

  it('colisão genuína (a mesma versão foi convertida por uma chamada concorrente): reporta o erro correto e NÃO tenta de novo', async () => {
    quoteFindFirstMock.mockResolvedValueOnce(baseQuote());
    quoteVersionFindFirstMock.mockResolvedValueOnce(baseApprovedVersion());
    serviceOrderFindFirstMock
      .mockResolvedValueOnce(null) // existingLink inicial: passou pela checagem otimista
      .mockResolvedValueOnce({ osNumber: 41 }) // lastOs
      .mockResolvedValueOnce({ id: 'os-concurrent' }); // re-checagem no catch: a concorrente REALMENTE converteu esta versão

    const createMock = jest.fn().mockRejectedValueOnce(new FakeP2002());
    transactionMock.mockImplementationOnce(txWithServiceOrderCreate(createMock));

    await expect(
      service.convertToServiceOrder('quote-1', 'company-A', { branchId: 'branch-1', entryKilometer: 1000, userId: 'user-1' })
    ).rejects.toThrow('This quote version has already been converted into a service order');

    expect(createMock).toHaveBeenCalledTimes(1); // não tenta de novo
  });

  it('contenção extrema (osNumber colide em todas as tentativas): nunca vaza o P2002 cru, devolve mensagem de negócio clara', async () => {
    quoteFindFirstMock.mockResolvedValueOnce(baseQuote());
    quoteVersionFindFirstMock.mockResolvedValueOnce(baseApprovedVersion());
    // 1ª chamada: existingLink. Depois, alternando lastOs / re-checagem
    // (sempre null — nunca é esta versão que colide) por até 5 tentativas.
    serviceOrderFindFirstMock.mockResolvedValue(null);

    const createMock = jest.fn().mockRejectedValue(new FakeP2002());
    for (let i = 0; i < 5; i++) {
      transactionMock.mockImplementationOnce(txWithServiceOrderCreate(createMock));
    }

    await expect(
      service.convertToServiceOrder('quote-1', 'company-A', { branchId: 'branch-1', entryKilometer: 1000, userId: 'user-1' })
    ).rejects.toThrow('alta concorrência');

    expect(createMock).toHaveBeenCalledTimes(5);
  });
});
