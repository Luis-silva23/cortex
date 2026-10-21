/**
 * Fuso horário do produto (decisão 58): o dia do painel é o dia de Brasília. O banco guarda instantes (UTC) e continua
 * guardando; só o AGRUPAMENTO por dia e as fronteiras de "hoje" usam este fuso. Antes o dia vinha de `toISOString()` (UTC) e
 * do relógio do servidor, então uma venda depois das 21h de Brasília entrava no dia seguinte e "hoje" começava às 21h de ontem.
 *
 * Fuso único e fixo por enquanto (`America/Sao_Paulo`); fuso por empresa/filial seria outra decisão. O front usa o mesmo
 * critério em `apps/admin-web/lib/time-zone.ts` para o início de "hoje" e do mês.
 */
export const APP_TIME_ZONE = 'America/Sao_Paulo';

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(date: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Dia local (YYYY-MM-DD) do instante. Ex.: 2026-10-05T00:30Z é 21:30 de 04/10 em Brasília → "2026-10-04". */
export function localDayKey(date: Date, timeZone: string = APP_TIME_ZONE): string {
  const p = parts(date, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Diferença (local − UTC) em ms no instante dado.
function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Instante em que o relógio local marca 00:00 do dia (y, m, d); refaz o cálculo uma vez para o caso de a transição de horário cair no dia.
function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

/** Instante da meia-noite local que abre o dia do instante dado. */
export function startOfLocalDay(date: Date, timeZone: string = APP_TIME_ZONE): Date {
  const p = parts(date, timeZone);
  return localMidnight(p.year, p.month, p.day, timeZone);
}

/** Instante da meia-noite local que abre o dia SEGUINTE ao do instante dado (fim exclusivo do dia). */
export function startOfNextLocalDay(date: Date, timeZone: string = APP_TIME_ZONE): Date {
  const p = parts(date, timeZone);
  return localMidnight(p.year, p.month, p.day + 1, timeZone);
}

/** Instante da meia-noite local do dia civil (ano, mês 1-12, dia). O dia pode passar do fim do mês (ex.: dia 32 = dia 1 do seguinte). */
export function startOfLocalDate(year: number, month: number, day: number, timeZone: string = APP_TIME_ZONE): Date {
  return localMidnight(year, month, day, timeZone);
}
