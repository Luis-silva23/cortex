/**
 * Teste de regressão do achado de auditoria em SaleService.getSalesStats:
 * a função antes buscava TODAS as vendas PAID/PARTIALLY_PAID da empresa via
 * `findMany` (sem take/skip, com `items`/`payments` incluídos) só para somar
 * em JavaScript — mesmo bug já corrigido em GET /users e no device list do
 * Super Admin, mas aqui a correção certa é usar agregação do Postgres
 * (aggregate/count/groupBy) em vez de paginar, já que o resultado precisa
 * ser o total do período inteiro, não de uma página.
 *
 * O que este teste trava: `sale.findMany` NUNCA é chamado por este método
 * (nem com nem sem where), e os números retornados batem com o que o
 * `findMany` antigo + reduce em JS teria calculado — a refatoração não pode
 * mudar o resultado, só como ele é calculado.
 */

const saleFindManyMock = jest.fn();
const saleAggregateMock = jest.fn();
const saleItemCountMock = jest.fn();
const paymentGroupByMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    sale: { findMany: saleFindManyMock, aggregate: saleAggregateMock },
    saleItem: { count: saleItemCountMock },
    payment: { groupBy: paymentGroupByMock },
  })),
  Prisma: {},
}));

jest.mock('./product.service', () => ({ __esModule: true, default: { checkStock: jest.fn() } }));
jest.mock('./discount.service', () => ({ __esModule: true, checkSaleDiscount: jest.fn() }));

import { SaleService } from './sale.service';

describe('SaleService.getSalesStats — agregação no banco, sem findMany ilimitado', () => {
  const saleService = new SaleService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('nunca chama sale.findMany (a busca inteira de linhas foi substituída por aggregate/count)', async () => {
    saleAggregateMock.mockResolvedValueOnce({ _count: 3, _sum: { totalAmount: 300 } });
    saleItemCountMock.mockResolvedValueOnce(7);
    paymentGroupByMock.mockResolvedValueOnce([]);

    await saleService.getSalesStats('company-A');

    expect(saleFindManyMock).not.toHaveBeenCalled();
    expect(saleAggregateMock).toHaveBeenCalledTimes(1);
    expect(saleItemCountMock).toHaveBeenCalledTimes(1);
  });

  it('escopa companyId/branchId/status/período no WHERE passado ao aggregate (nunca filtra depois de buscar)', async () => {
    saleAggregateMock.mockResolvedValueOnce({ _count: 0, _sum: { totalAmount: null } });
    saleItemCountMock.mockResolvedValueOnce(0);
    paymentGroupByMock.mockResolvedValueOnce([]);

    await saleService.getSalesStats('company-A', 'branch-1', '2026-01-01', '2026-01-31');

    const aggregateArg = saleAggregateMock.mock.calls[0][0];
    expect(aggregateArg.where).toEqual(
      expect.objectContaining({
        companyId: 'company-A',
        branchId: 'branch-1',
        status: { in: ['PAID', 'PARTIALLY_PAID'] },
        saleDate: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
      })
    );

    // saleItem.count também precisa aplicar o MESMO filtro de venda (relation filter),
    // senão contaria itens de vendas de outra empresa/período.
    const itemCountArg = saleItemCountMock.mock.calls[0][0];
    expect(itemCountArg.where.sale).toEqual(expect.objectContaining({ companyId: 'company-A', branchId: 'branch-1' }));
  });

  it('calcula totalRevenue/avgTicket a partir do _sum/_count do Postgres, igual ao antigo reduce em JS', async () => {
    // Equivalente ao que 3 vendas de R$100 cada produziriam com o findMany antigo.
    saleAggregateMock.mockResolvedValueOnce({ _count: 3, _sum: { totalAmount: 300 } });
    saleItemCountMock.mockResolvedValueOnce(9);
    paymentGroupByMock.mockResolvedValueOnce([
      { paymentMethod: 'CASH', _sum: { amount: 200 }, _count: 2 },
      { paymentMethod: 'CREDIT_CARD', _sum: { amount: 100 }, _count: 1 },
    ]);

    const result = await saleService.getSalesStats('company-A');

    expect(result).toEqual({
      totalSales: 3,
      totalRevenue: 300,
      totalItems: 9,
      avgTicket: 100,
      paymentMethods: [
        { method: 'CASH', total: 200, count: 2 },
        { method: 'CREDIT_CARD', total: 100, count: 1 },
      ],
    });
  });

  it('não divide por zero quando não há vendas no período (avgTicket = 0, não NaN/Infinity)', async () => {
    saleAggregateMock.mockResolvedValueOnce({ _count: 0, _sum: { totalAmount: null } });
    saleItemCountMock.mockResolvedValueOnce(0);
    paymentGroupByMock.mockResolvedValueOnce([]);

    const result = await saleService.getSalesStats('company-A');

    expect(result.totalSales).toBe(0);
    expect(result.totalRevenue).toBe(0);
    expect(result.avgTicket).toBe(0);
  });
});
