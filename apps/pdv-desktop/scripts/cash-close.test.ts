// Rodar: npx tsx --test scripts/cash-close.test.ts (também no npm run test:logic)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePayload, compareClose, needsDifferenceReason, parseAmount, UNATTRIBUTED } from '../src/services/cash-close';

// Exemplo do dono: dinheiro 1.000 + cartão 2.000 + PIX 1.200 + convênios 800 = 5.000 (+ 120 de fundo/reforço/sangria no dinheiro)
const EXPECTED = [
  { method: 'CASH', expected: 1120 },
  { method: 'CREDIT_CARD', expected: 2000 },
  { method: 'PIX', expected: 1200 },
  { method: 'EMPLOYEE_AGREEMENT', expected: 500 },
  { method: 'COMPANY_AGREEMENT', expected: 300 },
];

test('valores em formato brasileiro', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1234.5'), 1234.5);
  assert.equal(parseAmount('2000'), 2000);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('-10'), null);
});

test('tudo conferido: sem diferença, sem motivo, corpo com o informado de cada forma', () => {
  const c = compareClose(EXPECTED, { CASH: '1.120,00', CREDIT_CARD: '2000', PIX: '1200', EMPLOYEE_AGREEMENT: '500', COMPANY_AGREEMENT: '300' });
  assert.equal(c.expectedTotal, 5120);
  assert.equal(c.informedTotal, 5120);
  assert.equal(c.difference, 0);
  assert.equal(c.complete, true);
  assert.equal(needsDifferenceReason(c, true), false);
  assert.deepEqual(closePayload(c, ''), {
    actualAmount: 5120,
    declaredByMethod: { CASH: 1120, CREDIT_CARD: 2000, PIX: 1200, EMPLOYEE_AGREEMENT: 500, COMPANY_AGREEMENT: 300 },
  });
});

test('faltou dinheiro: diferença por forma e no total; a política pede motivo', () => {
  const c = compareClose(EXPECTED, { CASH: '1050', CREDIT_CARD: '2000', PIX: '1200', EMPLOYEE_AGREEMENT: '500', COMPANY_AGREEMENT: '300' });
  assert.equal(c.difference, -70);
  assert.equal(c.rows.find((r) => r.method === 'CASH')!.difference, -70);
  assert.equal(needsDifferenceReason(c, true), true);
  assert.equal(needsDifferenceReason(c, false), false);
  assert.equal(closePayload(c, '  Troco dado a mais  ').differenceReason, 'Troco dado a mais');
});

test('forma não informada = incompleto; valor inválido é apontado', () => {
  const c = compareClose(EXPECTED, { CASH: '1120', CREDIT_CARD: 'dois mil' });
  assert.equal(c.complete, false);
  assert.deepEqual(c.invalid, ['CREDIT_CARD']);
});

test('estorno sem forma identificada: aparece e entra no esperado, mas não é informado nem enviado', () => {
  const c = compareClose([...EXPECTED, { method: UNATTRIBUTED, expected: -40 }], { CASH: '1120', CREDIT_CARD: '2000', PIX: '1200', EMPLOYEE_AGREEMENT: '500', COMPANY_AGREEMENT: '300', [UNATTRIBUTED]: '999' });
  assert.equal(c.expectedTotal, 5080);
  assert.equal(c.complete, true);
  assert.equal(c.difference, 40);
  assert.equal(UNATTRIBUTED in closePayload(c, 'x').declaredByMethod, false);
});
