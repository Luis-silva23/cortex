/**
 * Testes de DashboardService — cada teste alimenta o mock do Prisma com
 * dados conhecidos e verifica que a matemática do agregado (soma, média,
 * contagem, variação percentual) bate com o esperado, em vez de apenas
 * checar que a função não lança.
 */

const saleAggregateMock = jest.fn();
const saleGroupByMock = jest.fn();
const saleFindManyMock = jest.fn();
const saleCountMock = jest.fn();
const paymentGroupByMock = jest.fn();
const saleItemGroupByMock = jest.fn();
const accountsPayableAggregateMock = jest.fn();
const accountsReceivableAggregateMock = jest.fn();
const productFindManyMock = jest.fn();
const stockMovementFindManyMock = jest.fn();
const serviceOrderGroupByMock = jest.fn();
const serviceOrderCountMock = jest.fn();
const serviceOrderStatusHistoryFindManyMock = jest.fn();
const cashRegisterFindManyMock = jest.fn();
const companyCountMock = jest.fn();
const licenseGroupByMock = jest.fn();
const licenseFindManyMock = jest.fn();
const deviceGroupByMock = jest.fn();
const activationCountMock = jest.fn();
const branchFindManyMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    sale: {
      aggregate: saleAggregateMock,
      groupBy: saleGroupByMock,
      findMany: saleFindManyMock,
      count: saleCountMock,
    },
    payment: { groupBy: paymentGroupByMock },
    saleItem: { groupBy: saleItemGroupByMock },
    accountsPayable: { aggregate: accountsPayableAggregateMock },
    accountsReceivable: { aggregate: accountsReceivableAggregateMock },
    product: { findMany: productFindManyMock },
    stockMovement: { findMany: stockMovementFindManyMock },
    serviceOrder: { groupBy: serviceOrderGroupByMock, count: serviceOrderCountMock },
    serviceOrderStatusHistory: { findMany: serviceOrderStatusHistoryFindManyMock },
    cashRegister: { findMany: cashRegisterFindManyMock },
    company: { count: companyCountMock },
    license: { groupBy: licenseGroupByMock, findMany: licenseFindManyMock },
    device: { groupBy: deviceGroupByMock },
    activation: { count: activationCountMock },
    branch: { findMany: branchFindManyMock },
  })),
  Prisma: {},
}));

// Saldo agregado por produto (stockLedger.balances) — a regra em si é testada em test/integration/stock-ledger.
const balancesMock = jest.fn();
jest.mock('./stock-ledger', () => ({ stockLedger: { balances: (...a: unknown[]) => balancesMock(...a) } }));

jest.mock('./financial.service', () => ({
  __esModule: true,
  default: { getCashFlowSummary: jest.fn() },
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: {
    // remember: sem Redis real no teste, apenas executa o callback direto
    remember: jest.fn(async (_key: string, _ttl: number, cb: () => Promise<any>) => cb()),
  },
  CacheTTL: { CURRENT_STOCK: 180 },
}));

import { DashboardService } from './dashboard.service';
import financialService from './financial.service';

