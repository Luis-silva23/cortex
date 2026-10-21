import { Prisma } from '@prisma/client';
import { runInTransaction } from '@ln-system/database';
import moduleSettingsService from './module-settings.service';
import {
  compareValues,
  periodBuckets,
  previousPeriodBuckets,
  resolveDashboardPeriod,
  type PeriodGranularity,
  type PeriodRange,
  type ResolvedPeriod,
} from '../utils/dashboard-period';
import { APP_TIME_ZONE } from '../utils/time-zone';

/**
 * Dashboard gerencial (docs/CORTEX/DASHBOARD_GERENCIAL.md): UMA resposta de resumo e UMA de séries, cada uma numa única
 * transação de leitura (uma só conexão, no mesmo instante do banco), com RLS de empresa e filial aplicada pela própria
 * transação. Tudo é agregado no PostgreSQL (SUM, COUNT, COUNT DISTINCT, GROUP BY), nada é somado no Node; o período vem da regra
 * única (`utils/dashboard-period.ts`) e o dia/mês/hora é o de Brasília.
 *
 * Definições (as mesmas que a tela explica no tooltip):
 *   Receita        = valor oficial das vendas realizadas (PAID e PARTIALLY_PAID) na data da venda. Não é o valor recebido e não
 *                    inclui OS (receita de OS fica à parte nesta etapa). Não é receita líquida.
 *   Ticket médio   = receita ÷ vendas DISTINTAS (nunca ÷ registros de pagamento).
 *   Por forma      = pagamentos APROVADOS; quantidade = vendas distintas que usaram a forma (venda paga em duas formas conta uma vez
 *                    em cada forma); ticket da forma = valor pago na forma ÷ vendas distintas dela; participação = fração do valor
 *                    pago nas formas.
 *   Saques         = retiradas de caixa (CashMovement WITHDRAWAL) pela data do movimento.
 *   Cancelamentos  = vendas CANCELLED e devoluções TOTAIS (RETURNED) pela data do cancelamento/devolução; só quantidade (o valor
 *   e devoluções     depende de decisão: devolução parcial não tem data nem valor por item).
 *   Descontos      = soma de `Sale.discountAmount` das vendas realizadas; % sobre o valor bruto (subtotal).
 *   Origem         = canal da venda (sem canal = loja física); só entram canais ATIVOS e, com o módulo CANAIS desligado, só a loja.
 */

const CLOSED = Prisma.sql`s.status IN ('PAID', 'PARTIALLY_PAID')`;
const TZ = APP_TIME_ZONE; // constante do produto, nunca entrada de usuário

// Instante UTC como "relógio UTC" sem fuso, exatamente a forma em que o banco guarda `timestamp`; independe do fuso da sessão.
const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

