import {
  CircuitBreaker,
  GatewayTimeoutError,
  callProviderSafely,
  providerRegistry,
  sanitizeErrorMessage,
  signWebhook,
  verifyWebhookSignature,
  withTimeout,
} from './gateway';

describe('sanitizeErrorMessage — nada de segredo em log, evento ou tela', () => {
  it('troca token, chave e valores longos por [omitido]', () => {
    const msg = sanitizeErrorMessage(new Error('401 Authorization: Bearer abc.DEF-123_xyz token=SEGREDO123 api_key: "k-9f8e7d6c5b4a3210ffee" senha=hunter2'));
    expect(msg).not.toMatch(/abc\.DEF|SEGREDO123|9f8e7d6c5b4a3210|hunter2/);
    expect(msg).toContain('[omitido]');
  });
  it('limita o tamanho e aceita texto ou erro sem mensagem', () => {
    expect(sanitizeErrorMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
    expect(sanitizeErrorMessage(undefined)).toBe('Erro desconhecido');
  });
});

describe('withTimeout e callProviderSafely — falha externa nunca derruba quem chamou', () => {
  it('resolve dentro do prazo', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
  it('estoura o prazo com erro próprio', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toBeInstanceOf(GatewayTimeoutError);
  });
  it('devolve ok:true com o valor', async () => {
    const r = await callProviderSafely('c1', async () => 'pronto', { breaker: new CircuitBreaker() });
    expect(r).toEqual({ ok: true, value: 'pronto' });
  });
  it('erro do provedor vira resultado (sem lançar), com mensagem sanitizada', async () => {
    const r = await callProviderSafely('c2', async () => { throw new Error('falha token=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'); }, { retries: 0, breaker: new CircuitBreaker() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ERROR');
      expect(r.message).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
    }
  });
  it('lentidão vira TIMEOUT', async () => {
    const r = await callProviderSafely('c3', () => new Promise(() => undefined), { timeoutMs: 20, retries: 0, breaker: new CircuitBreaker() });
    expect(r).toMatchObject({ ok: false, reason: 'TIMEOUT' });
  });
  it('retentativa limitada: falha uma vez e dá certo na segunda, sem passar de retries + 1 chamadas', async () => {
    let calls = 0;
    const r = await callProviderSafely('c4', async () => { calls += 1; if (calls === 1) throw new Error('oscilou'); return 'ok'; }, { retries: 2, backoffMs: 1, breaker: new CircuitBreaker() });
    expect(r).toEqual({ ok: true, value: 'ok' });
    expect(calls).toBe(2);
    let always = 0;
    await callProviderSafely('c5', async () => { always += 1; throw new Error('x'); }, { retries: 2, backoffMs: 1, breaker: new CircuitBreaker(10) });
    expect(always).toBe(3);
  });
  it('disjuntor: depois de 3 falhas seguidas recusa sem chamar o provedor, e volta a tentar depois do tempo', async () => {
    const breaker = new CircuitBreaker(3, 1000);
    let calls = 0;
    const fail = async () => { calls += 1; throw new Error('fora do ar'); };
    for (let i = 0; i < 3; i++) await callProviderSafely('c6', fail, { retries: 0, breaker });
    expect(calls).toBe(3);
    const blocked = await callProviderSafely('c6', fail, { retries: 0, breaker });
    expect(blocked).toMatchObject({ ok: false, reason: 'CIRCUIT_OPEN' });
    expect(calls).toBe(3); // nenhuma chamada nova
    expect(breaker.isOpen('c6')).toBe(true);
    expect(breaker.canCall('c6', Date.now() + 1500)).toBe(true); // meio-aberto
    breaker.success('c6');
    expect(breaker.isOpen('c6')).toBe(false);
  });
  it('o disjuntor é por canal: um canal quebrado não bloqueia os outros', () => {
    const breaker = new CircuitBreaker(1, 1000);
    breaker.failure('canal-A');
    expect(breaker.canCall('canal-A')).toBe(false);
    expect(breaker.canCall('canal-B')).toBe(true);
  });
});

describe('assinatura de webhook — autenticada, com janela de tempo e sem repetição', () => {
  const secret = 'segredo-de-teste';
  const body = JSON.stringify({ eventId: 'E1', orderId: 'P1' });
  const now = 1_790_000_000_000;
  const t = Math.floor(now / 1000);

  it('aceita a assinatura correta dentro da janela', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, header: signWebhook(secret, body, t), nowMs: now })).toEqual({ ok: true, timestamp: t });
  });
  it('recusa corpo alterado, segredo errado, cabeçalho ausente ou malformado', () => {
    const header = signWebhook(secret, body, t);
    expect(verifyWebhookSignature({ secret, rawBody: body + ' ', header, nowMs: now })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verifyWebhookSignature({ secret: 'outro', rawBody: body, header, nowMs: now })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verifyWebhookSignature({ secret, rawBody: body, header: undefined, nowMs: now })).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyWebhookSignature({ secret, rawBody: body, header: 't=abc,v1=zz', nowMs: now })).toEqual({ ok: false, reason: 'MALFORMED' });
  });
  it('recusa assinatura velha ou do futuro (repetição de mensagem capturada)', () => {
    const old = signWebhook(secret, body, t - 600);
    expect(verifyWebhookSignature({ secret, rawBody: body, header: old, nowMs: now })).toEqual({ ok: false, reason: 'EXPIRED' });
    const future = signWebhook(secret, body, t + 600);
    expect(verifyWebhookSignature({ secret, rawBody: body, header: future, nowMs: now })).toEqual({ ok: false, reason: 'EXPIRED' });
  });
});

describe('registro de provedores — nenhum provedor real existe nesta etapa', () => {
  it('começa vazio: nenhuma integração instalada', () => {
    expect(providerRegistry.has('ifood')).toBe(false);
    expect(providerRegistry.has('commerce-api')).toBe(false);
    expect(providerRegistry.get(null)).toBeUndefined();
  });
});