describe('DashboardService.getSalesDashboard', () => {
  const service = new DashboardService();

  it('calcula faturamento total, ticket médio e variação percentual vs. período anterior', async () => {
    // Período atual: 3 vendas somando 300 (ticket médio 100)
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: 300 }, _count: 3 });
    // Período anterior: 2 vendas somando 200
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: 200 }, _count: 2 });
    paymentGroupByMock.mockResolvedValueOnce([
      { paymentMethod: 'CASH', _sum: { amount: 100 }, _count: 1 },
      { paymentMethod: 'PIX', _sum: { amount: 200 }, _count: 2 },
    ]);
    saleItemGroupByMock.mockResolvedValueOnce([
      { productId: 'p1', productName: 'Óleo', _sum: { quantity: 5, totalPrice: 150 } },
    ]);
    // Vendas do período (evolução por dia): duas no dia 02 e uma no dia 05; os dias sem venda não aparecem.
    saleFindManyMock.mockResolvedValueOnce([
      { saleDate: new Date('2026-08-05T12:00:00Z'), totalAmount: 150 },
      { saleDate: new Date('2026-08-02T12:00:00Z'), totalAmount: 100 },
      { saleDate: new Date('2026-08-02T15:00:00Z'), totalAmount: 50 },
    ]);

    const result = await service.getSalesDashboard('company-A', undefined, '2026-08-01', '2026-08-31');

    expect(result.timeline).toEqual([
      { date: '2026-08-02', total: 150 },
      { date: '2026-08-05', total: 150 },
    ]);

    expect(result.totalRevenue).toBe(300);
    expect(result.totalSales).toBe(3);
    expect(result.avgTicket).toBe(100);
    expect(result.comparison.previousRevenue).toBe(200);
    // (300 - 200) / 200 * 100 = 50%
    expect(result.comparison.revenueChangePercent).toBeCloseTo(50);
    expect(result.paymentMethods).toEqual([
      { method: 'CASH', total: 100, count: 1 },
      { method: 'PIX', total: 200, count: 2 },
    ]);
    expect(result.topProducts).toEqual([
      { productId: 'p1', productName: 'Óleo', quantity: 5, total: 150 },
    ]);
  });

  it('retorna avgTicket 0 e variação null quando não há vendas em nenhum dos períodos', async () => {
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: null }, _count: 0 });
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: null }, _count: 0 });
    paymentGroupByMock.mockResolvedValueOnce([]);
    saleItemGroupByMock.mockResolvedValueOnce([]);
    saleFindManyMock.mockResolvedValueOnce([]);

    const result = await service.getSalesDashboard('company-A');

    expect(result.timeline).toEqual([]); // sem vendas: nenhum ponto inventado
    expect(result.totalRevenue).toBe(0);
    expect(result.avgTicket).toBe(0);
    expect(result.comparison.revenueChangePercent).toBe(0);
  });
});

