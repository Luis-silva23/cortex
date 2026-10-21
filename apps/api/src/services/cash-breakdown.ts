import { round2 } from './sale-refund';

// Cédulas e moedas do Real em circulação.
export const BRL_DENOMINATIONS = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05] as const;

export type CashBreakdownEntry = { value: number; quantity: number };

/**
 * Valida a composição do dinheiro recebido e devolve as entradas normalizadas (uma por valor, maior primeiro).
 * Recusa valor fora do Real, quantidade não inteira/não positiva e soma diferente do valor recebido.
 */
export function normalizeCashBreakdown(entries: CashBreakdownEntry[], receivedAmount: number): CashBreakdownEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Informe as cédulas recebidas');
  const byValue = new Map<number, number>();
  for (const entry of entries) {
    const value = Number(entry?.value);
    const quantity = Number(entry?.quantity);
    if (!BRL_DENOMINATIONS.some((d) => d === value)) throw new Error(`Cédula/moeda inválida: ${entry?.value}`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`Quantidade inválida para R$ ${value}`);
    byValue.set(value, (byValue.get(value) ?? 0) + quantity);
  }
  const normalized = [...byValue.entries()].sort((a, b) => b[0] - a[0]).map(([value, quantity]) => ({ value, quantity }));
  const total = round2(normalized.reduce((sum, e) => sum + e.value * e.quantity, 0));
  if (total !== round2(receivedAmount)) {
    throw new Error(`As cédulas somam R$ ${total.toFixed(2)}, mas o valor recebido é R$ ${round2(receivedAmount).toFixed(2)}`);
  }
  return normalized;
}
