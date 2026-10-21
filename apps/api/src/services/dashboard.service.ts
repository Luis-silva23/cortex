import { prisma } from '@ln-system/database';
import { stockLedger } from './stock-ledger';
import financialService from './financial.service';
import cacheService, { CacheTTL } from './cache.service';
import { visibilityScope } from '../utils/cache-scope';
import { localDayKey, startOfLocalDay, startOfNextLocalDay } from '../utils/time-zone';

const CLOSED_SALE_STATUSES = ['PAID', 'PARTIALLY_PAID'] as const;
const NON_TERMINAL_OS_STATUSES = [
  'ENTRADA',
  'DIAGNOSTICO',
  'ORCAMENTO',
  'APROVACAO',
  'EXECUCAO',
  'PRONTO',
  'ENTREGA',
] as const;

/**
 * Resolve o período de consulta. Se startDate/endDate não forem informados,
 * usa os últimos 30 dias (até agora). O "período anterior" tem exatamente a
 * mesma duração e termina imediatamente antes do início do período atual —
 * usado para comparações (ex.: faturamento vs. período anterior).
 */
function resolvePeriod(startDate?: string, endDate?: string) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const durationMs = Math.max(end.getTime() - start.getTime(), 0);
  const prevEnd = new Date(start.getTime() - 1); // 1ms antes do início do período atual
  const prevStart = new Date(prevEnd.getTime() - durationMs);

  return { start, end, prevStart, prevEnd };
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return current === 0 ? 0 : null; // variação indefinida quando não há base de comparação
  }
  return ((current - previous) / previous) * 100;
}

// Dia local de Brasília (YYYY-MM-DD), não UTC: venda depois das 21h não pode cair no dia seguinte (decisão 58).
function dayKey(date: Date): string {
  return localDayKey(date);
}

export class DashboardService {
  // ============================================
  // 1. VENDAS
  // ============================================

