jest.mock('@ln-system/database', () => ({ prisma: {}, prismaUnsafeBypassRLS: {}, runInTransaction: jest.fn(), runWithRLSContext: jest.fn() }));
jest.mock('../stock-ledger', () => ({ stockLedger: { balances: jest.fn() } }));
jest.mock('../stock-reservations', () => ({ availabilityOf: jest.fn(), lockProductsInOrder: jest.fn(), reservationShortfalls: jest.fn(), releaseReservations: jest.fn() }));
jest.mock('../module-settings.service', () => ({ __esModule: true, default: { isModuleEnabled: jest.fn() } }));

import { GatewayTimeoutError, providerRegistry, signWebhook, verifyWebhookSignature } from '../sales-channels/gateway';
import { ProviderError, providerErrorFromStatus } from './contract';
import { backoffMs, classifyFailure, MAX_ATTEMPTS, planFailure } from './outbox.service';
import { normalizedEventSchema } from './inbound.service';
import { registerSandboxProviderIfAllowed, sandboxProvider } from './sandbox.provider';

describe('classificação de erro do provedor (HTTP → tratamento)', () => {
  it('401/403 = AUTH; 429 = RATE_LIMIT com Retry-After; 408/409 e 5xx repetem; os demais 4xx são erro de requisição', () => {
    expect(providerErrorFromStatus(401).kind).toBe('AUTH');
    expect(providerErrorFromStatus(403).kind).toBe('AUTH');
    const limited = providerErrorFromStatus(429, 'devagar', 30);
    expect(limited).toMatchObject({ kind: 'RATE_LIMIT', retryAfterSec: 30 });
    expect(providerErrorFromStatus(408).kind).toBe('SERVER');
    expect(providerErrorFromStatus(409).kind).toBe('SERVER');
    expect(providerErrorFromStatus(500).kind).toBe('SERVER');
    expect(providerErrorFromStatus(503).kind).toBe('SERVER');
    expect(providerErrorFromStatus(400).kind).toBe('CLIENT');
    expect(providerErrorFromStatus(422).kind).toBe('CLIENT');
  });

  it('timeout do gateway é TIMEOUT; erro desconhecido é NETWORK; a mensagem é sanitizada (sem token)', () => {
    expect(classifyFailure(new GatewayTimeoutError(8000)).kind).toBe('TIMEOUT');
    const unknown = classifyFailure(new Error('falhou com Bearer abcdefghijklmnopqrstuvwxyz0123456789 e token=segredo-super-longo-123456'));
    expect(unknown.kind).toBe('NETWORK');
    expect(unknown.message).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(unknown.message).not.toContain('segredo-super-longo');
  });
});

describe('política de falha da caixa de saída', () => {
  const plan = (err: unknown, attempt = 1, max = MAX_ATTEMPTS) => planFailure(err, attempt, max, 0.5);

  it('espera crescente com teto de 30 min e variação de ±10%', () => {
    expect(backoffMs(1, 0.5)).toBe(30_000);
    expect(backoffMs(2, 0.5)).toBe(60_000);
    expect(backoffMs(3, 0.5)).toBe(120_000);
    expect(backoffMs(20, 0.5)).toBe(30 * 60_000);
    expect(backoffMs(1, 0)).toBe(27_000);
    expect(backoffMs(1, 1)).toBe(33_000);
  });

  it('AUTH: para e pausa o canal (não repete)', () => {
    expect(plan(new ProviderError('AUTH', 'x', 401)).action).toBe('AUTH');
  });

  it('4xx (CLIENT): DEAD na primeira, sem retentativa e sem contar no disjuntor', () => {
    expect(plan(new ProviderError('CLIENT', 'x', 422))).toMatchObject({ action: 'DEAD', reason: 'CLIENT_ERROR', countsForBreaker: false });
  });

  it('5xx, timeout e rede: repetem com espera crescente e contam para o disjuntor', () => {
    for (const kind of ['SERVER', 'TIMEOUT', 'NETWORK'] as const) {
      expect(plan(new ProviderError(kind, 'x'), 1)).toMatchObject({ action: 'RETRY', delayMs: 30_000, countsForBreaker: true });
    }
    expect(plan(new ProviderError('SERVER', 'x'), 3)).toMatchObject({ action: 'RETRY', delayMs: 120_000 });
  });

  it('429: respeita o Retry-After (com piso e teto) e NÃO conta para o disjuntor', () => {
    expect(plan(new ProviderError('RATE_LIMIT', 'x', 429, 90))).toMatchObject({ action: 'RETRY', delayMs: 90_000, countsForBreaker: false });
    expect(plan(new ProviderError('RATE_LIMIT', 'x', 429, 99_999))).toMatchObject({ delayMs: 3_600_000 });
    expect(plan(new ProviderError('RATE_LIMIT', 'x', 429))).toMatchObject({ action: 'RETRY', delayMs: 30_000, countsForBreaker: false }); // sem cabeçalho: espera padrão
  });

  it('estourou o limite de tentativas: DEAD, mesmo em falha transitória', () => {
    expect(plan(new ProviderError('SERVER', 'x'), MAX_ATTEMPTS)).toMatchObject({ action: 'DEAD', reason: 'MAX_ATTEMPTS' });
    expect(plan(new ProviderError('RATE_LIMIT', 'x', 429, 10), 2, 2)).toMatchObject({ action: 'DEAD', reason: 'MAX_ATTEMPTS', countsForBreaker: false });
  });
});

