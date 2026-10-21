// Regras e helpers puros da tela de Orçamentos. NADA aqui inventa regra de
// negócio: tudo espelha o que apps/api/src/services/quote.service.ts e
// routes/quotes.routes.ts já impõem (o backend continua sendo a autoridade —
// isto existe para a tela validar cedo, calcular a prévia e decidir quais
// ações mostrar).

export const QUOTE_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONVERTED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export type QuoteItemType = 'SERVICE' | 'PART';

// Fluxo: ORÇAMENTO → AGUARDANDO APROVAÇÃO → APROVADO → ORDEM DE SERVIÇO. EXPIRED = encerrado sem resposta do cliente
// (manual em lote ou pela rotina automática) — pode ser reaberto conforme a política quote.allowReopen.
export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  DRAFT: 'Orçamento',
  SENT: 'Aguardando aprovação',
  APPROVED: 'Aprovado',
  REJECTED: 'Recusado',
  EXPIRED: 'Encerrado',
  CONVERTED: 'Convertido em OS',
};

// ---------------------------------------------------------------------------
// Vencidos, encerramento e reabertura (espelha quote.service.ts: close/reopen)
// ---------------------------------------------------------------------------

/** Pode entrar na seleção de encerramento? (a API decide de verdade: SENT só vencido; DRAFT sempre). */
export function isClosable(quote: { status: string; overdue?: boolean }): boolean {
  return quote.status === 'DRAFT' || (quote.status === 'SENT' && quote.overdue === true);
}

export const CLOSE_REASON_MIN = 5;
export const REOPEN_REASON_MIN = 5;

export const CLOSE_OUTCOME_LABEL: Record<string, string> = {
  CLOSED: 'Encerrado',
  ALREADY_CLOSED: 'Já estava encerrado',
  NOT_ALLOWED: 'Não permitido',
  NOT_FOUND: 'Não encontrado',
};

export const QUOTE_EVENT_LABEL: Record<string, string> = {
  CLOSED: 'Encerrado manualmente',
  EXPIRED: 'Encerrado automaticamente (sem resposta)',
  REOPENED: 'Reaberto',
};

