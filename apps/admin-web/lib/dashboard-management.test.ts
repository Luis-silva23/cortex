import fs from 'fs';
import path from 'path';
import {
  DASHBOARD_PERIOD_LABELS,
  DASHBOARD_PERIOD_PRESETS,
  DEFAULT_DASHBOARD_PERIOD,
  count,
  isCustomRangeValid,
  money,
  percentText,
  periodParams,
  signedCount,
  signedMoney,
  timeFormatters,
} from './dashboard-management';

const ADMIN = path.resolve(__dirname, '..');
const API_PERIOD = path.resolve(ADMIN, '..', 'api', 'src', 'utils', 'dashboard-period.ts');
const read = (...p: string[]) => fs.readFileSync(path.join(ADMIN, ...p), 'utf8').replace(/\r\n/g, '\n');
const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('regra única de período: o front só envia o nome do recorte', () => {
  it('os recortes e os nomes são os mesmos da API (fonte única: apps/api/src/utils/dashboard-period.ts)', () => {
    const api = fs.readFileSync(API_PERIOD, 'utf8').replace(/\r\n/g, '\n');
    const presets = /DASHBOARD_PERIOD_PRESETS = \[([^\]]+)\] as const/.exec(api)![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect([...DASHBOARD_PERIOD_PRESETS]).toEqual(presets);
    expect(/DEFAULT_DASHBOARD_PERIOD: DashboardPeriodPreset = '(\w+)'/.exec(api)![1]).toBe(DEFAULT_DASHBOARD_PERIOD);
    expect(DEFAULT_DASHBOARD_PERIOD).toBe('30d');
    for (const p of DASHBOARD_PERIOD_PRESETS) expect(api).toContain(`'${DASHBOARD_PERIOD_LABELS[p]}'`);
  });

  it('as oito opções pedidas existem: hoje, ontem, 7 e 30 dias, mês atual e anterior, ano e personalizado', () => {
    expect(Object.values(DASHBOARD_PERIOD_LABELS)).toEqual(['Hoje', 'Ontem', 'Últimos 7 dias', 'Últimos 30 dias', 'Mês atual', 'Mês anterior', 'Ano', 'Período personalizado']);
  });

  it('todas as chamadas levam o MESMO período (periodParams); personalizado só com as duas datas', () => {
    expect(periodParams({ preset: '7d' })).toEqual({ period: '7d' });
    expect(periodParams({ preset: 'custom', start: '2026-01-01', end: '2026-12-31' })).toEqual({ period: 'custom', start: '2026-01-01', end: '2026-12-31' });
    expect(periodParams({ preset: 'custom' })).toEqual({ period: '30d' }); // incompleto: volta ao padrão, nunca meia janela
  });

  it('o intervalo personalizado precisa de datas completas e início não depois do fim (o teto de dias é da API)', () => {
    expect(isCustomRangeValid('2026-01-01', '2026-12-31')).toBe(true);
    expect(isCustomRangeValid('2026-01-01', '2026-01-01')).toBe(true);
    expect(isCustomRangeValid('2026-02-01', '2026-01-31')).toBe(false);
    expect(isCustomRangeValid('', '2026-01-31')).toBe(false);
    expect(isCustomRangeValid('01/01/2026', '2026-01-31')).toBe(false);
  });

  it('nenhum componente do painel faz conta de data nem monta janela própria: tudo passa por periodParams', () => {
    const files = ['ManagementDashboard.tsx', 'ManagementKpis.tsx', 'ManagementCharts.tsx', 'PaymentMethodsPanel.tsx', 'PeriodPicker.tsx'].map((f) => [f, read('components', 'dashboard', f)] as const);
    const forbidden = /\.setDate\(|\.getDate\(|\.getMonth\(|\.getFullYear\(|\.setMonth\(|\b86_?400_?000\b|24 \* 60 \* 60|startOfLocal|new Date\(\)/;
    for (const [name, src] of files) expect({ name, hit: forbidden.exec(src)?.[0] ?? null }).toEqual({ name, hit: null });
    const dash = files.find(([n]) => n === 'ManagementDashboard.tsx')![1];
    expect(dash).toContain('getManagementSummary(params)');
    expect(dash).toContain('getManagementTimeseries(params)');
    // contas vencidas e OS vêm no resumo: sem chamadas extras ao financeiro e à oficina na abertura
    expect(dash).not.toMatch(/getFinancialDashboard|getWorkshopDashboard|getCeoDashboard|getSalesDashboard/);
    expect(dash).not.toMatch(/startDate|endDate/);
  });

  it('a troca Linha ↔ Colunas e de métrica não chama a API (estado local)', () => {
    const charts = read('components', 'dashboard', 'ManagementCharts.tsx');
    expect(charts).toContain('useState<Metric>');
    expect(charts).not.toMatch(/\bapi\./);
    expect(charts).not.toMatch(/\bfetch\(/);
  });
});

describe('formatação (valores reais, sem inventar)', () => {
  it('dinheiro, quantidade e variação em pt-BR; nulo vira traço', () => {
    expect(nbsp(money(91500))).toBe('R$ 91.500,00');
    expect(money(null)).toBe('—');
    expect(count(1234)).toBe('1.234');
    expect(percentText(11.5897, true)).toBe('+11,59%');
    expect(percentText(-3, true)).toBe('−3,00%');
    expect(percentText(null)).toBe('—');
    expect(nbsp(signedMoney(9500))).toBe('+R$ 9.500,00');
    expect(nbsp(signedMoney(-12.5))).toBe('−R$ 12,50');
    expect(signedCount(0)).toBe('0');
  });

  it('eixo e dica no relógio de Brasília: 23:59 ainda é o dia anterior; meia-noite abre o dia', () => {
    const day = timeFormatters('day');
    expect(day.tick(Date.parse('2026-10-05T02:59:59Z'))).toBe('04/10'); // 04/10 23:59:59 em Brasília
    expect(day.tick(Date.parse('2026-10-05T03:00:00Z'))).toBe('05/10');
    expect(day.label(Date.parse('2026-10-05T02:59:59Z'))).toBe('04/10/2026');
    const hour = timeFormatters('hour');
    expect(hour.tick(Date.parse('2026-10-05T12:00:00Z'))).toBe('09h');
    expect(nbsp(hour.label(Date.parse('2026-10-05T12:00:00Z')))).toContain('05/10/2026');
    const month = timeFormatters('month');
    expect(month.label(Date.parse('2027-01-01T02:59:59Z')).toLowerCase()).toContain('dezembro');
    expect(month.label(Date.parse('2027-01-01T03:00:00Z')).toLowerCase()).toContain('janeiro');
  });
});
