// GUARDA DE DESIGN 3/5 — KPI neutro. Regra oficial CÓRTEX: "número de KPI NUNCA verde/vermelho (variação em
// seta/indicador)"; verde/amarelo/vermelho existem só para status/indicadores (globals.css, tailwind.config.js).
//
// Como identificamos o elemento de VALOR do KPI (ver design-guard.ts, findKpiViolations):
//   (a) elemento JSX com `text-2xl` ou maior cujos filhos diretos têm expressão numérica
//       ({value}, {formatCurrency(..)}, {x.total}, {String(..)}, .toFixed(), .length...);
//   (b) `text-lg|xl` + `font-semibold|bold` + expressão numérica;
//   (c) qualquer expressão numérica dentro de componente Kpi*/Stat*/Metric*/Indicator* (KpiCard, FinancialStat).
// O texto de classe é resolvido também via variáveis locais (`${toneClass}`, `tons[tom]`).
// Seta/ícone/ponto de variação e status NÃO são o número: podem usar success/warning/danger.
// Também proíbe ícone de KPI colorido por prop (iconColor="text-green-600"): decoração com cor semântica.
//
// Roda sem navegador: `cd apps/admin-web && npx jest lib/design-kpi`.

import {
  findKpiViolations,
  formatViolations,
  listUiSources,
  readText,
  Violation,
} from './design-guard';

const cls = (...parts: string[]) => parts.join('-');
const RED = cls('text', 'red', '600');
const GREEN = cls('text', 'green', '600');
const AMBER = cls('text', 'amber', '600');

describe('auditor de KPI detecta o que promete (exemplos sintéticos)', () => {
  it('valor de KPI grande com cor semântica direta', () => {
    const src = `export const P = ({ v }) => <p className="text-2xl font-bold ${RED}">{formatCurrency(v)}</p>;`;
    expect(findKpiViolations(src, 'x.tsx')).toHaveLength(1);
  });

  it('valor de KPI colorido por condicional (caso real do saldo de caixa negativo em vermelho)', () => {
    const src = 'export const P = ({ s }) => <p className={`text-2xl font-bold ${s < 0 ? \'' + RED + '\' : \'text-foreground\'}`}>{formatCurrency(s.net)}</p>;';
    expect(findKpiViolations(src, 'x.tsx')).toHaveLength(1);
  });

  it('cor vinda de variável local (toneClass) dentro de componente *Stat*', () => {
    const src = `
      function FinancialStat({ value, tone }) {
        const toneClass = tone === 'red' ? '${RED}' : '${AMBER}';
        return <p className={\`text-lg font-semibold \${toneClass}\`}>{formatCurrency(value)}</p>;
      }`;
    expect(findKpiViolations(src, 'x.tsx')).toHaveLength(1);
  });

  it('token semântico (text-success / text-danger) também não vale para o número', () => {
    const src = `export const P = ({ v }) => <div className="text-3xl font-bold text-danger">{v.total}</div>;`;
    expect(findKpiViolations(src, 'x.tsx')).toHaveLength(1);
  });

  it('ícone de KPI colorido por prop', () => {
    const src = `export const P = () => <KpiCard title="Receita" icon={D} iconColor="${GREEN}" value="1" />;`;
    expect(findKpiViolations(src, 'x.tsx')).toHaveLength(1);
    const blue = `export const P = () => <KpiCard iconColor="${cls('text', 'blue', '600')}" />;`;
    expect(findKpiViolations(blue, 'x.tsx')).toHaveLength(1);
  });

  it('NÃO dispara: número neutro, seta de variação colorida, título colorido sem número, ícone neutro', () => {
    const neutral = `export const P = ({ v }) => <div className="text-2xl font-bold text-foreground">{formatCurrency(v)}</div>;`;
    expect(findKpiViolations(neutral, 'x.tsx')).toHaveLength(0);

    const arrow = `export const P = ({ up }) => <span className="inline-flex text-xs">{up ? <TrendingUp className="h-3 w-3 ${GREEN}" /> : <TrendingDown className="h-3 w-3 ${RED}" />}</span>;`;
    expect(findKpiViolations(arrow, 'x.tsx')).toHaveLength(0);

    const dot = `export const P = () => <span className="h-2 w-2 rounded-full ${cls('bg', 'red', '600')}" />;`;
    expect(findKpiViolations(dot, 'x.tsx')).toHaveLength(0);

    const title = `export const P = () => <h1 className="text-3xl font-bold ${RED}">Falha crítica</h1>;`;
    expect(findKpiViolations(title, 'x.tsx')).toHaveLength(0);

    const icon = `export const P = () => <KpiCard iconColor="text-muted-foreground" />;`;
    expect(findKpiViolations(icon, 'x.tsx')).toHaveLength(0);
  });
});

describe('varredura real: nenhum valor/ícone de KPI colorido em app/** e components/**', () => {
  const files = listUiSources();

  it('a varredura encontra o dashboard e o KpiCard (não está vazia)', () => {
    const dash = files.find((f) => f.replace(/\\/g, '/').endsWith('app/dashboard/page.tsx'));
    expect(dash).toBeDefined();
    expect(readText(dash!)).toContain('function KpiCard');
  });

  it('valores de KPI usam a cor neutra (text-foreground); estado/variação vão em seta, ponto ou ícone', () => {
    const violations: Violation[] = files.flatMap((f) => findKpiViolations(readText(f), f));
    if (violations.length) {
      throw new Error(
        `KPI colorido (regra CÓRTEX: número neutro; verde/vermelho/amarelo só em indicador de estado):\n${formatViolations(violations)}`
      );
    }
  });
});
