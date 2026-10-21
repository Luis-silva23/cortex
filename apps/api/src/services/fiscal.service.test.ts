const findFirstSaleMock = jest.fn();
const findFirstFiscalDocumentMock = jest.fn();
const findManySaleItemMock = jest.fn();
const createFiscalDocumentMock = jest.fn();
const updateFiscalDocumentMock = jest.fn();
const findUniqueFiscalConfigMock = jest.fn();
const updateFiscalConfigMock = jest.fn();
const transactionMock = jest.fn();

class FakeP2002 extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    sale: { findFirst: findFirstSaleMock },
    saleItem: { findMany: findManySaleItemMock },
    fiscalDocument: {
      findFirst: findFirstFiscalDocumentMock,
      create: createFiscalDocumentMock,
      update: updateFiscalDocumentMock,
    },
    fiscalConfig: {
      findUnique: findUniqueFiscalConfigMock,
      update: updateFiscalConfigMock,
    },
    $transaction: transactionMock,
  })),
  Prisma: { PrismaClientKnownRequestError: FakeP2002 },
  FiscalDocumentStatus: {
    DRAFT: 'DRAFT',
    PENDING: 'PENDING',
    AUTHORIZED: 'AUTHORIZED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    CONTINGENCY: 'CONTINGENCY',
  },
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

const emitMock = jest.fn();
const cancelMock = jest.fn();
jest.mock('./fiscal-adapters/unconfigured-adapter', () => ({
  __esModule: true,
  default: { providerName: 'unconfigured', emit: (...args: any[]) => emitMock(...args), cancel: (...args: any[]) => cancelMock(...args) },
}));

// Política fiscal (docs/CORTEX/policies/FISCAL.md): padrão = emissão de VENDA habilitada.
const effectiveMock = jest.fn();
jest.mock('./policy.service', () => ({ policyService: { effective: (...a: any[]) => effectiveMock(...a) } }));
const txQueryRawMock = jest.fn();

import { FiscalService } from './fiscal.service';

