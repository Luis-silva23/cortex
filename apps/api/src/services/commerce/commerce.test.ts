jest.mock('@ln-system/database', () => ({ prisma: {}, prismaUnsafeBypassRLS: {}, runInTransaction: jest.fn() }));
jest.mock('../stock-ledger', () => ({ stockLedger: { balances: jest.fn() } }));
jest.mock('../stock-reservations', () => ({ availabilityOf: jest.fn(), lockProductsInOrder: jest.fn(), reservationShortfalls: jest.fn() }));

import { SIGNATURE_TOLERANCE_SEC, signRequest, verifyRequestSignature, bodyDigest } from './signature';
import { aggregatePaymentStatus, canMovePaymentState, paymentEventSchema } from './payment-events.service';
import { createOrderSchema, orderFingerprint, toCents } from './order.service';
import { exposedQuantity, readStockPolicy } from './catalog.service';
import { generateKeyMaterial, isUsable, KEY_ID_PATTERN } from './credentials.service';
import { readOrderPolicy } from './reservation.service';
import { canMoveFulfillment, FULFILLMENT_TRANSITIONS } from './convert.service';

const SECRET = 'cs_segredo-de-teste-0123456789abcdef';
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const TS = Math.floor(NOW / 1000);

describe('assinatura da Commerce API', () => {
  const base = { method: 'POST', path: '/commerce/v1/orders?x=1', rawBody: '{"a":1}' };
  const signed = () => signRequest(SECRET, { timestampSec: TS, ...base });
  const verify = (over: Partial<Parameters<typeof verifyRequestSignature>[0]> = {}) =>
    verifyRequestSignature({ secret: SECRET, signatureHeader: signed(), timestampHeader: String(TS), nowMs: NOW, ...base, ...over });

  it('aceita a assinatura correta', () => expect(verify()).toEqual({ ok: true }));
  it('recusa segredo errado, corpo alterado, caminho alterado e método alterado', () => {
    expect(verify({ secret: 'cs_outro' })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verify({ rawBody: '{"a":2}' })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verify({ path: '/commerce/v1/orders?x=2' })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verify({ method: 'PUT' })).toEqual({ ok: false, reason: 'MISMATCH' });
  });
  it('recusa carimbo de tempo fora da janela (repetição antiga ou relógio adiantado)', () => {
    const tol = SIGNATURE_TOLERANCE_SEC * 1000;
    expect(verify({ nowMs: NOW + tol + 2000 })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verify({ nowMs: NOW - tol - 2000 })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verify({ nowMs: NOW + tol - 2000 })).toEqual({ ok: true });
  });
  it('recusa cabeçalhos malformados sem lançar erro', () => {
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify({ signatureHeader: 'v1=zzzz' })).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify({ signatureHeader: `v2=${'a'.repeat(64)}` })).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify({ timestampHeader: 'abc' })).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify({ timestampHeader: undefined })).toEqual({ ok: false, reason: 'MALFORMED' });
  });
  it('GET sem corpo assina o hash do vazio', () => {
    const sig = signRequest(SECRET, { timestampSec: TS, method: 'GET', path: '/commerce/v1/products' });
    expect(verifyRequestSignature({ secret: SECRET, signatureHeader: sig, timestampHeader: String(TS), method: 'GET', path: '/commerce/v1/products', nowMs: NOW })).toEqual({ ok: true });
    expect(bodyDigest(undefined)).toBe(bodyDigest(''));
  });
});

describe('credenciais', () => {
  it('gera identificador público e segredo no formato esperado, sempre diferentes', () => {
    const a = generateKeyMaterial();
    const b = generateKeyMaterial();
    expect(a.keyId).toMatch(KEY_ID_PATTERN);
    expect(a.secret).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.secret).not.toBe(b.secret);
  });
  it('credencial revogada ou vencida não é utilizável', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(isUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(isUsable({ revokedAt: null, expiresAt: new Date('2026-10-06T00:00:00Z') }, now)).toBe(true);
    expect(isUsable({ revokedAt: null, expiresAt: new Date('2026-10-05T11:59:59Z') }, now)).toBe(false);
    expect(isUsable({ revokedAt: new Date('2026-10-05T11:00:00Z'), expiresAt: null }, now)).toBe(false);
  });
});

