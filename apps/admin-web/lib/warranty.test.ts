import { buildWarrantyDecision, CloseWarrantyForm, itemsForCoverage, nextClaimDecisions, warrantySummary } from './warranty';

const items = [
  { id: 's1', itemType: 'SERVICE' as const, description: 'Troca de kit relação' },
  { id: 'p1', itemType: 'PART' as const, description: 'Kit relação' },
];
const base: CloseWarrantyForm = {
  decision: 'GRANTED',
  coverage: 'SERVICE_AND_PART',
  durationValue: '3',
  durationUnit: 'MONTHS',
  useKmLimit: true,
  kmLimit: '3000',
  startKm: '',
  coveredItemIds: ['s1', 'p1'],
  conditions: '',
  notes: '',
};
const opts = { required: true, enabled: true, entryKm: 42_000 };

describe('buildWarrantyDecision', () => {
  it('exige a escolha quando a política exige decisão', () => {
    expect(buildWarrantyDecision({ ...base, decision: '' }, items, opts)).toEqual({ ok: false, error: expect.stringMatching(/Sem garantia/) });
    expect(buildWarrantyDecision({ ...base, decision: '' }, items, { ...opts, required: false })).toEqual({ ok: true, payload: undefined });
  });

  it('sem garantia manda NONE; garantia desabilitada não manda decisão', () => {
    expect(buildWarrantyDecision({ ...base, decision: 'NONE' }, items, opts)).toEqual({ ok: true, payload: { decision: 'NONE' } });
    expect(buildWarrantyDecision(base, items, { ...opts, enabled: false })).toEqual({ ok: true, payload: undefined });
  });

  it('com garantia: prazo + km (o que ocorrer primeiro) e itens cobertos', () => {
    const r = buildWarrantyDecision({ ...base, startKm: '42.350', conditions: ' Uso normal ' }, items, opts);
    expect(r).toEqual({
      ok: true,
      payload: { decision: 'GRANTED', coverage: 'SERVICE_AND_PART', durationValue: 3, durationUnit: 'MONTHS', kmLimit: 3000, startKm: 42_350, coveredItemIds: ['s1', 'p1'], conditions: 'Uso normal' },
    });
  });

  it('sem limite de km manda kmLimit null; itens de outro tipo são descartados', () => {
    const r = buildWarrantyDecision({ ...base, coverage: 'SERVICE', useKmLimit: false }, items, opts);
    expect(r.ok && r.payload && r.payload.decision === 'GRANTED' && [r.payload.kmLimit, r.payload.coveredItemIds]).toEqual([null, ['s1']]);
  });

  it('recusa prazo/km inválidos, km inicial abaixo da entrada e nenhum item coberto', () => {
    expect(buildWarrantyDecision({ ...base, durationValue: '0' }, items, opts).ok).toBe(false);
    expect(buildWarrantyDecision({ ...base, kmLimit: '' }, items, opts).ok).toBe(false);
    expect(buildWarrantyDecision({ ...base, startKm: '100' }, items, opts).ok).toBe(false);
    expect(buildWarrantyDecision({ ...base, coverage: 'PART', coveredItemIds: ['s1'] }, items, opts).ok).toBe(false);
  });
});

it('itemsForCoverage filtra por tipo', () => {
  expect(itemsForCoverage(items, 'PART').map((i) => i.id)).toEqual(['p1']);
  expect(itemsForCoverage(items, 'SERVICE_AND_PART')).toHaveLength(2);
});

it('warrantySummary segue o formato da tela de pós-venda', () => {
  expect(
    warrantySummary(
      { status: 'ACTIVE', coverage: 'SERVICE', validUntil: '2026-12-28T02:59:59.999Z', kmUntil: '45350', coveredItems: [{ description: 'troca de kit relação' }], serviceOrder: { osNumber: 1842 } },
      'America/Sao_Paulo'
    )
  ).toBe('GARANTIA VIGENTE · OS #1842 · Serviço: troca de kit relação · Validade: 27/12/2026 · KM: até 45.350');
  expect(warrantySummary({ status: 'EXPIRED', expiredBy: 'KM', coverage: 'PART', validUntil: '2026-12-28T02:59:59.999Z' }, 'America/Sao_Paulo')).toBe(
    'GARANTIA EXPIRADA (km) · Peça · Validade: 27/12/2026'
  );
});

it('nextClaimDecisions espelha a máquina da API', () => {
  expect(nextClaimDecisions('OPEN')).toEqual(['ACCEPTED', 'REJECTED']);
  expect(nextClaimDecisions('ACCEPTED')).toEqual(['RESOLVED']);
  expect(nextClaimDecisions('RESOLVED')).toEqual([]);
});