describe('FiscalService', () => {
  const service = new FiscalService();

  beforeEach(() => {
    // reset (não só clear): filas de mockResolvedValueOnce não consumidas vazavam para o teste seguinte.
    jest.resetAllMocks();
    effectiveMock.mockResolvedValue({ 'fiscal.enabledOperations': ['SALE'] });
    txQueryRawMock.mockResolvedValue([{ status: 'PAID' }]);
    // emitDocument agora reserva número e cria o rascunho dentro de runInTransaction (travas por venda/filial).
    transactionMock.mockImplementation(async (cb: any) =>
      cb({
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: txQueryRawMock,
        fiscalDocument: { findFirst: findFirstFiscalDocumentMock, create: createFiscalDocumentMock, update: updateFiscalDocumentMock },
        fiscalConfig: { findUnique: findUniqueFiscalConfigMock, update: updateFiscalConfigMock },
      })
    );
  });

  describe('emitDocument — venda cancelada/não concluída e política (docs/CORTEX/policies/FISCAL.md)', () => {
    const sale = (status: string) => ({ id: 'sale-9', companyId: 'company-A', branchId: 'branch-1', totalAmount: 100, status });

    it.each([
      ['CANCELLED', 'FISCAL_SALE_CANCELLED'],
      ['PENDING', 'FISCAL_SALE_NOT_COMPLETED'],
      ['PARTIALLY_PAID', 'FISCAL_SALE_NOT_COMPLETED'],
    ])('venda %s: 409 %s e nenhum documento criado', async (status, code) => {
      findFirstSaleMock.mockResolvedValueOnce(sale(status));
      await expect(service.emitDocument('sale-9', 'company-A', 'branch-1')).rejects.toMatchObject({ statusCode: 409, code });
      expect(createFiscalDocumentMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('política sem SALE em fiscal.enabledOperations: 409 FISCAL_OPERATION_DISABLED, nada criado', async () => {
      findFirstSaleMock.mockResolvedValueOnce(sale('PAID'));
      effectiveMock.mockResolvedValueOnce({ 'fiscal.enabledOperations': ['RETURN'] });
      await expect(service.emitDocument('sale-9', 'company-A', 'branch-1')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_OPERATION_DISABLED' });
      expect(createFiscalDocumentMock).not.toHaveBeenCalled();
    });

    it('venda cancelada entre a leitura e a trava: a releitura na transação recusa e nada é criado', async () => {
      findFirstSaleMock.mockResolvedValueOnce(sale('PAID'));
      txQueryRawMock.mockResolvedValueOnce([{ status: 'CANCELLED' }]);
      await expect(service.emitDocument('sale-9', 'company-A', 'branch-1')).rejects.toMatchObject({ code: 'FISCAL_SALE_CANCELLED' });
      expect(createFiscalDocumentMock).not.toHaveBeenCalled();
    });
  });

  describe('emitDocument', () => {
    it('cria um FiscalDocument registrando a tentativa mesmo sem provedor configurado, com status honesto', async () => {
      findFirstSaleMock.mockResolvedValueOnce({
        id: 'sale-1',
        status: 'PAID',
        companyId: 'company-A',
        branchId: 'branch-1',
        totalAmount: 100,
      });
      findFirstFiscalDocumentMock.mockResolvedValueOnce(null); // sem documento ativo existente
      findUniqueFiscalConfigMock.mockResolvedValueOnce(null); // sem FiscalConfig
      createFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-1',
        companyId: 'company-A',
        branchId: 'branch-1',
        series: '1',
        number: 1,
        saleId: 'sale-1',
      });
      findManySaleItemMock.mockResolvedValueOnce([]);
      emitMock.mockResolvedValueOnce({
        status: 'PENDING',
        errorMessage: 'Emissão fiscal não configurada para esta empresa — configure um provedor em Configurações > Fiscal.',
      });
      updateFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-1',
        status: 'PENDING',
        rejectionReason: 'Emissão fiscal não configurada para esta empresa — configure um provedor em Configurações > Fiscal.',
      });

      const result = await service.emitDocument('sale-1', 'company-A', 'branch-1');

      expect(createFiscalDocumentMock).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('PENDING');
      expect(result.rejectionReason).toContain('não configurada');
      // Sem FiscalConfig, não há série a incrementar.
      expect(updateFiscalConfigMock).not.toHaveBeenCalled();
    });

    it('delega ao adapter correto quando há FiscalConfig e persiste o resultado autorizado', async () => {
      findFirstSaleMock.mockResolvedValueOnce({
        id: 'sale-2',
        status: 'PAID',
        companyId: 'company-A',
        branchId: 'branch-1',
        totalAmount: 250,
      });
      findFirstFiscalDocumentMock.mockResolvedValueOnce(null);
      findUniqueFiscalConfigMock.mockResolvedValue({
        companyId: 'company-A',
        branchId: 'branch-1',
        nfceEnabled: true,
        nfceSeriesNumber: 1,
        nfceNextNumber: 5,
      });
      createFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-2',
        companyId: 'company-A',
        branchId: 'branch-1',
        series: '1',
        number: 5,
        saleId: 'sale-2',
      });
      findManySaleItemMock.mockResolvedValueOnce([
        { productName: 'Óleo', quantity: 1, unitPrice: 250, totalPrice: 250 },
      ]);
      // Mesmo com FiscalConfig presente, o único adapter funcional neste
      // ambiente é o unconfigured-adapter (nenhum provedor real integrado) —
      // o teste confirma que o service delega a ELE (via resolveAdapter).
      emitMock.mockResolvedValueOnce({ status: 'PENDING', errorMessage: 'not configured' });
      updateFiscalDocumentMock.mockResolvedValueOnce({ id: 'doc-2', status: 'PENDING' });

      await service.emitDocument('sale-2', 'company-A', 'branch-1');

      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 'company-A',
          branchId: 'branch-1',
          saleId: 'sale-2',
          series: '1',
          number: 5,
          items: [expect.objectContaining({ description: 'Óleo', quantity: 1, unitPrice: 250 })],
        })
      );
      // Com FiscalConfig existente, o próximo número de série é reservado.
      expect(updateFiscalConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nfceNextNumber: 6 } })
      );
    });

    it('rejeita emissão quando a venda não existe/não pertence à empresa', async () => {
      findFirstSaleMock.mockResolvedValueOnce(null);

      await expect(service.emitDocument('sale-x', 'company-A', 'branch-1')).rejects.toThrow('Sale not found');
      expect(createFiscalDocumentMock).not.toHaveBeenCalled();
    });

    it('guarda contra corrida na numeração: quando duas emissões concorrentes colidem no `number` (P2002 da constraint única), tenta de novo com o número atualizado em vez de vazar o erro cru', async () => {
      findFirstSaleMock.mockResolvedValueOnce({
        id: 'sale-3',
        status: 'PAID',
        companyId: 'company-A',
        branchId: 'branch-1',
        totalAmount: 300,
      });
      findFirstFiscalDocumentMock.mockResolvedValueOnce(null);
      // 1ª leitura: nextNumber=5 (mesmo valor que uma emissão concorrente
      // acabou de usar). 2ª leitura (após o P2002): já reflete o
      // incremento que a concorrente commitou — nextNumber=6.
      // leituras: config inicial, releitura na trava (5) -> P2002 -> config relida, releitura na trava (6)
      findUniqueFiscalConfigMock
        .mockResolvedValueOnce({ companyId: 'company-A', branchId: 'branch-1', nfceSeriesNumber: 1, nfceNextNumber: 5 })
        .mockResolvedValueOnce({ companyId: 'company-A', branchId: 'branch-1', nfceSeriesNumber: 1, nfceNextNumber: 5 })
        .mockResolvedValueOnce({ companyId: 'company-A', branchId: 'branch-1', nfceSeriesNumber: 1, nfceNextNumber: 6 })
        .mockResolvedValueOnce({ companyId: 'company-A', branchId: 'branch-1', nfceSeriesNumber: 1, nfceNextNumber: 6 });
      createFiscalDocumentMock
        .mockRejectedValueOnce(new FakeP2002()) // 1ª tentativa: colide com a concorrente
        .mockResolvedValueOnce({ id: 'doc-3', companyId: 'company-A', branchId: 'branch-1', series: '1', number: 6, saleId: 'sale-3' });
      findManySaleItemMock.mockResolvedValueOnce([]);
      emitMock.mockResolvedValueOnce({ status: 'PENDING', errorMessage: 'not configured' });
      updateFiscalDocumentMock.mockResolvedValueOnce({ id: 'doc-3', status: 'PENDING' });

      await service.emitDocument('sale-3', 'company-A', 'branch-1');

      expect(createFiscalDocumentMock).toHaveBeenCalledTimes(2);
      expect(createFiscalDocumentMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ number: 5 }) }));
      expect(createFiscalDocumentMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ number: 6 }) }));
      // Só reserva o próximo número (increment) na tentativa que de fato criou o documento.
      expect(updateFiscalConfigMock).toHaveBeenCalledTimes(1);
      expect(updateFiscalConfigMock).toHaveBeenCalledWith(expect.objectContaining({ data: { nfceNextNumber: 7 } }));
    });

    it('esgotando todas as tentativas sob contenção extrema, nunca vaza o erro cru do Prisma — devolve mensagem de negócio clara', async () => {
      findFirstSaleMock.mockResolvedValueOnce({
        id: 'sale-4',
        status: 'PAID',
        companyId: 'company-A',
        branchId: 'branch-1',
        totalAmount: 400,
      });
      findFirstFiscalDocumentMock.mockResolvedValueOnce(null);
      findUniqueFiscalConfigMock.mockResolvedValue({
        companyId: 'company-A',
        branchId: 'branch-1',
        nfceSeriesNumber: 1,
        nfceNextNumber: 10,
      });
      createFiscalDocumentMock.mockRejectedValue(new FakeP2002());

      await expect(service.emitDocument('sale-4', 'company-A', 'branch-1')).rejects.toThrow(
        'alta concorrência na emissão fiscal'
      );

      expect(createFiscalDocumentMock).toHaveBeenCalledTimes(5);
      expect(updateFiscalConfigMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });
  });

  describe('cancelDocument', () => {
    it('rejeita cancelar um documento já cancelado', async () => {
      findFirstFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-1',
        companyId: 'company-A',
        branchId: 'branch-1',
        status: 'CANCELLED',
      });

      await expect(service.cancelDocument('doc-1', 'company-A', 'motivo qualquer')).rejects.toThrow(
        'already cancelled'
      );
      expect(cancelMock).not.toHaveBeenCalled();
    });

    it('rejeita cancelamento sem motivo', async () => {
      findFirstFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-1',
        companyId: 'company-A',
        branchId: 'branch-1',
        status: 'PENDING',
      });

      await expect(service.cancelDocument('doc-1', 'company-A', '')).rejects.toThrow('reason is required');
    });

    it('cancela um documento não-cancelado delegando ao adapter', async () => {
      findFirstFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-1',
        companyId: 'company-A',
        branchId: 'branch-1',
        status: 'PENDING',
      });
      findUniqueFiscalConfigMock.mockResolvedValueOnce(null);
      cancelMock.mockResolvedValueOnce({
        status: 'PENDING',
        errorMessage: 'Emissão fiscal não configurada para esta empresa — configure um provedor em Configurações > Fiscal.',
      });

      const txQueryRawMock = jest.fn().mockResolvedValue(undefined);
      const txFindUniqueOrThrowMock = jest.fn().mockResolvedValueOnce({ id: 'doc-1', status: 'PENDING' });
      const txUpdateMock = jest.fn().mockResolvedValueOnce({ id: 'doc-1', status: 'PENDING', cancelReason: 'cliente desistiu' });
      transactionMock.mockImplementationOnce(async (cb: any) =>
        cb({
          $queryRaw: txQueryRawMock,
          fiscalDocument: { findUniqueOrThrow: txFindUniqueOrThrowMock, update: txUpdateMock },
        })
      );

      const result = await service.cancelDocument('doc-1', 'company-A', 'cliente desistiu');

      expect(cancelMock).toHaveBeenCalledWith('doc-1', 'cliente desistiu');
      expect(txQueryRawMock).toHaveBeenCalledTimes(1); // SELECT ... FOR UPDATE
      expect(txUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-1' },
          data: expect.objectContaining({ cancelReason: 'cliente desistiu' }),
        })
      );
      expect(result.status).toBe('PENDING');
    });

    it('guarda contra corrida: a chamada que espera o lock relê o status já cancelado pela concorrente e se recusa a sobrescrever, mesmo já tendo chamado adapter.cancel() antes de adquirir o lock', async () => {
      findFirstFiscalDocumentMock.mockResolvedValueOnce({
        id: 'doc-1',
        companyId: 'company-A',
        branchId: 'branch-1',
        status: 'AUTHORIZED', // leitura otimista fora da transação ainda não vê o cancelamento da concorrente
      });
      findUniqueFiscalConfigMock.mockResolvedValueOnce(null);
      cancelMock.mockResolvedValueOnce({ status: 'CANCELLED', cancelledAt: new Date() });

      const txQueryRawMock = jest.fn().mockResolvedValue(undefined);
      // Depois de esperar o `FOR UPDATE`, a releitura mostra que a
      // concorrente já commitou um cancelamento genuíno enquanto esta
      // chamada aguardava o lock.
      const txFindUniqueOrThrowMock = jest.fn().mockResolvedValueOnce({ id: 'doc-1', status: 'CANCELLED' });
      const txUpdateMock = jest.fn();
      transactionMock.mockImplementationOnce(async (cb: any) =>
        cb({
          $queryRaw: txQueryRawMock,
          fiscalDocument: { findUniqueOrThrow: txFindUniqueOrThrowMock, update: txUpdateMock },
        })
      );

      await expect(service.cancelDocument('doc-1', 'company-A', 'motivo')).rejects.toThrow('already cancelled');

      // Nunca sobrescreve o cancelamento genuíno já commitado pela concorrente.
      expect(txUpdateMock).not.toHaveBeenCalled();
    });
  });
});