  async getSalesDashboard(
    companyId: string,
    branchId?: string,
    startDate?: string,
    endDate?: string
  ) {
    const { start, end, prevStart, prevEnd } = resolvePeriod(startDate, endDate);

    const baseSaleWhere = {
      companyId,
      ...(branchId && { branchId }),
      status: { in: [...CLOSED_SALE_STATUSES] },
    };

    const [current, previous, paymentMethodsRaw, topProductsRaw, salesInPeriod] = await Promise.all([
      prisma.sale.aggregate({
        where: { ...baseSaleWhere, saleDate: { gte: start, lte: end } },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.sale.aggregate({
        where: { ...baseSaleWhere, saleDate: { gte: prevStart, lte: prevEnd } },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.payment.groupBy({
        by: ['paymentMethod'],
        where: {
          companyId,
          status: 'APPROVED',
          sale: { ...baseSaleWhere, saleDate: { gte: start, lte: end } },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.saleItem.groupBy({
        by: ['productId', 'productName'],
        where: {
          sale: { ...baseSaleWhere, saleDate: { gte: start, lte: end } },
        },
        _sum: { quantity: true, totalPrice: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 10,
      }),
      // Evolução temporal do mesmo conjunto de vendas (mesmo filtro de empresa/filial/status/período do total).
      prisma.sale.findMany({
        where: { ...baseSaleWhere, saleDate: { gte: start, lte: end } },
        select: { saleDate: true, totalAmount: true },
      }),
    ]);

    // Soma real de vendas por dia (só os dias com venda; sem suavização nem pontos inventados) — igual ao do painel CEO.
    const dailyTotals = new Map<string, number>();
    for (const sale of salesInPeriod) {
      const key = dayKey(sale.saleDate);
      dailyTotals.set(key, (dailyTotals.get(key) || 0) + Number(sale.totalAmount));
    }
    const timeline = Array.from(dailyTotals.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, total]) => ({ date, total }));

    const totalRevenue = Number(current._sum.totalAmount || 0);
    const totalSales = current._count;
    const avgTicket = totalSales > 0 ? totalRevenue / totalSales : 0;

    const previousRevenue = Number(previous._sum.totalAmount || 0);
    const previousSales = previous._count;

    return {
      period: { start, end },
      totalRevenue,
      totalSales,
      avgTicket,
      comparison: {
        previousPeriod: { start: prevStart, end: prevEnd },
        previousRevenue,
        previousSales,
        revenueChangePercent: percentChange(totalRevenue, previousRevenue),
        salesChangePercent: percentChange(totalSales, previousSales),
      },
      timeline,
      paymentMethods: paymentMethodsRaw.map((pm) => ({
        method: pm.paymentMethod,
        total: Number(pm._sum.amount || 0),
        count: pm._count,
      })),
      topProducts: topProductsRaw.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        quantity: Number(p._sum.quantity || 0),
        total: Number(p._sum.totalPrice || 0),
      })),
    };
  }

  // ============================================
  // 2. FINANCEIRO
  // ============================================

  async getFinancialDashboard(
    companyId: string,
    branchId?: string,
    startDate?: string,
    endDate?: string
  ) {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const branchFilter = branchId ? { branchId } : {};

    const [
      payablesPending,
      receivablesPending,
      payablesOverdue,
      receivablesOverdue,
      payablesDue7,
      receivablesDue7,
      payablesDue30,
      receivablesDue30,
      cashFlow,
    ] = await Promise.all([
      prisma.accountsPayable.aggregate({
        where: { companyId, ...branchFilter, status: { in: ['PENDING', 'OVERDUE'] } },
        _sum: { amount: true },
      }),
      prisma.accountsReceivable.aggregate({
        where: { companyId, ...branchFilter, status: { in: ['PENDING', 'OVERDUE'] } },
        _sum: { amount: true },
      }),
      prisma.accountsPayable.aggregate({
        where: { companyId, ...branchFilter, status: 'PENDING', dueDate: { lt: now } },
        _sum: { amount: true },
      }),
      prisma.accountsReceivable.aggregate({
        where: { companyId, ...branchFilter, status: 'PENDING', dueDate: { lt: now } },
        _sum: { amount: true },
      }),
      prisma.accountsPayable.aggregate({
        where: { companyId, ...branchFilter, status: 'PENDING', dueDate: { gte: now, lte: in7Days } },
        _sum: { amount: true },
      }),
      prisma.accountsReceivable.aggregate({
        where: { companyId, ...branchFilter, status: 'PENDING', dueDate: { gte: now, lte: in7Days } },
        _sum: { amount: true },
      }),
      prisma.accountsPayable.aggregate({
        where: { companyId, ...branchFilter, status: 'PENDING', dueDate: { gte: now, lte: in30Days } },
        _sum: { amount: true },
      }),
      prisma.accountsReceivable.aggregate({
        where: { companyId, ...branchFilter, status: 'PENDING', dueDate: { gte: now, lte: in30Days } },
        _sum: { amount: true },
      }),
      financialService.getCashFlowSummary(
        companyId,
        branchId,
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined
      ),
    ]);

    return {
      payables: {
        pending: Number(payablesPending._sum.amount || 0),
        overdue: Number(payablesOverdue._sum.amount || 0),
        dueNext7Days: Number(payablesDue7._sum.amount || 0),
        dueNext30Days: Number(payablesDue30._sum.amount || 0),
      },
      receivables: {
        pending: Number(receivablesPending._sum.amount || 0),
        overdue: Number(receivablesOverdue._sum.amount || 0),
        dueNext7Days: Number(receivablesDue7._sum.amount || 0),
        dueNext30Days: Number(receivablesDue30._sum.amount || 0),
      },
      cashFlow,
    };
  }

  // ============================================
  // 3. ESTOQUE
  // ============================================

  /**
   * KPIs de estoque. Cacheado por poucos minutos (CacheTTL.CURRENT_STOCK):
   * o saldo de todos os produtos ativos sai numa consulta agregada
   * (stockLedger.balances — mesma regra de entradas/saídas do resto do
   * sistema), que ainda percorre o livro de movimentações no banco.
   */
  async getStockDashboard(companyId: string, branchId?: string, staleDays = 90) {
    // `branchId` é só o FILTRO pedido; o total calculado depende também de quem pede (RLS por
    // filial): o valor de estoque a custo que um administrador gerou para a empresa toda
    // era entregue depois ao operador de uma filial pela mesma chave `...:all:...`.
    const cacheKey = `dashboard:stock:${companyId}:${visibilityScope()}:${branchId || 'all'}:${staleDays}`;

    return cacheService.remember(cacheKey, CacheTTL.CURRENT_STOCK, async () => {
      const products = await prisma.product.findMany({
        where: { companyId, ...(branchId && { branchId }), isActive: true },
        select: { id: true, costPrice: true, minStock: true },
      });

      const activeProductsCount = products.length;

      const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
      const recentMovements = await prisma.stockMovement.findMany({
        where: { companyId, ...(branchId && { branchId }), createdAt: { gte: cutoff } },
        select: { productId: true },
        distinct: ['productId'],
      });
      const recentProductIds = new Set(recentMovements.map((m) => m.productId));

      let lowStockCount = 0;
      let totalStockValue = 0;
      let staleProductsCount = 0;
      let notInventoriedCount = 0;

      // Saldo de todos os produtos numa consulta (antes: uma varredura do histórico inteiro POR produto).
      const balances = await stockLedger.balances({ companyId, branchId, productIds: products.map((p) => p.id) });

      for (const product of products) {
        const { balance, count } = balances.get(product.id)!;
        const hasMovements = count > 0;

        // Produto sem NENHUM StockMovement ainda não foi inventariado — isso é
        // diferente de "saldo zero porque vendeu tudo" e não deve contar como
        // "estoque baixo" (não sabemos o estoque real dele ainda).
        if (!hasMovements) {
          notInventoriedCount += 1;
        } else if (balance <= (product.minStock || 0)) {
          lowStockCount += 1;
        }

        totalStockValue += balance * Number(product.costPrice);

        if (!recentProductIds.has(product.id)) {
          staleProductsCount += 1;
        }
      }

      return {
        activeProductsCount,
        lowStockCount,
        notInventoriedCount,
        staleProductsCount,
        staleDays,
        totalStockValue,
      };
    });
  }

  // ============================================
  // 4. OFICINA
  // ============================================

  /**
   * "OS atrasada" — distingue DATA AGENDADA (não usada aqui, é do fluxo de
   * agenda/pré-atendimento) de DATA PROMETIDA (`ServiceOrder.
   * estimatedDelivery`, já existente no schema) e STATUS: nunca marca uma
   * OS como atrasada só por ter uma data qualquer associada. Regra real:
   *   - se a OS tem `estimatedDelivery` definido: atrasada quando essa data
   *     já passou e a OS ainda está em status não-terminal;
   *   - se a OS NÃO tem `estimatedDelivery` (prazo prometido é opcional):
   *     cai no fallback heurístico por `overdueDays` desde a entrada
   *     (configurável via parâmetro) — só usado quando não há dado real
   *     para decidir, nunca substitui um prazo prometido existente.
   */
  async getWorkshopDashboard(
    companyId: string,
    branchId?: string,
    startDate?: string,
    endDate?: string,
    overdueDays = 7
  ) {
    const { start, end } = resolvePeriod(startDate, endDate);
    const now = new Date();
    const overdueCutoff = new Date(now.getTime() - overdueDays * 24 * 60 * 60 * 1000);

    const [byStatus, overduePromised, overdueFallback, closedHistories] = await Promise.all([
      prisma.serviceOrder.groupBy({
        by: ['status'],
        where: {
          companyId,
          ...(branchId && { branchId }),
          status: { in: [...NON_TERMINAL_OS_STATUSES] },
        },
        _count: true,
      }),
      prisma.serviceOrder.count({
        where: {
          companyId,
          ...(branchId && { branchId }),
          status: { in: [...NON_TERMINAL_OS_STATUSES] },
          estimatedDelivery: { not: null, lt: now },
        },
      }),
      prisma.serviceOrder.count({
        where: {
          companyId,
          ...(branchId && { branchId }),
          status: { in: [...NON_TERMINAL_OS_STATUSES] },
          estimatedDelivery: null,
          entryDate: { lt: overdueCutoff },
        },
      }),
      prisma.serviceOrderStatusHistory.findMany({
        where: {
          toStatus: 'ENCERRADA',
          changedAt: { gte: start, lte: end },
          serviceOrder: { companyId, ...(branchId && { branchId }) },
        },
        select: { changedAt: true, serviceOrder: { select: { entryDate: true } } },
      }),
    ]);

    const overdueCount = overduePromised + overdueFallback;

    const durations = closedHistories.map(
      (h) => h.changedAt.getTime() - h.serviceOrder.entryDate.getTime()
    );
    const avgCycleTimeHours =
      durations.length > 0
        ? durations.reduce((acc, d) => acc + d, 0) / durations.length / (1000 * 60 * 60)
        : null;

    return {
      period: { start, end },
      openByStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
      overdueCount,
      // Quantas das atrasadas são por prazo prometido REAL ultrapassado vs.
      // pelo fallback heurístico (sem prazo definido) — nunca escondido,
      // já que são garantias de qualidade bem diferentes.
      overduePromisedCount: overduePromised,
      overdueFallbackCount: overdueFallback,
      overdueDays,
      closedOrdersInPeriod: closedHistories.length,
      avgCycleTimeHours,
    };
  }

  // ============================================
  // 5. PDV
  // ============================================

  async getPdvDashboard(companyId: string, branchId: string) {
    const now = new Date();
    // "Hoje" = o dia de Brasília (meia-noite local até 1 ms antes da seguinte), não o relógio do servidor (UTC em contêiner),
    // que fazia o dia começar às 21h de ontem.
    const todayStart = startOfLocalDay(now);
    const todayEnd = new Date(startOfNextLocalDay(now).getTime() - 1);

    const baseSaleWhere = {
      companyId,
      branchId,
      status: { in: [...CLOSED_SALE_STATUSES] },
    };

    const [openRegisters, todaySales, paymentMethodsRaw, cancellationsToday] = await Promise.all([
      prisma.cashRegister.findMany({
        where: { companyId, branchId, status: 'OPEN' },
      }),
      prisma.sale.aggregate({
        where: { ...baseSaleWhere, saleDate: { gte: todayStart, lte: todayEnd } },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.payment.groupBy({
        by: ['paymentMethod'],
        where: {
          companyId,
          status: 'APPROVED',
          sale: { ...baseSaleWhere, saleDate: { gte: todayStart, lte: todayEnd } },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.sale.count({
        where: {
          companyId,
          branchId,
          status: 'CANCELLED',
          cancelledAt: { gte: todayStart, lte: todayEnd },
        },
      }),
    ]);

    return {
      openRegisters: openRegisters.map((r) => ({
        id: r.id,
        registerNumber: r.registerNumber,
        userId: r.userId,
        openingAmount: Number(r.openingAmount),
        expectedAmount: Number(r.expectedAmount),
        openedAt: r.openedAt,
      })),
      todaySales: {
        total: Number(todaySales._sum.totalAmount || 0),
        count: todaySales._count,
      },
      paymentMethods: paymentMethodsRaw.map((pm) => ({
        method: pm.paymentMethod,
        total: Number(pm._sum.amount || 0),
        count: pm._count,
      })),
      cancellationsToday,
    };
  }

  // ============================================
  // 6. SUPER ADMIN
  // ============================================

  async getSuperAdminDashboard() {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [activeCompanies, licensesByStatus, devicesByStatus, pendingActivations, expiringLicenses] =
      await Promise.all([
        prisma.company.count({ where: { isActive: true } }),
        prisma.license.groupBy({ by: ['status'], _count: true }),
        prisma.device.groupBy({ by: ['status'], _count: true }),
        prisma.activation.count({ where: { status: 'PENDING' } }),
        prisma.license.findMany({
          where: { status: 'ACTIVE', expiryDate: { gte: now, lte: in30Days } },
          select: {
            id: true,
            expiryDate: true,
            company: { select: { id: true, name: true } },
          },
          orderBy: { expiryDate: 'asc' },
        }),
      ]);

    return {
      activeCompanies,
      licensesByStatus: licensesByStatus.map((l) => ({ status: l.status, count: l._count })),
      devicesByStatus: devicesByStatus.map((d) => ({ status: d.status, count: d._count })),
      pendingActivations,
      expiringLicenses: expiringLicenses.map((l) => ({
        licenseId: l.id,
        companyId: l.company.id,
        companyName: l.company.name,
        expiryDate: l.expiryDate,
      })),
    };
  }

  // ============================================
  // 7. CEO (visão consolidada multi-filial)
  // ============================================

  async getCeoDashboard(companyId: string, startDate?: string, endDate?: string) {
    const { start, end } = resolvePeriod(startDate, endDate);

    const [branches, salesByBranch, salesInPeriod] = await Promise.all([
      prisma.branch.findMany({ where: { companyId }, select: { id: true, name: true } }),
      prisma.sale.groupBy({
        by: ['branchId'],
        where: {
          companyId,
          status: { in: [...CLOSED_SALE_STATUSES] },
          saleDate: { gte: start, lte: end },
        },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.sale.findMany({
        where: {
          companyId,
          status: { in: [...CLOSED_SALE_STATUSES] },
          saleDate: { gte: start, lte: end },
        },
        select: { saleDate: true, totalAmount: true },
      }),
    ]);

    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

    const revenueByBranch = salesByBranch.map((s) => ({
      branchId: s.branchId,
      branchName: branchNameById.get(s.branchId) || s.branchId,
      totalRevenue: Number(s._sum.totalAmount || 0),
      totalSales: s._count,
    }));

    // Evolução temporal: soma real de vendas por dia (sem suavização/fabricação de pontos)
    const dailyTotals = new Map<string, number>();
    for (const sale of salesInPeriod) {
      const key = dayKey(sale.saleDate);
      dailyTotals.set(key, (dailyTotals.get(key) || 0) + Number(sale.totalAmount));
    }
    const timeline = Array.from(dailyTotals.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, total]) => ({ date, total }));

    return {
      period: { start, end },
      revenueByBranch,
      timeline,
    };
  }
}

export default new DashboardService();