function bucketSql(col: string, granularity: PeriodGranularity) {
  const local = `((${col} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
  switch (granularity) {
    case 'hour':
      return Prisma.raw(`to_char(date_trunc('hour', ${local}), 'YYYY-MM-DD"T"HH24')`);
    case 'month':
      return Prisma.raw(`to_char(date_trunc('month', ${local}), 'YYYY-MM')`);
    default:
      return Prisma.raw(`to_char(date_trunc('day', ${local}), 'YYYY-MM-DD')`);
  }
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

type Window = { start: Date; end: Date };
const win = (r: PeriodRange): Window => ({ start: r.start, end: r.end });
const between = (col: string, w: Window) => Prisma.sql`${Prisma.raw(col)} >= ${ts(w.start)} AND ${Prisma.raw(col)} < ${ts(w.end)}`;
const inWindow = (col: string, a: Window, b: Window) => ({
  cur: between(col, a),
  prev: between(col, b),
  // intervalo que cobre os dois (o período anterior pode ter fim parcial)
  any: Prisma.sql`${Prisma.raw(col)} >= ${ts(new Date(Math.min(a.start.getTime(), b.start.getTime())))} AND ${Prisma.raw(col)} < ${ts(new Date(Math.max(a.end.getTime(), b.end.getTime())))}`,
});

export type Trend = 'up' | 'down' | 'flat';
export type Outcome = 'better' | 'worse' | 'neutral';
export interface Comparison {
  current: number | null;
  previous: number | null;
  diff: number | null;
  percent: number | null;
  trend: Trend | null;
  outcome: Outcome;
}

/** Atual × anterior com diferença, % e se melhorou ou piorou (`goodWhen`: o sentido que é bom; neutro não julga). */
export function comparison(current: number | null, previous: number | null, goodWhen: 'up' | 'down' | 'neutral', decimals = 2): Comparison {
  if (current === null || previous === null) return { current, previous, diff: null, percent: null, trend: null, outcome: 'neutral' };
  const c = compareValues(current, previous);
  const trend: Trend = c.diff > 0 ? 'up' : c.diff < 0 ? 'down' : 'flat';
  const outcome: Outcome = goodWhen === 'neutral' || trend === 'flat' ? 'neutral' : trend === goodWhen ? 'better' : 'worse';
  const r = (n: number) => (decimals === 0 ? Math.round(n) : round2(n));
  return { current: r(current), previous: r(previous), diff: r(c.diff), percent: c.percent === null ? null : round2(c.percent), trend, outcome };
}

export const DEFINITIONS = {
  revenue: 'Valor das vendas realizadas no período (vendas pagas e parcialmente pagas, pelo valor oficial da venda). Não é o valor recebido e não inclui a receita de OS.',
  sales: 'Quantidade de vendas realizadas no período (cada venda conta uma vez).',
  avgTicket: 'Receita ÷ quantidade de vendas distintas. Sem vendas, não há ticket.',
  withdrawals: 'Retiradas de caixa (sangrias) feitas no período, com quantidade e valor.',
  cancellations: 'Vendas canceladas e devoluções totais no período, pela data do cancelamento ou da devolução. Só quantidade: devolução parcial não tem data nem valor por item.',
  discounts: 'Soma dos descontos concedidos nas vendas realizadas, e quanto isso representa do valor bruto (antes do desconto).',
  paymentMethods: 'Pagamentos aprovados das vendas do período. Vendas = vendas distintas que usaram a forma; ticket = valor pago na forma ÷ essas vendas; participação = parte do valor pago.',
  origins: 'Receita do período por origem da venda. Só aparecem canais ativos; venda sem canal é loja física.',
} as const;

type CardDetail = 'DEBIT_CARD' | 'CREDIT_CARD';
const GROUP_LABEL: Record<string, string> = {
  CARD: 'Cartão',
  PIX: 'PIX',
  CASH: 'Dinheiro',
  EMPLOYEE_AGREEMENT: 'Convênio funcionário',
  COMPANY_AGREEMENT: 'Convênio empresa',
  OTHER: 'Outras formas',
};
const GROUP_ORDER = ['CARD', 'PIX', 'CASH', 'EMPLOYEE_AGREEMENT', 'COMPANY_AGREEMENT', 'OTHER'];
const METHOD_LABEL: Record<CardDetail, string> = { DEBIT_CARD: 'Débito', CREDIT_CARD: 'Crédito' };
const STORE_KEY = 'LOJA_FISICA';

const groupCase = Prisma.raw(
  `CASE p."paymentMethod" WHEN 'DEBIT_CARD' THEN 'CARD' WHEN 'CREDIT_CARD' THEN 'CARD' WHEN 'BANK_TRANSFER' THEN 'OTHER' WHEN 'CHECK' THEN 'OTHER' WHEN 'VOUCHER' THEN 'OTHER' WHEN 'OTHER' THEN 'OTHER' ELSE p."paymentMethod"::text END`
);

export interface ManagementScope {
  companyId: string;
  /** Filial pedida (ADM/Super Admin) ou a do token (gerente). Nulo = empresa inteira (o que a RLS permitir). */
  branchId: string | null;
}

const branchSql = (alias: string, branchId: string | null) => (branchId ? Prisma.sql`AND ${Prisma.raw(alias)}."branchId" = ${branchId}` : Prisma.empty);

/** Canais (para origem) desta empresa/filial: só os ATIVOS, e só com o módulo CANAIS ligado (a loja física existe sempre). */
async function activeChannels(tx: Prisma.TransactionClient, scope: ManagementScope) {
  const moduleOn = await moduleSettingsService.isModuleEnabled(scope.companyId, scope.branchId, 'CANAIS');
  const rows = await tx.salesChannel.findMany({
    where: { companyId: scope.companyId, isActive: true, ...(scope.branchId ? { OR: [{ branchId: scope.branchId }, { branchId: null }] } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, displayName: true },
  });
  const storeRow = rows.find((c) => c.type === 'LOJA_FISICA');
  const store = { key: STORE_KEY, name: storeRow?.displayName ?? 'Loja física', type: 'LOJA_FISICA' as string, channelIds: rows.filter((c) => c.type === 'LOJA_FISICA').map((c) => c.id) };
  const others = moduleOn ? rows.filter((c) => c.type !== 'LOJA_FISICA').map((c) => ({ key: c.id, name: c.displayName, type: c.type as string, channelIds: [c.id] })) : [];
  return { moduleOn, channels: [store, ...others] };
}

// Leitura consistente (mesmo instante do banco para todas as consultas da resposta) e prazo explícito para períodos longos.
const READ_TX = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 } as const;

export class DashboardManagementService {
  async summary(scope: ManagementScope, input: { period?: unknown; start?: unknown; end?: unknown }, now: Date = new Date()) {
    const period = resolveDashboardPeriod(input, now);
    const cur = win(period.current);
    const prev = win(period.previous);
    const sd = inWindow('s."saleDate"', cur, prev);
    const company = Prisma.sql`s."companyId" = ${scope.companyId} ${branchSql('s', scope.branchId)}`;

    return runInTransaction(async (tx) => {
      // 1) vendas e descontos, atual e anterior numa só leitura
      const [sales] = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE ${sd.cur}) AS c_sales,
          COALESCE(SUM(s."totalAmount") FILTER (WHERE ${sd.cur}), 0) AS c_revenue,
          COALESCE(SUM(s."discountAmount") FILTER (WHERE ${sd.cur}), 0) AS c_discount,
          COUNT(*) FILTER (WHERE ${sd.cur} AND s."discountAmount" > 0) AS c_disc_sales,
          COALESCE(SUM(s.subtotal) FILTER (WHERE ${sd.cur}), 0) AS c_gross,
          COUNT(*) FILTER (WHERE ${sd.prev}) AS p_sales,
          COALESCE(SUM(s."totalAmount") FILTER (WHERE ${sd.prev}), 0) AS p_revenue,
          COALESCE(SUM(s."discountAmount") FILTER (WHERE ${sd.prev}), 0) AS p_discount,
          COUNT(*) FILTER (WHERE ${sd.prev} AND s."discountAmount" > 0) AS p_disc_sales,
          COALESCE(SUM(s.subtotal) FILTER (WHERE ${sd.prev}), 0) AS p_gross
        FROM sales s
        WHERE ${company} AND ${CLOSED} AND ${sd.any}`);

      // 2) cancelamentos e devoluções totais (pela data em que aconteceram)
      const cd = inWindow('s."cancelledAt"', cur, prev);
      const cancels = await tx.$queryRaw<Array<{ status: string; c: bigint; p: bigint }>>(Prisma.sql`
        SELECT s.status::text AS status, COUNT(*) FILTER (WHERE ${cd.cur}) AS c, COUNT(*) FILTER (WHERE ${cd.prev}) AS p
        FROM sales s
        WHERE ${company} AND s.status IN ('CANCELLED', 'RETURNED') AND ${cd.any}
        GROUP BY 1`);

      // 3) pagamentos aprovados por forma e por grupo (vendas distintas, valor), atual e anterior
      const payMethods = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT p."paymentMethod"::text AS method,
          COUNT(DISTINCT p."saleId") FILTER (WHERE ${sd.cur}) AS c_sales,
          COALESCE(SUM(p.amount) FILTER (WHERE ${sd.cur}), 0) AS c_amount,
          COUNT(DISTINCT p."saleId") FILTER (WHERE ${sd.prev}) AS p_sales,
          COALESCE(SUM(p.amount) FILTER (WHERE ${sd.prev}), 0) AS p_amount
        FROM payments p JOIN sales s ON s.id = p."saleId"
        WHERE ${company} AND ${CLOSED} AND p.status = 'APPROVED' AND ${sd.any}
        GROUP BY 1`);
      const payGroups = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${groupCase} AS grp,
          COUNT(DISTINCT p."saleId") FILTER (WHERE ${sd.cur}) AS c_sales,
          COALESCE(SUM(p.amount) FILTER (WHERE ${sd.cur}), 0) AS c_amount,
          COUNT(DISTINCT p."saleId") FILTER (WHERE ${sd.prev}) AS p_sales,
          COALESCE(SUM(p.amount) FILTER (WHERE ${sd.prev}), 0) AS p_amount
        FROM payments p JOIN sales s ON s.id = p."saleId"
        WHERE ${company} AND ${CLOSED} AND p.status = 'APPROVED' AND ${sd.any}
        GROUP BY 1`);

      // 4) saques (retiradas de caixa)
      const wd = inWindow('m."createdAt"', cur, prev);
      const [withdrawals] = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE ${wd.cur}) AS c_count, COALESCE(SUM(m.amount) FILTER (WHERE ${wd.cur}), 0) AS c_amount,
               COUNT(*) FILTER (WHERE ${wd.prev}) AS p_count, COALESCE(SUM(m.amount) FILTER (WHERE ${wd.prev}), 0) AS p_amount
        FROM cash_movements m JOIN cash_registers r ON r.id = m."cashRegisterId"
        WHERE r."companyId" = ${scope.companyId} ${branchSql('r', scope.branchId)} AND m."movementType" = 'WITHDRAWAL' AND ${wd.any}`);

      // 5) origem das vendas (período atual)
      const origins = await tx.$queryRaw<Array<{ channel_id: string | null; sales: bigint; revenue: unknown }>>(Prisma.sql`
        SELECT s."channelId" AS channel_id, COUNT(*) AS sales, COALESCE(SUM(s."totalAmount"), 0) AS revenue
        FROM sales s WHERE ${company} AND ${CLOSED} AND ${sd.cur} GROUP BY 1`);
      const { moduleOn, channels } = await activeChannels(tx, scope);

      // 6) receita por filial (período atual)
      const byBranchRows = await tx.$queryRaw<Array<{ branch_id: string; sales: bigint; revenue: unknown }>>(Prisma.sql`
        SELECT s."branchId" AS branch_id, COUNT(*) AS sales, COALESCE(SUM(s."totalAmount"), 0) AS revenue
        FROM sales s WHERE ${company} AND ${CLOSED} AND ${sd.cur} GROUP BY 1 ORDER BY 3 DESC`);
      const branches = await tx.branch.findMany({ where: { companyId: scope.companyId }, select: { id: true, name: true } });

      // 7) caixa: abertos agora e fechamentos do período
      const cl = between('r."closedAt"', cur);
      const [cash] = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE r.status = 'OPEN') AS open_registers,
               COALESCE(SUM(r."expectedAmount") FILTER (WHERE r.status = 'OPEN'), 0) AS open_expected,
               COUNT(*) FILTER (WHERE r.status = 'CLOSED' AND ${cl}) AS closings,
               COUNT(*) FILTER (WHERE r.status = 'CLOSED' AND ${cl} AND r.difference IS NOT NULL AND r.difference <> 0) AS divergent,
               COALESCE(SUM(r.difference) FILTER (WHERE r.status = 'CLOSED' AND ${cl} AND r.difference IS NOT NULL), 0) AS difference_sum,
               COUNT(*) FILTER (WHERE r.status = 'CLOSED' AND ${cl} AND r."closeType" = 'FORCED') AS forced
        FROM cash_registers r
        WHERE r."companyId" = ${scope.companyId} ${branchSql('r', scope.branchId)} AND (r.status = 'OPEN' OR (r.status = 'CLOSED' AND ${cl}))`);

      // 8) operação (mesma regra dos painéis /financial e /workshop, na MESMA transação: nenhuma chamada extra ao abrir o painel).
      // Respeita o gate de módulo de cada área: módulo desligado = nulo (a tela mostra "—"), nunca o número.
      const nowTs = ts(now);
      const [financeOn, workshopOn] = await Promise.all([
        moduleSettingsService.isModuleEnabled(scope.companyId, scope.branchId, 'FINANCEIRO'),
        moduleSettingsService.isModuleEnabled(scope.companyId, scope.branchId, 'OFICINA'),
      ]);
      let payablesOverdue: number | null = null;
      let receivablesOverdue: number | null = null;
      if (financeOn) {
        const [pay] = await tx.$queryRaw<Array<{ v: unknown }>>(Prisma.sql`
          SELECT COALESCE(SUM(a.amount), 0) AS v FROM accounts_payable a
          WHERE a."companyId" = ${scope.companyId} ${branchSql('a', scope.branchId)} AND a.status = 'PENDING' AND a."dueDate" < ${nowTs}`);
        const [rec] = await tx.$queryRaw<Array<{ v: unknown }>>(Prisma.sql`
          SELECT COALESCE(SUM(a.amount), 0) AS v FROM accounts_receivable a
          WHERE a."companyId" = ${scope.companyId} ${branchSql('a', scope.branchId)} AND a.status = 'PENDING' AND a."dueDate" < ${nowTs}`);
        payablesOverdue = round2(num(pay.v));
        receivablesOverdue = round2(num(rec.v));
      }
      let openOrders: number | null = null;
      let overdueOrders: number | null = null;
      if (workshopOn) {
        // OS atrasada: prazo prometido vencido; sem prazo prometido, mais de 7 dias desde a entrada (a regra de getWorkshopDashboard).
        const [os] = await tx.$queryRaw<Array<{ open_orders: bigint; overdue_orders: bigint }>>(Prisma.sql`
          SELECT COUNT(*) AS open_orders,
                 COUNT(*) FILTER (WHERE (o."estimatedDelivery" IS NOT NULL AND o."estimatedDelivery" < ${nowTs})
                                     OR (o."estimatedDelivery" IS NULL AND o."entryDate" < ${nowTs} - interval '7 days')) AS overdue_orders
          FROM service_orders o
          WHERE o."companyId" = ${scope.companyId} ${branchSql('o', scope.branchId)}
            AND o.status IN ('ENTRADA', 'DIAGNOSTICO', 'ORCAMENTO', 'APROVACAO', 'EXECUCAO', 'PRONTO', 'ENTREGA')`);
        openOrders = num(os.open_orders);
        overdueOrders = num(os.overdue_orders);
      }

      // ---- montagem ----
      const cSales = num(sales.c_sales);
      const pSales = num(sales.p_sales);
      const cRev = num(sales.c_revenue);
      const pRev = num(sales.p_revenue);
      const cTicket = cSales > 0 ? cRev / cSales : null;
      const pTicket = pSales > 0 ? pRev / pSales : null;
      const cGross = num(sales.c_gross);
      const pGross = num(sales.p_gross);
      const cancelOf = (status: string) => cancels.find((r) => r.status === status);
      const cancelled = comparison(num(cancelOf('CANCELLED')?.c), num(cancelOf('CANCELLED')?.p), 'down', 0);
      const returned = comparison(num(cancelOf('RETURNED')?.c), num(cancelOf('RETURNED')?.p), 'down', 0);
      const cancelTotal = comparison(
        num(cancelOf('CANCELLED')?.c) + num(cancelOf('RETURNED')?.c),
        num(cancelOf('CANCELLED')?.p) + num(cancelOf('RETURNED')?.p),
        'down',
        0
      );

      const totalPaid = payGroups.reduce((a, g) => a + num(g.c_amount), 0);
      const totalPaidPrev = payGroups.reduce((a, g) => a + num(g.p_amount), 0);
      const paymentGroups = GROUP_ORDER.map((key) => {
        const g = payGroups.find((r) => r.grp === key);
        const c = { sales: num(g?.c_sales), amount: round2(num(g?.c_amount)) };
        const p = { sales: num(g?.p_sales), amount: round2(num(g?.p_amount)) };
        return {
          key,
          label: GROUP_LABEL[key],
          current: { ...c, avgTicket: c.sales > 0 ? round2(c.amount / c.sales) : null, share: totalPaid > 0 ? round2((c.amount / totalPaid) * 100) : null },
          previous: { ...p, avgTicket: p.sales > 0 ? round2(p.amount / p.sales) : null, share: totalPaidPrev > 0 ? round2((p.amount / totalPaidPrev) * 100) : null },
          amount: comparison(c.amount, p.amount, 'up'),
          sales: comparison(c.sales, p.sales, 'up', 0),
          details:
            key === 'CARD'
              ? (['DEBIT_CARD', 'CREDIT_CARD'] as CardDetail[]).map((m) => {
                  const r = payMethods.find((x) => x.method === m);
                  const amount = round2(num(r?.c_amount));
                  const salesCount = num(r?.c_sales);
                  return { key: m, label: METHOD_LABEL[m], sales: salesCount, amount, avgTicket: salesCount > 0 ? round2(amount / salesCount) : null };
                })
              : undefined,
        };
        // "Outras formas" só aparece quando houve uso; as cinco oficiais sempre (zero real também é informação)
      }).filter((g) => g.key !== 'OTHER' || g.current.amount > 0 || g.previous.amount > 0);

      const included = channels.map((c) => {
        const rows = origins.filter((o) => (o.channel_id === null ? c.key === STORE_KEY : c.channelIds.includes(o.channel_id)));
        const revenue = round2(rows.reduce((a, r) => a + num(r.revenue), 0));
        return { key: c.key, name: c.name, type: c.type, sales: rows.reduce((a, r) => a + num(r.sales), 0), revenue };
      });
      const includedTotal = included.reduce((a, o) => a + o.revenue, 0);
      const includedSales = included.reduce((a, o) => a + o.sales, 0);
      const originRows = included.map((o) => ({ ...o, share: includedTotal > 0 ? round2((o.revenue / includedTotal) * 100) : null }));

      const branchName = new Map(branches.map((b) => [b.id, b.name]));

      return {
        period: serializePeriod(period),
        scope: { branchId: scope.branchId },
        definitions: DEFINITIONS,
        kpis: {
          revenue: comparison(cRev, pRev, 'up'),
          sales: comparison(cSales, pSales, 'up', 0),
          avgTicket: comparison(cTicket, pTicket, 'up'),
          withdrawals: {
            count: comparison(num(withdrawals.c_count), num(withdrawals.p_count), 'neutral', 0),
            amount: comparison(num(withdrawals.c_amount), num(withdrawals.p_amount), 'neutral'),
          },
          cancellations: { cancelled, returned, total: cancelTotal },
          discounts: {
            amount: comparison(num(sales.c_discount), num(sales.p_discount), 'down'),
            salesWithDiscount: comparison(num(sales.c_disc_sales), num(sales.p_disc_sales), 'down', 0),
            percentOfGross: comparison(cGross > 0 ? (num(sales.c_discount) / cGross) * 100 : null, pGross > 0 ? (num(sales.p_discount) / pGross) * 100 : null, 'down'),
          },
        },
        paymentMethods: {
          totalAmount: comparison(round2(totalPaid), round2(totalPaidPrev), 'up'),
          groups: paymentGroups,
        },
        origins: {
          moduleEnabled: moduleOn,
          totalRevenue: round2(includedTotal),
          totalSales: includedSales,
          items: originRows,
          // vendas de canal desativado (ou de módulo desligado) ficam fora da composição, mas dentro da receita: o painel avisa
          excluded: { revenue: round2(cRev - includedTotal), sales: cSales - includedSales },
        },
        byBranch: byBranchRows.map((b) => ({ branchId: b.branch_id, branchName: branchName.get(b.branch_id) ?? b.branch_id, sales: num(b.sales), revenue: round2(num(b.revenue)) })),
        cash: {
          openRegisters: num(cash.open_registers),
          openExpectedAmount: round2(num(cash.open_expected)),
          closings: num(cash.closings),
          divergentClosings: num(cash.divergent),
          differenceSum: round2(num(cash.difference_sum)),
          forcedClosings: num(cash.forced),
        },
        operations: { payablesOverdue, receivablesOverdue, openOrders, overdueOrders },
      };
    }, READ_TX);
  }

  async timeseries(scope: ManagementScope, input: { period?: unknown; start?: unknown; end?: unknown }, now: Date = new Date()) {
    const period = resolveDashboardPeriod(input, now);
    const g = period.granularity;
    const cur = win(period.current);
    const prev = win(period.previous);
    const company = Prisma.sql`s."companyId" = ${scope.companyId} ${branchSql('s', scope.branchId)}`;
    const bucketS = bucketSql('s."saleDate"', g);

    return runInTransaction(async (tx) => {
      const sales = await tx.$queryRaw<Array<{ b: string; sales: bigint; revenue: unknown }>>(Prisma.sql`
        SELECT ${bucketS} AS b, COUNT(*) AS sales, COALESCE(SUM(s."totalAmount"), 0) AS revenue
        FROM sales s WHERE ${company} AND ${CLOSED} AND ${between('s."saleDate"', cur)} GROUP BY 1`);
      const prevSales = await tx.$queryRaw<Array<{ b: string; sales: bigint; revenue: unknown }>>(Prisma.sql`
        SELECT ${bucketS} AS b, COUNT(*) AS sales, COALESCE(SUM(s."totalAmount"), 0) AS revenue
        FROM sales s WHERE ${company} AND ${CLOSED} AND ${between('s."saleDate"', prev)} GROUP BY 1`);
      const pay = await tx.$queryRaw<Array<{ b: string; grp: string; sales: bigint; amount: unknown }>>(Prisma.sql`
        SELECT ${bucketS} AS b, ${groupCase} AS grp, COUNT(DISTINCT p."saleId") AS sales, COALESCE(SUM(p.amount), 0) AS amount
        FROM payments p JOIN sales s ON s.id = p."saleId"
        WHERE ${company} AND ${CLOSED} AND p.status = 'APPROVED' AND ${between('s."saleDate"', cur)} GROUP BY 1, 2`);
      const byChannel = await tx.$queryRaw<Array<{ b: string; channel_id: string | null; sales: bigint; revenue: unknown }>>(Prisma.sql`
        SELECT ${bucketS} AS b, s."channelId" AS channel_id, COUNT(*) AS sales, COALESCE(SUM(s."totalAmount"), 0) AS revenue
        FROM sales s WHERE ${company} AND ${CLOSED} AND ${between('s."saleDate"', cur)} GROUP BY 1, 2`);
      const wd = await tx.$queryRaw<Array<{ b: string; count: bigint; amount: unknown }>>(Prisma.sql`
        SELECT ${bucketSql('m."createdAt"', g)} AS b, COUNT(*) AS count, COALESCE(SUM(m.amount), 0) AS amount
        FROM cash_movements m JOIN cash_registers r ON r.id = m."cashRegisterId"
        WHERE r."companyId" = ${scope.companyId} ${branchSql('r', scope.branchId)} AND m."movementType" = 'WITHDRAWAL' AND ${between('m."createdAt"', cur)} GROUP BY 1`);
      const { channels } = await activeChannels(tx, scope);

      const bySales = new Map(sales.map((r) => [r.b, r]));
      const byPrev = new Map(prevSales.map((r) => [r.b, r]));
      const byWd = new Map(wd.map((r) => [r.b, r]));
      const buckets = periodBuckets(period, now);
      const prevBuckets = previousPeriodBuckets(period, buckets.length);

      const channelOf = (id: string | null) => channels.find((c) => (id === null ? c.key === STORE_KEY : c.channelIds.includes(id)));

      const points = buckets.map((bk) => {
        const s = bySales.get(bk.key);
        const count = num(s?.sales);
        const revenue = round2(num(s?.revenue));
        const w = byWd.get(bk.key);
        const byMethod: Record<string, { sales: number; amount: number }> = {};
        for (const r of pay.filter((x) => x.b === bk.key)) byMethod[r.grp] = { sales: num(r.sales), amount: round2(num(r.amount)) };
        const byChan: Record<string, { sales: number; revenue: number }> = {};
        for (const c of channels) byChan[c.key] = { sales: 0, revenue: 0 };
        for (const r of byChannel.filter((x) => x.b === bk.key)) {
          const c = channelOf(r.channel_id);
          if (c) {
            byChan[c.key].sales += num(r.sales);
            byChan[c.key].revenue = round2(byChan[c.key].revenue + num(r.revenue));
          }
        }
        return {
          key: bk.key,
          t: bk.t.toISOString(),
          // ausência de venda em dia/hora/mês do período é ZERO (vendas); ticket sem venda é indefinido, não zero
          revenue,
          sales: count,
          avgTicket: count > 0 ? round2(revenue / count) : null,
          withdrawals: { count: num(w?.count), amount: round2(num(w?.amount)) },
          byMethod,
          byChannel: byChan,
        };
      });

      const previousPoints = prevBuckets.map((bk) => {
        const s = byPrev.get(bk.key);
        const count = num(s?.sales);
        const revenue = round2(num(s?.revenue));
        return { key: bk.key, t: bk.t.toISOString(), revenue, sales: count, avgTicket: count > 0 ? round2(revenue / count) : null };
      });

      return {
        period: serializePeriod(period),
        scope: { branchId: scope.branchId },
        granularity: g,
        points,
        previousPoints,
        methods: GROUP_ORDER.map((key) => ({ key, label: GROUP_LABEL[key] })),
        channels: channels.map((c) => ({ key: c.key, name: c.name, type: c.type })),
      };
    }, READ_TX);
  }
}

function serializePeriod(p: ResolvedPeriod) {
  return {
    preset: p.preset,
    label: p.label,
    rangeLabel: p.rangeLabel,
    granularity: p.granularity,
    timeZone: p.timeZone,
    start: p.current.start.toISOString(),
    end: p.current.end.toISOString(),
    startDay: p.current.startDay,
    endDay: p.current.endDay,
    days: p.current.days,
    previous: {
      label: p.previousLabel,
      start: p.previous.start.toISOString(),
      end: p.previous.end.toISOString(),
      startDay: p.previous.startDay,
      endDay: p.previous.endDay,
      days: p.previous.days,
    },
  };
}

export default new DashboardManagementService();
