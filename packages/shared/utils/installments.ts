/**
 * PARCELAMENTO — divisão financeira do valor de uma venda/pagamento em parcelas, SEMPRE em centavos inteiros.
 *
 * Domínio: Venda → Parcelas → Liquidação → Fiscal. Este módulo só faz a primeira divisão (Venda → Parcelas): não sabe de
 * recebimento, taxa de adquirente nem tributo. Não usa ponto flutuante em nenhuma soma: o total vira um inteiro de centavos,
 * é dividido com aritmética inteira e só então volta a reais para exibição/gravação (cada parcela é um inteiro / 100, exato).
 *
 * Regra de distribuição (determinística): `base = floor(total / n)` centavos em todas as parcelas e o resto (`total % n`, sempre
 * menor que n) vai de 1 centavo para cada uma das ÚLTIMAS parcelas. R$ 100,00 em 3x = 33,33 + 33,33 + 33,34; R$ 10,00 em 3x =
 * 3,33 + 3,33 + 3,34; R$ 100,01 em 3x = 33,33 + 33,34 + 33,34. A soma é sempre exatamente o total.
 * Mesmo código no servidor e no PDV (uma só fonte da regra).
 */
export class InstallmentError extends Error {
  constructor(
    message: string,
    public code: 'INSTALLMENTS_INVALID' | 'AMOUNT_INVALID' | 'AMOUNT_PRECISION_INVALID' | 'INSTALLMENT_TOO_SMALL'
  ) {
    super(message);
    this.name = 'InstallmentError';
  }
}

/** Reais → centavos inteiros. Recusa valor não finito, negativo ou com fração de centavo (R$ 10,005). Tolera só o ruído do double. */
export function toCents(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InstallmentError('Valor inválido', 'AMOUNT_INVALID');
  if (value < 0) throw new InstallmentError('Valor não pode ser negativo', 'AMOUNT_INVALID');
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) throw new InstallmentError('Valor com mais de duas casas decimais (fração de centavo)', 'AMOUNT_PRECISION_INVALID');
  return cents;
}

/** Centavos inteiros → reais (divisão por 100 de um inteiro: o double mais próximo do valor exato, sem acúmulo de erro). */
export const fromCents = (cents: number): number => cents / 100;

/** `true` se o valor está em centavos exatos (no máximo 2 casas decimais). */
export function isCentsExact(value: number): boolean {
  try {
    toCents(value);
    return true;
  } catch {
    return false;
  }
}

/** Divide `totalCents` em `n` parcelas inteiras (em centavos); o resto vai 1 centavo para cada uma das últimas parcelas. */
export function splitCents(totalCents: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new InstallmentError('Quantidade de parcelas inválida: informe um inteiro maior ou igual a 1', 'INSTALLMENTS_INVALID');
  if (!Number.isInteger(totalCents) || totalCents < 1) throw new InstallmentError('O valor a parcelar deve ser maior que zero', 'AMOUNT_INVALID');
  if (totalCents < n) throw new InstallmentError(`R$ ${fromCents(totalCents).toFixed(2).replace(".", ",")} não pode ser dividido em ${n} parcelas (cada parcela precisa de pelo menos R$ 0,01)`, 'INSTALLMENT_TOO_SMALL');
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n; // 0 <= rest < n
  return Array.from({ length: n }, (_, i) => base + (i >= n - rest ? 1 : 0));
}

/** Divide um valor em reais em `n` parcelas em reais (exatas em centavos). A soma, em centavos, é exatamente o total. */
export function splitInstallments(total: number, n: number): number[] {
  return splitCents(toCents(total), n).map(fromCents);
}

/** Soma de valores em reais feita em centavos inteiros (sem o erro de 0,1 + 0,2 do ponto flutuante). */
export function sumInCents(values: number[]): number {
  return fromCents(values.reduce((acc, v) => acc + toCents(v), 0));
}

/** Resumo para a tela/comprovante: "3x de R$ 33,33 (a última de R$ 33,34)". `uniform` = todas as parcelas iguais. */
export function describeInstallments(total: number, n: number): { parts: number[]; first: number; last: number; uniform: boolean } {
  const parts = splitInstallments(total, n);
  return { parts, first: parts[0], last: parts[parts.length - 1], uniform: parts[0] === parts[parts.length - 1] };
}
