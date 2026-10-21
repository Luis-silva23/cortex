// Cores dos gráficos do Super Admin, ligadas aos tokens do tema (`app/globals.css`): `var()` é resolvido pelo navegador, então o
// gráfico acompanha a troca claro/escuro sem re-render. Mesmos nomes de `apps/admin-web/lib/chart-theme.ts`: o gráfico temporal
// compartilhado (`components/charts/TimeSeriesChart.tsx`, idêntico nos dois apps) importa daqui. Verde/amarelo/vermelho só como estado.
export const CHART_GRID = 'hsl(var(--border))';
export const CHART_AXIS = 'hsl(var(--muted-foreground))';

// Série principal (azul naval no claro, off-white no escuro, o `--primary` da marca), secundária (cinza), superfície do cartão
// (miolo dos pontos e fundo da dica), texto e fundo do cursor.
export const CHART_PRIMARY = 'hsl(var(--primary))';
export const CHART_SECONDARY = 'hsl(var(--muted-foreground))';
export const CHART_SURFACE = 'hsl(var(--card))';
export const CHART_TEXT = 'hsl(var(--foreground))';
export const CHART_CURSOR = 'hsl(var(--muted))';

// Estados (só para série que significa estado: erro, atenção).
export const CHART_DANGER = 'hsl(var(--danger))';
export const CHART_WARNING = 'hsl(var(--warning))';
