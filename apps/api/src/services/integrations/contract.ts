/**
 * Contrato GENÉRICO de um provedor de integração (Integration Gateway, Fase 3). Nada aqui é específico de iFood, marketplace ou site:
 * qualquer provedor real entra depois só implementando `ChannelProvider` (gateway.ts) com estes tipos. O CÓRTEX é a autoridade dos
 * dados; o provedor é canal de entrada e de saída e NUNCA fonte de verdade. Tudo que vem dele é NÃO CONFIÁVEL e é validado pelo
 * gateway (esquema fechado, identidade, preço, estoque, estado) antes de tocar pedido, pagamento, estoque ou venda.
 */

// ---------- erros do provedor, classificados ----------

/**
 * Como a falha deve ser tratada (docs/CORTEX/COMMERCE_API.md §12):
 *  - AUTH (401/403): credencial inválida → o canal vai a ERROR e para de enviar até ser revalidado; não se insiste;
 *  - RATE_LIMIT (429): respeita `Retry-After`; não conta para o disjuntor (o provedor está vivo, só pediu calma);
 *  - CLIENT (outros 4xx): erro do que foi enviado → sem retentativa (a linha vira DEAD para tratamento); 408/409 repetem;
 *  - SERVER (5xx), TIMEOUT e NETWORK: retentativa com espera crescente; contam para o disjuntor.
 */
export type ProviderErrorKind = 'AUTH' | 'RATE_LIMIT' | 'CLIENT' | 'SERVER' | 'TIMEOUT' | 'NETWORK';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Converte o status HTTP de uma resposta de provedor no erro classificado (provedores reais usam isto). */
export function providerErrorFromStatus(status: number, message = `HTTP ${status}`, retryAfterSec?: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('AUTH', message, status);
  if (status === 429) return new ProviderError('RATE_LIMIT', message, status, retryAfterSec);
  if (status === 408 || status === 409) return new ProviderError('SERVER', message, status); // repete: o provedor pode ter processado ou estar ocupado
  if (status >= 400 && status < 500) return new ProviderError('CLIENT', message, status);
  return new ProviderError('SERVER', message, status);
}

// ---------- eventos de ENTRADA normalizados ----------

/**
 * O que o adaptador do provedor devolve depois de ler um webhook ou uma consulta. É o único formato que o gateway entende; o que ele
 * contém ainda é dado EXTERNO e é revalidado (esquema fechado) antes de ser aplicado. `eventId` é a identidade do evento no provedor
 * (base da idempotência e da proteção contra repetição).
 */
export type NormalizedEvent =
  | { type: 'ORDER_CREATED'; eventId: string; occurredAt?: string; order: unknown }
  | { type: 'PAYMENT'; eventId: string; occurredAt?: string; externalOrderId: string; payment: { providerRef: string; status: string; amount: number; method?: string } }
  | { type: 'ORDER_CANCELLED'; eventId: string; occurredAt?: string; externalOrderId: string; reason?: string };

/** Como o gateway confere a assinatura de um webhook deste provedor (HMAC-SHA256 de `t.corpo`, janela de tempo). */
export interface WebhookSpec {
  /** Nome do cabeçalho com a assinatura (`t=<unix>,v1=<hex>`), em minúsculas. */
  signatureHeader: string;
  toleranceSec?: number;
}

// ---------- operações de SAÍDA ----------

/** Todas as saídas levam uma chave de idempotência (a do registro da caixa de saída): repetir o envio não duplica efeito no provedor. */
export interface OutboundOptions {
  idempotencyKey: string;
  correlationId?: string;
}

export interface CatalogItem {
  sku: string;
  name: string;
  description: string | null;
  brand: string | null;
  unit: string;
  category: string | null;
}

export interface PriceItem {
  sku: string;
  price: number;
}

export interface InventoryItem {
  sku: string;
  quantity: number;
}

/** Estados do pedido que o CÓRTEX comunica ao provedor. `RETURNED` fica só no vocabulário (devolução de canal é decisão 87 pendente). */
export type OutboundOrderStatus = 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'CONVERTED' | 'RETURNED';

export interface OrderStatusUpdate {
  externalOrderId: string;
  status: OutboundOrderStatus;
  reason?: string;
}

export interface FulfillmentUpdate {
  externalOrderId: string;
  status: string;
  type: string | null;
}
