// Devolução ao fornecedor no Admin Web (docs/CORTEX/policies/DEVOLUCAO-FORNECEDOR.md). NÃO é garantia ao cliente
// (essa nasce da OS). A API é a autoridade: política de quem aprova, saldo de estoque, transições, auditoria. Aqui ficam
// só os textos da tela e a montagem/validação do formulário.

export type SupplierReturnStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SENT' | 'CLOSED' | 'CANCELLED';
export type SupplierReturnReason = 'DAMAGED' | 'DEFECTIVE' | 'WRONG_ITEM' | 'NOT_ORDERED' | 'OTHER';
export type SupplierReturnOutcome = 'CREDIT' | 'REPLACEMENT' | 'REFUND' | 'REFUSED_BY_SUPPLIER';
export type SupplierReturnAction = 'approve' | 'reject' | 'send' | 'close' | 'cancel';

export const STATUS_LABEL: Record<SupplierReturnStatus, string> = {
  REQUESTED: 'Solicitada',
  APPROVED: 'Aprovada (estoque retirado)',
  REJECTED: 'Recusada',
  SENT: 'Enviada ao fornecedor',
  CLOSED: 'Encerrada',
  CANCELLED: 'Cancelada',
};

export const STATUS_VARIANT: Record<SupplierReturnStatus, 'default' | 'secondary' | 'success' | 'warning' | 'error' | 'outline'> = {
  REQUESTED: 'warning',
  APPROVED: 'default',
  REJECTED: 'error',
  SENT: 'secondary',
  CLOSED: 'success',
  CANCELLED: 'outline',
};

export const REASON_LABEL: Record<SupplierReturnReason, string> = {
  DAMAGED: 'Produto danificado',
  DEFECTIVE: 'Defeito identificado',
  WRONG_ITEM: 'Produto inadequado / errado',
  NOT_ORDERED: 'Recebido sem ter sido pedido',
  OTHER: 'Outro motivo',
};

export const OUTCOME_LABEL: Record<SupplierReturnOutcome, string> = {
  CREDIT: 'Crédito com o fornecedor',
  REPLACEMENT: 'Reposição do produto',
  REFUND: 'Reembolso',
  REFUSED_BY_SUPPLIER: 'Recusada pelo fornecedor',
};

export const EVENT_LABEL: Record<string, string> = {
  REQUESTED: 'Solicitação registrada',
  APPROVED: 'Aprovada',
  STOCK_WITHDRAWN: 'Estoque retirado',
  REJECTED: 'Recusada',
  SENT: 'Enviada ao fornecedor',
  CLOSED: 'Encerrada com resultado',
  REPLACEMENT_RECEIVED: 'Reposição com entrada no estoque',
  CANCELLED: 'Cancelada',
  STOCK_RESTORED: 'Estoque devolvido',
};

export const ACTION_LABEL: Record<SupplierReturnAction, string> = {
  approve: 'Aprovar e retirar do estoque',
  reject: 'Recusar',
  send: 'Registrar envio',
  close: 'Encerrar com resultado',
  cancel: 'Cancelar',
};

/** Etapas do fluxo básico, na ordem (para a linha do tempo da tela). */
export const FLOW_STEPS: Array<{ status: SupplierReturnStatus; label: string }> = [
  { status: 'REQUESTED', label: 'Solicitação' },
  { status: 'APPROVED', label: 'Aprovação e retirada do estoque' },
  { status: 'SENT', label: 'Envio ao fornecedor' },
  { status: 'CLOSED', label: 'Resultado' },
];

/** Índice da etapa atingida (−1 = fluxo interrompido: recusada/cancelada). */
export function flowStepIndex(status: SupplierReturnStatus): number {
  if (status === 'REJECTED' || status === 'CANCELLED') return -1;
  return FLOW_STEPS.findIndex((s) => s.status === status);
}

/** Texto fixo da tela: separa claramente da garantia ao cliente. */
export const NOT_WARRANTY_NOTICE =
  'Devolução ao fornecedor é para produto/peça recebido da cadeia de fornecimento (danificado, com defeito, errado ou não pedido). ' +
  'Não é garantia ao cliente: garantia de serviço/peça do cliente é registrada no encerramento da OS.';

export interface AllowedActions {
  approve: boolean;
  reject: boolean;
  send: boolean;
  close: boolean;
  cancel: boolean;
}

/** Ações a mostrar, na ordem da tela — a API calcula o que o usuário atual pode fazer (papel, política, solicitante). */
export function visibleActions(allowed: Partial<AllowedActions> | null | undefined): SupplierReturnAction[] {
  if (!allowed) return [];
  return (['approve', 'reject', 'send', 'close', 'cancel'] as SupplierReturnAction[]).filter((a) => allowed[a] === true);
}