describe('pagamento externo: máquina de estados', () => {
  it('só anda para frente; FAILED e REFUNDED são finais', () => {
    expect(canMovePaymentState(null, 'PENDING')).toBe(true);
    expect(canMovePaymentState(null, 'CONFIRMED')).toBe(true);
    expect(canMovePaymentState(null, 'REFUNDED')).toBe(false); // estorno de algo que nunca foi confirmado
    expect(canMovePaymentState('PENDING', 'CONFIRMED')).toBe(true);
    expect(canMovePaymentState('PENDING', 'FAILED')).toBe(true);
    expect(canMovePaymentState('CONFIRMED', 'REFUNDED')).toBe(true);
    expect(canMovePaymentState('CONFIRMED', 'PENDING')).toBe(false); // nunca regride
    expect(canMovePaymentState('CONFIRMED', 'FAILED')).toBe(false);
    expect(canMovePaymentState('FAILED', 'CONFIRMED')).toBe(false);
    expect(canMovePaymentState('REFUNDED', 'CONFIRMED')).toBe(false);
  });

  it('o estado do pedido vem de todos os pagamentos: confirmado só quando cobre o total', () => {
    expect(aggregatePaymentStatus([], 10000)).toBe('UNKNOWN');
    expect(aggregatePaymentStatus([{ status: 'PENDING', amountCents: 10000 }], 10000)).toBe('PENDING');
    expect(aggregatePaymentStatus([{ status: 'CONFIRMED', amountCents: 10000 }], 10000)).toBe('CONFIRMED');
    expect(aggregatePaymentStatus([{ status: 'CONFIRMED', amountCents: 6000 }], 10000)).toBe('PENDING'); // parcial
    expect(aggregatePaymentStatus([{ status: 'CONFIRMED', amountCents: 6000 }, { status: 'CONFIRMED', amountCents: 4000 }], 10000)).toBe('CONFIRMED');
    expect(aggregatePaymentStatus([{ status: 'FAILED', amountCents: 10000 }], 10000)).toBe('FAILED');
    expect(aggregatePaymentStatus([{ status: 'FAILED', amountCents: 10000 }, { status: 'PENDING', amountCents: 10000 }], 10000)).toBe('PENDING'); // nova tentativa
    expect(aggregatePaymentStatus([{ status: 'REFUNDED', amountCents: 10000 }], 10000)).toBe('REFUNDED');
  });

  it('o corpo do evento é fechado e valida valor e referência', () => {
    const ok = { eventId: 'evt_1', providerRef: 'pay_1', status: 'CONFIRMED', amount: 99.9 };
    expect(paymentEventSchema.safeParse(ok).success).toBe(true);
    expect(paymentEventSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(paymentEventSchema.safeParse({ ...ok, amount: 10.123 }).success).toBe(false);
    expect(paymentEventSchema.safeParse({ ...ok, status: 'UNKNOWN' }).success).toBe(false);
    expect(paymentEventSchema.safeParse({ ...ok, providerRef: 'com espaço' }).success).toBe(false);
    expect(paymentEventSchema.safeParse({ ...ok, occurredAt: 'ontem' }).success).toBe(false);
  });
});

describe('pedido: validação e impressão digital', () => {
  const order = {
    externalOrderId: 'SITE-1001',
    items: [
      { sku: 'B-2', quantity: 2, unitPrice: 10 },
      { sku: 'A-1', quantity: 1, unitPrice: 49.9 },
    ],
    total: 69.9,
  };

  it('aceita um pedido válido e assume BRL', () => {
    const r = createOrderSchema.safeParse(order);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.currency).toBe('BRL');
  });
  it('recusa campo desconhecido (inclusive empresa/filial vindos do canal), preço com 3 casas e identificador com espaço', () => {
    expect(createOrderSchema.safeParse({ ...order, companyId: 'x' }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, branchId: 'x' }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, items: [{ sku: 'A', quantity: 1, unitPrice: 1.234 }] }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, items: [{ sku: 'A', quantity: 1, unitPrice: 1, costPrice: 1 }] }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, externalOrderId: 'com espaço' }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, items: [] }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, items: [{ sku: 'A', quantity: 0, unitPrice: 1 }] }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...order, currency: 'USD' }).success).toBe(false);
  });
  it('a impressão digital não depende da ordem dos itens e muda com preço, quantidade ou total', () => {
    const a = createOrderSchema.parse(order);
    const reordered = createOrderSchema.parse({ ...order, items: [...order.items].reverse() });
    expect(orderFingerprint(a)).toBe(orderFingerprint(reordered));
    expect(orderFingerprint(a)).not.toBe(orderFingerprint(createOrderSchema.parse({ ...order, total: 70 })));
    expect(orderFingerprint(a)).not.toBe(orderFingerprint(createOrderSchema.parse({ ...order, items: [{ sku: 'B-2', quantity: 3, unitPrice: 10 }, order.items[1]] })));
  });
  it('centavos: 49.9 e 0.1 + 0.2 não geram erro de ponto flutuante', () => {
    expect(toCents(49.9)).toBe(4990);
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3));
  });
});

