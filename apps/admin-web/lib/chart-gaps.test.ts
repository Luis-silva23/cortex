import { breakAtGaps, isEmptyPoint } from './chart-gaps';
import { dayToTime } from './chart-format';

const DAY = 86_400_000;

describe('breakAtGaps — sem dado interrompe a linha (decisão 59)', () => {
  it('receita do painel: 21/09, 25/09, 27/09 e 28/09 → a linha quebra depois de 21/09 e de 25/09, mas liga 27→28', () => {
    const pts = ['2026-09-21', '2026-09-25', '2026-09-27', '2026-09-28'].map((d, i) => ({ t: dayToTime(d), total: [20, 20, 160, 40][i] }));
    const out = breakAtGaps(pts, DAY);
    expect(out.map((p) => [p.t, p.total ?? null])).toEqual([
      [dayToTime('2026-09-21'), 20],
      [dayToTime('2026-09-22'), null], // dia seguinte ao último ponto antes da lacuna: sem valor
      [dayToTime('2026-09-25'), 20],
      [dayToTime('2026-09-26'), null],
      [dayToTime('2026-09-27'), 160],
      [dayToTime('2026-09-28'), 40],
    ]);
  });

  it('nunca inventa valor: os pontos reais saem iguais e os inseridos não têm nenhuma série', () => {
    const pts = [{ t: 0, a: 1, b: 2 }, { t: 10 * DAY, a: 3, b: null }];
    const out = breakAtGaps(pts, DAY);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(pts[0]);
    expect(out[2]).toBe(pts[1]);
    expect(Object.keys(out[1])).toEqual(['t']);
    expect(isEmptyPoint(out[1], ['a', 'b'])).toBe(true);
    expect(isEmptyPoint(out[0], ['a', 'b'])).toBe(false);
  });

  it('pontos em intervalos consecutivos (inclusive com folga de hora) não quebram', () => {
    const hourly = [0, 1, 2, 3].map((h) => ({ t: h * 3_600_000, v: h }));
    expect(breakAtGaps(hourly, 3_600_000)).toHaveLength(4);
    const dst = [{ t: 0, v: 1 }, { t: DAY + 3_600_000, v: 2 }]; // dia de 25 h
    expect(breakAtGaps(dst, DAY)).toHaveLength(2);
  });

  it('um intervalo vazio já quebra (2 intervalos entre pontos)', () => {
    expect(breakAtGaps([{ t: 0, v: 1 }, { t: 2 * DAY, v: 2 }], DAY)).toHaveLength(3);
  });

  it('um único ponto fica como está, e sem intervalo válido nada muda (só ordena)', () => {
    expect(breakAtGaps([{ t: 5, v: 1 }], DAY)).toEqual([{ t: 5, v: 1 }]);
    const pts = [{ t: 10 * DAY, v: 2 }, { t: 0, v: 1 }];
    expect(breakAtGaps(pts, undefined).map((p) => p.t)).toEqual([0, 10 * DAY]);
    expect(breakAtGaps(pts, 0)).toHaveLength(2);
    expect(breakAtGaps(pts, Number.NaN)).toHaveLength(2);
  });

  it('não altera o vetor de entrada', () => {
    const pts = [{ t: 10 * DAY, v: 2 }, { t: 0, v: 1 }];
    breakAtGaps(pts, DAY);
    expect(pts.map((p) => p.t)).toEqual([10 * DAY, 0]);
  });
});
