/**
 * Relé de notificações em Google Apps Script — lado do CÓRTEX. NENHUMA rede e NENHUM envio real: o `fetch` é simulado e, nos testes de ponta a ponta local, aponta para os arquivos
 * .gs REAIS carregados num contexto simulado (integrations/google-apps-script/test/harness.js), provando que a assinatura do TypeScript e a verificação do script combinam.
 */
jest.mock('@ln-system/database', () => ({
  prisma: { company: { findUnique: jest.fn().mockResolvedValue({ name: 'Loja Teste' }) }, externalDelivery: { count: jest.fn() } },
  runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
jest.mock('./deliveries', () => ({
  ...jest.requireActual('./deliveries'),
  sentCounts: jest.fn(),
  lastDeliveryAt: jest.fn(),
  recordDelivery: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./settings.service', () => {
  const actual = jest.requireActual('./settings.service');
  return { ...actual, getEffective: jest.fn(async (env: NodeJS.ProcessEnv) => actual.resolveEffective(env, null)) };
});

import path from 'path';
import { emailAttempts, emailConfig, smsAttempts, smsConfig, sendWithFailover, whatsappAttempts, whatsappConfig } from '@ln-system/shared/utils/alert-channels';
import { buildRelayBody, makeRelayId, mapRelayResponse, relayConfig, sendViaAppsScript } from '@ln-system/shared/utils/apps-script-relay';
import { lastDeliveryAt, recordDelivery, sentCounts } from './deliveries';
import { sendEmail, __resetResendBreaker } from './resend.service';
import { sendSms, smsBreaker } from './sms.service';
import { sendWhatsapp, whatsappBreaker } from './whatsapp.service';
import { channelsStatus } from './notifier';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createScript, SECRET } = require(path.resolve(__dirname, '../../../../../integrations/google-apps-script/test/harness'));

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTESTE0123456789abcdefghijklmnop/exec';
const NOW = new Date('2026-10-23T15:00:00Z');
const RELAY = { APPS_SCRIPT_URL: URL_OK, APPS_SCRIPT_SECRET: SECRET };
const RESEND = { RESEND_API_KEY: 're_chave_de_teste_123', ALERT_EMAIL_FROM: 'a@exemplo.test', ALERT_EMAIL_TO: 'ops@example.com', RESEND_DOMAIN_VERIFIED: 'true' };
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => {
  jest.clearAllMocks();
  (sentCounts as jest.Mock).mockResolvedValue({ hour: 0, day: 0, month: 0 });
  (lastDeliveryAt as jest.Mock).mockResolvedValue(null);
  smsBreaker.reset?.();
  whatsappBreaker.reset?.();
  __resetResendBreaker();
});

// ------------------------------------------------------------------------------------------------------------------------------------
describe('configuração do relé', () => {
  it('desligado por padrão: nada muda (sem canais, sem pendências)', () => {
    const c = relayConfig({} as NodeJS.ProcessEnv);
    expect(c.channels).toEqual([]);
    expect(c.readyFor).toEqual({ email: false, sms: false, whatsapp: false });
    expect(c.missing).toEqual([]);
  });

  it('canais pedidos + URL oficial + segredo ≥ 32: pronto só para os canais pedidos', () => {
    const c = relayConfig(env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email, SMS, inventado, email' }));
    expect(c.channels).toEqual(['email', 'sms']);
    expect(c.readyFor).toEqual({ email: true, sms: true, whatsapp: false });
    expect(c.host).toBe('script.google.com');
  });

  it.each([
    ['http', 'http://script.google.com/macros/s/AKfycbxTESTE0123456789abcdefghijklmnop/exec'],
    ['outro host', 'https://evil.example.com/macros/s/AKfycbxTESTE0123456789abcdefghijklmnop/exec'],
    ['sem /exec', 'https://script.google.com/macros/s/AKfycbxTESTE0123456789abcdefghijklmnop'],
    ['com consulta', `${URL_OK}?x=1`],
    ['host parecido', 'https://script.google.com.evil.com/macros/s/AKfycbxTESTE0123456789abcdefghijklmnop/exec'],
    ['id curto', 'https://script.google.com/macros/s/curto/exec'],
    ['/dev (teste)', 'https://script.google.com/macros/s/AKfycbxTESTE0123456789abcdefghijklmnop/dev'],
  ])('URL inválida (%s) é recusada', (_n, url) => {
    const c = relayConfig(env({ APPS_SCRIPT_URL: url, APPS_SCRIPT_SECRET: SECRET, APPS_SCRIPT_CHANNELS: 'email' }));
    expect(c.urlOk).toBe(false);
    expect(c.readyFor.email).toBe(false);
    expect(c.missing.join(' ')).toMatch(/APPS_SCRIPT_URL/);
  });

  it('URL de conta Workspace é aceita; segredo curto é recusado; pendências só citam NOMES de variáveis', () => {
    expect(relayConfig(env({ APPS_SCRIPT_URL: 'https://script.google.com/a/macros/exemplo.com.br/s/AKfycbxTESTE0123456789abcdefghijklmnop/exec', APPS_SCRIPT_SECRET: SECRET, APPS_SCRIPT_CHANNELS: 'email' })).urlOk).toBe(true);
    const c = relayConfig(env({ APPS_SCRIPT_URL: URL_OK, APPS_SCRIPT_SECRET: 'curto', APPS_SCRIPT_CHANNELS: 'email' }));
    expect(c.secretOk).toBe(false);
    expect(c.missing).toEqual([expect.stringContaining('APPS_SCRIPT_SECRET')]);
    expect(JSON.stringify(c)).not.toContain('curto');
  });

  it('o resumo de configuração nunca contém a URL de implantação nem o segredo', () => {
    const c = relayConfig(env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email,sms,whatsapp' }));
    const text = JSON.stringify(c);
    expect(text).not.toContain('AKfycbx');
    expect(text).not.toContain(SECRET);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
describe('assinatura: o TypeScript e o script concordam (arquivos .gs reais)', () => {
  const props = { RELAY_SECRET: SECRET, EMAIL_ALLOWED_RECIPIENTS: 'ops@example.com' };

  it('corpo assinado pelo CÓRTEX é aceito pelo script e envia o e-mail uma vez', () => {
    const s = createScript({ props });
    const body = buildRelayBody(SECRET, { id: makeRelayId(['t1']), channel: 'email', payload: { subject: 'Assunto', text: 'Texto' }, nowMs: s.now() });
    const r = s.post(body);
    expect(r.status).toBe('sent');
    expect(s.mail.sent).toHaveLength(1);
  });

  it('assinatura com segredo diferente, payload adulterado e timestamp antigo são recusados pelo script', () => {
    const s = createScript({ props });
    const mk = (secret: string, nowMs: number) => buildRelayBody(secret, { id: makeRelayId([secret, String(nowMs)]), channel: 'email', payload: { subject: 'a', text: 'b' }, nowMs });
    expect(s.post(mk('outro-segredo-'.padEnd(40, 'z'), s.now())).status).toBe('unauthorized');
    const good = JSON.parse(mk(SECRET, s.now()));
    expect(s.post(JSON.stringify({ ...good, payload: good.payload.replace('"a"', '"hack"') })).status).toBe('unauthorized');
    expect(s.post(mk(SECRET, s.now() - 10 * 60_000)).status).toBe('unauthorized');
    expect(s.mail.sent).toHaveLength(0);
  });

  it('o mesmo identificador não reenvia: segunda chamada volta como duplicate (e o CÓRTEX a trata como aceita, sem nova mensagem)', async () => {
    const s = createScript({ props });
    const fetchImpl = (async (_u: string, init: RequestInit) => json(200, s.post(init.body as string))) as unknown as typeof fetch;
    const input = { channel: 'email' as const, id: makeRelayId(['dup']), payload: { subject: 'a', text: 'b' } };
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email' });
    const first = await sendViaAppsScript(e, input, { fetchImpl, nowMs: () => s.now() });
    const second = await sendViaAppsScript(e, input, { fetchImpl, nowMs: () => s.now() });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(s.mail.sent).toHaveLength(1);
  });

  it('ponta a ponta local: SMS e WhatsApp pelo relé chegam ao adaptador do provedor (simulado) e respeitam a lista permitida', async () => {
    const s = createScript({
      props: { RELAY_SECRET: SECRET, SMS_ALLOWED_RECIPIENTS: '+5511999998888', SMS_SENDER_VERIFIED: 'true', SMS_TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), SMS_TWILIO_AUTH_TOKEN: 'tok', SMS_FROM: '+15005550006', WA_ALLOWED_RECIPIENTS: '+5511999998888', WA_TEMPLATE_APPROVED: 'true', WA_META_TOKEN: 't', WA_META_PHONE_NUMBER_ID: '1', WA_TEMPLATE_NAME: 'm' },
      fetchHandler: () => ({ code: 201, body: '{}' }),
    });
    const fetchImpl = (async (_u: string, init: RequestInit) => json(200, s.post(init.body as string))) as unknown as typeof fetch;
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'sms,whatsapp' });
    const deps = { fetchImpl, nowMs: () => s.now() };
    expect((await sendViaAppsScript(e, { channel: 'sms', id: makeRelayId(['s']), payload: { to: '+5511999998888', text: 'x' } }, deps)).ok).toBe(true);
    expect((await sendViaAppsScript(e, { channel: 'whatsapp', id: makeRelayId(['w']), payload: { to: '+5511999998888', text: 'x' } }, deps)).ok).toBe(true);
    const bad = await sendViaAppsScript(e, { channel: 'sms', id: makeRelayId(['s2']), payload: { to: '+5511000000000', text: 'x' } }, deps);
    expect(bad).toMatchObject({ ok: false, error: 'apps_script_invalid_request_recipient_not_allowed', retryable: false });
    expect(s.fetches.calls.map((c: { url: string }) => new URL(c.url).host)).toEqual(['api.twilio.com', 'graph.facebook.com']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
describe('tradução da resposta do script', () => {
  const id = makeRelayId(['x']);
  it.each([
    ['sent', { status: 'sent' }, true, undefined],
    ['duplicate', { status: 'duplicate' }, true, undefined],
    ['dry_run (nada foi enviado)', { status: 'dry_run' }, false, 'apps_script_dry_run'],
    ['rate_limited', { status: 'rate_limited', detail: 'gmail_quota' }, false, 'apps_script_rate_limited_gmail_quota'],
    ['not_configured', { status: 'not_configured', detail: 'recipients' }, false, 'apps_script_not_configured_recipients'],
    ['unauthorized', { status: 'unauthorized' }, false, 'apps_script_unauthorized'],
    ['invalid_request', { status: 'invalid_request', detail: 'subject' }, false, 'apps_script_invalid_request_subject'],
    ['failed definitivo', { status: 'failed', detail: 'provider_http_400', retryable: false }, false, 'apps_script_failed_provider_http_400'],
    ['status desconhecido', { status: 'ok-mas-nao-sei' }, false, 'apps_script_unexpected_response'],
  ])('%s', (_n, body, okExpected, error) => {
    const r = mapRelayResponse(200, JSON.stringify(body), id);
    expect(r.ok).toBe(okExpected);
    expect(r.error).toBe(error);
    expect(r.retryable).toBe(false);
  });

  it('failed com retryable=true é repetível; 5xx e 429 são repetíveis; 4xx não; HTML com 200 não é sucesso', () => {
    expect(mapRelayResponse(200, JSON.stringify({ status: 'failed', retryable: true }), id).retryable).toBe(true);
    expect(mapRelayResponse(503, '', id)).toMatchObject({ ok: false, error: 'apps_script_http_503', retryable: true });
    expect(mapRelayResponse(429, '', id).retryable).toBe(true);
    expect(mapRelayResponse(403, '', id)).toMatchObject({ ok: false, retryable: false });
    expect(mapRelayResponse(200, '<html>Faça login no Google</html>', id)).toMatchObject({ ok: false, error: 'apps_script_unexpected_response', retryable: false });
    expect(mapRelayResponse(200, 'null', id).ok).toBe(false);
  });

  it('o texto do erro vem de um conjunto fechado: nada do servidor remoto (nem segredo) passa para o resultado', () => {
    const r = mapRelayResponse(200, JSON.stringify({ status: 'failed', detail: `vazou ${SECRET} <script>`, retryable: false }), id);
    expect(r.error).toMatch(/^apps_script_[a-z0-9_]+$/i);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
describe('transporte (rede simulada)', () => {
  const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email' });
  const input = { channel: 'email' as const, id: makeRelayId(['t']), payload: { subject: 'a', text: 'b' } };

  it('canal não configurado: não chama a rede e diz "not_configured" (nunca sucesso presumido)', async () => {
    const fetchImpl = jest.fn();
    const r = await sendViaAppsScript(env({}), input, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, error: 'not_configured', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    const sms = await sendViaAppsScript(e, { ...input, channel: 'sms' }, { fetchImpl: fetchImpl as unknown as typeof fetch }); // só e-mail foi pedido
    expect(sms.error).toBe('not_configured');
  });

  it('envia POST JSON à URL configurada; o segredo NÃO vai na URL, nos cabeçalhos nem no corpo (só a assinatura)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, { status: 'sent' });
    }) as unknown as typeof fetch;
    const r = await sendViaAppsScript(e, input, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe(URL_OK);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init as { redirect?: string }).redirect).toBe('follow');
    expect(JSON.stringify(calls[0].init.headers)).not.toContain(SECRET);
    expect(String(calls[0].init.body)).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(String(calls[0].init.body))).sort()).toEqual(['channel', 'id', 'payload', 'sig', 'ts', 'v']);
  });

  it('tempo esgotado, falha de rede e resposta inesperada: erro repetível/definitivo corretos, sem vazar nada', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout ' + SECRET), { name: 'TimeoutError' });
    const t = await sendViaAppsScript(e, input, { fetchImpl: (async () => { throw timeout; }) as unknown as typeof fetch });
    expect(t).toMatchObject({ ok: false, error: 'apps_script_timeout', retryable: true });
    const n = await sendViaAppsScript(e, input, { fetchImpl: (async () => { throw new Error('ECONNRESET ' + URL_OK); }) as unknown as typeof fetch });
    expect(n).toMatchObject({ ok: false, error: 'apps_script_network', retryable: true });
    for (const r of [t, n]) expect(JSON.stringify(r)).not.toMatch(/AKfycbx|test-secret/);
    const html = await sendViaAppsScript(e, input, { fetchImpl: (async () => json(200, '<html>login</html>')) as unknown as typeof fetch });
    expect(html).toMatchObject({ ok: false, error: 'apps_script_unexpected_response' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
describe('configuração dos canais com o relé (e preservação do comportamento existente)', () => {
  it('SEM relé: e-mail/SMS/WhatsApp são exatamente o que eram (Resend sozinho, Twilio, Meta/Twilio)', () => {
    expect(emailConfig(env(RESEND))).toMatchObject({ configured: true, providers: ['resend'], missing: [] });
    expect(emailConfig(env({}))).toMatchObject({ configured: false, providers: [] });
    expect(emailConfig(env({})).missing).toEqual(expect.arrayContaining(['RESEND_API_KEY', 'RESEND_DOMAIN_VERIFIED=true']));
    expect(smsConfig(env({})).providers).toEqual([]);
    expect(whatsappConfig(env({})).providers).toEqual([]);
  });

  it('e-mail só pelo relé: pronto sem credenciais do Resend; Resend continua usável como alternativa quando também estiver completo', () => {
    const only = emailConfig(env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email' }));
    expect(only).toMatchObject({ configured: true, providers: ['apps-script'], missing: [] });
    const both = emailConfig(env({ ...RELAY, ...RESEND, APPS_SCRIPT_CHANNELS: 'email' }));
    expect(both.providers).toEqual(['apps-script', 'resend']);
    expect(emailConfig(env({ ...RELAY, ...RESEND, APPS_SCRIPT_CHANNELS: 'email', ALERT_EMAIL_PROVIDERS: 'resend,apps-script' })).providers).toEqual(['resend', 'apps-script']);
    // relé pedido mas inválido: não pronto, pendências dizem o que falta (e o Resend segue valendo se completo)
    const bad = emailConfig(env({ APPS_SCRIPT_URL: 'http://x', APPS_SCRIPT_SECRET: SECRET, APPS_SCRIPT_CHANNELS: 'email' }));
    expect(bad.configured).toBe(false);
    expect(bad.missing.join(' ')).toMatch(/APPS_SCRIPT_URL/);
    expect(emailConfig(env({ APPS_SCRIPT_URL: 'http://x', APPS_SCRIPT_SECRET: SECRET, APPS_SCRIPT_CHANNELS: 'email', ...RESEND })).providers).toEqual(['resend']);
  });

  it('SMS e WhatsApp pelo relé: dispensam credenciais do provedor NO servidor, mas continuam exigindo destinatários e as declarações do operador', () => {
    const base = { ...RELAY, APPS_SCRIPT_CHANNELS: 'sms,whatsapp' };
    expect(smsConfig(env(base)).configured).toBe(false);
    expect(smsConfig(env(base)).missing).toEqual(expect.arrayContaining(['ALERT_SMS_TO', 'ALERT_SMS_SENDER_VERIFIED=true']));
    const sms = smsConfig(env({ ...base, ALERT_SMS_TO: '11999998888', ALERT_SMS_SENDER_VERIFIED: 'true' }));
    expect(sms).toMatchObject({ configured: true, providers: ['apps-script'] });
    const wa0 = whatsappConfig(env({ ...base, ALERT_WHATSAPP_TO: '11999998888' }));
    expect(wa0.configured).toBe(false);
    expect(wa0.missing).toEqual(expect.arrayContaining(['ALERT_WHATSAPP_TEMPLATE_APPROVED=true']));
    const wa = whatsappConfig(env({ ...base, ALERT_WHATSAPP_TO: '11999998888', ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true' }));
    expect(wa).toMatchObject({ configured: true, providers: ['apps-script'] });
  });

  it('relé de e-mail apenas NÃO ativa SMS nem WhatsApp (canal não pedido continua pendente)', () => {
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email', ALERT_SMS_TO: '11999998888', ALERT_SMS_SENDER_VERIFIED: 'true', ALERT_WHATSAPP_TO: '11999998888', ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true' });
    expect(smsConfig(e).configured).toBe(false);
    expect(whatsappConfig(e).configured).toBe(false);
  });

  it('o Twilio direto continua primeiro; o relé entra como alternativa', () => {
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'sms', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'tok', ALERT_SMS_FROM: '+15005550006', ALERT_SMS_TO: '11999998888', ALERT_SMS_SENDER_VERIFIED: 'true' });
    expect(smsConfig(e).providers).toEqual(['twilio', 'apps-script']);
  });

  it('o estado dos canais (tela) não traz URL nem segredo do relé', () => {
    const st = channelsStatus(env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email,sms,whatsapp', ALERT_SMS_TO: '11999998888', ALERT_SMS_SENDER_VERIFIED: 'true' }));
    const text = JSON.stringify(st);
    expect(text).not.toContain('AKfycbx');
    expect(text).not.toContain(SECRET);
    expect(st.EMAIL.configured).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
describe('failover preservado (tentativas e serviços)', () => {
  const scriptFails = (status: string, extra: object = {}) => json(200, { status, retryable: false, ...extra });

  it('padrão (relé desligado): UMA tentativa, o Resend — idêntico ao comportamento anterior', () => {
    expect(emailAttempts(env(RESEND), { subject: 'a', text: 'b', idempotencyKey: 'k' }).map((a) => a.provider)).toEqual(['resend']);
  });

  it('relé primeiro, Resend como alternativa: se o relé falha (definitivo), o Resend entrega', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(new URL(url).host);
      return url.startsWith('https://script.google.com') ? scriptFails('failed', { detail: 'mail_exception' }) : json(200, { id: 're_1' });
    }) as unknown as typeof fetch;
    const e = env({ ...RELAY, ...RESEND, APPS_SCRIPT_CHANNELS: 'email' });
    const { result, tried } = await sendWithFailover(emailAttempts(e, { subject: 'a', text: 'b', idempotencyKey: 'k' }, { fetchImpl }), { sleep: async () => undefined });
    expect(calls).toEqual(['script.google.com', 'api.resend.com']);
    expect(result).toMatchObject({ ok: true, provider: 'resend' });
    expect(tried).toHaveLength(2);
  });

  it('relé "dry_run" NÃO conta como enviado: o Resend é tentado', async () => {
    const fetchImpl = (async (url: string) => (url.startsWith('https://script.google.com') ? json(200, { status: 'dry_run' }) : json(200, { id: 're_1' }))) as unknown as typeof fetch;
    const e = env({ ...RELAY, ...RESEND, APPS_SCRIPT_CHANNELS: 'email' });
    const { result } = await sendWithFailover(emailAttempts(e, { subject: 'a', text: 'b', idempotencyKey: 'k' }, { fetchImpl }));
    expect(result.provider).toBe('resend');
  });

  it('sendEmail (serviço): relé aceito → SENT registrado sem texto, destinatário nem segredo; relé em dry_run sem alternativa → FAILED (nunca SENT)', async () => {
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'email' });
    const okFetch = (async () => json(200, { status: 'sent' })) as unknown as typeof fetch;
    const sent = await sendEmail({ subject: 'Assunto secreto', text: 'Texto secreto', dedupeKey: 'alert:A:1' }, { env: e, now: NOW, fetchImpl: okFetch, sleep: async () => undefined });
    expect(sent.status).toBe('SENT');
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EMAIL', status: 'SENT' }));
    expect(JSON.stringify((recordDelivery as jest.Mock).mock.calls)).not.toMatch(/secreto|AKfycbx|test-secret/);
    (recordDelivery as jest.Mock).mockClear();
    __resetResendBreaker();
    const dry = (async () => json(200, { status: 'dry_run' })) as unknown as typeof fetch;
    const failed = await sendEmail({ subject: 'a', text: 'b', dedupeKey: 'alert:A:2' }, { env: e, now: NOW, fetchImpl: dry, sleep: async () => undefined });
    expect(failed.status).toBe('FAILED');
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });

  it('serviços de SMS e WhatsApp pelo relé: aceito → SENT; dry_run/not_configured → FAILED; nada de número/texto/segredo no registro', async () => {
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'sms,whatsapp', ALERT_SMS_TO: '11999998888', ALERT_SMS_SENDER_VERIFIED: 'true', ALERT_WHATSAPP_TO: '11999998888', ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true' });
    const respond = (status: string) => (async () => json(200, { status })) as unknown as typeof fetch;
    const s1 = await sendSms({ text: 'texto sms secreto', dedupeKey: 'alert:B:1' }, { env: e, now: NOW, fetchImpl: respond('sent'), sleep: async () => undefined });
    expect(s1.status).toBe('SENT');
    const w1 = await sendWhatsapp({ text: 'texto wa secreto', dedupeKey: 'alert:B:1' }, { env: e, now: NOW, fetchImpl: respond('sent'), sleep: async () => undefined });
    expect(w1.status).toBe('SENT');
    smsBreaker.reset?.();
    whatsappBreaker.reset?.();
    const s2 = await sendSms({ text: 'x', dedupeKey: 'alert:B:2' }, { env: e, now: NOW, fetchImpl: respond('dry_run'), sleep: async () => undefined });
    const w2 = await sendWhatsapp({ text: 'x', dedupeKey: 'alert:B:2' }, { env: e, now: NOW, fetchImpl: respond('not_configured'), sleep: async () => undefined });
    expect(s2.status).toBe('FAILED');
    expect(w2.status).toBe('FAILED');
    expect(JSON.stringify((recordDelivery as jest.Mock).mock.calls)).not.toMatch(/secreto|5511999998888|11999998888|AKfycbx|test-secret/);
  });

  it('o identificador do relé é estável por notificação e destinatário (retentativa = mesmo id → duplicate no script) e distinto entre destinatários', () => {
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'sms', ALERT_SMS_TO: '11999998888', ALERT_SMS_SENDER_VERIFIED: 'true' });
    const idOf = async (to: string, key: string) => {
      let id = '';
      const fetchImpl = (async (_u: string, init: RequestInit) => {
        id = JSON.parse(String(init.body)).id;
        return json(200, { status: 'sent' });
      }) as unknown as typeof fetch;
      await smsAttempts(e, to, 'x', key, { fetchImpl })[0].run();
      return id;
    };
    return Promise.all([idOf('+5511999998888', 'k1'), idOf('+5511999998888', 'k1'), idOf('+5511999998888', 'k2'), idOf('+5521988887777', 'k1')]).then(([a, b, c, d]) => {
      expect(a).toBe(b);
      expect(new Set([a, c, d]).size).toBe(3);
      expect(a).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  it('WhatsApp: a ordem configurada é respeitada e o relé é a alternativa final', () => {
    const e = env({ ...RELAY, APPS_SCRIPT_CHANNELS: 'whatsapp', ALERT_WHATSAPP_TO: '11999998888', ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true', META_WHATSAPP_TOKEN: 'EAAtoken', META_WHATSAPP_PHONE_NUMBER_ID: '1', ALERT_WHATSAPP_TEMPLATE_NAME: 'm' });
    expect(whatsappAttempts(e, '+5511999998888', 'x', 'k').map((a) => a.provider)).toEqual(['meta-whatsapp', 'apps-script']);
  });
});
