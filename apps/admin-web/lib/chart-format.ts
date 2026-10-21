// Formatação dos gráficos do painel. Datas "YYYY-MM-DD" são rótulos de DIA: não passam por `new Date()`, que as lê como UTC
// e, no Brasil (UTC-3), mostraria o dia anterior.

const BRL_COMPACT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/** Rótulo curto de eixo: "R$ 80 mil", "R$ 1,2 mi". O valor exato fica na dica (formatCurrency). */
export function formatBRLCompact(value: number): string {
  return BRL_COMPACT.format(Number.isFinite(value) ? value : 0);
}

/** "2026-09-04" → "04/09". Texto fora do formato volta como veio. */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}` : String(iso);
}

/** "2026-09-04" → instante UTC da meia-noite desse dia (escala de tempo do eixo). Texto inválido vira NaN. */
export function dayToTime(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
}

/** Volta do instante UTC para "YYYY-MM-DD" (sem fuso: o dia é o mesmo que entrou em `dayToTime`). */
export function timeToDay(time: number): string {
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

/** "2026-09-04" → "04/09/2026". */
export function dayLabelLong(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}
