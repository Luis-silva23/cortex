import { bucketKeyOf, compareValues, periodBuckets, resolveDashboardPeriod, DASHBOARD_PERIOD_PRESETS, granularityFor } from './dashboard-period';

// Brasília é UTC-3 o ano todo (sem horário de verão desde 2019): 12:00 em Brasília = 15:00Z; 23:59 = 02:59Z do dia seguinte.
const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-04T18:30:00Z'); // 04/10/2026, 15:30 em Brasília

const days = (p: ReturnType<typeof resolveDashboardPeriod>) => [p.current.startDay, p.current.endDay, p.previous.startDay, p.previous.endDay];

describe('resolveDashboardPeriod — regra única de período (dias civis de Brasília)', () => {
  it('padrão = últimos 30 dias, e 30 dias são 30 dias civis (não 30 × 24 h)', () => {
    const p = resolveDashboardPeriod({}, NOW);
    expect(p.preset).toBe('30d');
    expect(days(p)).toEqual(['2026-09-05', '2026-10-04', '2026-08-06', '2026-09-04']);
    expect(p.current.days).toBe(30);
    expect(p.current.start.toISOString()).toBe('2026-09-05T03:00:00.000Z'); // meia-noite de Brasília, primeiro dia inteiro
    expect(p.current.end.toISOString()).toBe('2026-10-05T03:00:00.000Z');
    expect(p.current.end.getTime() - p.current.start.getTime()).toBe(30 * 24 * 3_600_000);
    expect(p.granularity).toBe('day');
  });

  it('hoje × ontem até o mesmo horário', () => {
    const p = resolveDashboardPeriod({ period: 'today' }, NOW);
    expect(days(p)).toEqual(['2026-10-04', '2026-10-04', '2026-10-03', '2026-10-03']);
    expect(p.current.start.toISOString()).toBe('2026-10-04T03:00:00.000Z');
    expect(p.previous.start.toISOString()).toBe('2026-10-03T03:00:00.000Z');
    expect(p.previous.end.toISOString()).toBe('2026-10-03T18:30:00.000Z'); // 15:30 de ontem
    expect(p.previousLabel).toBe('ontem até 15:30');
    expect(p.granularity).toBe('hour');
  });

  it('ontem × anteontem inteiro', () => {
    const p = resolveDashboardPeriod({ period: 'yesterday' }, NOW);
    expect(days(p)).toEqual(['2026-10-03', '2026-10-03', '2026-10-02', '2026-10-02']);
    expect(p.previous.end.toISOString()).toBe('2026-10-03T03:00:00.000Z');
  });

  it('7 dias × os 7 imediatamente anteriores', () => {
    const p = resolveDashboardPeriod({ period: '7d' }, NOW);
    expect(days(p)).toEqual(['2026-09-28', '2026-10-04', '2026-09-21', '2026-09-27']);
  });

  it('mês atual × os mesmos dias do mês anterior; mês anterior × o mês antes dele', () => {
    const m = resolveDashboardPeriod({ period: 'month' }, NOW);
    expect(days(m)).toEqual(['2026-10-01', '2026-10-04', '2026-09-01', '2026-09-04']);
    const pm = resolveDashboardPeriod({ period: 'prev_month' }, NOW);
    expect(days(pm)).toEqual(['2026-09-01', '2026-09-30', '2026-08-01', '2026-08-31']);
  });

  it('mês atual no dia 31 não invade o mês anterior mais curto (fevereiro de 2026 tem 28 dias)', () => {
    const p = resolveDashboardPeriod({ period: 'month' }, at('2026-03-31T15:00:00Z'));
    expect(days(p)).toEqual(['2026-03-01', '2026-03-31', '2026-02-01', '2026-02-28']);
  });

  it('ano = 1º de janeiro até hoje × os mesmos dias do ano anterior; granularidade mensal', () => {
    const p = resolveDashboardPeriod({ period: 'year' }, NOW);
    expect(days(p)).toEqual(['2026-01-01', '2026-10-04', '2025-01-01', '2025-10-04']);
    expect(p.granularity).toBe('month');
    expect(periodBuckets(p, NOW).map((b) => b.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  });

  it('personalizado 01/01/2026 → 31/12/2026 = o ano inteiro, × os 365 dias imediatamente anteriores', () => {
    const p = resolveDashboardPeriod({ period: 'custom', start: '2026-01-01', end: '2026-12-31' }, NOW);
    expect(days(p)).toEqual(['2026-01-01', '2026-12-31', '2025-01-01', '2025-12-31']);
    expect(p.current.days).toBe(365);
    expect(p.rangeLabel).toBe('01/01/2026 – 31/12/2026');
    expect(periodBuckets(p, NOW)).toHaveLength(12);
  });

  it('personalizado 01/03/2026 → 15/09/2026 × período anterior de mesma duração', () => {
    const p = resolveDashboardPeriod({ period: 'custom', start: '2026-03-01', end: '2026-09-15' }, NOW);
    expect(p.current.days).toBe(199);
    expect(p.previous.days).toBe(199);
    expect(p.previous.endDay).toBe('2026-02-28');
    expect(p.previous.start.getTime()).toBeLessThan(p.current.start.getTime());
    expect(p.previous.end.getTime()).toBe(p.current.start.getTime());
  });

  it('personalizado inválido: formato, ordem, ausência e teto de 366 dias', () => {
    expect(() => resolveDashboardPeriod({ period: 'custom', start: '01/01/2026', end: '2026-01-31' }, NOW)).toThrow(/Data inválida/);
    expect(() => resolveDashboardPeriod({ period: 'custom', start: '2026-02-30', end: '2026-03-31' }, NOW)).toThrow(/inexistente/);
    expect(() => resolveDashboardPeriod({ period: 'custom', start: '2026-02-01', end: '2026-01-31' }, NOW)).toThrow(/depois do fim/);
    expect(() => resolveDashboardPeriod({ period: 'custom', start: '2026-01-01' }, NOW)).toThrow(/início e o fim/);
    expect(() => resolveDashboardPeriod({ period: 'custom', start: '2025-01-01', end: '2026-12-31' }, NOW)).toThrow(/366 dias/);
    expect(() => resolveDashboardPeriod({ period: 'semana' }, NOW)).toThrow(/Período inválido/);
  });

  it('o nome dos recortes é fechado e inclui os oito pedidos', () => {
    expect([...DASHBOARD_PERIOD_PRESETS]).toEqual(['today', 'yesterday', '7d', '30d', 'month', 'prev_month', 'year', 'custom']);
  });
});

describe('virada de dia, de mês e de ano em Brasília', () => {
  it('23:59 de Brasília ainda é hoje; 00:00 abre o dia seguinte', () => {
    const before = resolveDashboardPeriod({ period: 'today' }, at('2026-10-05T02:59:59Z')); // 23:59:59 de 04/10
    const after = resolveDashboardPeriod({ period: 'today' }, at('2026-10-05T03:00:00Z')); // 00:00 de 05/10
    expect(before.current.startDay).toBe('2026-10-04');
    expect(after.current.startDay).toBe('2026-10-05');
    expect(after.previous.end.toISOString()).toBe('2026-10-04T03:00:00.000Z'); // 00:00 de ontem: nada ainda a comparar
  });

  it('virada de mês: 31/10 23:59 é outubro inteiro; 01/11 00:00 é o primeiro dia de novembro × 1º de outubro', () => {
    const oct = resolveDashboardPeriod({ period: 'month' }, at('2026-11-01T02:59:59Z'));
    expect(days(oct)).toEqual(['2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30']);
    const nov = resolveDashboardPeriod({ period: 'month' }, at('2026-11-01T03:00:00Z'));
    expect(days(nov)).toEqual(['2026-11-01', '2026-11-01', '2026-10-01', '2026-10-01']);
    expect(resolveDashboardPeriod({ period: 'prev_month' }, at('2026-11-01T03:00:00Z')).current.startDay).toBe('2026-10-01');
  });

  it('virada de ano: 31/12 23:59 ainda é 2026; 01/01 00:00 abre 2027 (e janeiro de 2027 olha para dezembro de 2026)', () => {
    const last = resolveDashboardPeriod({ period: 'year' }, at('2027-01-01T02:59:59Z'));
    expect(days(last)).toEqual(['2026-01-01', '2026-12-31', '2025-01-01', '2025-12-31']);
    const first = resolveDashboardPeriod({ period: 'year' }, at('2027-01-01T03:00:00Z'));
    expect(days(first)).toEqual(['2027-01-01', '2027-01-01', '2026-01-01', '2026-01-01']);
    const prevMonth = resolveDashboardPeriod({ period: 'prev_month' }, at('2027-01-01T03:00:00Z'));
    expect(days(prevMonth)).toEqual(['2026-12-01', '2026-12-31', '2026-11-01', '2026-11-30']);
  });

  it('ano bissexto: 29/02 existe e o ano seguinte compara só os dias que ele tem', () => {
    const p = resolveDashboardPeriod({ period: 'year' }, at('2028-12-31T15:00:00Z'));
    expect(p.current.days).toBe(366);
    expect(days(p)).toEqual(['2028-01-01', '2028-12-31', '2027-01-01', '2027-12-31']);
  });

  it('baldes e agrupamento de um instante seguem o calendário de Brasília', () => {
    expect(bucketKeyOf(at('2026-10-05T02:59:59Z'), 'day')).toBe('2026-10-04');
    expect(bucketKeyOf(at('2026-10-05T03:00:00Z'), 'day')).toBe('2026-10-05');
    expect(bucketKeyOf(at('2026-11-01T02:59:59Z'), 'month')).toBe('2026-10');
    expect(bucketKeyOf(at('2027-01-01T02:59:59Z'), 'month')).toBe('2026-12');
    expect(bucketKeyOf(at('2026-10-04T02:59:59Z'), 'hour')).toBe('2026-10-03T23');
    expect(bucketKeyOf(at('2026-10-04T03:00:00Z'), 'hour')).toBe('2026-10-04T00');
  });

  it('hoje por hora: do 00h até a hora atual (hora futura não é zero)', () => {
    const p = resolveDashboardPeriod({ period: 'today' }, NOW);
    const buckets = periodBuckets(p, NOW);
    expect(buckets).toHaveLength(16); // 00h..15h
    expect(buckets[0].key).toBe('2026-10-04T00');
    expect(buckets[15].key).toBe('2026-10-04T15');
    expect(buckets[0].t.toISOString()).toBe('2026-10-04T03:00:00.000Z');
    const y = resolveDashboardPeriod({ period: 'yesterday' }, NOW);
    expect(periodBuckets(y, NOW)).toHaveLength(24);
  });

  it('30 dias têm 30 baldes diários, do primeiro ao último dia', () => {
    const b = periodBuckets(resolveDashboardPeriod({ period: '30d' }, NOW), NOW);
    expect(b).toHaveLength(30);
    expect(b[0].key).toBe('2026-09-05');
    expect(b[29].key).toBe('2026-10-04');
  });

  it('granularidade: 1 dia = hora; até 62 dias = dia; acima = mês', () => {
    expect([granularityFor(1), granularityFor(2), granularityFor(62), granularityFor(63), granularityFor(366)]).toEqual(['hour', 'day', 'day', 'month', 'month']);
  });
});

describe('compareValues — atual, anterior, diferença e percentual', () => {
  it('calcula diferença e variação', () => {
    expect(compareValues(91500, 82000)).toEqual({ current: 91500, previous: 82000, diff: 9500, percent: (9500 / 82000) * 100 });
    expect(compareValues(40, 100).percent).toBe(-60);
  });
  it('anterior zero: sem percentual inválido (null), e zero × zero = 0%', () => {
    expect(compareValues(10, 0).percent).toBeNull();
    expect(compareValues(0, 0).percent).toBe(0);
    expect(compareValues(0, 50).percent).toBe(-100);
  });
});