// DECISÃO 58 — o dia do painel é o dia de Brasília. UTC−3: 21:30 de 04/10 em Brasília já é 00:30 de 05/10 em UTC.
describe('DashboardService — virada do dia no fuso de Brasília', () => {
  const service = new DashboardService();

  it('evolução de vendas: venda depois das 21h de Brasília fica no mesmo dia local', async () => {
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: 250 }, _count: 4 });
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: null }, _count: 0 });
    paymentGroupByMock.mockResolvedValueOnce([]);
    saleItemGroupByMock.mockResolvedValueOnce([]);
    saleFindManyMock.mockResolvedValueOnce([
      { saleDate: new Date('2026-10-05T03:00:00Z'), totalAmount: 70 }, // 00:00 de 05/10 em Brasília → dia 05
      { saleDate: new Date('2026-10-05T02:59:59Z'), totalAmount: 50 }, // 23:59:59 de 04/10 → dia 04
      { saleDate: new Date('2026-10-05T00:30:00Z'), totalAmount: 100 }, // 21:30 de 04/10 → dia 04 (em UTC seria 05)
      { saleDate: new Date('2026-10-04T15:00:00Z'), totalAmount: 30 }, // 12:00 de 04/10 → dia 04
    ]);

    const result = await service.getSalesDashboard('company-A', undefined, '2026-10-01', '2026-10-31');

    expect(result.timeline).toEqual([
      { date: '2026-10-04', total: 180 },
      { date: '2026-10-05', total: 70 },
    ]);
  });

  it('evolução do CEO: mesma regra de dia local', async () => {
    branchFindManyMock.mockResolvedValueOnce([{ id: 'branch-1', name: 'Matriz' }]);
    saleGroupByMock.mockResolvedValueOnce([{ branchId: 'branch-1', _sum: { totalAmount: 150 }, _count: 2 }]);
    saleFindManyMock.mockResolvedValueOnce([
      { saleDate: new Date('2026-10-05T00:30:00Z'), totalAmount: 100 }, // 21:30 de 04/10
      { saleDate: new Date('2026-10-05T03:00:00Z'), totalAmount: 50 }, // 00:00 de 05/10
    ]);

    const result = await service.getCeoDashboard('company-A', '2026-10-01', '2026-10-31');

    expect(result.timeline).toEqual([
      { date: '2026-10-04', total: 100 },
      { date: '2026-10-05', total: 50 },
    ]);
  });

  it('"hoje" do PDV começa à meia-noite de Brasília (03:00 UTC) e termina 1 ms antes da seguinte, não no relógio do servidor', async () => {
    // Só a Date é falsa: promessas e timers reais seguem funcionando.
    jest.useFakeTimers({
      now: new Date('2026-10-05T01:30:00Z'), // 22:30 de 04/10 em Brasília
      doNotFake: ['nextTick', 'setImmediate', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'clearImmediate', 'queueMicrotask', 'performance', 'hrtime'],
    });
    try {
      cashRegisterFindManyMock.mockResolvedValueOnce([]);
      saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: 0 }, _count: 0 });
      paymentGroupByMock.mockResolvedValueOnce([]);
      saleCountMock.mockResolvedValueOnce(0);

      await service.getPdvDashboard('company-A', 'branch-1');

      const where = saleAggregateMock.mock.calls[saleAggregateMock.mock.calls.length - 1][0].where;
      expect(where.saleDate.gte.toISOString()).toBe('2026-10-04T03:00:00.000Z');
      expect(where.saleDate.lte.toISOString()).toBe('2026-10-05T02:59:59.999Z');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('DashboardService.getFinancialDashboard', () => {
  const service = new DashboardService();

  it('soma corretamente pendente/vencido/a vencer para pagar e receber', async () => {
    accountsPayableAggregateMock
      .mockResolvedValueOnce({ _sum: { amount: 1000 } }) // pending (PENDING+OVERDUE)
      .mockResolvedValueOnce({ _sum: { amount: 300 } }) // overdue
      .mockResolvedValueOnce({ _sum: { amount: 200 } }) // due next 7
      .mockResolvedValueOnce({ _sum: { amount: 500 } }); // due next 30
    accountsReceivableAggregateMock
      .mockResolvedValueOnce({ _sum: { amount: 2000 } })
      .mockResolvedValueOnce({ _sum: { amount: 100 } })
      .mockResolvedValueOnce({ _sum: { amount: 400 } })
      .mockResolvedValueOnce({ _sum: { amount: 900 } });

    (financialService.getCashFlowSummary as jest.Mock).mockResolvedValueOnce({
      payables: { total: 1000, paid: 700 },
      receivables: { total: 2000, paid: 1800 },
      netCashFlow: 1100,
    });

    const result = await service.getFinancialDashboard('company-A');

    expect(result.payables).toEqual({
      pending: 1000,
      overdue: 300,
      dueNext7Days: 200,
      dueNext30Days: 500,
    });
    expect(result.receivables).toEqual({
      pending: 2000,
      overdue: 100,
      dueNext7Days: 400,
      dueNext30Days: 900,
    });
    expect(result.cashFlow.netCashFlow).toBe(1100);
  });
});

