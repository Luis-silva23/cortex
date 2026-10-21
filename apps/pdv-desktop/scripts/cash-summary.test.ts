// Rodar: npx tsx --test scripts/cash-summary.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesOfTheDay } from '../src/services/cash-summary';

test('"Vendas do Dia" soma só vendas: reforço e sangria não entram (antes entravam via expectedAmount − abertura)', () => {
  const movements = [
    { movementType: 'OPENING', amount: 100 },
    { movementType: 'SALE', amount: '50.00' },
    { movementType: 'SALE', amount: 30 },
    { movementType: 'DEPOSIT', amount: 200 },
    { movementType: 'WITHDRAWAL', amount: 40 },
  ];
  assert.equal(salesOfTheDay(movements), 80);
  // o cálculo antigo (esperado − abertura) daria 240: 80 de venda + 200 de reforço − 40 de sangria
  const expected = 100 + 50 + 30 + 200 - 40;
  assert.notEqual(expected - 100, salesOfTheDay(movements));
});

test('estorno de venda (cancelamento/devolução) sai das vendas do dia', () => {
  assert.equal(
    salesOfTheDay([
      { movementType: 'SALE', amount: 100 },
      { movementType: 'CANCELLATION', amount: 30 },
      { movementType: 'RETURN', amount: 10.5 },
    ]),
    59.5
  );
});

test('sem movimentos: zero', () => {
  assert.equal(salesOfTheDay(undefined), 0);
  assert.equal(salesOfTheDay([]), 0);
});
