// Regras puras da tela de vendas do Admin Web. Espelha o backend
// (apps/api sales.routes.ts / sale.service.ts) — sem regra nova.

export const SALE_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  PAID: 'Concluída',
  PARTIALLY_PAID: 'Parcial',
  CANCELLED: 'Cancelada',
  RETURNED: 'Devolvida',
};

// Cor semântica só no status: verde = concluída, amarelo = em aberto,
// vermelho = cancelada; devolvida fica neutra.
export const SALE_STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'error'> = {
  PENDING: 'warning',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
  CANCELLED: 'error',
  RETURNED: 'secondary',
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Cartão de débito',
  CREDIT_CARD: 'Cartão de crédito',
  PIX: 'PIX',
  BANK_TRANSFER: 'Transferência',
  CHECK: 'Cheque',
  VOUCHER: 'Vale',
  OTHER: 'Outro',
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  APPROVED: 'Aprovado',
  REJECTED: 'Rejeitado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Estornado',
};

export const PAYMENT_STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'error'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'error',
  REFUNDED: 'secondary',
};

// Mesmos papéis do gate de escrita de sales.routes.ts (VIEWER e MECHANIC ficam
// de fora: a API responde 403). A API continua sendo a autoridade — isto só
// esconde o botão.
const SALE_WRITE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'];

export function canRequestSaleReversal(userType: string | null | undefined): boolean {
  return !!userType && SALE_WRITE_ROLES.includes(userType);
}

// sale.service.ts recusa cancelar venda já CANCELLED/RETURNED.
export function canCancelSale(sale: { status: string }, userType: string | null | undefined): boolean {
  if (sale.status === 'CANCELLED' || sale.status === 'RETURNED') return false;
  return canRequestSaleReversal(userType);
}

// ---------------------------------------------------------------------------
// Formulário de cancelamento (motivo + credenciais do autorizador)
// ---------------------------------------------------------------------------

export const MIN_REASON_LENGTH = 3; // cancelSaleSchema/sale.service: "Reason is required (minimum 3 characters)"

export interface CancelFormValues {
  reason: string;
  numericId: string;
  password: string;
  mfaCode: string;
}

export const emptyCancelForm: CancelFormValues = { reason: '', numericId: '', password: '', mfaCode: '' };

export function validateReason(reason: string): string | null {
  return reason.trim().length < MIN_REASON_LENGTH ? `O motivo deve ter no mínimo ${MIN_REASON_LENGTH} caracteres.` : null;
}

export function validateAuthorizer(values: Pick<CancelFormValues, 'numericId' | 'password'>): string | null {
  const id = values.numericId.trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) return 'Informe o ID numérico do autorizador.';
  if (values.password === '') return 'Informe a senha do autorizador.';
  return null;
}

export interface CancelPayload {
  reason: string;
  authorizerNumericId: number;
  authorizerPassword: string;
  authorizerMfaCode?: string;
}

export function buildCancelPayload(values: CancelFormValues): CancelPayload {
  const mfa = values.mfaCode.trim();
  return {
    reason: values.reason.trim(),
    authorizerNumericId: parseInt(values.numericId.trim(), 10),
    authorizerPassword: values.password,
    ...(mfa ? { authorizerMfaCode: mfa } : {}),
  };
}
