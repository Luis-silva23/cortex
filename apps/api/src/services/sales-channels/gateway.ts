import crypto from 'crypto';
import type { CatalogItem, FulfillmentUpdate, InventoryItem, NormalizedEvent, OrderStatusUpdate, OutboundOptions, PriceItem, WebhookSpec } from '../integrations/contract';

/**
 * Camada genérica de integração (Integration Gateway) dos canais de venda. Nada aqui é específico de um provedor: iFood, site
 * próprio e marketplaces entram depois como `ChannelProvider` registrado no `providerRegistry` — hoje NENHUM está registrado,
 * então nenhuma chamada externa existe (docs/CORTEX/CANAIS.md).
 *
 * Regras que esta camada impõe a qualquer provedor futuro:
 *   - toda chamada externa tem prazo (timeout), retentativa limitada com espera crescente e disjuntor por canal: uma falha ou
 *     lentidão do provedor vira um resultado de erro, nunca uma exceção que derrube o PDV ou a rotina da loja;
 *   - mensagens de erro são sanitizadas antes de ir para log, evento ou tela (sem token, chave ou valor longo);
 *   - webhook só vale com assinatura HMAC válida e dentro da janela de tempo (anti-repetição).
 */

export interface ChannelContext {
  channelId: string;
  companyId: string;
  branchId: string | null;
  provider: string;
  externalAccountId: string | null;
  config: Record<string, unknown> | null;
  /** Credenciais já abertas (cifra removida), só em memória, só durante a chamada; nunca registradas. */
  credentials: Record<string, string> | null;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/**
 * Contrato de um provedor. `testConnection` é o único obrigatório: sem um teste real que dê certo, o canal NUNCA fica "Conectado".
 * Os demais nomes fixam o vocabulário (catálogo, preço, estoque) para quando houver integração homologada.
 */
export interface ChannelProvider {
  key: string;
  testConnection(ctx: ChannelContext): Promise<ProviderTestResult>;

  // ---- ENTRADA (provedor → CÓRTEX). Tudo o que sai daqui é dado externo, revalidado pelo gateway. ----
  /** Se o provedor chama o CÓRTEX por webhook: como a assinatura é conferida. A rota só existe para provedor que declara isto. */
  webhook?: WebhookSpec;
  /** Lê o corpo (já autenticado por assinatura) e devolve eventos normalizados. Lança se o corpo for ilegível: o gateway responde 400. */
  parseWebhook?(input: { rawBody: string; headers: Record<string, string | undefined>; ctx: ChannelContext }): NormalizedEvent[];
  /** Consulta periódica (cobre webhook que não chegou). `cursor` é opaco e só o provedor o interpreta. Lança `ProviderError` se falhar. */
  pollEvents?(ctx: ChannelContext, cursor: string | null): Promise<{ events: NormalizedEvent[]; nextCursor: string | null }>;

