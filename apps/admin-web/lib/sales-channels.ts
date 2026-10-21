// Canais de venda (módulo CANAIS): tipos e textos da tela de administração. O tipo técnico é estável; o nome exibido é livre.

export type SalesChannelType = 'LOJA_FISICA' | 'SITE_PROPRIO' | 'IFOOD' | 'MARKETPLACE' | 'OUTRO';
export type ChannelConnectionStatus = 'NOT_CONFIGURED' | 'UNVALIDATED' | 'CONNECTED' | 'ERROR';

export interface SalesChannelView {
  id: string;
  companyId: string;
  branchId: string | null;
  type: SalesChannelType;
  typeLabel: string;
  displayName: string;
  isActive: boolean;
  provider: string | null;
  connectionStatus: ChannelConnectionStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  externalAccountId: string | null;
  hasCredentials: boolean;
  credentialsHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CHANNEL_TYPE_OPTIONS: Array<{ value: SalesChannelType; label: string }> = [
  { value: 'LOJA_FISICA', label: 'Loja física (só personaliza o nome)' },
  { value: 'SITE_PROPRIO', label: 'Site próprio / e-commerce' },
  { value: 'IFOOD', label: 'iFood' },
  { value: 'MARKETPLACE', label: 'Marketplace' },
  { value: 'OUTRO', label: 'Outro canal' },
];

// "Conectado" só existe depois de um teste de conexão real; salvar credencial nunca conecta.
export const CONNECTION_STATUS_LABEL: Record<ChannelConnectionStatus, string> = {
  NOT_CONFIGURED: 'Configuração pendente',
  UNVALIDATED: 'Credencial salva, não validada',
  CONNECTED: 'Conectado (teste de conexão feito)',
  ERROR: 'Erro na conexão',
};

export const EVENT_LEVEL_LABEL: Record<string, string> = { INFO: 'Informação', WARN: 'Aviso', ERROR: 'Erro' };

// ---------- Commerce API (docs/CORTEX/COMMERCE_API.md): credenciais do canal, publicação e pedidos ----------

/** Tipos de canal que usam a Commerce API (o site chama o CÓRTEX). iFood e marketplaces usam o gateway de integração. */
export const COMMERCE_CHANNEL_TYPES: SalesChannelType[] = ['SITE_PROPRIO', 'OUTRO'];
export const usesCommerceApi = (type: SalesChannelType) => COMMERCE_CHANNEL_TYPES.includes(type);

export type ChannelScope = 'CATALOG_READ' | 'ORDERS_READ' | 'ORDERS_WRITE' | 'PAYMENT_EVENTS_WRITE';
export const SCOPE_OPTIONS: Array<{ value: ChannelScope; label: string; hint: string }> = [
  { value: 'CATALOG_READ', label: 'Ler catálogo', hint: 'produtos publicados, preço e disponibilidade' },
  { value: 'ORDERS_READ', label: 'Consultar pedidos', hint: 'ver o estado dos pedidos do canal' },
  { value: 'ORDERS_WRITE', label: 'Criar e cancelar pedidos', hint: 'envia pedidos ao CÓRTEX' },
  { value: 'PAYMENT_EVENTS_WRITE', label: 'Informar pagamentos', hint: 'eventos de pagamento do provedor' },
];

export interface ChannelCredentialView {
  id: string;
  keyId: string;
  label: string;
  scopes: ChannelScope[];
  secretHint: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function credentialState(c: Pick<ChannelCredentialView, 'revokedAt' | 'expiresAt'>, now = Date.now()): 'Ativa' | 'Revogada' | 'Vencida' {
  if (c.revokedAt) return 'Revogada';
  if (c.expiresAt && new Date(c.expiresAt).getTime() <= now) return 'Vencida';
  return 'Ativa';
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Recebido',
  ACCEPTED: 'Aceito',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
  CONVERTED: 'Virou venda',
  EXPIRED: 'Reserva vencida',
};
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  UNKNOWN: 'Sem informação',
  PENDING: 'Pendente',
  CONFIRMED: 'Confirmado',
  FAILED: 'Falhou',
  REFUNDED: 'Estornado',
};

export interface ChannelOrderView {
  orderId: string;
  cortexOrderId: string;
  status: string;
  paymentStatus: string;
  total: number | null;
  currency: 'BRL';
  items: Array<{ sku: string; name: string; quantity: number; unitPrice: number; lineTotal: number }>;
  statusReason: string | null;
  receivedAt: string;
  /** Só depois da conversão em venda. */
  saleNumber?: number;
  fulfillment?: { status: string; type: string | null };
}

/** Recusar só vale para pedido recebido (nada reservado); cancelar vale também para pedido aceito (libera a reserva). */
export const canActOnOrder = (status: string) => status === 'RECEIVED';
export const canCancelOrder = (status: string) => status === 'RECEIVED' || status === 'ACCEPTED';
/** Aceitar = reservar estoque (tudo ou nada). */
export const canAcceptOrder = (status: string) => status === 'RECEIVED';
/** Converter = virar venda; exige pagamento confirmado. Pedido com reserva vencida também pode (tenta reservar de novo). */
export const canConvertOrder = (o: Pick<ChannelOrderView, 'status' | 'paymentStatus'>) => (o.status === 'ACCEPTED' || o.status === 'EXPIRED') && o.paymentStatus === 'CONFIRMED';

export const FULFILLMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Aguardando separação',
  READY: 'Pronto',
  PICKED_UP: 'Retirado',
  IN_TRANSIT: 'Em trânsito',
  DELIVERED: 'Entregue',
  FAILED_DELIVERY: 'Entrega falhou',
  RETURNED: 'Devolvido',
  CANCELLED: 'Cancelado',
};
export const FULFILLMENT_TYPE_LABEL: Record<string, string> = { PICKUP: 'Retirada na loja', OWN_DELIVERY: 'Entrega própria', CHANNEL_DELIVERY: 'Entrega do canal' };

