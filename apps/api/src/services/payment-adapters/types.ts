/**
 * Contrato para um adaptador de gateway de pagamento (TEF, PIX, cartão, etc).
 *
 * O objetivo desta interface é isolar o `PaymentService` de qualquer detalhe
 * de integração real. Hoje nenhum dos adaptadores implementados conversa com
 * um gateway de verdade (não há credenciais/sandbox neste ambiente) — mas o
 * contrato já é desenhado para o caso real: cobrança pode ser instantânea
 * (dinheiro), "confiar no operador" (cartão manual sem TEF) ou assíncrona
 * (PIX/TEF, que dependem de confirmação externa).
 *
 * IMPORTANTE sobre status: `PaymentGatewayStatus` é mais rico que o enum
 * `PaymentStatus` do Prisma (schema.prisma) de propósito. TIMEOUT e UNKNOWN
 * são estados transientes do processo de cobrança — nunca devem ser
 * persistidos como tal no banco, pois não são um status final do pagamento.
 * O `PaymentService` mapeia esses dois para `PENDING` no banco (o pagamento
 * fica "em aberto, aguardando confirmação"), preservando o motivo real em
 * `notes`/log para quem for reconciliar depois.
 *
 * Se um gateway real for integrado, `PaymentStatus` (schema.prisma) pode
 * precisar crescer para incluir algo como `TIMED_OUT` ou `UNKNOWN` como
 * status final "preso" que precisa de intervenção manual — isso é uma
 * mudança de schema e está fora do escopo desta tarefa (ver relatório).
 */
export type PaymentGatewayStatus =
  | 'APPROVED'
  | 'DECLINED'
  | 'PENDING'
  | 'TIMEOUT'
  | 'UNKNOWN'
  | 'CANCELLED'
  /** só como resposta de `refund` */
  | 'REFUNDED';

export interface ChargeRequest {
  amount: number;
  paymentMethod: string;
  installments?: number;
  /**
   * Identificador de transação fornecido pelo chamador (idempotência).
   * Quando ausente, o adaptador pode gerar um identificador interno, mas
   * hoje nenhum adaptador implementado faz isso — a idempotência é sempre
   * responsabilidade de quem chama `processPayment`.
   */
  transactionId?: string;
  authorizationCode?: string;
  cardBrand?: string;
  cardLastDigits?: string;
  nsuHost?: string;
  nsuTef?: string;
  notes?: string;
}

export interface ChargeResult {
  status: PaymentGatewayStatus;
  authorizationCode?: string;
  transactionId?: string;
  nsuHost?: string;
  nsuTef?: string;
  /** Motivo legível para humano (ex.: por que ficou PENDING/DECLINED). */
  reason?: string;
  /** Payload bruto do gateway, para auditoria/depuração futura. */
  raw?: unknown;
}

export interface PaymentGatewayAdapter {
  /** Nome do adaptador, para logging/depuração. */
  readonly name: string;

  /**
   * Cobrança depende de terminal/provedor externo (TEF, PIX de PSP): o pagamento é gravado PENDING com a chave de
   * idempotência ANTES de acionar o adaptador, para que uma resposta perdida possa ser reconciliada sem cobrar de novo.
   */
  readonly external?: boolean;

  /** Desfaz no provedor uma transação ainda não confirmada; devolve o status real (pode ter sido aprovada). */
  cancel?(transactionId: string): Promise<ChargeResult>;

  /** Estorna no provedor uma transação já aprovada/capturada (idempotente pela transação); REFUNDED quando confirmado. */
  refund?(transactionId: string, amount: number): Promise<ChargeResult>;

  /** Inicia a cobrança. Pode resolver de forma síncrona ou ficar PENDING. */
  charge(request: ChargeRequest): Promise<ChargeResult>;

  /**
   * Consulta o status atual de uma transação já iniciada (reconciliação).
   * Para adaptadores sem gateway real por trás, isso é necessariamente um
   * no-op honesto: devolve o mesmo status incerto de antes, já que não há
   * nada real para consultar. Quando um gateway real for integrado, aqui é
   * onde entra a chamada à API de consulta de status dele.
   */
  checkStatus(transactionId: string): Promise<ChargeResult>;
}
