import { APP_TIME_ZONE, localDayKey, startOfLocalDay, startOfNextLocalDay } from './time-zone';

/**
 * DECISÃO 58: o dia do painel é o dia de Brasília (UTC−3, sem horário de verão desde 2019). Os casos da virada do dia
 * são os que o agrupamento em UTC errava: venda das 21h30 de 04/10 em Brasília é 00h30 de 05/10 em UTC.
 */
describe('localDayKey — dia de Brasília', () => {
  it('usa America/Sao_Paulo como fuso do produto', () => {
    expect(APP_TIME_ZONE).toBe('America/Sao_Paulo');
  });

  it('venda depois das 21h de Brasília fica no MESMO dia local (UTC já virou o dia)', () => {
    expect(localDayKey(new Date('2026-10-05T00:30:00Z'))).toBe('2026-10-04'); // 21:30 de 04/10 em Brasília
    expect(new Date('2026-10-05T00:30:00Z').toISOString().slice(0, 10)).toBe('2026-10-05'); // o que o UTC dizia (errado)
  });

  it('venda um segundo antes da meia-noite de Brasília fica no dia que termina', () => {
    expect(localDayKey(new Date('2026-10-05T02:59:59Z'))).toBe('2026-10-04'); // 23:59:59
  });

  it('venda na meia-noite de Brasília abre o dia seguinte', () => {
    expect(localDayKey(new Date('2026-10-05T03:00:00Z'))).toBe('2026-10-05'); // 00:00:00
  });

  it('venda do meio do dia fica no próprio dia', () => {
    expect(localDayKey(new Date('2026-10-04T15:00:00Z'))).toBe('2026-10-04'); // 12:00
    expect(localDayKey(new Date('2026-10-04T03:00:00Z'))).toBe('2026-10-04'); // 00:00 exato
    expect(localDayKey(new Date('2026-10-04T02:59:59Z'))).toBe('2026-10-03'); // 23:59:59 do dia anterior
  });

  it('virada de mês e de ano', () => {
    expect(localDayKey(new Date('2026-11-01T01:30:00Z'))).toBe('2026-10-31'); // 22:30 de 31/10
    expect(localDayKey(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-31'); // 23:00 de 31/12
  });
});

describe('início e fim do dia local ("hoje" do PDV)', () => {
  it('"hoje" começa à meia-noite de Brasília (03:00 UTC), não às 21h de ontem', () => {
    const now = new Date('2026-10-05T01:30:00Z'); // 22:30 de 04/10 em Brasília
    expect(startOfLocalDay(now).toISOString()).toBe('2026-10-04T03:00:00.000Z');
    expect(startOfNextLocalDay(now).toISOString()).toBe('2026-10-05T03:00:00.000Z');
  });

  it('cobre exatamente 24 horas num dia sem troca de horário', () => {
    const now = new Date('2026-10-04T15:00:00Z');
    expect(startOfNextLocalDay(now).getTime() - startOfLocalDay(now).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('a conta também vale com troca de horário (outro fuso): o dia de 8/3/2026 em Nova York tem 23 h', () => {
    const now = new Date('2026-03-08T12:00:00Z');
    expect(startOfLocalDay(now, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z'); // EST (UTC−5)
    expect(startOfNextLocalDay(now, 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z'); // já EDT (UTC−4)
  });
});
