import { normalizeCashBreakdown } from './cash-breakdown';

describe('composição do dinheiro recebido (controle de cédulas)', () => {
  it('1×100 + 1×50 + 1×20 = R$ 170', () => {
    expect(normalizeCashBreakdown([{ value: 20, quantity: 1 }, { value: 100, quantity: 1 }, { value: 50, quantity: 1 }], 170)).toEqual([
      { value: 100, quantity: 1 },
      { value: 50, quantity: 1 },
      { value: 20, quantity: 1 },
    ]);
  });

  it('junta valores repetidos e aceita moedas', () => {
    expect(normalizeCashBreakdown([{ value: 0.25, quantity: 2 }, { value: 0.25, quantity: 2 }, { value: 1, quantity: 3 }], 4)).toEqual([
      { value: 1, quantity: 3 },
      { value: 0.25, quantity: 4 },
    ]);
  });

  it.each([
    [[{ value: 3, quantity: 1 }], 3, /inválida/],
    [[{ value: 10, quantity: 0 }], 0.01, /Quantidade/],
    [[{ value: 10, quantity: 1.5 }], 15, /Quantidade/],
    [[{ value: 50, quantity: 3 }], 170, /somam R\$ 150.00/],
    [[], 10, /Informe/],
  ])('recusa %j (recebido %s)', (entries, received, error) => {
    expect(() => normalizeCashBreakdown(entries as any, received as number)).toThrow(error as RegExp);
  });
});
