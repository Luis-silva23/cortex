// Modos de visualização dos gráficos de evolução no tempo do painel. LINHA é o padrão: a tela abre em Linha e o usuário escolhe
// Colunas quando quiser (troca só visual, mesma série, sem nova chamada à API). Gráficos só categóricos (forma de pagamento,
// filial) não passam por aqui: ficam em barras, porque não há ordem entre categorias para uma linha ligar.
export type TimeChartMode = 'line' | 'columns';

export const DEFAULT_TIME_CHART_MODE: TimeChartMode = 'line';

// A ordem é a do controle na tela: Linha primeiro.
export const TIME_CHART_MODES: { value: TimeChartMode; label: string }[] = [
  { value: 'line', label: 'Linha' },
  { value: 'columns', label: 'Colunas' },
];
