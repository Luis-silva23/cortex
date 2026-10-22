import {
  composeIncidentMessage,
  emailConfig,
  formatDuration,
  maskPhone,
  normalizePhone,
  parsePhoneList,
  redact,
  sendEmailResend,
  sendSmsTwilio,
  sendWhatsappMeta,
  sendWhatsappTwilio,
  sendWithFailover,
  smsConfig,
  toSmsText,
  toTemplateParam,
  whatsappConfig,
  type TransportResult,
} from '@ln-system/shared/utils/alert-channels';

// Números, chaves e identificadores abaixo são FICTÍCIOS: nenhum provedor real é chamado (fetch simulado).
const SMS_ENV = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'token-de-teste-123',
  ALERT_SMS_FROM: '+15005550006',
  ALERT_SMS_TO: '(11) 99999-8888, +55 21 98888-7777',
  ALERT_SMS_SENDER_VERIFIED: 'true',
} as unknown as NodeJS.ProcessEnv;
const WA_ENV = {
  META_WHATSAPP_TOKEN: 'EAAtoken-de-teste-1234567890',
  META_WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  ALERT_WHATSAPP_TEMPLATE_NAME: 'alerta_cortex',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'token-de-teste-123',
  TWILIO_WHATSAPP_FROM: '+15005550006',
  TWILIO_WHATSAPP_CONTENT_SID: 'HX00000000000000000000000000000000',
  ALERT_WHATSAPP_TO: '11999998888',
  ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true',
} as unknown as NodeJS.ProcessEnv;

const res = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

