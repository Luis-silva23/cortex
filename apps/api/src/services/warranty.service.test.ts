import { computeValidUntil, durationLabel, evaluateWarranty } from './warranty.service';

/**
 * Regra pura da garantia de OS (docs/CORTEX/policies/GARANTIA.md): validade = fim do último dia no fuso da empresa,
 * meses sem estourar o mês; vigente = dentro do prazo E abaixo do km limite (o que ocorrer primeiro).
 */
const SP = 'America/Sao_Paulo';
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: SP }).format(d);
const localTime = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: SP, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);

describe('computeValidUntil', () => {
  it('31/01 + 1 mês = 28/02 (não estoura para março), até 23:59:59 de São Paulo', () => {
    const v = computeValidUntil(new Date('2026-01-31T15:00:00Z'), 1, 'MONTHS', SP);
    expect(localDate(v)).toBe('2026-02-28');
    expect(localTime(v)).toBe('23:59:59');
  });

  it('31/01 + 1 mês em ano bissexto = 29/02', () => {
    expect(localDate(computeValidUntil(new Date('2028-01-31T15:00:00Z'), 1, 'MONTHS', SP))).toBe('2028-02-29');
  });

  it('usa a DATA LOCAL do início: entrega às 22h de 31/01 em SP (01/02 em UTC) conta de 31/01', () => {
    expect(localDate(computeValidUntil(new Date('2026-02-01T01:00:00Z'), 1, 'MONTHS', SP))).toBe('2026-02-28');
  });

  it('dias: 01/03 + 90 dias = 30/05 (o dia da entrega não conta)', () => {
    expect(localDate(computeValidUntil(new Date('2026-03-01T13:00:00Z'), 90, 'DAYS', SP))).toBe('2026-05-30');
  });

  it('anos: 29/02/2028 + 1 ano = 28/02/2029; 27/09/2026 + 3 meses = 27/12/2026', () => {
    expect(localDate(computeValidUntil(new Date('2028-02-29T13:00:00Z'), 1, 'YEARS', SP))).toBe('2029-02-28');
    expect(localDate(computeValidUntil(new Date('2026-09-27T13:00:00Z'), 3, 'MONTHS', SP))).toBe('2026-12-27');
  });
});

describe('evaluateWarranty — o que ocorrer primeiro', () => {
  const w = { validUntil: new Date('2026-12-27T02:59:59.999Z'), kmUntil: 45_000 };

  it('dentro do prazo e abaixo do km: vigente', () => {
    expect(evaluateWarranty(w, new Date('2026-11-01T12:00:00Z'), 44_999)).toEqual({ active: true, expiredBy: null });
  });
  it('prazo vence antes do km: expirada por DATA', () => {
    expect(evaluateWarranty(w, new Date('2026-12-28T12:00:00Z'), 43_000)).toEqual({ active: false, expiredBy: 'DATE' });
  });
  it('km vence antes do prazo: expirada por KM (no limite já não vale)', () => {
    expect(evaluateWarranty(w, new Date('2026-10-01T12:00:00Z'), 45_000)).toEqual({ active: false, expiredBy: 'KM' });
  });
  it('sem limite de km, ou km não informado: só o prazo conta', () => {
    expect(evaluateWarranty({ ...w, kmUntil: null }, new Date('2026-10-01T12:00:00Z'), 999_999).active).toBe(true);
    expect(evaluateWarranty(w, new Date('2026-10-01T12:00:00Z'), null).active).toBe(true);
  });
});

it('durationLabel usa singular/plural em português', () => {
  expect(durationLabel(1, 'MONTHS')).toBe('1 mês');
  expect(durationLabel(6, 'MONTHS')).toBe('6 meses');
  expect(durationLabel(1, 'YEARS')).toBe('1 ano');
  expect(durationLabel(90, 'DAYS')).toBe('90 dias');
});
