/**
 * Regras puras do fechamento de caixa no PDV (docs/CORTEX/policies/CAIXA.md) — testadas em scripts/cash-close.test.ts.
 * O esperado vem da API por forma de pagamento (todo o movimento do caixa); o operador informa o realizado de cada
 * forma; com diferença, a política pede o motivo.
 */
export interface ExpectedRow {
  method: string;
  expected: number;
  sales?: number;
  refunds?: number;
  opening?: number;
  deposits?: number;
  withdrawals?: number;
}

/** Estorno cuja forma de pagamento não dá para identificar: aparece, entra no esperado, mas não é "contável". */
export const UNATTRIBUTED = 'NAO_IDENTIFICADO';

export const METHOD_LABELS: Record<string, string> = {
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Cartão de débito',
  CREDIT_CARD: 'Cartão de crédito',
  PIX: 'PIX',
  BANK_SLIP: 'Boleto',
  BANK_TRANSFER: 'Transferência',
  EMPLOYEE_AGREEMENT: 'Convênio de funcionário',
  COMPANY_AGREEMENT: 'Convênio de empresa',
  [UNATTRIBUTED]: 'Estornos sem forma identificada',
};
export const methodLabel = (m: string) => METHOD_LABELS[m] ?? m;

export const DIFFERENCE_REASON_MIN = 5;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** "1.234,56", "1234.56", "1234,5" → número; vazio/inválido → null. */
export function parseAmount(text: string): number | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return r2(Number(normalized));
}

export interface CloseRow extends ExpectedRow {
  informed: number | null;
  difference: number | null;
  readOnly: boolean;
}

export interface CloseComparison {
  rows: CloseRow[];
  expectedTotal: number;
  informedTotal: number;
  difference: number;
  /** Todas as formas contáveis com valor esperado (≠ 0) foram informadas? */
  complete: boolean;
  invalid: string[];
}

export function compareClose(expected: ExpectedRow[], inputs: Record<string, string>): CloseComparison {
  const invalid: string[] = [];
  const rows = expected.map((row) => {
    const readOnly = row.method === UNATTRIBUTED;
    const text = readOnly ? '' : inputs[row.method] ?? '';
    const informed = parseAmount(text);
    if (text.trim() && informed === null) invalid.push(row.method);
    return { ...row, readOnly, informed, difference: informed === null ? null : r2(informed - row.expected) };
  });
  const expectedTotal = r2(expected.reduce((s, r) => s + r.expected, 0));
  const informedTotal = r2(rows.reduce((s, r) => s + (r.informed ?? 0), 0));
  return {
    rows,
    expectedTotal,
    informedTotal,
    difference: r2(informedTotal - expectedTotal),
    complete: rows.every((r) => r.readOnly || r.informed !== null || Math.abs(r.expected) < 0.005),
    invalid,
  };
}

export function needsDifferenceReason(comparison: CloseComparison, policyRequires: boolean) {
  return policyRequires && Math.abs(comparison.difference) >= 0.01;
}

/** Corpo do POST /close (e do force-close): total informado, informado por forma e o motivo quando houver. */
export function closePayload(comparison: CloseComparison, differenceReason: string) {
  const declaredByMethod = Object.fromEntries(comparison.rows.filter((r) => !r.readOnly).map((r) => [r.method, r.informed ?? 0]));
  const reason = differenceReason.trim();
  return { actualAmount: comparison.informedTotal, declaredByMethod, ...(reason ? { differenceReason: reason } : {}) };
}
