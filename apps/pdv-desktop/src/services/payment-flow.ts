/**
 * Regras puras do fluxo de pagamento do PDV (sem React, sem rede) — testadas em scripts/payment-flow.test.ts.
 *
 * Estados que o operador vê (nunca "concluída" sem confirmação válida do servidor):
 *   FORM         aguardando pagamento (escolhendo a forma)
 *   CARD_CONFIRM cartão sem TEF: aguardando o operador dizer o que a maquininha respondeu
 *   PROCESSING   enviando ao servidor (botões travados; ESC não fecha)
 *   APPROVED     aprovado pelo servidor → imprime e conclui
 *   DECLINED     recusado (venda NÃO concluída)
 *   CANCELLED    cancelado (venda NÃO concluída)
 *   UNCONFIRMED  não confirmado: pendente (PIX/terminal) ou sem resposta do servidor (venda NÃO concluída)
 */
export type PaymentPhase = 'FORM' | 'CARD_CONFIRM' | 'PROCESSING' | 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'UNCONFIRMED';

/** Situação do pagamento devolvida pela API → estado da tela. Qualquer coisa desconhecida é "não confirmado", nunca aprovado. */
export function phaseFromPaymentStatus(status: unknown): 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'UNCONFIRMED' {
  switch (status) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
    case 'DECLINED':
      return 'DECLINED';
    case 'CANCELLED':
    case 'REFUNDED':
      return 'CANCELLED';
    default:
      return 'UNCONFIRMED';
  }
}

export function newIdempotencyKey(prefix = 'PDV'): string {
  const c: any = (globalThis as any).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${id}`;
}

/** JSON com chaves ordenadas: mesma intenção → mesma assinatura, independentemente da ordem dos campos. */
export function stableSignature(value: unknown): string {
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v)
        .sort()
        .reduce((acc: any, k) => {
          if (v[k] !== undefined) acc[k] = norm(v[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * Tentativa = (assinatura do corpo, chave). Reenviar a MESMA tentativa (sem resposta, 5xx, "já em processamento",
 * pendente) reusa a chave — o servidor devolve o mesmo resultado sem cobrar/criar de novo. Resultado definitivo
 * (recusado, cancelado, erro de regra 4xx) fecha a tentativa: a próxima ganha chave nova. Corpo diferente = tentativa
 * nova (a API recusa com 422 a mesma chave com outro corpo).
 */
export interface Attempt {
  signature: string;
  key: string;
  open: boolean;
}

export function attemptFor(current: Attempt | null, signature: string, prefix = 'PDV'): Attempt {
  if (current && current.open && current.signature === signature) return current;
  return { signature, key: newIdempotencyKey(prefix), open: true };
}

export function closeAttempt(current: Attempt | null): Attempt | null {
  return current ? { ...current, open: false } : null;
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export type PaymentErrorKind =
  | 'NETWORK' // sem resposta: não se sabe se o servidor gravou
  | 'IN_FLIGHT' // 409 da idempotência: a mesma tentativa ainda está sendo processada
  | 'SERVER' // 5xx: a chave é liberada para nova tentativa real
  | 'ALREADY_PAID' // a venda já está paga (ex.: resposta perdida de um pagamento anterior)
  | 'COMMITTED_BY_PENDING' // saldo reservado por um pagamento pendente
  | 'FORBIDDEN'
  | 'BUSINESS'; // regra (4xx): definitivo para esta tentativa

export interface ClassifiedError {
  kind: PaymentErrorKind;
  message: string;
  code?: string;
  status?: number;
}

const ALREADY_PAID = /already fully paid \(concurrent|já foi paga por outro pagamento/i;
const PAID_OR_COMMITTED = /already fully paid|já está paga/i;
const COMMITTED = /committed by pending|reservado por pagamentos pendentes/i;

/** Mensagens de convênio pelo código de erro do contrato da API (docs/CORTEX/policies/PDV.md). */
export const AGREEMENT_ERROR_MESSAGES: Record<string, string> = {
  AGREEMENT_DISABLED: 'Convênio desligado nesta filial. Escolha outra forma de pagamento.',
  AGREEMENT_LIMIT_EXCEEDED: 'Limite do convênio insuficiente para esta venda. Veja o valor disponível ou escolha outra forma.',
  AGREEMENT_BLOCKED: 'Convênio bloqueado. Não pode ser usado até a regularização (fale com a gerência).',
  AGREEMENT_INACTIVE: 'Convênio inativo. Não pode ser usado.',
  AGREEMENT_REQUIRED: 'Selecione o conveniado antes de confirmar.',
  INSTALLMENTS_INVALID: 'Quantidade de parcelas inválida para este convênio.',
};

// Mesmo critério de api.ts::apiErrorMessage: `error` genérico do HTTP ("Conflict") cede lugar a `message`.
const GENERIC_HTTP_ERROR = /^(Unauthorized|Forbidden|Bad Request|Not Found|Conflict|Too Many Requests|Internal Server Error|Invalid Code)$/i;
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{2,}$/; // `error` que é código de máquina cede lugar a `message`
export function readableError(data: any): string {
  if (!data) return '';
  if (typeof data.message === 'string' && (typeof data.error !== 'string' || GENERIC_HTTP_ERROR.test(data.error) || MACHINE_CODE.test(data.error))) return data.message;
  if (typeof data.error === 'string') return data.error;
  if (typeof data.message === 'string') return data.message;
  return '';
}

export function classifyApiError(error: any): ClassifiedError {
  if (!error?.response) {
    return {
      kind: 'NETWORK',
      message: 'Sem resposta do servidor: não sabemos se o pagamento foi registrado. Verifique a conexão e use "Verificar de novo" — a mesma tentativa é reenviada, sem cobrar duas vezes.',
    };
  }
  const status: number = error.response.status;
  const data = error.response.data ?? {};
  const code: string | undefined = typeof data.code === 'string' ? data.code : undefined;
  const raw = readableError(data);

  if (code && AGREEMENT_ERROR_MESSAGES[code]) return { kind: 'BUSINESS', message: AGREEMENT_ERROR_MESSAGES[code], code, status };
  if (status === 409 && /Idempotency-Key já está sendo processada/i.test(raw)) {
    return { kind: 'IN_FLIGHT', message: 'Esta cobrança ainda está sendo processada pelo servidor. Aguarde alguns segundos e use "Verificar de novo".', status };
  }
  if (status >= 500) {
    return { kind: 'SERVER', message: 'O servidor falhou ao processar. Nada foi confirmado; use "Verificar de novo" para reenviar a mesma tentativa.', status };
  }
  if (status === 403) {
    return { kind: 'FORBIDDEN', message: raw && !/^Forbidden$/i.test(raw) ? raw : 'Seu perfil não tem permissão para esta operação. Chame a gerência.', status, code };
  }
  if (ALREADY_PAID.test(raw)) return { kind: 'ALREADY_PAID', message: raw, status, code };
  if (COMMITTED.test(raw)) return { kind: 'COMMITTED_BY_PENDING', message: raw, status, code };
  if (PAID_OR_COMMITTED.test(raw)) return { kind: 'ALREADY_PAID', message: raw, status, code };
  return { kind: 'BUSINESS', message: raw || 'O servidor recusou a operação.', status, code };
}

/** Resultado incerto (a mesma tentativa deve ser reenviada com a mesma chave). */
export function isUncertain(kind: PaymentErrorKind): boolean {
  return kind === 'NETWORK' || kind === 'IN_FLIGHT' || kind === 'SERVER';
}
