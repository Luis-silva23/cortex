// Resumo do caixa aberto na tela do PDV (docs/CORTEX/policies/CAIXA.md).

export interface CashMovementLike {
  movementType: string;
  amount: unknown;
}

/**
 * "Vendas do Dia": só o que entrou por VENDA neste caixa (movimentos SALE), menos os estornos de venda
 * (CANCELLATION / RETURN). Reforço (DEPOSIT), sangria (WITHDRAWAL), abertura e fechamento NÃO são venda — antes o card
 * mostrava expectedAmount − abertura, que somava reforços e descontava sangrias como se fossem vendas.
 */
export function salesOfTheDay(movements: CashMovementLike[] | null | undefined): number {
  const total = (movements ?? []).reduce((sum, m) => {
    const value = Number(m.amount) || 0;
    if (m.movementType === 'SALE') return sum + value;
    if (m.movementType === 'CANCELLATION' || m.movementType === 'RETURN') return sum - value;
    return sum;
  }, 0);
  return Math.round(total * 100) / 100;
}
