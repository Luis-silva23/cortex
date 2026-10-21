import { AppError } from '@ln-system/shared';
import { APP_TIME_ZONE, localDayKey, startOfLocalDate } from './time-zone';

/**
 * REGRA ÚNICA DE PERÍODO do Dashboard (decisões 67 e 68). Toda tela e todo número do painel recebem o MESMO intervalo, resolvido
 * aqui, em dias civis de Brasília (`America/Sao_Paulo`): o front só envia o nome do recorte (e, no personalizado, as duas datas)
 * e mostra o que a API devolve; nenhuma conta de data é feita em componente.
 *
 *   Hoje              dia de hoje            × ontem até o mesmo horário
 *   Ontem             dia de ontem           × anteontem (dia inteiro)
 *   Últimos 7 dias    hoje e os 6 anteriores × os 7 dias imediatamente antes
 *   Últimos 30 dias   hoje e os 29 anteriores× os 30 dias imediatamente antes (padrão)
 *   Mês atual         dia 1 até hoje         × os mesmos dias do mês anterior (limitado ao tamanho dele)
 *   Mês anterior      mês inteiro            × o mês antes dele, inteiro
 *   Ano               1º de janeiro até hoje × os mesmos dias do ano anterior
 *   Personalizado     início e fim (inclusive) × período imediatamente anterior de mesma duração
 *
 * Intervalos são [início, fim): `start` é a meia-noite local do primeiro dia e `end` a meia-noite local que abre o dia seguinte
 * ao último (nunca "agora"; para a comparação de "Hoje" o fim anterior acompanha o horário de agora). "30 dias" são 30 dias
 * civis, não 30 × 24 h: a série começa na meia-noite de Brasília e o primeiro dia nunca é parcial.
 */

