import { refundedValue, round2 } from './sale-refund';

type Item = { quantity: number; returnedQuantity: number; totalPrice: number };
const item = (quantity: number, totalPrice: number, returnedQuantity = 0): Item => ({ quantity, totalPrice, returnedQuantity });

// Simula devoluções sucessivas: cada uma estorna f(depois) − f(antes), como returnSale.
function refundsFor(items: Item[], paid: number, steps: Array<[number, number]>) {
  const state = items.map((i) => ({ ...i }));
  const refunds: number[] = [];
  for (const [index, qty] of steps) {
    const before = refundedValue(state, paid);
    state[index].returnedQuantity += qty;
    refunds.push(round2(refundedValue(state, paid) - before));
  }
  return { refunds, total: round2(refunds.reduce((a, b) => a + b, 0)), remaining: round2(paid - refundedValue(state, paid)) };
}

describe('rateio do estorno na devolução (valor pago, não preço de tabela)', () => {
  it('1 item sem desconto: devolução total estorna o pago', () => {
    expect(refundsFor([item(1, 50)], 50, [[0, 1]]).total).toBe(50);
  });

  it('1 item com desconto na venda: estorna o pago, nunca o preço cheio', () => {
    const r = refundsFor([item(2, 40)], 30, [[0, 1]]); // tabela 40, pago 30
    expect(r.refunds).toEqual([15]);
    expect(r.remaining).toBe(15);
  });

  it('2 itens com desconto, devolução parcial e depois total: soma fecha exatamente no pago', () => {
    const r = refundsFor([item(2, 20), item(2, 20)], 30, [[0, 1], [0, 1], [1, 2]]);
    expect(r.refunds).toEqual([7.5, 7.5, 15]);
    expect(r.total).toBe(30);
    expect(r.remaining).toBe(0);
  });

  it('itens de valores diferentes: rateio proporcional ao líquido de cada linha', () => {
    const r = refundsFor([item(1, 75), item(1, 25)], 80, [[1, 1]]); // desconto de 20%
    expect(r.refunds).toEqual([20]);
  });

  it('arredondamento: dízimas nunca geram centavo a mais nem a menos no total', () => {
    const r = refundsFor([item(3, 30)], 20, [[0, 1], [0, 1], [0, 1]]); // fator 2/3
    expect(r.refunds).toEqual([6.67, 6.66, 6.67]);
    expect(r.total).toBe(20);
  });

  it('nunca estorna mais que o pago, em qualquer ordem de devolução', () => {
    const items = [item(3, 33.33), item(7, 70), item(1, 9.99)];
    const paid = 100;
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      const steps = order.map((i) => [i, items[i].quantity] as [number, number]);
      const r = refundsFor(items, paid, steps);
      expect(r.total).toBe(paid);
      expect(r.refunds.every((x) => x >= 0)).toBe(true);
    }
  });

  it('sem pagamento aprovado não há o que estornar', () => {
    expect(refundedValue([item(1, 10, 1)], 0)).toBe(0);
  });
});
