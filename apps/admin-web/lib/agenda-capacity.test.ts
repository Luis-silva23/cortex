jest.mock('@/lib/api', () => ({ api: { http: {} } }));

import { AGENDA_REFUSAL_LABEL, resourcesPayload, validateDuration } from './api/agenda';

// Capacidade da agenda na tela (docs/CORTEX/policies/AGENDA.md): a duração vazia é "padrão da filial" e não vai no
// corpo; mecânico vazio também não. A API revalida tudo.
describe('agenda — campos de capacidade', () => {
  it('duração: vazio aceito (padrão da filial); fora de 5..1440 ou fracionada recusada', () => {
    expect(validateDuration('')).toBeNull();
    expect(validateDuration('90')).toBeNull();
    expect(validateDuration('4')).toMatch(/5 a 1440/);
    expect(validateDuration('1441')).toMatch(/5 a 1440/);
    expect(validateDuration('30.5')).toMatch(/5 a 1440/);
  });

  it('payload só leva o que foi informado', () => {
    expect(resourcesPayload({ durationMinutes: '', mechanicId: '' })).toEqual({});
    expect(resourcesPayload({ durationMinutes: '90', mechanicId: 'mec-1' })).toEqual({ durationMinutes: 90, mechanicId: 'mec-1' });
  });

  it('todo código de recusa da API tem rótulo curto em português', () => {
    for (const code of ['OUTSIDE_BUSINESS_HOURS', 'SLOT_FULL', 'NO_BOX_AVAILABLE', 'DAY_FULL', 'MONTH_FULL', 'MECHANIC_CONFLICT', 'MECHANIC_UNAVAILABLE', 'AGENDA_UNAVAILABLE'] as const) {
      expect(AGENDA_REFUSAL_LABEL[code]).toMatch(/\S/);
    }
  });
});
