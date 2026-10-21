// Cores de gráfico (recharts) ligadas aos tokens de globals.css: `var()` é resolvido pelo navegador no
// atributo SVG, então o gráfico acompanha a troca de tema sem re-render.
export const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-6))',
] as const;

export const CHART_GRID = 'hsl(var(--border))';
export const CHART_AXIS = 'hsl(var(--muted-foreground))';

// Uso nos gráficos do painel: série principal (azul naval; off-white-azulado no escuro), secundária, superfície do
// cartão (miolo dos pontos e fundo da dica) e texto. Todos são tokens: acompanham o tema sem re-render.
export const CHART_PRIMARY = CHART_COLORS[0];
export const CHART_SECONDARY = CHART_COLORS[1];
export const CHART_SURFACE = 'hsl(var(--card))';
export const CHART_TEXT = 'hsl(var(--foreground))';
export const CHART_CURSOR = 'hsl(var(--muted))';

export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}
