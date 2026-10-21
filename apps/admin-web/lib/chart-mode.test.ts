import fs from 'fs';
import path from 'path';
import { DEFAULT_TIME_CHART_MODE, TIME_CHART_MODES } from './chart-mode';

const ROOT = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Guarda: gráfico de evolução no tempo abre em LINHA; Colunas segue disponível como alternativa.
describe('modo padrão dos gráficos de evolução no tempo', () => {
  it('o padrão é Linha e Linha é a primeira opção do controle', () => {
    expect(DEFAULT_TIME_CHART_MODE).toBe('line');
    expect(TIME_CHART_MODES.map((m) => m.value)).toEqual(['line', 'columns']);
    expect(TIME_CHART_MODES[0].label).toBe('Linha');
  });

  it('o gráfico temporal único começa no padrão, tem Colunas e a troca é só estado local (sem requisição)', () => {
    const src = read('components', 'charts', 'TimeSeriesChart.tsx');
    expect(src).toContain('initialMode = DEFAULT_TIME_CHART_MODE');
    expect(src).toContain('useState<TimeChartMode>(initialMode)');
    expect(src).toContain('columns ? (');
    expect(src).not.toMatch(/initialMode\s*=\s*['"]columns['"]/);
    expect(src).not.toMatch(/\b(fetch|axios|api\.)\b/); // a troca nunca chama a API
  });

  it('nenhuma tela força Colunas ao abrir', () => {
    const page = read('app', 'dashboard', 'page.tsx');
    expect(page).not.toMatch(/initialMode\s*=/);
    expect(read('components', 'charts', 'RevenueTimeChart.tsx')).not.toMatch(/initialMode\s*=\s*['"]columns['"]/);
  });
});