describe('eventos normalizados do provedor: esquema fechado', () => {
  const order = { externalOrderId: 'P-1', items: [{ sku: 'ABC', quantity: 1, unitPrice: 10 }], total: 10 };
  const base = { eventId: 'ev-1', occurredAt: '2026-10-05T12:00:00.000Z' };

  it('aceita pedido, pagamento e cancelamento bem formados', () => {
    expect(normalizedEventSchema.safeParse({ type: 'ORDER_CREATED', ...base, order }).success).toBe(true);
    expect(normalizedEventSchema.safeParse({ type: 'PAYMENT', ...base, externalOrderId: 'P-1', payment: { providerRef: 'R1', status: 'CONFIRMED', amount: 10, method: 'PIX' } }).success).toBe(true);
    expect(normalizedEventSchema.safeParse({ type: 'ORDER_CANCELLED', ...base, externalOrderId: 'P-1', reason: 'desistiu' }).success).toBe(true);
  });

  it('recusa campo desconhecido (inclusive empresa e filial), tipo desconhecido, id fora do padrão e valor inválido', () => {
    const bad = (e: unknown) => expect(normalizedEventSchema.safeParse(e).success).toBe(false);
    bad({ type: 'ORDER_CREATED', ...base, order, companyId: 'outra-empresa' });
    bad({ type: 'ORDER_CREATED', ...base, order: { ...order, branchId: 'x' } });
    bad({ type: 'ORDER_CREATED', ...base, order: { ...order, items: [] } });
    bad({ type: 'ORDER_CREATED', ...base, order: { ...order, total: -1 } });
    bad({ type: 'ORDER_CREATED', ...base, eventId: 'tem espaço', order });
    bad({ type: 'ORDER_CREATED', ...base, order: { ...order, externalOrderId: '../../etc' } });
    bad({ type: 'REFUND_EVERYTHING', ...base, externalOrderId: 'P-1' });
    bad({ type: 'PAYMENT', ...base, externalOrderId: 'P-1', payment: { providerRef: 'R1', status: 'CONFIRMED', amount: '10' } });
    bad({ type: 'PAYMENT', ...base, externalOrderId: 'P-1', payment: { providerRef: 'R1', status: 'APROVADO', amount: 10 } });
    bad({ type: 'PAYMENT', ...base, externalOrderId: 'P-1', payment: { providerRef: 'R1', status: 'CONFIRMED', amount: 10.005 } });
    bad({ type: 'ORDER_CANCELLED', ...base, eventId: 'x'.repeat(200), externalOrderId: 'P-1' });
    bad({ type: 'ORDER_CANCELLED', ...base, occurredAt: 'ontem', externalOrderId: 'P-1' });
  });
});

describe('assinatura do webhook (anti-repetição)', () => {
  const secret = 'whsec_teste';
  const body = '{"events":[]}';
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const ts = Math.floor(now / 1000);

  it('aceita dentro da janela, recusa corpo alterado, segredo errado e carimbo fora de 300 s', () => {
    const header = signWebhook(secret, body, ts);
    expect(verifyWebhookSignature({ secret, rawBody: body, header, nowMs: now }).ok).toBe(true);
    expect(verifyWebhookSignature({ secret, rawBody: body + ' ', header, nowMs: now })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verifyWebhookSignature({ secret: 'outro', rawBody: body, header, nowMs: now })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verifyWebhookSignature({ secret, rawBody: body, header, nowMs: now + 301_000 })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verifyWebhookSignature({ secret, rawBody: body, header: undefined, nowMs: now })).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('provedor simulado: só onde é permitido', () => {
  afterEach(() => providerRegistry.clear());

  it('registra fora de produção; em produção só com CHANNEL_SANDBOX_PROVIDER=true', () => {
    expect(registerSandboxProviderIfAllowed({ NODE_ENV: 'development' } as any)).toBe(true);
    expect(providerRegistry.has('sandbox')).toBe(true);
    providerRegistry.clear();
    expect(registerSandboxProviderIfAllowed({ NODE_ENV: 'production' } as any)).toBe(false);
    expect(providerRegistry.has('sandbox')).toBe(false);
    expect(registerSandboxProviderIfAllowed({ NODE_ENV: 'production', CHANNEL_SANDBOX_PROVIDER: 'true' } as any)).toBe(true);
  });

  it('nenhum provedor REAL é registrado por padrão (iFood, marketplace)', () => {
    expect(providerRegistry.has('ifood')).toBe(false);
    expect(providerRegistry.has('marketplace')).toBe(false);
  });

  it('o webhook do simulado exige corpo com 1 a 50 eventos', () => {
    const parse = (raw: string) => sandboxProvider.parseWebhook!({ rawBody: raw, headers: {}, ctx: {} as any });
    expect(parse('{"events":[{"a":1}]}')).toHaveLength(1);
    expect(() => parse('{"events":[]}')).toThrow();
    expect(() => parse('{"events":[{"a":1}],"extra":1}')).toThrow();
    expect(() => parse('nao e json')).toThrow();
  });
});
