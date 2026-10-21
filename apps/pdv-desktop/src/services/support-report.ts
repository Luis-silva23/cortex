// "Relatar problema" no PDV (docs/CORTEX/SUPPORT.md). Funções puras: o servidor é a autoridade — empresa, filial e usuário
// vêm do token, e a venda/pagamento citados são conferidos na empresa do operador. Aqui só montamos o contexto que a
// tela já sabe e checamos o texto antes de enviar.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SUBJECT_MAX = 160;

export interface TicketContextInput {
  screen: string;
  saleId?: string | null;
  paymentId?: string | null;
  registerNumber?: number | string | null;
}

export interface TicketContext {
  screen: string;
  terminal?: string;
  entityType?: 'PAYMENT' | 'SALE';
  entityId?: string;
}

/** Pagamento tem prioridade sobre a venda; id malformado é descartado (nunca vai para a API). */
export function buildTicketContext(i: TicketContextInput): TicketContext {
  const ctx: TicketContext = { screen: i.screen.trim().slice(0, 80) };
  const register = i.registerNumber !== null && i.registerNumber !== undefined ? String(i.registerNumber).trim() : '';
  if (register) ctx.terminal = `Caixa #${register}`.slice(0, 60);
  if (i.paymentId && UUID.test(i.paymentId)) {
    ctx.entityType = 'PAYMENT';
    ctx.entityId = i.paymentId;
  } else if (i.saleId && UUID.test(i.saleId)) {
    ctx.entityType = 'SALE';
    ctx.entityId = i.saleId;
  }
  return ctx;
}

/** Corpo de POST /api/support/tickets: o contexto vai aninhado em `context` (o schema da API é estrito). */
export function buildTicketPayload(input: { subject: string; description: string; type: string; context: TicketContext }) {
  return {
    subject: input.subject.trim(),
    description: input.description.trim(),
    module: 'PDV' as const,
    type: input.type,
    context: input.context,
  };
}

export const REPORT_TYPES = [
  { value: 'PROBLEMA', label: 'Problema' },
  { value: 'DUVIDA', label: 'Dúvida' },
] as const;

/** A API grava a resposta 4xx sob a chave; corrigir o texto e reenviar exige chave nova. Sem resposta/5xx a chave é mantida. */
export function shouldRenewIdempotencyKey(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** Mesmas regras de tamanho da API (assunto 3+, descrição 10+); a API valida de novo. */
export function validateReport(input: { subject: string; description: string }): string | null {
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject.length < 3) return 'Informe o assunto (mínimo 3 caracteres).';
  if (subject.length > SUBJECT_MAX) return `Assunto: no máximo ${SUBJECT_MAX} caracteres.`;
  if (description.length < 10) return 'Descreva o que aconteceu (mínimo 10 caracteres).';
  return null;
}
