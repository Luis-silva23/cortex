// Rodar: npx tsx --test scripts/installment-preview.test.ts (também no npm run test:logic)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installmentPreview } from '../src/services/installment-preview';

const norm = (s: string) => s.replace(/ /g, ' '); // o Intl separa "R$" do valor com espaço sem quebra
const cents = (parts: number[]) => parts.reduce((a, p) => a + Math.round(p * 100), 0);

test('R$ 100,00: 1x, 2x e 3x — o rótulo mostra o centavo da última parcela e a soma é exatamente o total', () => {
  assert.equal(norm(installmentPreview(100, 1)!.label), '1x de R$ 100,00');
  assert.equal(norm(installmentPreview(100, 2)!.label), '2x de R$ 50,00');
  const three = installmentPreview(100, 3)!;
  assert.equal(norm(three.label), '3x de R$ 33,33 (última de R$ 33,34)');
  assert.deepEqual(three.parts, [33.33, 33.33, 33.34]);
  assert.equal(cents(three.parts), 10000);
});

test('R$ 10,00 em 3x e valores com resto: soma exata em centavos', () => {
  assert.deepEqual(installmentPreview(10, 3)!.parts, [3.33, 3.33, 3.34]);
  for (const [total, n] of [[100.01, 3], [1234.57, 4], [99.99, 12], [0.1 + 0.2, 3]] as const) {
    const p = installmentPreview(total, n)!;
    assert.equal(cents(p.parts), Math.round(total * 100));
  }
});

test('não parcela o que não dá: R$ 0,01 em 2x, fração de centavo e quantidade inválida', () => {
  assert.equal(installmentPreview(0.01, 2), null);
  assert.equal(installmentPreview(10.005, 2), null);
  assert.equal(installmentPreview(100, 0), null);
  assert.equal(installmentPreview(100, -2), null);
  assert.equal(installmentPreview(100, 2.5), null);
});
