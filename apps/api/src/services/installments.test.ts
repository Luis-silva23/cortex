import { splitInstallments, splitCents, toCents, fromCents, sumInCents, describeInstallments, isCentsExact, InstallmentError } from '@ln-system/shared/utils/installments';

// Soma em CENTAVOS INTEIROS (nunca em reais com ponto flutuante): é o que prova que a soma das parcelas é exatamente o total.
const centsSum = (parts: number[]) => parts.reduce((acc, p) => acc + Math.round(p * 100), 0);

describe('parcelamento em centavos inteiros', () => {
  it.each([
    [100, 1, [100]],
    [100, 2, [50, 50]],
    [100, 3, [33.33, 33.33, 33.34]], // exemplo obrigatório: o centavo que sobra vai para a ÚLTIMA parcela
    [10, 3, [3.33, 3.33, 3.34]],
    [100.01, 3, [33.33, 33.34, 33.34]], // resto de 2 centavos: 1 para cada uma das duas últimas
    [100.02, 3, [33.34, 33.34, 33.34]],
    [0.03, 3, [0.01, 0.01, 0.01]],
    [0.01, 1, [0.01]],
    [1234.56, 4, [308.64, 308.64, 308.64, 308.64]],
    [1234.57, 4, [308.64, 308.64, 308.64, 308.65]],
    [99.99, 12, [8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.34, 8.34, 8.34]], // 9999 = 12×833 + 3
  ])('R$ %p em %ix = %p', (total, n, expected) => {
    const parts = splitInstallments(total, n);
    expect(parts).toEqual(expected);
    expect(centsSum(parts)).toBe(Math.round(total * 100)); // matemática final: soma exata em centavos
  });

  it('R$ 0,01 em várias parcelas: recusado (cada parcela precisa de pelo menos R$ 0,01); 1 parcela de R$ 0,01 é válida', () => {
    expect(() => splitInstallments(0.01, 2)).toThrow(InstallmentError);
    expect(() => splitInstallments(0.01, 2)).toThrow(/pelo menos R\$ 0,01/);
    expect(splitInstallments(0.01, 1)).toEqual([0.01]);
    expect(splitInstallments(0.02, 2)).toEqual([0.01, 0.01]);
  });

  it('valor zero ou negativo é recusado (não existe pagamento de R$ 0,00)', () => {
    for (const bad of [0, -1, -0.01]) expect(() => splitInstallments(bad, 1)).toThrow(InstallmentError);
  });

  it('quantidade de parcelas inválida: 0, negativa, fracionária, NaN, infinita', () => {
    for (const n of [0, -1, -3, 2.5, NaN, Infinity]) {
      expect(() => splitInstallments(100, n)).toThrow(/Quantidade de parcelas inválida/);
    }
  });

  it('fração de centavo e valor não finito são recusados em vez de arredondados em silêncio', () => {
    expect(() => toCents(10.005)).toThrow(/duas casas/);
    expect(() => toCents(NaN)).toThrow(InstallmentError);
    expect(() => toCents(Infinity)).toThrow(InstallmentError);
    expect(isCentsExact(10.005)).toBe(false);
    expect(isCentsExact(10.01)).toBe(true);
    // o ruído do double (99.99000000000001 = 33.33 * 3) NÃO é fração de centavo
    expect(toCents(33.33 * 3)).toBe(9999);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('ponto flutuante clássico: 0,1 + 0,2 = 0,3 só em centavos; somas de valores em reais passam por centavos', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // o problema que o módulo evita
    expect(sumInCents([0.1, 0.2])).toBe(0.3);
    expect(sumInCents(splitInstallments(100, 3))).toBe(100);
    expect(fromCents(toCents(19.99))).toBe(19.99);
  });

  it('varredura: de R$ 0,01 a R$ 200,00 em 1..12 parcelas — soma exata, parcelas inteiras em centavos, diferença máxima de 1 centavo, ordem crescente', () => {
    for (let total = 1; total <= 20000; total += 1) {
      for (let n = 1; n <= 12; n += 1) {
        if (total < n) {
          expect(() => splitCents(total, n)).toThrow(InstallmentError);
          continue;
        }
        const parts = splitCents(total, n);
        if (parts.length !== n || parts.reduce((a, b) => a + b, 0) !== total) throw new Error(`soma/quantidade errada para ${total}c em ${n}x`);
        if (!parts.every((p) => Number.isInteger(p) && p >= 1)) throw new Error(`parcela não inteira/positiva para ${total}c em ${n}x`);
        if (Math.max(...parts) - Math.min(...parts) > 1) throw new Error(`diferença maior que 1 centavo para ${total}c em ${n}x`);
        if (parts.some((p, i) => i > 0 && p < parts[i - 1])) throw new Error(`ordem não crescente para ${total}c em ${n}x`);
      }
    }
  });

  it('valores grandes e muitas parcelas continuam exatos', () => {
    for (const [total, n] of [[999999.99, 48], [1000000, 7], [123456.78, 36]] as const) {
      const parts = splitInstallments(total, n);
      expect(centsSum(parts)).toBe(Math.round(total * 100));
      expect(parts).toHaveLength(n);
    }
  });

  it('determinismo: a mesma entrada dá sempre a mesma divisão', () => {
    expect(splitInstallments(100, 3)).toEqual(splitInstallments(100, 3));
    expect(splitInstallments(77.77, 5)).toEqual(splitInstallments(77.77, 5));
  });

  it('describeInstallments: resumo para a tela (primeira, última, se são iguais)', () => {
    expect(describeInstallments(100, 3)).toEqual({ parts: [33.33, 33.33, 33.34], first: 33.33, last: 33.34, uniform: false });
    expect(describeInstallments(100, 2)).toEqual({ parts: [50, 50], first: 50, last: 50, uniform: true });
  });
});
