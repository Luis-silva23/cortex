import fs from 'fs';
import path from 'path';

// Padrão ÚNICO de gráficos entre Admin Web e Super Admin. Cada app tem seu próprio design system (tokens), mas o gráfico temporal, a
// dica, a alternância e o modo padrão são o MESMO arquivo nos dois: estas guardas falham se uma cópia mudar sem a outra, ou se alguém
// voltar a escrever um gráfico temporal avulso (linha suavizada, grade tracejada, dica padrão da biblioteca).
const ADMIN = path.resolve(__dirname, '..');
const SUPER = path.resolve(__dirname, '..', '..', 'super-admin');
const norm = (s: string) => s.replace(/\r\n/g, '\n');
const read = (root: string, ...p: string[]) => norm(fs.readFileSync(path.join(root, ...p), 'utf8'));

const SHARED = [
  ['components', 'charts', 'TimeSeriesChart.tsx'],
  ['components', 'charts', 'ChartTooltip.tsx'],
  ['components', 'charts', 'ChartModeToggle.tsx'],
  ['lib', 'chart-mode.ts'],
  ['lib', 'chart-gaps.ts'],
];

describe('os dois apps usam o mesmo gráfico temporal', () => {
  it.each(SHARED)('%s/%s/%s é idêntico nos dois apps', (...p) => {
    expect(read(SUPER, ...p)).toBe(read(ADMIN, ...p));
  });

  it('o Super Admin tem os tokens de gráfico que o componente compartilhado importa', () => {
    const theme = read(SUPER, 'lib', 'chart-theme.ts');
    for (const name of ['CHART_AXIS', 'CHART_CURSOR', 'CHART_GRID', 'CHART_PRIMARY', 'CHART_SURFACE']) expect(theme).toContain(`export const ${name}`);
  });

  it('os gráficos temporais do Super Admin passam pelo componente único (nada de LineChart avulso)', () => {
    const branch = read(SUPER, 'app', 'dashboard', 'companies', '[id]', 'branches', '[branchId]', 'page.tsx');
    const perf = read(SUPER, 'app', 'dashboard', 'observability', 'performance', 'page.tsx');
    expect(branch).toContain('TimeSeriesChart');
    expect(perf).toContain('TimeSeriesChart');
    expect(branch).not.toContain('<LineChart');
    expect(perf).not.toContain('<LineChart');
  });

  // Decisão 59: sem dado, a linha interrompe (nunca liga pontos separados por intervalos vazios) e cada tela diz o intervalo da série.
  it('a linha interrompe onde não há dado e todo gráfico temporal informa o intervalo da série', () => {
    const chart = read(ADMIN, 'components', 'charts', 'TimeSeriesChart.tsx');
    expect(chart).toContain('breakAtGaps(data, stepMs)');
    expect(chart).toContain('connectNulls={false}');
    expect(read(ADMIN, 'components', 'charts', 'RevenueTimeChart.tsx')).toContain('stepMs={86_400_000}');
    const branch = read(SUPER, 'app', 'dashboard', 'companies', '[id]', 'branches', '[branchId]', 'page.tsx');
    expect(branch).toContain('stepMs={stepMs}');
    expect(branch).toContain('bucketSec');
    expect(read(SUPER, 'app', 'dashboard', 'observability', 'performance', 'page.tsx')).toContain('stepMs={bucketUnit');
  });

  it('Admin Web: biblioteca de gráfico só dentro de components/charts', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === 'node_modules' || e.name === '.next') return [];
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
      });
    const offenders = [...walk(path.join(ADMIN, 'app')), ...walk(path.join(ADMIN, 'components')), ...walk(path.join(ADMIN, 'lib'))]
      .filter((f) => !f.includes(`${path.sep}components${path.sep}charts${path.sep}`) && !f.endsWith('.test.ts'))
      .filter((f) => /from ['"]recharts['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