/** Espelha as transições aceitas pela API (a API é quem decide; isto só evita oferecer botão inválido). */
export const FULFILLMENT_NEXT: Record<string, string[]> = {
  PENDING: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED_DELIVERY'],
  FAILED_DELIVERY: ['IN_TRANSIT', 'RETURNED', 'CANCELLED'],
  PICKED_UP: [],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

// ---------- Integration Gateway (caixa de saída e entrada do canal com provedor) ----------
export interface OutboxRowView {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  deadlineAt: string;
  sentAt: string | null;
  lastError: string | null;
  lastErrorKind: string | null;
  createdAt: string;
}

export const OUTBOX_STATUS_LABEL: Record<string, string> = { PENDING: 'Aguardando envio', PROCESSING: 'Enviando', SENT: 'Enviado', DEAD: 'Falhou (precisa de tratamento)', CANCELLED: 'Cancelado' };
export const OUTBOX_TYPE_LABEL: Record<string, string> = {
  INVENTORY_SYNC: 'Estoque',
  PRICE_SYNC: 'Preços',
  CATALOG_SYNC: 'Catálogo',
  ORDER_STATUS: 'Estado do pedido',
  FULFILLMENT_STATUS: 'Entrega',
};
export const INBOUND_OUTCOME_LABEL: Record<string, string> = { APPLIED: 'Aplicados', DEFERRED: 'Aguardando o pedido', REJECTED: 'Recusados', REVIEW: 'Para revisão', FAILED: 'Falharam', RECEIVED: 'Em tratamento' };

/** Só linha que falhou (ou ainda espera) pode ser reenviada ou cancelada por pessoa autorizada. */
export const canRetryOutbox = (status: string) => status === 'DEAD' || status === 'PENDING';

/** Endereço que o provedor chama (webhook): vem da URL da API, sem o sufixo `/api`. O segredo do webhook NUNCA aparece na tela. */
export function webhookUrl(apiUrl: string, channelId: string): string {
  return `${apiUrl.replace(/\/api\/?$/, '').replace(/\/$/, '')}/integrations/v1/webhooks/${channelId}`;
}

/** Separa SKUs digitados (um por linha, vírgula ou ponto e vírgula), sem vazios nem repetidos. */
export function parseSkus(text: string): string[] {
  return [...new Set(text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];
}