describe('projeção de estoque para o canal', () => {
  it('padrão: sem margem, sem cota, sem quantidade exata', () => {
    expect(readStockPolicy(undefined)).toEqual({ safetyMargin: 0, quota: null, exposeQuantity: false });
    expect(readStockPolicy({ stockSafetyMargin: -5, exposeStockQuantity: 'sim' })).toEqual({ safetyMargin: 0, quota: null, exposeQuantity: false }); // inválido volta ao padrão
  });
  it('lê a política do canal', () => {
    expect(readStockPolicy({ stockSafetyMargin: 2, stockQuota: 5, exposeStockQuantity: true })).toEqual({ safetyMargin: 2, quota: 5, exposeQuantity: true });
  });
  it('nunca expõe negativo, fração ou acima da cota', () => {
    expect(exposedQuantity(10, { safetyMargin: 0, quota: null })).toBe(10);
    expect(exposedQuantity(10, { safetyMargin: 3, quota: null })).toBe(7);
    expect(exposedQuantity(2, { safetyMargin: 5, quota: null })).toBe(0);
    expect(exposedQuantity(-4, { safetyMargin: 0, quota: null })).toBe(0); // venda negativa no balcão não vaza
    expect(exposedQuantity(7.9, { safetyMargin: 0, quota: null })).toBe(7);
    expect(exposedQuantity(100, { safetyMargin: 0, quota: 4 })).toBe(4);
  });
});

describe('política de pedido do canal (Fase 2) — nada é decidido pelo código', () => {
  it('sem configuração: sem prazo de reserva, sem aceite automático e sem conversão automática', () => {
    const empty = { reservationTtlMinutes: null, autoAcceptOrders: false, autoConvertOnPaymentConfirmed: false };
    expect(readOrderPolicy(null)).toEqual(empty);
    expect(readOrderPolicy({})).toEqual(empty);
    expect(readOrderPolicy({ reservationTtlMinutes: 'abc', autoAcceptOrders: 'sim' })).toEqual(empty); // inválido não vira política
  });
  it('lê só valores válidos; prazo fora da faixa é ignorado', () => {
    expect(readOrderPolicy({ reservationTtlMinutes: 30, autoAcceptOrders: true })).toEqual({ reservationTtlMinutes: 30, autoAcceptOrders: true, autoConvertOnPaymentConfirmed: false });
    expect(readOrderPolicy({ reservationTtlMinutes: 0 }).reservationTtlMinutes).toBeNull();
    expect(readOrderPolicy({ reservationTtlMinutes: 99_999 }).reservationTtlMinutes).toBeNull();
  });
});

describe('máquina de estados da entrega (Fase 2)', () => {
  it('estados finais não têm saída e nenhum estado volta para PENDING', () => {
    for (const final of ['PICKED_UP', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const) expect(FULFILLMENT_TRANSITIONS[final]).toEqual([]);
    for (const targets of Object.values(FULFILLMENT_TRANSITIONS)) expect(targets).not.toContain('PENDING');
  });
  it('só avança pelos caminhos previstos', () => {
    expect(canMoveFulfillment('PENDING', 'READY')).toBe(true);
    expect(canMoveFulfillment('PENDING', 'DELIVERED')).toBe(false);
    expect(canMoveFulfillment('READY', 'IN_TRANSIT')).toBe(true);
    expect(canMoveFulfillment('IN_TRANSIT', 'DELIVERED')).toBe(true);
    expect(canMoveFulfillment('DELIVERED', 'READY')).toBe(false);
    expect(canMoveFulfillment('FAILED_DELIVERY', 'IN_TRANSIT')).toBe(true); // nova tentativa
  });
});
