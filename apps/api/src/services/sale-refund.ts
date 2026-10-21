export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Quanto do valor PAGO já foi estornado pelas devoluções registradas nos itens (regra de rateio — ver
 * docs/CORTEX/contracts/business-state-machines.md, "Devolução"). O desconto da venda é rateado na proporção do valor
 * líquido de cada linha: fator = pago / Σ totalPrice. Função do estado (não soma de parcelas), então as devoluções
 * sucessivas estornam f(depois) − f(antes) e o total fecha exatamente no pago quando tudo foi devolvido.
 */
export function refundedValue(
  items: Array<{ quantity: unknown; returnedQuantity: unknown; totalPrice: unknown }>,
  paid: number
): number {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (!(paid > 0)) return 0;
  if (items.length > 0 && items.every((i) => num(i.returnedQuantity) >= num(i.quantity))) return paid;
  const netTotal = items.reduce((sum, i) => sum + num(i.totalPrice), 0);
  if (netTotal <= 0) return 0;
  const factor = paid / netTotal;
  const value = items.reduce(
    (sum, i) => sum + (num(i.quantity) > 0 ? (num(i.returnedQuantity) / num(i.quantity)) * num(i.totalPrice) : 0),
    0
  );
  return Math.min(paid, round2(value * factor));
}
