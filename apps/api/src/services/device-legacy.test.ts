import { legacyLoginVerdict, legacyCutoff, DEFAULT_LEGACY_CUTOFF, LEGACY_SET_CLOSED_AT } from './device-legacy';

describe('legado de equipamento sem chave (id/MAC): conjunto fechado + data de corte', () => {
  const before = new Date('2026-09-01T00:00:00Z'); // criado antes do enrolamento com chave
  const after = new Date('2026-10-08T00:00:00Z'); // criado pelo fluxo antigo depois da entrega
  const now = new Date('2026-11-01T00:00:00Z');

  it('equipamento do conjunto fechado, antes do corte: ALLOWED (compatibilidade de transição)', () => {
    expect(legacyLoginVerdict({ createdAt: before, now, env: {} as NodeJS.ProcessEnv })).toBe('ALLOWED');
  });

  it('equipamento criado depois do fechamento do conjunto: CLOSED_SET — o legado não cresce', () => {
    expect(legacyLoginVerdict({ createdAt: after, now, env: {} as NodeJS.ProcessEnv })).toBe('CLOSED_SET');
    expect(legacyLoginVerdict({ createdAt: LEGACY_SET_CLOSED_AT, now, env: {} as NodeJS.ProcessEnv })).toBe('CLOSED_SET');
  });

  it('depois da data de corte padrão (31/12/2026 em Brasília): CUTOFF — o legado não vale para sempre', () => {
    expect(legacyLoginVerdict({ createdAt: before, now: new Date('2026-12-31T23:59:58-03:00'), env: {} as NodeJS.ProcessEnv })).toBe('ALLOWED');
    expect(legacyLoginVerdict({ createdAt: before, now: new Date('2027-01-01T00:00:01-03:00'), env: {} as NodeJS.ProcessEnv })).toBe('CUTOFF');
  });

  it('DEVICE_LEGACY_CUTOFF antecipa o corte; valor inválido volta ao padrão (nunca desliga o corte)', () => {
    const env = { DEVICE_LEGACY_CUTOFF: '2026-10-15T00:00:00Z' } as unknown as NodeJS.ProcessEnv;
    expect(legacyCutoff(env).toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(legacyLoginVerdict({ createdAt: before, now, env })).toBe('CUTOFF');
    expect(legacyCutoff({ DEVICE_LEGACY_CUTOFF: 'lixo' } as unknown as NodeJS.ProcessEnv)).toEqual(DEFAULT_LEGACY_CUTOFF);
    expect(legacyCutoff({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_LEGACY_CUTOFF);
  });
});