describe('telefones', () => {
  it('normaliza para E.164 (assume Brasil sem "+") e recusa o que não é número', () => {
    expect(normalizePhone('+5511999998888')).toBe('+5511999998888');
    expect(normalizePhone('(11) 99999-8888')).toBe('+5511999998888');
    expect(normalizePhone('11 3333-4444')).toBe('+551133334444');
    expect(normalizePhone('5511999998888')).toBe('+5511999998888');
    expect(normalizePhone('whatsapp:+5511999998888')).toBe('+5511999998888');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
  it('lista: remove repetidos, conta os inválidos e mascara para exibição', () => {
    expect(parsePhoneList('11999998888, +5511999998888, xx, 21988887777')).toEqual({ valid: ['+5511999998888', '+5521988887777'], invalid: 1 });
    expect(maskPhone('+5511999998888')).toBe('+5511*****8888');
    expect(maskPhone('+5511999998888')).not.toContain('99999');
  });
  it('SMS em ASCII e uma linha; parâmetro de modelo do WhatsApp sem quebra de linha', () => {
    expect(toSmsText('Falha crítica — API\nDesde: 14:30')).toBe('Falha critica API | Desde: 14:30');
    expect(toTemplateParam('a\nb\tc   d')).toBe('a | b | c d');
  });
});

describe('mascaramento de erros', () => {
  it('tira chave, token, e-mail, telefone e identificadores do provedor', () => {
    const t = redact('Bearer abc.def-123 re_testkey_1234567890 fulano@exemplo.test +5511999998888 AC00000000000000000000000000000000 Basic dXNlcjpwYXNz1234');
    expect(t).not.toMatch(/abc\.def|re_testkey|fulano@|99999|AC0000|dXNlcjpw/);
    expect(t).toContain('[REDACTED]');
    expect(t).toContain('[email]');
    expect(t).toContain('[telefone]');
  });
});

describe('configuração', () => {
  it('e-mail exige chave, remetente, destinatários e a declaração do domínio', () => {
    expect(emailConfig({} as NodeJS.ProcessEnv).missing).toEqual(['RESEND_API_KEY', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO', 'RESEND_DOMAIN_VERIFIED=true']);
  });
  it('SMS: nada configurado lista o que falta; completo fica pronto e só com números válidos', () => {
    const none = smsConfig({} as NodeJS.ProcessEnv);
    expect(none.configured).toBe(false);
    expect(none.missing).toEqual(expect.arrayContaining(['TWILIO_ACCOUNT_SID', 'ALERT_SMS_TO', 'ALERT_SMS_SENDER_VERIFIED=true']));
    const full = smsConfig(SMS_ENV);
    expect(full).toMatchObject({ configured: true, providers: ['twilio'], to: ['+5511999998888', '+5521988887777'] });
    expect(smsConfig({ ...SMS_ENV, ALERT_SMS_SENDER_VERIFIED: 'false' } as NodeJS.ProcessEnv).missing).toEqual(['ALERT_SMS_SENDER_VERIFIED=true']);
    expect(smsConfig({ ...SMS_ENV, ALERT_SMS_TO: 'abc' } as NodeJS.ProcessEnv)).toMatchObject({ configured: false, invalidRecipients: 1 });
    expect(smsConfig({ ...SMS_ENV, TWILIO_AUTH_TOKEN: undefined, TWILIO_API_KEY_SID: 'SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', TWILIO_API_KEY_SECRET: 'segredo' } as unknown as NodeJS.ProcessEnv).configured).toBe(true);
  });
  it('WhatsApp: provedores prontos na ordem; exige declaração do modelo aprovado; ordem configurável', () => {
    expect(whatsappConfig(WA_ENV)).toMatchObject({ configured: true, providers: ['meta', 'twilio'], to: ['+5511999998888'] });
    expect(whatsappConfig({ ...WA_ENV, ALERT_WHATSAPP_PROVIDERS: 'twilio,meta' } as NodeJS.ProcessEnv).providers).toEqual(['twilio', 'meta']);
    expect(whatsappConfig({ ...WA_ENV, ALERT_WHATSAPP_TEMPLATE_APPROVED: '' } as NodeJS.ProcessEnv)).toMatchObject({ configured: false, providers: [] });
    const onlyTwilio = whatsappConfig({ ...WA_ENV, META_WHATSAPP_TOKEN: '' } as NodeJS.ProcessEnv);
    expect(onlyTwilio.providers).toEqual(['twilio']);
    expect(whatsappConfig({} as NodeJS.ProcessEnv).configured).toBe(false);
  });
});

describe('transportes (rede simulada)', () => {
  it('Resend: URL, Bearer, idempotência e lista de operadores', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(200, { id: 'em_1' }));
    const env = { RESEND_API_KEY: 're_testkey_1234567890', ALERT_EMAIL_FROM: 'a@exemplo.test', ALERT_EMAIL_TO: 'o1@exemplo.test,o2@exemplo.test', RESEND_DOMAIN_VERIFIED: 'true' } as unknown as NodeJS.ProcessEnv;
    const r = await sendEmailResend(env, { subject: 's', text: 't', idempotencyKey: 'k1' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, provider: 'resend', providerMessageId: 'em_1' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_testkey_1234567890');
    expect(init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(init.body).to).toEqual(['o1@exemplo.test', 'o2@exemplo.test']);
  });

  it('Twilio SMS: formulário com To/From/Body, Basic com a conta e o token, e só o necessário no corpo', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(201, { sid: 'SMabc', status: 'queued', error_code: null }));
    const r = await sendSmsTwilio(SMS_ENV, '+5511999998888', 'Falha crítica na API\nDesde 14:30', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, provider: 'twilio', providerMessageId: 'SMabc', retryable: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC00000000000000000000000000000000:token-de-teste-123').toString('base64')}`);
    const form = new URLSearchParams(init.body);
    expect(form.get('To')).toBe('+5511999998888');
    expect(form.get('From')).toBe('+15005550006');
    expect(form.get('Body')).toBe('Falha critica na API | Desde 14:30');
    expect(init.body).not.toContain('token-de-teste');
  });

  it('Twilio SMS com serviço de mensagens usa MessagingServiceSid em vez de From', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(201, { sid: 'SM1' }));
    await sendSmsTwilio({ ...SMS_ENV, ALERT_SMS_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000' } as unknown as NodeJS.ProcessEnv, '+5511999998888', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const form = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(form.get('MessagingServiceSid')).toBe('MG00000000000000000000000000000000');
    expect(form.has('From')).toBe(false);
  });

  it('erro da Twilio: número inválido NÃO é repetível; 429 e 5xx são; nada vaza no erro', async () => {
    const bad = await sendSmsTwilio(SMS_ENV, '+5511999998888', 'x', { fetchImpl: (() => res(400, { code: 21211, message: "The 'To' number +5511999998888 is not a valid phone number", status: 400 })) as unknown as typeof fetch });
    expect(bad).toMatchObject({ ok: false, httpStatus: 400, retryable: false });
    expect(bad.error).toContain('http_400');
    expect(bad.error).not.toContain('99999');
    const limited = await sendSmsTwilio(SMS_ENV, '+5511999998888', 'x', { fetchImpl: (() => res(429, { code: 20429, message: 'Too many requests', status: 429 })) as unknown as typeof fetch });
    expect(limited.retryable).toBe(true);
    const down = await sendSmsTwilio(SMS_ENV, '+5511999998888', 'x', { fetchImpl: (() => res(503, {})) as unknown as typeof fetch });
    expect(down.retryable).toBe(true);
    const net = await sendSmsTwilio(SMS_ENV, '+5511999998888', 'x', { fetchImpl: (() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.twilio.com'))) as unknown as typeof fetch });
    expect(net).toMatchObject({ ok: false, retryable: true });
  });

  it('resposta 200 com error_code da Twilio é falha (não confia só no status HTTP)', async () => {
    const r = await sendSmsTwilio(SMS_ENV, '+5511999998888', 'x', { fetchImpl: (() => res(200, { sid: 'SM1', error_code: 30007, error_message: 'Carrier violation' })) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
  });

  it('sem configuração não chama a rede', async () => {
    const fetchImpl = jest.fn();
    expect(await sendSmsTwilio({} as NodeJS.ProcessEnv, '+5511999998888', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, error: 'not_configured', retryable: false });
    expect(await sendWhatsappMeta({} as NodeJS.ProcessEnv, '+5511999998888', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, error: 'not_configured' });
    expect(await sendWhatsappTwilio({} as NodeJS.ProcessEnv, '+5511999998888', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, error: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('WhatsApp Meta: mensagem de MODELO com um parâmetro de texto sem quebra de linha, Bearer e versão da API', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.123' }] }));
    const r = await sendWhatsappMeta(WA_ENV, '+5511999998888', 'Novo alerta\nCRITICAL — API', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, provider: 'meta-whatsapp', providerMessageId: 'wamid.123' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(init.headers.Authorization).toBe('Bearer EAAtoken-de-teste-1234567890');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '5511999998888', type: 'template', template: { name: 'alerta_cortex', language: { code: 'pt_BR' } } });
    expect(body.template.components[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'Novo alerta | CRITICAL — API' }] });
  });

  it('WhatsApp Meta: erro do provedor (modelo não aprovado, token inválido) não é repetível e vem mascarado', async () => {
    const r = await sendWhatsappMeta(WA_ENV, '+5511999998888', 'x', { fetchImpl: (() => res(400, { error: { message: 'Template name does not exist for +5511999998888', code: 132001 } })) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, httpStatus: 400, retryable: false });
    expect(r.error).not.toContain('99999');
  });

  it('WhatsApp Twilio: prefixo whatsapp:, ContentSid do modelo e a mensagem em ContentVariables', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(201, { sid: 'SMwa1' }));
    const r = await sendWhatsappTwilio(WA_ENV, '+5511999998888', 'Alerta\nCRITICAL', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, provider: 'twilio-whatsapp', providerMessageId: 'SMwa1' });
    const form = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(form.get('To')).toBe('whatsapp:+5511999998888');
    expect(form.get('From')).toBe('whatsapp:+15005550006');
    expect(form.get('ContentSid')).toBe('HX00000000000000000000000000000000');
    expect(JSON.parse(form.get('ContentVariables')!)).toEqual({ '1': 'Alerta | CRITICAL' });
  });
});

describe('tentativas controladas e provedor alternativo', () => {
  const ok = (provider: string): TransportResult => ({ ok: true, provider, retryable: false });
  const fail = (provider: string, retryable: boolean): TransportResult => ({ ok: false, provider, error: 'x', retryable });
  const noSleep = jest.fn().mockResolvedValue(undefined);

  it('falha repetível: tenta de novo no mesmo provedor com espera e aceita', async () => {
    const run = jest.fn().mockResolvedValueOnce(fail('a', true)).mockResolvedValueOnce(ok('a'));
    const r = await sendWithFailover([{ provider: 'a', run }], { sleep: noSleep, backoffMs: [500] });
    expect(r.result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(500);
  });
  it('falha NÃO repetível passa direto ao provedor alternativo, sem repetir o primeiro', async () => {
    const a = jest.fn().mockResolvedValue(fail('a', false));
    const b = jest.fn().mockResolvedValue(ok('b'));
    const r = await sendWithFailover([{ provider: 'a', run: a }, { provider: 'b', run: b }], { sleep: noSleep });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(r.result.provider).toBe('b');
    expect(r.tried.map((t) => t.provider)).toEqual(['a', 'b']);
  });
  it('todos falham: devolve a última falha e o histórico; sem provedor, diz que não há provedor', async () => {
    const r = await sendWithFailover([{ provider: 'a', run: async () => fail('a', true) }, { provider: 'b', run: async () => fail('b', true) }], { sleep: noSleep, attemptsPerProvider: 2 });
    expect(r.result.ok).toBe(false);
    expect(r.tried).toHaveLength(4);
    expect((await sendWithFailover([])).result.error).toBe('no_provider_configured');
  });
});

describe('mensagem do incidente', () => {
  it('abertura e recuperação levam tipo, alvo, desde quando e duração, sem dado sensível', () => {
    const open = composeIncidentMessage({ phase: 'OPEN', severity: 'CRITICAL', target: 'API', type: 'EXTERNAL_API_DOWN', detail: '3 falhas seguidas', since: new Date('2026-10-22T14:30:00Z'), source: 'monitor externo', panelUrl: 'https://super.exemplo.test/x' });
    expect(open.subject).toBe('[CÓRTEX] Novo alerta · CRITICAL · API');
    expect(open.text).toContain('Desde: 2026-10-22 14:30 UTC');
    expect(open.text).toContain('Origem da medição: monitor externo');
    const rec = composeIncidentMessage({ phase: 'RECOVERED', severity: 'CRITICAL', target: 'API', type: 'EXTERNAL_API_DOWN', source: 'monitor externo', durationMs: 7 * 60_000 });
    expect(rec.text).toContain('RECUPERADO');
    expect(rec.text).toContain('Duração: 7 min');
    expect(`${open.text}${rec.text}`).not.toMatch(/token|senha|secret|@/i);
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 5 min');
  });
});
