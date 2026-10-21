import { z } from 'zod';
import { providerRegistry, type ChannelProvider } from '../sales-channels/gateway';
import { ProviderError, type NormalizedEvent } from './contract';

/**
 * Provedor SANDBOX (simulado): a primeira implementação do contrato genérico, para desenvolver, demonstrar e provar o Integration
 * Gateway SEM nenhum serviço externo real. Não abre conexão de rede, não usa credencial real e não existe em produção a menos que
 * `CHANNEL_SANDBOX_PROVIDER=true` seja ligado de propósito.
 *
 * Comportamento controlável (só para teste/demonstração) por `sandboxControl`: falhas programadas nas saídas, eventos para a consulta
 * periódica e o registro de tudo que "o provedor" recebeu — com a idempotência que um provedor sério tem (a mesma chave não conta duas vezes).
 */
export const SANDBOX_KEY = 'sandbox';

export const sandboxControl = {
  /** Chamadas de saída que o "provedor" aceitou (sem repetir a mesma chave de idempotência). */
  received: [] as Array<{ op: string; idempotencyKey: string; payload: unknown }>,
  /** Quantas chamadas chegaram ao total (inclui repetidas e as que falharam). */
  attempts: 0,
  /** Fila de falhas: cada chamada de saída consome a primeira (se houver) e lança. */
  failures: [] as ProviderError[],
  /** Eventos que a consulta periódica devolverá (consumidos em ordem). */
  pollQueue: [] as NormalizedEvent[],
  reset() {
    this.received = [];
    this.attempts = 0;
    this.failures = [];
    this.pollQueue = [];
  },
};

const webhookBody = z.object({ events: z.array(z.record(z.unknown())).min(1).max(50) }).strict();

function record(op: string, payload: unknown, idempotencyKey: string) {
  sandboxControl.attempts += 1;
  const failure = sandboxControl.failures.shift();
  if (failure) throw failure;
  if (!sandboxControl.received.some((r) => r.idempotencyKey === idempotencyKey)) sandboxControl.received.push({ op, idempotencyKey, payload });
}

export const sandboxProvider: ChannelProvider = {
  key: SANDBOX_KEY,
  webhook: { signatureHeader: 'x-sandbox-signature' },

  async testConnection(ctx) {
    const apiKey = ctx.credentials?.apiKey;
    if (!apiKey) return { ok: false, message: 'Informe o campo apiKey na credencial' };
    if (apiKey === 'invalid') return { ok: false, message: 'Credencial recusada pelo provedor simulado' };
    return { ok: true, message: 'Provedor simulado respondeu normalmente' };
  },

  parseWebhook({ rawBody }) {
    const parsed = webhookBody.safeParse(JSON.parse(rawBody));
    if (!parsed.success) throw new Error('Corpo do webhook inválido');
    return parsed.data.events as unknown as NormalizedEvent[];
  },

  async pollEvents(_ctx, cursor) {
    const take = sandboxControl.pollQueue.splice(0, 50);
    const next = Number(cursor ?? 0) + take.length;
    return { events: take, nextCursor: String(next) };
  },

  async syncCatalog(_ctx, items, opts) {
    record('syncCatalog', items, opts.idempotencyKey);
  },
  async syncPrices(_ctx, items, opts) {
    record('syncPrices', items, opts.idempotencyKey);
  },
  async syncInventory(_ctx, items, opts) {
    record('syncInventory', items, opts.idempotencyKey);
  },
  async notifyOrderStatus(_ctx, update, opts) {
    record('notifyOrderStatus', update, opts.idempotencyKey);
  },
  async notifyFulfillment(_ctx, update, opts) {
    record('notifyFulfillment', update, opts.idempotencyKey);
  },
};

/** Registra o sandbox fora de produção, ou em produção só se for ligado de propósito. Chamado na partida da API. */
export function registerSandboxProviderIfAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = env.NODE_ENV !== 'production' || env.CHANNEL_SANDBOX_PROVIDER === 'true';
  if (allowed) providerRegistry.register(sandboxProvider);
  return allowed;
}
