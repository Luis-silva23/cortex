import { describeInstallments } from '@ln-system/shared/utils/installments';
import { formatBRL } from './money';

/**
 * Rótulo da opção de parcelamento do PDV: "3x de R$ 33,33 (última de R$ 33,34)". É a MESMA divisão em centavos inteiros que o
 * servidor grava (`shared/utils/installments`) — nunca `total / n` (que mostrava "3x de R$ 33,33" e escondia o centavo da última).
 * `null` = não dá para parcelar (fração de centavo no total, ou menos de R$ 0,01 por parcela).
 */
export function installmentPreview(total: number, n: number): { label: string; parts: number[] } | null {
  try {
    const d = describeInstallments(total, n);
    return { parts: d.parts, label: d.uniform ? `${n}x de ${formatBRL(d.first)}` : `${n}x de ${formatBRL(d.first)} (última de ${formatBRL(d.last)})` };
  } catch {
    return null;
  }
}
