// Validação das quantidades de envio/recebimento de uma transferência entre
// filiais. Espelha transfer.service.ts: send rejeita sentQuantity <= 0 ou acima
// do solicitado, receive rejeita receivedQuantity < 0 ou acima do enviado — e
// uma única quantidade inválida derruba a operação INTEIRA (400). Validar aqui
// aponta QUAL item está errado em vez de deixar a API recusar tudo.

export interface QuantityRow {
  id: string;
  label: string;
  // Teto do item: solicitado (envio) ou enviado (recebimento).
  max: number;
}

export interface QuantityValidation {
  ok: boolean;
  // itemId -> mensagem, para marcar cada linha inválida.
  errors: Record<string, string>;
  // Texto único para o alerta do topo (primeiro problema encontrado).
  message: string | null;
}

function parseQuantity(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function validate(
  rows: QuantityRow[],
  values: Record<string, string>,
  allowZero: boolean,
  maxLabel: string
): QuantityValidation {
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const value = parseQuantity(values[row.id]);
    if (value === null) {
      errors[row.id] = 'Informe a quantidade.';
    } else if (allowZero ? value < 0 : value <= 0) {
      errors[row.id] = allowZero ? 'A quantidade não pode ser negativa.' : 'A quantidade deve ser maior que zero.';
    } else if (value > row.max) {
      errors[row.id] = `Máximo permitido: ${row.max} (${maxLabel}).`;
    }
  }
  const firstBad = rows.find((row) => errors[row.id]);
  return {
    ok: !firstBad,
    errors,
    message: firstBad ? `Item "${firstBad.label}": ${errors[firstBad.id]}` : null,
  };
}

export function validateSendQuantities(rows: QuantityRow[], values: Record<string, string>): QuantityValidation {
  return validate(rows, values, false, 'solicitado');
}

export function validateReceiveQuantities(rows: QuantityRow[], values: Record<string, string>): QuantityValidation {
  return validate(rows, values, true, 'enviado');
}
