import { THRESHOLDS, devicesStatus, level, worst } from './health-status';

describe('estados de saúde', () => {
  it('limites por métrica', () => {
    expect(level(500, THRESHOLDS.apiP95Ms)).toBe('NORMAL');
    expect(level(800, THRESHOLDS.apiP95Ms)).toBe('ATTENTION');
    expect(level(2500, THRESHOLDS.apiP95Ms)).toBe('CRITICAL');
    expect(level(90, THRESHOLDS.diskPct)).toBe('ATTENTION');
    expect(level(null, THRESHOLDS.cpuPct)).toBe('NO_DATA');
  });

  it('pior estado; sem dado não vira normal', () => {
    expect(worst('NORMAL', 'ATTENTION', 'NO_DATA')).toBe('ATTENTION');
    expect(worst('NO_DATA', 'NO_DATA')).toBe('NO_DATA');
    expect(worst('CRITICAL', 'OFFLINE')).toBe('OFFLINE');
  });

  it('equipamentos: 8/8 normal, 5/8 atenção, 2/8 crítico, 0/6 offline, sem equipamento sem dado', () => {
    expect(devicesStatus(8, 8)).toBe('NORMAL');
    expect(devicesStatus(5, 8)).toBe('ATTENTION');
    expect(devicesStatus(2, 8)).toBe('CRITICAL');
    expect(devicesStatus(0, 6)).toBe('OFFLINE');
    expect(devicesStatus(0, 0)).toBe('NO_DATA');
  });
});