describe('DashboardService.getStockDashboard', () => {
  const service = new DashboardService();

  it('conta produtos com estoque baixo e soma o valor total do estoque (balance * costPrice)', async () => {
    productFindManyMock.mockResolvedValueOnce([
      { id: 'prod-1', costPrice: 10, minStock: 5 },
      { id: 'prod-2', costPrice: 20, minStock: 2 },
    ]);
    stockMovementFindManyMock.mockResolvedValueOnce([{ productId: 'prod-1' }]); // só prod-1 movimentou recentemente

    balancesMock.mockResolvedValueOnce(
      new Map([
        ['prod-1', { balance: 3, count: 4 }], // 3 <= minStock 5 -> low stock
        ['prod-2', { balance: 10, count: 2 }], // 10 > minStock 2 -> ok
      ])
    );

    const result = await service.getStockDashboard('company-A');

    expect(result.activeProductsCount).toBe(2);
    expect(result.lowStockCount).toBe(1);
    // prod-1: 3*10=30, prod-2: 10*20=200 => 230
    expect(result.totalStockValue).toBe(230);
    // prod-2 não teve movimentação recente
    expect(result.staleProductsCount).toBe(1);
    expect(result.notInventoriedCount).toBe(0);
    // Uma consulta para todos os produtos (antes: uma por produto).
    expect(balancesMock).toHaveBeenCalledTimes(1);
    expect(balancesMock).toHaveBeenCalledWith({ companyId: 'company-A', branchId: undefined, productIds: ['prod-1', 'prod-2'] });
  });

  it('trata produto sem nenhum StockMovement como "não inventariado", não como estoque baixo', async () => {
    productFindManyMock.mockResolvedValueOnce([
      { id: 'prod-3', costPrice: 15, minStock: 5 },
    ]);
    stockMovementFindManyMock.mockResolvedValueOnce([]); // nenhuma movimentação recente

    balancesMock.mockResolvedValueOnce(new Map([['prod-3', { balance: 0, count: 0 }]]));

    const result = await service.getStockDashboard('company-A');

    expect(result.notInventoriedCount).toBe(1);
    expect(result.lowStockCount).toBe(0);
  });
});

describe('DashboardService.getWorkshopDashboard', () => {
  const service = new DashboardService();

  it('calcula o tempo médio de ciclo (ENTRADA -> ENCERRADA) em horas a partir do histórico', async () => {
    serviceOrderGroupByMock.mockResolvedValueOnce([{ status: 'EXECUCAO', _count: 2 }]);
    // Duas chamadas a partir desta fase: atrasadas por prazo PROMETIDO real
    // (estimatedDelivery) e atrasadas pelo fallback heurístico (sem prazo
    // definido) — ver comentário em DashboardService.getWorkshopDashboard.
    serviceOrderCountMock.mockResolvedValueOnce(1); // overduePromised
    serviceOrderCountMock.mockResolvedValueOnce(0); // overdueFallback
    serviceOrderStatusHistoryFindManyMock.mockResolvedValueOnce([
      {
        changedAt: new Date('2026-08-02T10:00:00Z'),
        serviceOrder: { entryDate: new Date('2026-08-01T10:00:00Z') }, // 24h
      },
      {
        changedAt: new Date('2026-08-05T22:00:00Z'),
        serviceOrder: { entryDate: new Date('2026-08-05T10:00:00Z') }, // 12h
      },
    ]);

    const result = await service.getWorkshopDashboard('company-A', undefined, '2026-08-01', '2026-08-31');

    expect(result.openByStatus).toEqual([{ status: 'EXECUCAO', count: 2 }]);
    expect(result.overdueCount).toBe(1);
    expect(result.closedOrdersInPeriod).toBe(2);
    // média de 24h e 12h = 18h
    expect(result.avgCycleTimeHours).toBeCloseTo(18);
  });

  it('retorna avgCycleTimeHours null quando nenhuma OS foi encerrada no período', async () => {
    serviceOrderGroupByMock.mockResolvedValueOnce([]);
    serviceOrderCountMock.mockResolvedValueOnce(0); // overduePromised
    serviceOrderCountMock.mockResolvedValueOnce(0); // overdueFallback
    serviceOrderStatusHistoryFindManyMock.mockResolvedValueOnce([]);

    const result = await service.getWorkshopDashboard('company-A');

    expect(result.avgCycleTimeHours).toBeNull();
  });
});

