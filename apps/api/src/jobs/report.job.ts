import { Job } from 'bullmq';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { Logger } from '../services/logger.service';
import { formatCurrency, formatDate } from '@ln-system/shared';
import { stockLedger } from '../services/stock-ledger';

const logger = Logger; // Logger tem apenas métodos estáticos, não getInstance()

export interface ReportJobData {
  type: 'daily-sales' | 'monthly-summary' | 'inventory' | 'financial' | 'customers';
  companyId: string;
  branchId?: string;
  startDate?: Date;
  endDate?: Date;
  format?: 'pdf' | 'excel' | 'json';
  userId: string;
}

/**
 * Processa geração de relatórios
 */
export async function processReportJob(job: Job<ReportJobData>) {
  const { type, companyId, branchId, startDate, endDate, format = 'json', userId: _userId } = job.data;

  try {
    logger.job(job.name, 'started', {
      jobId: job.id,
      type,
      companyId,
      branchId,
      format,
    });

    // Worker do BullMQ roda fora de qualquer requisição HTTP — sem contexto
    // de RLS ativo, toda consulta abaixo (sale/product/customer/etc.)
    // retornava vazia silenciosamente (RLS nega SELECT sem `set_config`
    // ativo), não um erro — relatórios agendados vinham sempre em branco.
    // Ver mesma nota em observability.job.ts/audit.job.ts. Aqui o bypass é
    // seguro porque toda query já filtra por `companyId` explicitamente
    // (vindo de `job.data`, nunca de sessão).
    const reportData = await runWithRLSContext(
      { companyId: null, userType: 'SUPER_ADMIN', branchId: null },
      async () => {
        switch (type) {
          case 'daily-sales':
            return generateDailySalesReport(companyId, branchId, startDate, endDate);
          case 'monthly-summary':
            return generateMonthlySummaryReport(companyId, branchId, startDate, endDate);
          case 'inventory':
            return generateInventoryReport(companyId, branchId);
          case 'financial':
            return generateFinancialReport(companyId, branchId, startDate, endDate);
          case 'customers':
            return generateCustomersReport(companyId, branchId);
          default:
            throw new Error(`Unknown report type: ${type}`);
        }
      }
    );

    // Aqui você pode integrar com biblioteca de geração de PDF/Excel
    // Exemplo: puppeteer, pdfkit, exceljs

    logger.job(job.name, 'completed', {
      jobId: job.id,
      type,
      recordCount: Array.isArray(reportData) ? reportData.length : 'N/A',
    });

    return { success: true, type, data: reportData };
  } catch (error) {
    logger.error('Failed to generate report', {
      jobId: job.id,
      type,
      companyId,
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Relatório de vendas diárias
 */
async function generateDailySalesReport(
  companyId: string,
  branchId?: string,
  startDate?: Date,
  endDate?: Date
) {
  const where: any = { companyId };
  
  if (branchId) where.branchId = branchId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  const sales = await prisma.sale.findMany({
    where,
    include: {
      items: {
        include: {
          product: true,
        },
      },
      payments: true,
      customer: true,
      user: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const summary = {
    totalSales: sales.length,
    totalRevenue: sales.reduce((sum, sale) => sum + Number(sale.totalAmount), 0),
    totalDiscount: sales.reduce((sum, sale) => sum + Number(sale.discountAmount || 0), 0),
    averageTicket: 0,
  };

  summary.averageTicket = summary.totalSales > 0 ? summary.totalRevenue / summary.totalSales : 0;

  return {
    summary,
    sales: sales.map(sale => ({
      id: sale.id,
      saleNumber: sale.saleNumber,
      total: formatCurrency(Number(sale.totalAmount)),
      discount: formatCurrency(Number(sale.discountAmount || 0)),
      itemsCount: sale.items.length,
      customer: sale.customer?.name || 'Sem cliente',
      seller: sale.user?.name ?? 'Canal de venda', // venda de canal não tem operador (userId nulo)
      date: formatDate(sale.createdAt),
      status: sale.status,
    })),
  };
}

/**
 * Relatório de resumo mensal
 */
async function generateMonthlySummaryReport(
  companyId: string,
  branchId?: string,
  startDate?: Date,
  endDate?: Date
) {
  const where: any = { companyId };
  
  if (branchId) where.branchId = branchId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  const [sales, expenses, products, customers] = await Promise.all([
    prisma.sale.aggregate({
      where,
      _sum: { totalAmount: true, discountAmount: true },
      _count: true,
    }),
    // Não existe model "Expense" no schema — o equivalente real é
    // AccountsPayable (contas a pagar), filtrado pela mesma janela de datas
    // usando dueDate (não há um "createdAt" genérico de despesa aqui).
    prisma.accountsPayable.aggregate({
      where: {
        companyId,
        ...(branchId && { branchId }),
        ...(startDate || endDate
          ? {
              dueDate: {
                ...(startDate && { gte: startDate }),
                ...(endDate && { lte: endDate }),
              },
            }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.product.count({ where: { companyId } }),
    prisma.customer.count({ where: { companyId } }),
  ]);

  const revenue = Number(sales._sum.totalAmount || 0);
  const totalExpenses = Number(expenses._sum.amount || 0);
  const profit = revenue - totalExpenses;

  return {
    period: {
      start: startDate ? formatDate(startDate) : 'N/A',
      end: endDate ? formatDate(endDate) : 'N/A',
    },
    sales: {
      count: sales._count,
      revenue: formatCurrency(revenue),
      discount: formatCurrency(Number(sales._sum.discountAmount || 0)),
    },
    expenses: {
      count: expenses._count,
      total: formatCurrency(totalExpenses),
    },
    profit: {
      amount: formatCurrency(profit),
      margin: revenue > 0 ? ((profit / revenue) * 100).toFixed(2) + '%' : '0%',
    },
    inventory: {
      productsCount: products,
    },
    customers: {
      count: customers,
    },
  };
}

/**
 * Relatório de inventário
 */
async function generateInventoryReport(companyId: string, branchId?: string) {
  const where: any = { companyId };
  if (branchId) where.branchId = branchId;

  // Não existe uma relação "stock" no model Product (nenhum model Stock
  // existe no schema) — o saldo é sempre derivado do ledger StockMovement
  // via stockService.getBalance, igual ao resto do sistema.
  const products = await prisma.product.findMany({
    where,
    include: {
      category: true,
    },
    orderBy: { name: 'asc' },
  });

  // Um saldo para todos os produtos numa consulta (antes: uma varredura do histórico inteiro por produto, em paralelo).
  const ledger = await stockLedger.balances({ companyId, branchId, productIds: products.map((p) => p.id) });
  const balances = products.map((p) => {
    const { balance, count } = ledger.get(p.id)!;
    return { balance, hasMovements: count > 0 };
  });

  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: um produto NUNCA inventariado
  // (hasMovements=false) tem balance=0 só por ausência de movimentação, não
  // porque o estoque real é zero — mesmo princípio já aplicado corretamente
  // em dashboard.service.ts, mas ignorado aqui. Sem checar `hasMovements`,
  // todo produto recém-cadastrado aparecia como "ESTOQUE BAIXO" e distorcia
  // `lowStockCount`/`totalValue` do relatório.
  const summary = {
    totalProducts: products.length,
    totalValue: products.reduce((sum, p, i) => sum + Number(p.costPrice) * balances[i].balance, 0),
    lowStockCount: products.filter((p, i) => balances[i].hasMovements && balances[i].balance < Number(p.minStock)).length,
    notInventoriedCount: products.filter((_, i) => !balances[i].hasMovements).length,
  };

  return {
    summary: {
      ...summary,
      totalValue: formatCurrency(summary.totalValue),
    },
    products: products.map((product, i) => {
      const stockQty = balances[i].balance;
      const hasMovements = balances[i].hasMovements;
      const isLowStock = hasMovements && stockQty < Number(product.minStock);

      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        category: product.category?.name || 'Sem categoria',
        quantity: stockQty,
        minStock: Number(product.minStock),
        costPrice: formatCurrency(Number(product.costPrice)),
        salePrice: formatCurrency(Number(product.salePrice)),
        totalValue: formatCurrency(Number(product.costPrice) * stockQty),
        status: !hasMovements ? 'NÃO INVENTARIADO' : isLowStock ? 'ESTOQUE BAIXO' : 'OK',
      };
    }),
  };
}

/**
 * Relatório financeiro
 */
async function generateFinancialReport(
  companyId: string,
  branchId?: string,
  startDate?: Date,
  endDate?: Date
) {
  const [payments, expensesByStatus, expensesTotal] = await Promise.all([
    prisma.payment.groupBy({
      by: ['paymentMethod'],
      // Payment não tem campo branchId (branch só existe em Sale) — usar o
      // `where` genérico da função (que inclui branchId quando presente)
      // quebraria esta query. Também filtramos por status APPROVED: um
      // pagamento PENDING/DECLINED/CANCELLED/REFUNDED não é receita real.
      where: {
        companyId,
        status: 'APPROVED',
        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate && { gte: startDate }),
                ...(endDate && { lte: endDate }),
              },
            }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    // Não existe model "Expense"/campo "category" no schema — o equivalente
    // real de despesa é AccountsPayable, que não tem uma dimensão de
    // categoria, apenas status (PENDING/PAID/OVERDUE/CANCELLED). Agrupamos
    // por status em vez de inventar um campo que não existe.
    prisma.accountsPayable.groupBy({
      by: ['status'],
      where: {
        companyId,
        ...(branchId && { branchId }),
        ...(startDate || endDate
          ? {
              dueDate: {
                ...(startDate && { gte: startDate }),
                ...(endDate && { lte: endDate }),
              },
            }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.accountsPayable.aggregate({
      where: {
        companyId,
        ...(branchId && { branchId }),
        ...(startDate || endDate
          ? {
              dueDate: {
                ...(startDate && { gte: startDate }),
                ...(endDate && { lte: endDate }),
              },
            }
          : {}),
      },
      _sum: { amount: true },
    }),
  ]);

  const totalRevenue = payments.reduce((sum, p) => sum + Number(p._sum.amount || 0), 0);
  const totalExpenses = Number(expensesTotal._sum.amount || 0);

  return {
    revenue: {
      total: formatCurrency(totalRevenue),
      byMethod: payments.map(p => ({
        method: p.paymentMethod,
        amount: formatCurrency(Number(p._sum.amount || 0)),
        count: p._count,
      })),
    },
    expenses: {
      total: formatCurrency(totalExpenses),
      byStatus: expensesByStatus.map(e => ({
        status: e.status,
        amount: formatCurrency(Number(e._sum.amount || 0)),
        count: e._count,
      })),
    },
    balance: {
      amount: formatCurrency(totalRevenue - totalExpenses),
      margin: totalRevenue > 0 ? (((totalRevenue - totalExpenses) / totalRevenue) * 100).toFixed(2) + '%' : '0%',
    },
  };
}

/**
 * Relatório de clientes
 */
async function generateCustomersReport(companyId: string, branchId?: string) {
  const customers = await prisma.customer.findMany({
    where: { companyId },
    include: {
      sales: {
        where: branchId ? { branchId } : {},
        select: {
          totalAmount: true,
          createdAt: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const summary = {
    totalCustomers: customers.length,
    activeCustomers: customers.filter(c => c.sales.length > 0).length,
    totalRevenue: customers.reduce((sum, c) => 
      sum + c.sales.reduce((s, sale) => s + Number(sale.totalAmount), 0), 0
    ),
  };

  return {
    summary: {
      ...summary,
      totalRevenue: formatCurrency(summary.totalRevenue),
      averagePerCustomer: summary.activeCustomers > 0 
        ? formatCurrency(summary.totalRevenue / summary.activeCustomers)
        : formatCurrency(0),
    },
    customers: customers.map(customer => {
      const totalSpent = customer.sales.reduce((sum, sale) => sum + Number(sale.totalAmount), 0);
      const lastPurchase = customer.sales.length > 0 
        ? new Date(Math.max(...customer.sales.map(s => s.createdAt.getTime())))
        : null;

      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        document: customer.document,
        purchaseCount: customer.sales.length,
        totalSpent: formatCurrency(totalSpent),
        averageTicket: customer.sales.length > 0 
          ? formatCurrency(totalSpent / customer.sales.length)
          : formatCurrency(0),
        lastPurchase: lastPurchase ? formatDate(lastPurchase) : 'Nunca',
        status: customer.sales.length > 0 ? 'ATIVO' : 'INATIVO',
      };
    }),
  };
}
