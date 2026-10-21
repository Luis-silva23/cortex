import { canReverseAccount, isReversalRecord } from './financial';

describe('isReversalRecord / canReverseAccount', () => {
  it('o lançamento de estorno (referenceType Reversal, PAID) não pode ser estornado de novo', () => {
    const reversal = { status: 'PAID', referenceType: 'Reversal' };
    expect(isReversalRecord(reversal)).toBe(true);
    expect(canReverseAccount(reversal)).toBe(false);
  });

  it('conta paga comum pode ser estornada', () => {
    expect(canReverseAccount({ status: 'PAID', referenceType: null })).toBe(true);
    expect(canReverseAccount({ status: 'PAID' })).toBe(true);
    // Contas geradas por outras origens (ex.: OS) também são estornáveis.
    expect(canReverseAccount({ status: 'PAID', referenceType: 'ServiceOrder' })).toBe(true);
  });

  it('conta que não está paga não pode ser estornada', () => {
    expect(canReverseAccount({ status: 'PENDING' })).toBe(false);
    expect(canReverseAccount({ status: 'CANCELLED' })).toBe(false);
    expect(canReverseAccount(null)).toBe(false);
  });
});
