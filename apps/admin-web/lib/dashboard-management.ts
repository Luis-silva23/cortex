// Dashboard gerencial: tipos da resposta de GET /api/dashboard/management/{summary,timeseries}, os recortes de período e os
// formatadores. REGRA ÚNICA DE PERÍODO: quem calcula o intervalo é a API (apps/api/src/utils/dashboard-period.ts, dias civis de
// Brasília); aqui só se envia o NOME do recorte (e, no personalizado, as duas datas escolhidas) e se mostra o que a API devolve.
// Nenhuma conta de data é feita no front. A lista abaixo é conferida contra a da API por teste (`dashboard-period.parity.test.ts`).

export const DASHBOARD_PERIOD_PRESETS = ['today', 'yesterday', '7d', '30d', 'month', 'prev_month', 'year', 'custom'] as const;
export type DashboardPeriodPreset = (typeof DASHBOARD_PERIOD_PRESETS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriodPreset = '30d';

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriodPreset, string> = {
  today: 'Hoje',
  yesterday: 'Ontem',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  month: 'Mês atual',
  prev_month: 'Mês anterior',
  year: 'Ano',
  custom: 'Período personalizado',
};

export interface PeriodSelection {
  preset: DashboardPeriodPreset;
  /** Só no personalizado: datas `AAAA-MM-DD` escolhidas pelo usuário (a API valida e resolve). */
  start?: string;
  end?: string;
}

export const DEFAULT_PERIOD_SELECTION: PeriodSelection = { preset: DEFAULT_DASHBOARD_PERIOD };

/** Parâmetros de consulta enviados a TODAS as chamadas do painel: o mesmo período para tudo. */
export function periodParams(sel: PeriodSelection): { period: string; start?: string; end?: string } {
  return sel.preset === 'custom' && sel.start && sel.end ? { period: 'custom', start: sel.start, end: sel.end } : { period: sel.preset === 'custom' ? DEFAULT_DASHBOARD_PERIOD : sel.preset };
}

/** O personalizado só vale com as duas datas e o início não depois do fim (comparação de texto AAAA-MM-DD; o teto de dias é da API). */
export function isCustomRangeValid(start: string, end: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;
}

// ---------- respostas da API ----------

export interface Comparison {
  current: number | null;
  previous: number | null;
  diff: number | null;
  percent: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  outcome: 'better' | 'worse' | 'neutral';
}

export interface ResolvedPeriodInfo {
  preset: DashboardPeriodPreset;
  label: string;
  rangeLabel: string;
  granularity: 'hour' | 'day' | 'month';
  timeZone: string;
  start: string;
  end: string;
  startDay: string;
  endDay: string;
  days: number;
  previous: { label: string; start: string; end: string; startDay: string; endDay: string; days: number };
}

export interface PaymentPeriodStats {
  sales: number;
  amount: number;
  avgTicket: number | null;
  share: number | null;
}

export interface PaymentGroup {
  key: string;
  label: string;
  current: PaymentPeriodStats;
  previous: PaymentPeriodStats;
  amount: Comparison;
  sales: Comparison;
  details?: Array<{ key: string; label: string; sales: number; amount: number; avgTicket: number | null }>;
}

export interface OriginItem {
  key: string;
  name: string;
  type: string;
  sales: number;
  revenue: number;
  share: number | null;
}

export interface ManagementSummary {
  period: ResolvedPeriodInfo;
  scope: { branchId: string | null };
  definitions: Record<'revenue' | 'sales' | 'avgTicket' | 'withdrawals' | 'cancellations' | 'discounts' | 'paymentMethods' | 'origins', string>;
  kpis: {
    revenue: Comparison;
    sales: Comparison;
    avgTicket: Comparison;
    withdrawals: { count: Comparison; amount: Comparison };
    cancellations: { cancelled: Comparison; returned: Comparison; total: Comparison };
    discounts: { amount: Comparison; salesWithDiscount: Comparison; percentOfGross: Comparison };
  };
  paymentMethods: { totalAmount: Comparison; groups: PaymentGroup[] };
  origins: { moduleEnabled: boolean; totalRevenue: number; totalSales: number; items: OriginItem[]; excluded: { revenue: number; sales: number } };
  byBranch: Array<{ branchId: string; branchName: string; sales: number; revenue: number }>;
  cash: { openRegisters: number; openExpectedAmount: number; closings: number; divergentClosings: number; differenceSum: number; forcedClosings: number };
  /** Nulo = módulo (Financeiro ou Oficina) desligado para a filial: a tela mostra traço, nunca zero. */
  operations: { payablesOverdue: number | null; receivablesOverdue: number | null; openOrders: number | null; overdueOrders: number | null };
}

export interface SeriesPoint {
  key: string;
  t: string;
  revenue: number;
  sales: number;
  avgTicket: number | null;
  withdrawals: { count: number; amount: number };
  byMethod: Record<string, { sales: number; amount: number }>;
  byChannel: Record<string, { sales: number; revenue: number }>;
}

export interface ManagementTimeseries {
  period: ResolvedPeriodInfo;
  scope: { branchId: string | null };
  granularity: 'hour' | 'day' | 'month';
  points: SeriesPoint[];
  previousPoints: Array<{ key: string; t: string; revenue: number; sales: number; avgTicket: number | null }>;
  methods: Array<{ key: string; label: string }>;
  channels: Array<{ key: string; name: string; type: string }>;
}

// ---------- formatação (sempre no fuso de Brasília) ----------

const TZ = 'America/Sao_Paulo';
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const int = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export const money = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : brl.format(v));
export const count = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : int.format(v));

export function percentText(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined) return '—';
  const text = `${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  return signed ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${text}` : v < 0 ? `−${text}` : text;
}

export function signedMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${brl.format(Math.abs(v))}`;
}

export function signedCount(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${int.format(Math.abs(v))}`;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts });
const F = {
  hour: fmt({ hour: '2-digit', hourCycle: 'h23' }),
  dayShort: fmt({ day: '2-digit', month: '2-digit' }),
  dayLong: fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }),
  hourLong: fmt({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  monthShort: fmt({ month: 'short', year: '2-digit' }),
  monthLong: fmt({ month: 'long', year: 'numeric' }),
};

/** Rótulos do eixo e da dica para a granularidade que a API devolveu; instantes em ms, sempre no relógio de Brasília. */
export function timeFormatters(granularity: 'hour' | 'day' | 'month') {
  switch (granularity) {
    case 'hour':
      return { tick: (t: number) => `${F.hour.format(t)}h`, label: (t: number) => F.hourLong.format(t), stepMs: 3_600_000, pad: 1_800_000 };
    case 'month':
      return { tick: (t: number) => F.monthShort.format(t).replace('.', ''), label: (t: number) => F.monthLong.format(t), stepMs: undefined, pad: 15 * 86_400_000 };
    default:
      return { tick: (t: number) => F.dayShort.format(t), label: (t: number) => F.dayLong.format(t), stepMs: 86_400_000, pad: 43_200_000 };
  }
}
