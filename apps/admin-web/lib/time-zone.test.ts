import { APP_TIME_ZONE, startOfLocalDay, startOfLocalMonth } from './time-zone';

// Mesmo critério da API (apps/api/src/utils/time-zone.ts): o dia do painel é o dia de Brasília, UTC−3.
describe('início de "Hoje" e do mês no fuso de Brasília', () => {
  it('usa America/Sao_Paulo', () => {
    expect(APP_TIME_ZONE).toBe('America/Sao_Paulo');
  });

  it('às 22h30 de 04/10 em Brasília (01h30 UTC de 05/10) "Hoje" ainda começa à meia-noite de 04/10', () => {
    expect(startOfLocalDay(new Date('2026-10-05T01:30:00Z')).toISOString()).toBe('2026-10-04T03:00:00.000Z');
  });

  it('um segundo antes e na meia-noite de Brasília', () => {
    expect(startOfLocalDay(new Date('2026-10-05T02:59:59Z')).toISOString()).toBe('2026-10-04T03:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-10-05T03:00:00Z')).toISOString()).toBe('2026-10-05T03:00:00.000Z');
  });

  it('o mês começa à meia-noite de Brasília do dia 1, mesmo quando em UTC já é o mês seguinte', () => {
    expect(startOfLocalMonth(new Date('2026-11-01T01:30:00Z')).toISOString()).toBe('2026-10-01T03:00:00.000Z'); // ainda 31/10 22:30
    expect(startOfLocalMonth(new Date('2026-10-15T12:00:00Z')).toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });
});