const toNumber = (s: string): number | null => {
  const raw = String(s ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
  return Number.isFinite(n) ? n : null;
};

export interface ReturnItemRow {
  productId: string;
  productLabel: string;
  quantity: string;
  unitCost: string;
  notes: string;
}

export interface NewReturnForm {
  supplierId: string;
  branchId: string;
  reason: SupplierReturnReason | '';
  description: string;
  items: ReturnItemRow[];
}

export interface CreateReturnPayload {
  supplierId: string;
  branchId?: string;
  reason: SupplierReturnReason;
  description?: string;
  items: Array<{ productId: string; quantity: number; unitCost?: number; notes?: string }>;
}

/** Valida e monta o POST /supplier-returns. `branchRequired`: usuário de empresa inteira precisa escolher a filial. */
export function buildCreatePayload(
  form: NewReturnForm,
  opts: { branchRequired: boolean }
): { ok: true; payload: CreateReturnPayload } | { ok: false; error: string } {
  if (!form.supplierId) return { ok: false, error: 'Selecione o fornecedor.' };
  if (opts.branchRequired && !form.branchId) return { ok: false, error: 'Selecione a filial de onde sai a mercadoria.' };
  if (!form.reason) return { ok: false, error: 'Escolha o motivo da devolução.' };
  const filled = form.items.filter((i) => i.productId);
  if (filled.length === 0) return { ok: false, error: 'Inclua ao menos um produto.' };
  const seen = new Set<string>();
  const items: CreateReturnPayload['items'] = [];
  for (const i of filled) {
    if (seen.has(i.productId)) return { ok: false, error: `"${i.productLabel}" aparece mais de uma vez. Some as quantidades numa linha só.` };
    seen.add(i.productId);
    const quantity = toNumber(i.quantity);
    if (quantity === null || quantity <= 0) return { ok: false, error: `Informe uma quantidade maior que zero para "${i.productLabel}".` };
    const unitCost = toNumber(i.unitCost);
    if (unitCost !== null && unitCost < 0) return { ok: false, error: `O custo de "${i.productLabel}" não pode ser negativo.` };
    items.push({
      productId: i.productId,
      quantity,
      ...(unitCost !== null ? { unitCost } : {}),
      ...(i.notes.trim() ? { notes: i.notes.trim() } : {}),
    });
  }
  return {
    ok: true,
    payload: {
      supplierId: form.supplierId,
      ...(form.branchId ? { branchId: form.branchId } : {}),
      reason: form.reason,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      items,
    },
  };
}

export interface CloseForm {
  outcome: SupplierReturnOutcome | '';
  outcomeAmount: string;
  outcomeNotes: string;
  /** productId → quantidade de reposição que chegou (texto do campo). */
  received: Record<string, string>;
}

export interface ClosePayload {
  outcome: SupplierReturnOutcome;
  outcomeAmount?: number;
  outcomeNotes?: string;
  receivedItems?: Array<{ productId: string; quantity: number }>;
}

/** Valida e monta o POST /supplier-returns/:id/close. A entrada de reposição só vai quando informada (nada automático). */
export function buildClosePayload(
  form: CloseForm,
  returned: Array<{ productId: string; quantity: number; label: string }>
): { ok: true; payload: ClosePayload } | { ok: false; error: string } {
  if (!form.outcome) return { ok: false, error: 'Escolha o resultado informado pelo fornecedor.' };
  let outcomeAmount: number | undefined;
  if (form.outcomeAmount.trim() !== '') {
    const n = toNumber(form.outcomeAmount);
    if (n === null || n < 0) return { ok: false, error: 'Valor inválido: use um número a partir de zero.' };
    outcomeAmount = n;
  }
  const receivedItems: Array<{ productId: string; quantity: number }> = [];
  if (form.outcome === 'REPLACEMENT') {
    for (const r of returned) {
      const raw = form.received[r.productId] ?? '';
      if (raw.trim() === '') continue;
      const q = toNumber(raw);
      if (q === null || q < 0) return { ok: false, error: `Quantidade recebida inválida para "${r.label}".` };
      if (q > r.quantity) return { ok: false, error: `A reposição de "${r.label}" não pode passar do devolvido (${r.quantity}).` };
      if (q > 0) receivedItems.push({ productId: r.productId, quantity: q });
    }
  }
  return {
    ok: true,
    payload: {
      outcome: form.outcome,
      ...(outcomeAmount !== undefined ? { outcomeAmount } : {}),
      ...(form.outcomeNotes.trim() ? { outcomeNotes: form.outcomeNotes.trim() } : {}),
      ...(receivedItems.length > 0 ? { receivedItems } : {}),
    },
  };
}

/** Motivo de recusa/cancelamento: mesmo mínimo da API (5 caracteres). */
export function validateReason(reason: string): string | null {
  return reason.trim().length >= 5 ? null : 'Informe o motivo (mínimo 5 caracteres).';
}
