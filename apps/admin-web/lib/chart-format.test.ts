import { dayLabel, dayLabelLong, dayToTime, formatBRLCompact, timeToDay } from './chart-format';

describe('escala de tempo do eixo', () => {
  it('vai e volta sem deslocar o dia, qualquer que seja o fuso da máquina', () => {
    for (const d of ['2026-09-04', '2026-10-01', '2026-12-31', '2026-03-01']) expect(timeToDay(dayToTime(d))).toBe(d);
  });
  it('dias reais ficam separados pela distância real (4, 2 e 1 dia), não equidistantes', () => {
    const [a, b, c, d] = ['2026-09-21', '2026-09-25', '2026-09-27', '2026-09-28'].map(dayToTime);
    expect([(b - a) / 86400000, (c - b) / 86400000, (d - c) / 86400000]).toEqual([4, 2, 1]);
  });
  it('texto inválido vira NaN e rótulo vazio', () => {
    expect(Number.isNaN(dayToTime('ontem'))).toBe(true);
    expect(timeToDay(Number.NaN)).toBe('');
  });
});

describe('rótulos de dia dos gráficos', () => {
  it('não desloca o dia pelo fuso (a data é rótulo, não instante)', () => {
    expect(dayLabel('2026-09-04')).toBe('04/09');
    expect(dayLabelLong('2026-09-04')).toBe('04/09/2026');
    expect(dayLabel('2026-10-01T00:00:00.000Z')).toBe('01/10');
  });
  it('texto fora do formato volta como veio', () => {
    expect(dayLabel('ontem')).toBe('ontem');
    expect(dayLabelLong('')).toBe('');
  });
});

describe('formatBRLCompact', () => {
  it('abrevia valores grandes em reais', () => {
    expect(formatBRLCompact(80000)).toMatch(/^R\$\s?80\s?mil$/);
    expect(formatBRLCompact(1500000)).toMatch(/^R\$\s?1,5\s?mi/);
  });
  it('zero e valor inválido viram R$ 0', () => {
    expect(formatBRLCompact(0)).toMatch(/^R\$\s?0$/);
    expect(formatBRLCompact(Number.NaN)).toMatch(/^R\$\s?0$/);
  });
});