export const DASHBOARD_PERIOD_PRESETS = ['today', 'yesterday', '7d', '30d', 'month', 'prev_month', 'year', 'custom'] as const;
export type DashboardPeriodPreset = (typeof DASHBOARD_PERIOD_PRESETS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriodPreset = '30d';
/** Teto do período personalizado (um ano civil bissexto cabe). */
export const MAX_CUSTOM_PERIOD_DAYS = 366;
/** Acima disto a série é mensal; em um só dia é por hora; entre os dois, diária. */
export const MAX_DAILY_GRANULARITY_DAYS = 62;

export type PeriodGranularity = 'hour' | 'day' | 'month';

export interface PeriodRange {
  /** Primeiro dia (inclusive), `YYYY-MM-DD` de Brasília. */
  startDay: string;
  /** Último dia (inclusive), `YYYY-MM-DD` de Brasília. */
  endDay: string;
  /** Meia-noite local do primeiro dia. */
  start: Date;
  /** Fim EXCLUSIVO do intervalo (instante). */
  end: Date;
  days: number;
}

export interface ResolvedPeriod {
  preset: DashboardPeriodPreset;
  /** Nome do recorte ("Últimos 30 dias") e o intervalo por extenso ("05/09/2026 – 04/10/2026"). */
  label: string;
  rangeLabel: string;
  current: PeriodRange;
  previous: PeriodRange;
  previousLabel: string;
  granularity: PeriodGranularity;
  timeZone: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (message: string) => new AppError(message, 400, 'INVALID_PERIOD');

/** Dia civil `YYYY-MM-DD` → número de dias desde 1970 (aritmética de calendário, sem fuso). */
function keyToDays(key: string): number {
  const m = KEY_RE.exec(key);
  if (!m) throw invalid(`Data inválida: ${key} (use AAAA-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw invalid(`Data inexistente: ${key}`);
  return ms / DAY_MS;
}

const daysToKey = (days: number): string => new Date(days * DAY_MS).toISOString().slice(0, 10);

const keyParts = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
};

/** Primeiro dia (em dias civis) do mês `m` (1-12) do ano `y`; aceita mês fora de 1-12 (13 = janeiro do ano seguinte). */
const monthStartDays = (y: number, m: number): number => Date.UTC(y, m - 1, 1) / DAY_MS;

const dayInstant = (days: number): Date => {
  const { y, m, d } = keyParts(daysToKey(days));
  return startOfLocalDate(y, m, d);
};

function range(startDays: number, endExclusiveDays: number): PeriodRange {
  return {
    startDay: daysToKey(startDays),
    endDay: daysToKey(endExclusiveDays - 1),
    start: dayInstant(startDays),
    end: dayInstant(endExclusiveDays),
    days: endExclusiveDays - startDays,
  };
}

const fmtDay = (key: string) => {
  const { y, m, d } = keyParts(key);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
};
const fmtRange = (r: PeriodRange) => (r.days === 1 ? fmtDay(r.startDay) : `${fmtDay(r.startDay)} – ${fmtDay(r.endDay)}`);

export const PERIOD_LABELS: Record<DashboardPeriodPreset, string> = {
  today: 'Hoje',
  yesterday: 'Ontem',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  month: 'Mês atual',
  prev_month: 'Mês anterior',
  year: 'Ano',
  custom: 'Período personalizado',
};

export const isDashboardPeriodPreset = (v: unknown): v is DashboardPeriodPreset =>
  typeof v === 'string' && (DASHBOARD_PERIOD_PRESETS as readonly string[]).includes(v);

export function granularityFor(days: number): PeriodGranularity {
  if (days <= 1) return 'hour';
  return days > MAX_DAILY_GRANULARITY_DAYS ? 'month' : 'day';
}

export function resolveDashboardPeriod(
  input: { period?: unknown; start?: unknown; end?: unknown } = {},
  now: Date = new Date()
): ResolvedPeriod {
  const preset = input.period === undefined || input.period === null || input.period === '' ? DEFAULT_DASHBOARD_PERIOD : input.period;
  if (!isDashboardPeriodPreset(preset)) throw invalid(`Período inválido: ${String(preset)}`);

  const today = keyToDays(localDayKey(now));
  const { y: ty, m: tm } = keyParts(daysToKey(today));
  const thisMonth = monthStartDays(ty, tm);
  const lastMonth = monthStartDays(ty, tm - 1);
  const thisYear = monthStartDays(ty, 1);
  const lastYear = monthStartDays(ty - 1, 1);

  let current: PeriodRange;
  let previous: PeriodRange;
  let previousLabel: string;

  switch (preset) {
    case 'today': {
      current = range(today, today + 1);
      const elapsed = now.getTime() - current.start.getTime();
      const yesterday = range(today - 1, today);
      const end = new Date(Math.min(yesterday.start.getTime() + Math.max(elapsed, 0), yesterday.end.getTime()));
      previous = { ...yesterday, end };
      previousLabel = `ontem até ${new Intl.DateTimeFormat('pt-BR', { timeZone: APP_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)}`;
      break;
    }
    case 'yesterday':
      current = range(today - 1, today);
      previous = range(today - 2, today - 1);
      previousLabel = 'anteontem';
      break;
    case '7d':
      current = range(today - 6, today + 1);
      previous = range(today - 13, today - 6);
      previousLabel = '7 dias anteriores';
      break;
    case '30d':
      current = range(today - 29, today + 1);
      previous = range(today - 59, today - 29);
      previousLabel = '30 dias anteriores';
      break;
    case 'month': {
      current = range(thisMonth, today + 1);
      const n = today + 1 - thisMonth;
      previous = range(lastMonth, Math.min(lastMonth + n, thisMonth));
      previousLabel = 'mesmo período do mês anterior';
      break;
    }
    case 'prev_month':
      current = range(lastMonth, thisMonth);
      previous = range(monthStartDays(ty, tm - 2), lastMonth);
      previousLabel = 'mês anterior a ele';
      break;
    case 'year': {
      current = range(thisYear, today + 1);
      const n = today + 1 - thisYear;
      previous = range(lastYear, Math.min(lastYear + n, thisYear));
      previousLabel = 'mesmo período do ano anterior';
      break;
    }
    case 'custom': {
      if (!input.start || !input.end) throw invalid('Informe o início e o fim do período personalizado');
      const s = keyToDays(String(input.start));
      const e = keyToDays(String(input.end));
      if (e < s) throw invalid('O início do período não pode ser depois do fim');
      const days = e - s + 1;
      if (days > MAX_CUSTOM_PERIOD_DAYS) throw invalid(`O período personalizado vai até ${MAX_CUSTOM_PERIOD_DAYS} dias`);
      current = range(s, e + 1);
      previous = range(s - days, s);
      previousLabel = 'período imediatamente anterior';
      break;
    }
  }

  return {
    preset,
    label: PERIOD_LABELS[preset],
    rangeLabel: fmtRange(current),
    current,
    previous,
    previousLabel,
    granularity: granularityFor(current.days),
    timeZone: APP_TIME_ZONE,
  };
}

/** Variação entre o período atual e o anterior. Anterior zero: a variação percentual é indefinida (`null`), nunca infinito. */
export function compareValues(current: number, previous: number) {
  const diff = current - previous;
  const percent = previous === 0 ? (current === 0 ? 0 : null) : (diff / previous) * 100;
  return { current, previous, diff, percent };
}

export interface PeriodBucket {
  /** `YYYY-MM-DD` (dia), `YYYY-MM` (mês) ou `YYYY-MM-DDTHH` (hora), em Brasília. */
  key: string;
  /** Início do balde (instante). */
  t: Date;
}

/**
 * Baldes do período na granularidade pedida, do primeiro ao último. Em "hora" de hoje para no horário atual (hora futura não é
 * zero, é ainda não aconteceu). Serve para o preenchimento com zero das séries de venda (ausência de venda = zero).
 */
export function periodBuckets(period: ResolvedPeriod, now: Date = new Date()): PeriodBucket[] {
  const { current, granularity } = period;
  const first = keyToDays(current.startDay);
  const last = keyToDays(current.endDay);
  if (granularity === 'hour') {
    const lastHour = Math.floor((Math.min(now.getTime(), current.end.getTime() - 1) - current.start.getTime()) / 3_600_000);
    const hours = Math.max(0, Math.min(23, lastHour));
    return Array.from({ length: hours + 1 }, (_, h) => ({
      key: `${current.startDay}T${String(h).padStart(2, '0')}`,
      t: new Date(current.start.getTime() + h * 3_600_000),
    }));
  }
  if (granularity === 'day') {
    return Array.from({ length: last - first + 1 }, (_, i) => ({ key: daysToKey(first + i), t: dayInstant(first + i) }));
  }
  const out: PeriodBucket[] = [];
  const a = keyParts(current.startDay);
  const b = keyParts(current.endDay);
  for (let y = a.y, m = a.m; y < b.y || (y === b.y && m <= b.m); m === 12 ? ((m = 1), y++) : m++) {
    out.push({ key: `${y}-${String(m).padStart(2, '0')}`, t: startOfLocalDate(y, m, 1) });
  }
  return out;
}

/**
 * Baldes do período ANTERIOR alinhados POR POSIÇÃO aos do atual (o i-ésimo anterior corresponde ao i-ésimo atual): serve à
 * série comparativa. No máximo `count` baldes e nunca além do que o período anterior tem (ex.: ano com 29/02).
 */
export function previousPeriodBuckets(period: ResolvedPeriod, count: number): PeriodBucket[] {
  const { previous, granularity } = period;
  if (granularity === 'hour') {
    return Array.from({ length: Math.max(0, Math.min(count, 24)) }, (_, h) => ({
      key: `${previous.startDay}T${String(h).padStart(2, '0')}`,
      t: new Date(previous.start.getTime() + h * 3_600_000),
    }));
  }
  const first = keyToDays(previous.startDay);
  if (granularity === 'day') {
    const n = Math.max(0, Math.min(count, previous.days));
    return Array.from({ length: n }, (_, i) => ({ key: daysToKey(first + i), t: dayInstant(first + i) }));
  }
  const out: PeriodBucket[] = [];
  const a = keyParts(previous.startDay);
  const b = keyParts(previous.endDay);
  for (let y = a.y, m = a.m; (y < b.y || (y === b.y && m <= b.m)) && out.length < count; m === 12 ? ((m = 1), y++) : m++) {
    out.push({ key: `${y}-${String(m).padStart(2, '0')}`, t: startOfLocalDate(y, m, 1) });
  }
  return out;
}

/** Chave do balde de um instante, na granularidade do período (para agrupar em memória quando o banco não puder). */
export function bucketKeyOf(instant: Date, granularity: PeriodGranularity): string {
  const day = localDayKey(instant);
  if (granularity === 'month') return day.slice(0, 7);
  if (granularity === 'day') return day;
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(instant);
  return `${day}T${hour.padStart(2, '0')}`;
}

/** Meia-noite local do dia civil `YYYY-MM-DD` — apoio de teste e de consulta. */
export const instantOfDayKey = (key: string): Date => dayInstant(keyToDays(key));
