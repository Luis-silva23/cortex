import { toCents, fromCents } from '@ln-system/shared/utils/installments';
import { toNumber } from './money';

/**
 * PRÉVIA do orçamento na tela — NÃO é regra: o total oficial é calculado e gravado pelo servidor (a tela mostra o que o servidor
 * devolve depois de salvar). A prévia usa a MESMA aritmética em centavos inteiros do restante do CÓRTEX (preço em centavos ×
 * quantidade em milésimos, arredondado por linha), nunca soma de reais em ponto flutuante.
 */
export interface PreviewLine {
  quantity: number | string;
  unitPrice: number | string;
}

export function lineCents(line: PreviewLine): number {
  const unitCents = toCents(Math.max(0, toNumber(line.unitPrice)));
  const qtyMilli = Math.round(Math.max(0, toNumber(line.quantity)) * 1000);
  return Math.round((unitCents * qtyMilli) / 1000);
}

export function previewTotal(lines: PreviewLine[]): number {
  return fromCents(lines.reduce((acc, l) => acc + lineCents(l), 0));
}
