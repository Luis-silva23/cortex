import { canAcceptOrder, canActOnOrder, canCancelOrder, canConvertOrder, canRetryOutbox, credentialState, FULFILLMENT_NEXT, OUTBOX_STATUS_LABEL, parseSkus, usesCommerceApi, SCOPE_OPTIONS, ORDER_STATUS_LABEL, webhookUrl } from './sales-channels';

describe('canais de venda: Commerce API na tela', () => {
  it('só site próprio e "outro" usam a Commerce API; loja física, iFood e marketplace não', () => {
    expect(usesCommerceApi('SITE_PROPRIO')).toBe(true);
    expect(usesCommerceApi('OUTRO')).toBe(true);
    expect(usesCommerceApi('LOJA_FISICA')).toBe(false);
    expect(usesCommerceApi('IFOOD')).toBe(false);
    expect(usesCommerceApi('MARKETPLACE')).toBe(false);
  });

  it('estado da credencial: revogada vence tudo, depois vencida, senão ativa', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(credentialState({ revokedAt: null, expiresAt: null }, now)).toBe('Ativa');
    expect(credentialState({ revokedAt: null, expiresAt: '2026-10-06T00:00:00Z' }, now)).toBe('Ativa');
    expect(credentialState({ revokedAt: null, expiresAt: '2026-10-05T11:00:00Z' }, now)).toBe('Vencida');
    expect(credentialState({ revokedAt: '2026-10-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z' }, now)).toBe('Revogada');
  });

  it('separa SKUs por linha, vírgula ou ponto e vírgula, sem vazios nem repetidos', () => {
    expect(parseSkus('A-1\nB-2, C-3;A-1\n\n  D-4  ')).toEqual(['A-1', 'B-2', 'C-3', 'D-4']);
    expect(parseSkus('  \n ,; ')).toEqual([]);
  });

  it('só pedido recebido pode ser recusado ou cancelado pela tela', () => {
    expect(canActOnOrder('RECEIVED')).toBe(true);
    for (const s of ['ACCEPTED', 'REJECTED', 'CANCELLED', 'CONVERTED', 'EXPIRED']) expect(canActOnOrder(s)).toBe(false);
  });

  it('todo escopo tem texto e todo estado de pedido tem rótulo em português', () => {
    expect(SCOPE_OPTIONS.map((s) => s.value).sort()).toEqual(['CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE']);
    for (const s of ['RECEIVED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'CONVERTED', 'EXPIRED']) expect(ORDER_STATUS_LABEL[s]).toBeTruthy();
  });
});

describe('ações sobre pedido externo (Fase 2)', () => {
  it('aceitar só no recebido; cancelar no recebido e no aceito; recusar só no recebido', () => {
    expect(canAcceptOrder('RECEIVED')).toBe(true);
    expect(canAcceptOrder('ACCEPTED')).toBe(false);
    expect(canCancelOrder('ACCEPTED')).toBe(true);
    expect(canCancelOrder('CONVERTED')).toBe(false);
    expect(canActOnOrder('ACCEPTED')).toBe(false);
  });
  it('converter exige pagamento confirmado e pedido aceito (ou com reserva vencida)', () => {
    expect(canConvertOrder({ status: 'ACCEPTED', paymentStatus: 'CONFIRMED' })).toBe(true);
    expect(canConvertOrder({ status: 'EXPIRED', paymentStatus: 'CONFIRMED' })).toBe(true);
    expect(canConvertOrder({ status: 'ACCEPTED', paymentStatus: 'PENDING' })).toBe(false);
    expect(canConvertOrder({ status: 'RECEIVED', paymentStatus: 'CONFIRMED' })).toBe(false);
    expect(canConvertOrder({ status: 'CONVERTED', paymentStatus: 'CONFIRMED' })).toBe(false);
  });
  it('entrega: estados finais não oferecem próxima ação', () => {
    for (const s of ['PICKED_UP', 'DELIVERED', 'RETURNED', 'CANCELLED']) expect(FULFILLMENT_NEXT[s]).toEqual([]);
    expect(FULFILLMENT_NEXT.PENDING).toContain('READY');
  });
});

describe('Integration Gateway na tela (Fase 3)', () => {
  it('o endereço do webhook vem da URL da API sem o sufixo /api e nunca leva segredo', () => {
    expect(webhookUrl('http://localhost:3001/api', 'abc')).toBe('http://localhost:3001/integrations/v1/webhooks/abc');
    expect(webhookUrl('https://api.exemplo.com/api/', 'abc')).toBe('https://api.exemplo.com/integrations/v1/webhooks/abc');
    expect(webhookUrl('https://api.exemplo.com', 'abc')).toBe('https://api.exemplo.com/integrations/v1/webhooks/abc');
  });
  it('só linha que falhou ou espera pode ser reenviada ou cancelada', () => {
    expect(canRetryOutbox('DEAD')).toBe(true);
    expect(canRetryOutbox('PENDING')).toBe(true);
    expect(canRetryOutbox('SENT')).toBe(false);
    expect(canRetryOutbox('CANCELLED')).toBe(false);
    expect(OUTBOX_STATUS_LABEL.DEAD).toMatch(/tratamento/);
  });
});