  // ---- SAÍDA (CÓRTEX → provedor). Só pela caixa de saída; lançam `ProviderError` classificado. O CÓRTEX é o mestre de tudo isto. ----
  syncCatalog?(ctx: ChannelContext, items: CatalogItem[], opts: OutboundOptions): Promise<void>;
  syncPrices?(ctx: ChannelContext, items: PriceItem[], opts: OutboundOptions): Promise<void>;
  /** O estoque oficial é o livro do CÓRTEX: o provedor recebe o disponível calculado lá, nunca guarda um paralelo. */
  syncInventory?(ctx: ChannelContext, available: InventoryItem[], opts: OutboundOptions): Promise<void>;
  /** Aceite, recusa, cancelamento, expiração e conversão do pedido (e, no futuro, devolução). */
  notifyOrderStatus?(ctx: ChannelContext, update: OrderStatusUpdate, opts: OutboundOptions): Promise<void>;
  notifyFulfillment?(ctx: ChannelContext, update: FulfillmentUpdate, opts: OutboundOptions): Promise<void>;
}

class ProviderRegistry {
  private providers = new Map<string, ChannelProvider>();
  register(provider: ChannelProvider) {
    this.providers.set(provider.key, provider);
  }
  get(key: string | null | undefined): ChannelProvider | undefined {
    return key ? this.providers.get(key) : undefined;
  }
  has(key: string | null | undefined): boolean {
    return !!key && this.providers.has(key);
  }
  /** Só para teste. */
  clear() {
    this.providers.clear();
  }
}
export const providerRegistry = new ProviderRegistry();

// ---------- erros sem segredo ----------

/** Texto de erro seguro para registrar: corta o tamanho e troca tokens, chaves e valores longos por "[omitido]". */
export function sanitizeErrorMessage(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Erro desconhecido';
  return raw
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [omitido]')
    .replace(/((?:api[_-]?key|token|secret|senha|password|authorization|signature)["']?\s*[:=]\s*)["']?[^\s"',;&]+/gi, '$1[omitido]')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[omitido]')
    .slice(0, max);
}

// ---------- prazo, retentativa e disjuntor ----------

export class GatewayTimeoutError extends Error {
  constructor(ms: number) {
    super(`A chamada ao provedor passou de ${ms} ms`);
    this.name = 'GatewayTimeoutError';
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayTimeoutError(ms)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Disjuntor por chave (canal): depois de `threshold` falhas seguidas, recusa chamadas por `openMs` em vez de insistir. */
export class CircuitBreaker {
  private state = new Map<string, { failures: number; openedAt: number | null }>();
  constructor(private threshold = 5, private openMs = 60_000) {}

  canCall(key: string, now = Date.now()): boolean {
    const s = this.state.get(key);
    if (!s || s.openedAt === null) return true;
    if (now - s.openedAt >= this.openMs) {
      // meio-aberto: deixa UMA tentativa passar; se falhar, reabre
      s.openedAt = null;
      s.failures = this.threshold - 1;
      return true;
    }
    return false;
  }
  success(key: string) {
    this.state.delete(key);
  }
  failure(key: string, now = Date.now()) {
    const s = this.state.get(key) ?? { failures: 0, openedAt: null };
    s.failures += 1;
    if (s.failures >= this.threshold) s.openedAt = now;
    this.state.set(key, s);
  }
  isOpen(key: string, now = Date.now()): boolean {
    const s = this.state.get(key);
    return !!s && s.openedAt !== null && now - s.openedAt < this.openMs;
  }
}
export const gatewayBreaker = new CircuitBreaker();

export type SafeCall<T> = { ok: true; value: T } | { ok: false; reason: 'CIRCUIT_OPEN' | 'TIMEOUT' | 'ERROR'; message: string };

/**
 * Executa uma chamada a provedor com prazo, até `retries` novas tentativas (espera `backoffMs`, `2×`, `4×`...) e disjuntor.
 * Nunca lança. Só use retentativa em operação idempotente.
 */
export async function callProviderSafely<T>(
  key: string,
  call: () => Promise<T>,
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number; breaker?: CircuitBreaker } = {}
): Promise<SafeCall<T>> {
  const { timeoutMs = 8000, retries = 1, backoffMs = 250, breaker = gatewayBreaker } = opts;
  if (!breaker.canCall(key)) {
    return { ok: false, reason: 'CIRCUIT_OPEN', message: 'Provedor indisponível: novas tentativas pausadas por alguns instantes' };
  }
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const value = await withTimeout(call(), timeoutMs);
      breaker.success(key);
      return { ok: true, value };
    } catch (err) {
      last = err;
      breaker.failure(key);
      if (attempt < retries && breaker.canCall(key)) await sleep(backoffMs * 2 ** attempt);
      else break;
    }
  }
  return {
    ok: false,
    reason: last instanceof GatewayTimeoutError ? 'TIMEOUT' : 'ERROR',
    message: sanitizeErrorMessage(last),
  };
}

// ---------- assinatura de webhook ----------

/** Assina `${t}.${corpo}` com HMAC-SHA256; devolve `t=<unix>,v1=<hex>` (usado pelo provedor/ferramenta que envia). */
export function signWebhook(secret: string, rawBody: string, timestampSec: number): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}

export type WebhookVerification = { ok: true; timestamp: number } | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'MISMATCH' };

/** Confere o cabeçalho de assinatura: formato, janela de tempo (anti-repetição) e igualdade em tempo constante. */
export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  header: string | undefined;
  toleranceSec?: number;
  nowMs?: number;
}): WebhookVerification {
  const { secret, rawBody, header, toleranceSec = 300, nowMs = Date.now() } = input;
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: 'EXPIRED' };
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'MISMATCH' };
  return { ok: true, timestamp: t };
}
