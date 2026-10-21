// Fuso do produto no painel (decisão 58): o dia é o de Brasília, o mesmo critério da API (`apps/api/src/utils/time-zone.ts`,
// que agrupa as vendas por dia). Antes "Hoje" e "Mês atual" usavam o relógio do navegador: quem abre o painel com o
// computador em outro fuso via um "hoje" diferente do que a API agrupa. A API devolve o DIA já pronto (YYYY-MM-DD) e o
// front não reconverte nada; só o início do período sai daqui, em instante (ISO), como a API espera.
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

function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

/** Instante da meia-noite de Brasília que abre o dia do instante dado. */
export function startOfLocalDay(date: Date, timeZone: string = APP_TIME_ZONE): Date {
  const p = parts(date, timeZone);
  return localMidnight(p.year, p.month, p.day, timeZone);
}

/** Instante da meia-noite de Brasília que abre o mês do instante dado. */
export function startOfLocalMonth(date: Date, timeZone: string = APP_TIME_ZONE): Date {
  const p = parts(date, timeZone);
  return localMidnight(p.year, p.month, 1, timeZone);
}