describe('DashboardService.getPdvDashboard', () => {
  const service = new DashboardService();

  it('soma vendas do dia e agrupa formas de pagamento corretamente', async () => {
    cashRegisterFindManyMock.mockResolvedValueOnce([
      { id: 'cr-1', registerNumber: 1, userId: 'u1', openingAmount: 100, expectedAmount: 250, openedAt: new Date() },
    ]);
    saleAggregateMock.mockResolvedValueOnce({ _sum: { totalAmount: 250 }, _count: 4 });
    paymentGroupByMock.mockResolvedValueOnce([
      { paymentMethod: 'CASH', _sum: { amount: 150 }, _count: 2 },
      { paymentMethod: 'CREDIT_CARD', _sum: { amount: 100 }, _count: 2 },
    ]);
    saleCountMock.mockResolvedValueOnce(1);

    const result = await service.getPdvDashboard('company-A', 'branch-1');

    expect(result.openRegisters).toHaveLength(1);
    expect(result.todaySales).toEqual({ total: 250, count: 4 });
    expect(result.paymentMethods).toEqual([
      { method: 'CASH', total: 150, count: 2 },
      { method: 'CREDIT_CARD', total: 100, count: 2 },
    ]);
    expect(result.cancellationsToday).toBe(1);
  });
});

describe('DashboardService.getSuperAdminDashboard', () => {
  const service = new DashboardService();

  it('agrega empresas ativas, licenças e dispositivos por status', async () => {
    companyCountMock.mockResolvedValueOnce(12);
    licenseGroupByMock.mockResolvedValueOnce([
      { status: 'ACTIVE', _count: 10 },
      { status: 'PENDING_APPROVAL', _count: 2 },
    ]);
    deviceGroupByMock.mockResolvedValueOnce([{ status: 'ACTIVE', _count: 20 }]);
    activationCountMock.mockResolvedValueOnce(3);
    licenseFindManyMock.mockResolvedValueOnce([
      { id: 'lic-1', expiryDate: new Date('2026-09-20'), company: { id: 'c1', name: 'Empresa 1' } },
    ]);

    const result = await service.getSuperAdminDashboard();

    expect(result.activeCompanies).toBe(12);
    expect(result.licensesByStatus).toEqual([
      { status: 'ACTIVE', count: 10 },
      { status: 'PENDING_APPROVAL', count: 2 },
    ]);
    expect(result.pendingActivations).toBe(3);
    expect(result.expiringLicenses).toEqual([
      { licenseId: 'lic-1', companyId: 'c1', companyName: 'Empresa 1', expiryDate: new Date('2026-09-20') },
    ]);
  });
});

describe('DashboardService.getCeoDashboard', () => {
  const service = new DashboardService();

  it('agrega faturamento por filial e monta a linha do tempo real (sem suavização)', async () => {
    branchFindManyMock.mockResolvedValueOnce([
      { id: 'branch-1', name: 'Matriz' },
      { id: 'branch-2', name: 'Filial 2' },
    ]);
    saleGroupByMock.mockResolvedValueOnce([
      { branchId: 'branch-1', _sum: { totalAmount: 500 }, _count: 2 },
      { branchId: 'branch-2', _sum: { totalAmount: 300 }, _count: 1 },
    ]);
    saleFindManyMock.mockResolvedValueOnce([
      { saleDate: new Date('2026-08-01T10:00:00Z'), totalAmount: 200 },
      { saleDate: new Date('2026-08-01T15:00:00Z'), totalAmount: 300 },
      { saleDate: new Date('2026-08-02T10:00:00Z'), totalAmount: 300 },
    ]);

    const result = await service.getCeoDashboard('company-A', '2026-08-01', '2026-08-31');

    expect(result.revenueByBranch).toEqual([
      { branchId: 'branch-1', branchName: 'Matriz', totalRevenue: 500, totalSales: 2 },
      { branchId: 'branch-2', branchName: 'Filial 2', totalRevenue: 300, totalSales: 1 },
    ]);
    expect(result.timeline).toEqual([
      { date: '2026-08-01', total: 500 },
      { date: '2026-08-02', total: 300 },
    ]);
  });
});
