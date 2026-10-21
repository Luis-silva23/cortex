/**
 * Erros da Commerce API (`/commerce/v1`). Cada um tem status HTTP, um CÓDIGO estável (o canal programa contra o código, não contra o
 * texto) e uma mensagem sem nenhum detalhe técnico. `details` só leva dados que o próprio canal enviou (ex.: SKUs recusados).
 */
export class CommerceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'CommerceError';
  }
}

export const commerceError = {
  unauthorized: () => new CommerceError(401, 'UNAUTHORIZED', 'Credencial inválida, expirada ou assinatura incorreta.'),
  forbiddenScope: (scope: string) => new CommerceError(403, 'INSUFFICIENT_SCOPE', `A credencial não tem o escopo ${scope}.`),
  channelDisabled: () => new CommerceError(403, 'CHANNEL_DISABLED', 'Canal desativado ou módulo de canais desligado.'),
  rateLimited: (retryAfterSec: number) => new CommerceError(429, 'RATE_LIMITED', 'Muitas requisições. Tente novamente em instantes.', { retryAfterSec }),
  invalidRequest: (details?: unknown) => new CommerceError(400, 'INVALID_REQUEST', 'Requisição inválida.', details),
  idempotencyKeyRequired: () => new CommerceError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'O cabeçalho Idempotency-Key é obrigatório nesta operação.'),
  notFound: (what = 'Recurso') => new CommerceError(404, 'NOT_FOUND', `${what} não encontrado.`),
  productUnavailable: (skus: string[]) => new CommerceError(422, 'PRODUCT_UNAVAILABLE', 'Há produtos indisponíveis para este canal.', { skus }),
  priceMismatch: (items: Array<{ sku: string; channelUnitPrice: number; currentPrice: number }>) =>
    new CommerceError(422, 'PRICE_MISMATCH', 'O preço informado difere do preço atual. Atualize o catálogo e refaça o pedido.', { items }),
  totalMismatch: (channelTotal: number, expectedTotal: number) =>
    new CommerceError(422, 'TOTAL_MISMATCH', 'O total informado difere do total calculado pelo CÓRTEX.', { channelTotal, expectedTotal }),
  orderConflict: () => new CommerceError(409, 'ORDER_CONFLICT', 'Este pedido já foi recebido com conteúdo diferente.'),
  invalidState: (status: string) => new CommerceError(409, 'INVALID_ORDER_STATE', `A operação não é permitida no estado atual do pedido (${status}).`, { status }),
  channelBranchRequired: () => new CommerceError(409, 'CHANNEL_BRANCH_REQUIRED', 'O canal precisa estar vinculado a uma filial de atendimento.'),
  reservationTtlNotConfigured: () =>
    new CommerceError(409, 'RESERVATION_TTL_NOT_CONFIGURED', 'Defina o prazo da reserva de estoque na configuração do canal (reservationTtlMinutes) antes de aceitar pedidos. O prazo é uma decisão comercial e não tem valor padrão.'),
  insufficientStock: (items: Array<{ sku: string; requested: number; available: number }>) =>
    new CommerceError(409, 'INSUFFICIENT_STOCK', 'Não há estoque disponível para todos os itens do pedido.', { items }),
  paymentNotConfirmed: () => new CommerceError(409, 'PAYMENT_NOT_CONFIRMED', 'O pedido só vira venda com o pagamento confirmado no valor total do pedido.'),
  reservationLost: (items: Array<{ sku: string; requested: number; available: number }>) =>
    new CommerceError(409, 'RESERVATION_LOST_NO_STOCK', 'A reserva venceu e não há estoque disponível para reservar de novo. O pagamento confirmado precisa de tratamento por pessoa autorizada.', { items }),
  insufficientPhysicalStock: (items: Array<{ sku: string; requested: number; balance: number }>) =>
    new CommerceError(409, 'INSUFFICIENT_PHYSICAL_STOCK', 'O saldo físico não cobre o pedido (houve baixa depois da reserva). A venda não foi criada.', { items }),
  fulfillmentInvalid: (message: string) => new CommerceError(409, 'INVALID_FULFILLMENT_TRANSITION', message),
};
