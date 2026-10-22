jest.mock('@ln-system/database', () => ({ prisma: {}, runWithRLSContext: (_c: unknown, fn: () => unknown) => fn(), runInTransaction: jest.fn() }));
jest.mock('../cache.service', () => ({ __esModule: true, default: { remember: (_k: string, _t: number, fn: () => unknown) => fn() } }));

import { alertMatchesService, alertScope, describeService, httpClasses, serviceState } from './infrastructure.service';

const now = new Date('2026-10-22T15:00:00Z');

describe('infraestrutura: classificação', () => {
  it('técnico = plataforma medida pela Central ou pelo monitor externo; empresa/filial/equipamento = operacional', () => {
    expect(alertScope({ companyId: null, source: 'CENTRAL' })).toBe('technical');
    expect(alertScope({ companyId: null, source: 'EXTERNAL' })).toBe('technical');
    expect(alertScope({ companyId: 'c1', source: 'COMPANY' })).toBe('operational');
    expect(alertScope({ companyId: 'c1', source: 'BRANCH' })).toBe('operational');
    expect(alertScope({ companyId: 'c1', source: 'CENTRAL' })).toBe('operational');
    expect(alertScope({ companyId: null, source: 'DEVICE' })).toBe('operational');
  });

  it('o filtro de serviço casa o alerta pela categoria (internos) ou pelo alvo (externos), sem confundir alvos parecidos', () => {
    expect(alertMatchesService('DATABASE_LATENCY', 'DATABASE')).toBe(true);
    expect(alertMatchesService('SERVER_CPU', 'HOST_CPU')).toBe(true);
    expect(alertMatchesService('REDIS_DOWN', 'DATABASE')).toBe(false);
    expect(alertMatchesService('EXTERNAL_API_DOWN', 'EXT_API')).toBe(true);
    expect(alertMatchesService('EXTERNAL_API_GATEWAY_DOWN', 'EXT_API')).toBe(false);
    expect(alertMatchesService('EXTERNAL_API_SLOW', 'EXT_API')).toBe(true);
  });

  it('descreve só o que é monitorado; alvo externo é identificado como medido de fora', () => {
    expect(describeService('DATABASE')).toMatchObject({ kind: 'dependency', external: false });
    expect(describeService('HOST_CPU').kind).toBe('capacity');
    expect(describeService('EXT_MINHA_API')).toMatchObject({ kind: 'external', external: true });
    expect(describeService('EXT_MINHA_API').label).toContain('medido de fora');
  });
});

describe('infraestrutura: estado do serviço', () => {
  const fiveMin = 5 * 60_000;
  it('sem amostra: SEM DADO (nunca "normal")', () => {
    expect(serviceState({ lastStatus: null, lastAt: null, now, intervalMs: fiveMin })).toBe('NO_DATA');
  });
  it('amostra velha demais (coletor parado) não afirma saúde', () => {
    expect(serviceState({ lastStatus: 'NORMAL', lastAt: new Date(now.getTime() - 60 * 60_000), now, intervalMs: fiveMin })).toBe('NO_DATA');
  });
  it('amostra recente traz o estado dela', () => {
    expect(serviceState({ lastStatus: 'CRITICAL', lastAt: new Date(now.getTime() - 60_000), now, intervalMs: fiveMin })).toBe('CRITICAL');
    expect(serviceState({ lastStatus: 'NORMAL', lastAt: new Date(now.getTime() - 60_000), now, intervalMs: fiveMin })).toBe('NORMAL');
  });
  it('estado desconhecido vira SEM DADO', () => {
    expect(serviceState({ lastStatus: 'WHATEVER', lastAt: new Date(now.getTime() - 60_000), now, intervalMs: fiveMin })).toBe('NO_DATA');
  });
});

describe('infraestrutura: códigos HTTP', () => {
  it('agrupa por classe e não perde códigos fora do padrão', () => {
    expect(httpClasses([{ code: 200, count: 10 }, { code: 204, count: 2 }, { code: 301, count: 1 }, { code: 404, count: 4 }, { code: 500, count: 3 }, { code: 503, count: 1 }, { code: 99, count: 1 }])).toEqual({ '2xx': 12, '3xx': 1, '4xx': 4, '5xx': 4, other: 1 });
  });
});