/** "Sem resposta há N dias" para a lista/detalhe. */
export function overdueLabel(quote: { overdue?: boolean; daysWithoutResponse?: number | null }): string | null {
  if (!quote.overdue) return null;
  const days = quote.daysWithoutResponse ?? 0;
  return `Vencido · sem resposta há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

// Cores semânticas SÓ no status (verde = sucesso, amarelo = aguardando,
// vermelho = recusado); rascunho/expirado ficam neutros.
export const QUOTE_STATUS_VARIANT: Record<QuoteStatus, 'secondary' | 'warning' | 'success' | 'error'> = {
  DRAFT: 'secondary',
  SENT: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  EXPIRED: 'secondary',
  CONVERTED: 'success',
};

export const ITEM_TYPE_LABEL: Record<QuoteItemType, string> = {
  SERVICE: 'Serviço',
  PART: 'Peça',
};

// Mesmos papéis do gate de escrita de quotes.routes.ts (todos menos VIEWER).
const WRITE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'];
export function canWriteQuotes(userType: string | null | undefined): boolean {
  return !!userType && WRITE_ROLES.includes(userType);
}

// Limites do schema (Decimal(10,3) e Decimal(10,2)) — mesmos de quote.service.ts.
export const MAX_QUANTITY = 9_999_999;
export const MAX_MONEY = 99_999_999.99;

export interface QuoteItemPayload {
  itemType: QuoteItemType;
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

// Linha do formulário: campos numéricos como string (é o que <input> entrega).
export interface QuoteItemDraft {
  key: string;
  itemType: QuoteItemType;
  productId?: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

let draftCounter = 0;
export function newItemDraft(itemType: QuoteItemType = 'SERVICE', overrides: Partial<QuoteItemDraft> = {}): QuoteItemDraft {
  draftCounter += 1;
  return { key: `item-${Date.now()}-${draftCounter}`, itemType, description: '', quantity: '1', unitPrice: '', ...overrides };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineTotal(quantity: number, unitPrice: number): number {
  return round2(quantity * unitPrice);
}

export interface QuoteTotals {
  laborTotal: number;
  partsTotal: number;
  discountAmount: number;
  totalAmount: number;
}

// Mesma soma de computeTotals() do backend: soma as linhas SEM arredondar
// cada uma e arredonda o total por tipo (Decimal(10,2)). `discountAmount` é
// sempre 0 hoje — o backend fixa 0 e não há regra/autorização de desconto em
// orçamentos; a tela só o exibe.
export function computeQuoteTotals(items: Array<{ itemType: QuoteItemType; quantity: number; unitPrice: number }>): QuoteTotals {
  const sum = (type: QuoteItemType) =>
    items.filter((i) => i.itemType === type).reduce((acc, i) => acc + i.quantity * i.unitPrice, 0);
  const laborTotal = round2(sum('SERVICE'));
  const partsTotal = round2(sum('PART'));
  return { laborTotal, partsTotal, discountAmount: 0, totalAmount: round2(laborTotal + partsTotal) };
}

export function formatCurrency(value: number | string | null | undefined): string {
  return Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatQuantity(value: number | string): string {
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function parseNumber(raw: string): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return NaN;
  return Number(String(raw).replace(',', '.'));
}

export interface ItemValidationResult {
  payload: QuoteItemPayload[];
  errors: Record<string, string>;
  message: string | null;
}

// Espelha assertValidItems() do backend, com mensagens em português apontando
// a linha. Retorna também o payload já convertido para o formato da API.
export function validateItemDrafts(drafts: QuoteItemDraft[]): ItemValidationResult {
  const errors: Record<string, string> = {};
  const payload: QuoteItemPayload[] = [];

  if (drafts.length === 0) {
    return { payload, errors, message: 'Adicione pelo menos um item ao orçamento.' };
  }

  drafts.forEach((draft, index) => {
    const label = `Item ${index + 1}`;
    const quantity = parseNumber(draft.quantity);
    const unitPrice = parseNumber(draft.unitPrice);

    if (draft.description.trim() === '') {
      errors[draft.key] = `${label}: informe a descrição.`;
    } else if (!Number.isFinite(quantity) || quantity <= 0) {
      errors[draft.key] = `${label}: a quantidade deve ser maior que zero.`;
    } else if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors[draft.key] = `${label}: informe o valor unitário (zero ou mais).`;
    } else if (quantity > MAX_QUANTITY || unitPrice > MAX_MONEY || quantity * unitPrice > MAX_MONEY) {
      errors[draft.key] = `${label}: o valor excede o limite suportado.`;
    } else {
      payload.push({
        itemType: draft.itemType,
        ...(draft.itemType === 'PART' && draft.productId ? { productId: draft.productId } : {}),
        description: draft.description.trim(),
        quantity,
        unitPrice,
      });
    }
  });

  if (Object.keys(errors).length === 0) {
    const total = computeQuoteTotals(payload).totalAmount;
    if (total > MAX_MONEY) {
      return { payload, errors, message: 'O total do orçamento excede o limite suportado.' };
    }
  }

  const first = Object.values(errors)[0];
  return { payload, errors, message: first ?? null };
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

// <input type="date"> entrega "YYYY-MM-DD". `new Date('2026-09-30')` é UTC e
// no Brasil vira o dia anterior; validade vale até o FIM do dia local.
export function endOfDayIso(dateValue: string): string | undefined {
  if (!dateValue) return undefined;
  return new Date(`${dateValue}T23:59:59`).toISOString();
}

export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}

// Orçamento ainda em aberto cuja validade já passou (só indicação visual: o
// backend não muda o status sozinho — EXPIRED existe no enum mas nada o define).
export function isPastValidity(quote: { status: string; validUntil?: string | null }, now: Date = new Date()): boolean {
  if (!quote.validUntil) return false;
  if (quote.status !== 'DRAFT' && quote.status !== 'SENT' && quote.status !== 'APPROVED') return false;
  return new Date(quote.validUntil).getTime() < now.getTime();
}

// ---------------------------------------------------------------------------
// Fluxo: o que cada estado permite (espelha quote.service.ts)
// ---------------------------------------------------------------------------

export interface QuoteVersionLike {
  versionNumber: number;
  sentAt?: string | null;
  isApproved?: boolean;
  approvedAt?: string | null; // preenchido em QUALQUER decisão (aprovar ou recusar)
  serviceOrder?: { id: string; osNumber: number; status: string } | null;
}

export function latestVersion<T extends QuoteVersionLike>(versions: T[] | undefined): T | undefined {
  if (!versions || versions.length === 0) return undefined;
  return versions.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
}

export interface QuoteActions {
  canSend: boolean;
  canDecide: boolean;
  canConvert: boolean;
  canAddVersion: boolean;
  linkedServiceOrder: { id: string; osNumber: number; status: string } | null;
}

export function quoteActions(
  quote: { status: string; versions?: QuoteVersionLike[] },
  canWrite: boolean
): QuoteActions {
  const status = quote.status;
  const latest = latestVersion(quote.versions);
  const linked = quote.versions?.find((v) => v.serviceOrder)?.serviceOrder ?? null;
  const none = { canSend: false, canDecide: false, canConvert: false, canAddVersion: false, linkedServiceOrder: linked };

  // Encerrado: só a reabertura (tratada à parte) devolve ao fluxo; enviar/decidir/versionar ficam bloqueados na API.
  if (!canWrite || !latest || status === 'CONVERTED' || status === 'EXPIRED') return none;

  return {
    // Enviar: a última versão ainda não foi enviada (reenviar é idempotente
    // no backend, então não oferecemos de novo).
    canSend: status === 'DRAFT' && !latest.sentAt,
    // Decidir: versão enviada e ainda sem decisão registrada.
    canDecide: !!latest.sentAt && !latest.approvedAt,
    // Converter: somente APPROVED (a versão aprovada vira a OS).
    canConvert: status === 'APPROVED',
    // Nova versão: em APPROVED já existe uma versão decidida pronta para
    // virar OS; criar outra deixaria o orçamento APPROVED com uma última
    // versão não enviada — ambíguo, então a tela não oferece.
    canAddVersion: status !== 'APPROVED',
    linkedServiceOrder: linked,
  };
}

export type StepState = 'done' | 'current' | 'pending' | 'blocked';

export interface WorkflowStep {
  label: string;
  state: StepState;
}

// Salvo → Enviado ao cliente → Decisão do cliente → OS gerada.
export function workflowSteps(status: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [
    { label: 'Orçamento salvo', state: 'done' },
    { label: 'Enviado ao cliente', state: 'pending' },
    { label: 'Decisão do cliente', state: 'pending' },
    { label: 'OS gerada', state: 'pending' },
  ];

  switch (status) {
    case 'DRAFT':
      steps[1].state = 'current';
      break;
    case 'SENT':
      steps[1].state = 'done';
      steps[2].state = 'current';
      break;
    case 'EXPIRED':
      steps[1].state = 'done';
      steps[2] = { label: 'Encerrado sem resposta', state: 'blocked' };
      break;
    case 'APPROVED':
      steps[1].state = 'done';
      steps[2] = { label: 'Cliente aprovou', state: 'done' };
      steps[3].state = 'current';
      break;
    case 'REJECTED':
      steps[1].state = 'done';
      steps[2] = { label: 'Cliente recusou', state: 'blocked' };
      break;
    case 'CONVERTED':
      steps[1].state = 'done';
      steps[2] = { label: 'Cliente aprovou', state: 'done' };
      steps[3].state = 'done';
      break;
  }
  return steps;
}
