'use strict';
// Testes LOCAIS do relé (arquivos .gs reais em contexto simulado). Rodam sem rede e sem enviar nada:  node --test integrations/google-apps-script/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScript, SECRET } = require('./harness');

const TWILIO_TOKEN = 'twilio-token-de-teste-123456789';
const META_TOKEN = 'meta-token-de-teste-123456789';
const EMAILS = 'ops@example.com,dev@example.com';
const PHONE = '+5511999998888';

const emailProps = { RELAY_SECRET: SECRET, EMAIL_ALLOWED_RECIPIENTS: EMAILS };
const smsProps = { RELAY_SECRET: SECRET, SMS_ALLOWED_RECIPIENTS: PHONE, SMS_SENDER_VERIFIED: 'true', SMS_TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), SMS_TWILIO_AUTH_TOKEN: TWILIO_TOKEN, SMS_FROM: '+15005550006' };
const waProps = { RELAY_SECRET: SECRET, WA_ALLOWED_RECIPIENTS: PHONE, WA_TEMPLATE_APPROVED: 'true', WA_META_TOKEN: META_TOKEN, WA_META_PHONE_NUMBER_ID: '1234567890', WA_TEMPLATE_NAME: 'alerta_cortex' };

const email = (s, payload = { subject: 'Queda crítica', text: 'API fora do ar desde 12:00' }, extra = {}) => s.sign({ channel: 'email', payload, ...extra });
const sms = (s, payload = { to: PHONE, text: 'CORTEX: API fora' }, extra = {}) => s.sign({ channel: 'sms', payload, ...extra });
const wa = (s, payload = { to: PHONE, text: 'CORTEX: API fora' }, extra = {}) => s.sign({ channel: 'whatsapp', payload, ...extra });

// ------------------------------------------------------------------------------------------------------------------------------------
test('e-mail: requisição assinada válida envia UMA vez, com prefixo, remetente fixo e só para a lista permitida', () => {
  const s = createScript({ props: emailProps });
  const r = s.post(email(s));
  assert.equal(r.status, 'sent');
  assert.equal(r.ok, true);
  assert.equal(s.mail.sent.length, 1);
  const m = s.mail.sent[0];
  assert.equal(m.to, 'ops@example.com,dev@example.com');
  assert.equal(m.subject, '[CÓRTEX] Queda crítica');
  assert.equal(m.noReply, true);
  assert.equal(m.name, 'CÓRTEX');
});

test('assinatura incorreta, payload adulterado, segredo errado e assinatura mal formada: nada é enviado', () => {
  const s = createScript({ props: emailProps });
  const good = JSON.parse(email(s));
  const wrongSig = JSON.stringify({ ...good, sig: '0'.repeat(64) });
  assert.equal(s.post(wrongSig).status, 'unauthorized');
  const tampered = JSON.stringify({ ...good, payload: good.payload.replace('Queda', 'Falso') });
  assert.equal(s.post(tampered).status, 'unauthorized');
  assert.equal(s.post(email(s, undefined, { secret: 'outro-segredo-'.padEnd(40, 'z') })).status, 'unauthorized');
  assert.equal(s.post(JSON.stringify({ ...good, sig: 'xyz' })).status, 'invalid_request');
  assert.equal(s.mail.sent.length, 0);
});

test('o canal assinado não pode ser trocado: assinatura de e-mail não vale para SMS', () => {
  const s = createScript({ props: { ...emailProps, ...smsProps } });
  const good = JSON.parse(email(s, { to: PHONE, text: 'x' }));
  assert.equal(s.post(JSON.stringify({ ...good, channel: 'sms' })).status, 'unauthorized');
  assert.equal(s.fetches.calls.length, 0);
});

test('timestamp expirado (passado) ou do futuro distante é recusado como não autorizado', () => {
  const s = createScript({ props: emailProps });
  const old = email(s, undefined, { ts: Math.floor(s.now() / 1000) - 600 });
  assert.equal(s.post(old).status, 'unauthorized');
  const future = email(s, undefined, { ts: Math.floor(s.now() / 1000) + 600 });
  assert.equal(s.post(future).status, 'unauthorized');
  const edge = email(s, undefined, { ts: Math.floor(s.now() / 1000) - 299 });
  assert.equal(s.post(edge).status, 'sent');
  assert.equal(s.mail.sent.length, 1);
});

test('repetição do mesmo identificador não envia de novo (duplicate), mesmo dentro da janela', () => {
  const s = createScript({ props: emailProps });
  const raw = email(s);
  assert.equal(s.post(raw).status, 'sent');
  const again = s.post(raw);
  assert.equal(again.status, 'duplicate');
  assert.equal(again.ok, true);
  assert.equal(s.mail.sent.length, 1);
});

test('falha com certeza de que NADA saiu libera o identificador e devolve a cota: a repetição pode funcionar', () => {
  const s = createScript({ props: { ...emailProps, EMAIL_MAX_PER_HOUR: '1' } });
  const raw = email(s);
  s.mail.throwOnSend = 'Exception: boom';
  const first = s.post(raw);
  assert.equal(first.status, 'failed');
  assert.equal(first.retryable, false);
  s.mail.throwOnSend = null;
  assert.equal(s.post(raw).status, 'sent'); // mesmo id, e a cota de 1/h não foi gasta pela falha
  assert.equal(s.mail.sent.length, 1);
});

test('limite de taxa do Google no MailApp vira rate_limited (não "falha de envio")', () => {
  const s = createScript({ props: emailProps });
  s.mail.throwOnSend = 'Service invoked too many times for one day: email.';
  assert.equal(s.post(email(s)).status, 'rate_limited');
});

// ------------------------------------------------------------------------------------------------------------------------------------
test('payload e envelope inválidos são recusados (invalid_request) sem enviar nada', () => {
  const s = createScript({ props: emailProps });
  const cases = [
    ['corpo não é JSON', '{nao e json'],
    ['corpo vazio', ''],
    ['corpo gigante', 'x'.repeat(17000)],
    ['array no lugar do objeto', '[]'],
    ['versão desconhecida', s.sign({ channel: 'email', payload: { subject: 'a', text: 'b' }, v: 2 })],
    ['canal desconhecido', s.sign({ channel: 'pombo', payload: { subject: 'a', text: 'b' } })],
    ['identificador curto', s.sign({ channel: 'email', payload: { subject: 'a', text: 'b' }, id: 'curto' })],
    ['assunto vazio', email(s, { subject: '   ', text: 'b' })],
    ['assunto grande demais', email(s, { subject: 'a'.repeat(151), text: 'b' })],
    ['texto vazio', email(s, { subject: 'a', text: '' })],
    ['texto grande demais', email(s, { subject: 'a', text: 'b'.repeat(4001) })],
    ['campos de tipo errado', email(s, { subject: 5, text: {} })],
    ['payload que não é objeto', s.sign({ channel: 'email', payload: '"texto"' })],
    ['payload não é JSON', s.sign({ channel: 'email', payload: 'isto nao e json' })],
  ];
  for (const [what, raw] of cases) {
    const r = s.post(raw);
    assert.equal(r.status, 'invalid_request', `${what}: ${JSON.stringify(r)}`);
  }
  assert.equal(s.mail.sent.length, 0);
});

test('ts não numérico e envelope sem campos obrigatórios são recusados', () => {
  const s = createScript({ props: emailProps });
  const good = JSON.parse(email(s));
  for (const bad of [{ ts: '123' }, { ts: 1.5 }, { id: undefined }, { payload: undefined }, { sig: undefined }, { channel: undefined }]) {
    const r = s.post(JSON.stringify({ ...good, ...bad }));
    assert.equal(r.status, 'invalid_request', JSON.stringify(bad));
  }
});

test('assunto com quebra de linha não injeta cabeçalhos: vira uma linha só', () => {
  const s = createScript({ props: emailProps });
  s.post(email(s, { subject: 'Alerta\r\nBcc: alguem@evil.com', text: 'x' }));
  assert.ok(!/[\r\n]/.test(s.mail.sent[0].subject));
});

// ------------------------------------------------------------------------------------------------------------------------------------
test('destinatários: só da lista permitida; formato inválido, excesso e lista ausente são tratados', () => {
  const s = createScript({ props: emailProps });
  assert.equal(s.post(email(s, { subject: 'a', text: 'b', to: ['intruso@evil.com'] })).detail, 'recipient_not_allowed');
  assert.equal(s.post(email(s, { subject: 'a', text: 'b', to: ['nao-e-email'] })).detail, 'to_format');
  assert.equal(s.post(email(s, { subject: 'a', text: 'b', to: [] })).detail, 'to_count');
  assert.equal(s.post(email(s, { subject: 'a', text: 'b', to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'] })).detail, 'to_count');
  assert.equal(s.post(email(s, { subject: 'a', text: 'b', to: 'ops@example.com' })).detail, 'to_count');
  assert.equal(s.mail.sent.length, 0);
  // subconjunto permitido (e caixa alta) funciona e não duplica endereço
  const ok = s.post(email(s, { subject: 'a', text: 'b', to: ['OPS@example.com', 'ops@example.com'] }));
  assert.equal(ok.status, 'sent');
  assert.equal(s.mail.sent[0].to, 'ops@example.com');
  // sem lista permitida: não configurado
  const none = createScript({ props: { RELAY_SECRET: SECRET } });
  assert.equal(none.post(email(none)).status, 'not_configured');
});

test('cota diária do Gmail: sem folga para os destinatários + reserva, não envia (rate_limited)', () => {
  const s = createScript({ props: emailProps, mailRemaining: 6 }); // 2 destinatários + reserva 5 = 7 > 6
  const r = s.post(email(s));
  assert.equal(r.status, 'rate_limited');
  assert.equal(r.detail, 'gmail_quota');
  s.mail.remaining = 7;
  assert.equal(s.post(email(s)).status, 'sent');
});

test('limites próprios por hora e por dia; o teto de segurança não pode ser aumentado por propriedade', () => {
  const s = createScript({ props: { ...emailProps, EMAIL_MAX_PER_HOUR: '2' } });
  assert.equal(s.post(email(s)).status, 'sent');
  assert.equal(s.post(email(s)).status, 'sent');
  const third = s.post(email(s));
  assert.equal(third.status, 'rate_limited');
  assert.equal(third.detail, 'hour');
  s.advance(3_600_000 + 1000); // próxima hora
  assert.equal(s.post(email(s)).status, 'sent');
  // teto: pedir 9999/dia é valor fora da faixa permitida → volta ao padrão seguro (30), nunca acima do teto de 90
  const t = createScript({ props: { ...emailProps, EMAIL_MAX_PER_DAY: '9999' } });
  assert.equal(t.run("channelLimit_('email','day')"), 30);
  const edge = createScript({ props: { ...emailProps, EMAIL_MAX_PER_DAY: '90' } });
  assert.equal(edge.run("channelLimit_('email','day')"), 90);
  const inv = createScript({ props: { ...emailProps, EMAIL_MAX_PER_DAY: 'muito' } });
  assert.equal(inv.run("channelLimit_('email','day')"), 30);
});

test('limite diário vale entre horas e o contador de dias antigos é limpo', () => {
  const s = createScript({ props: { ...emailProps, EMAIL_MAX_PER_HOUR: '90', EMAIL_MAX_PER_DAY: '3' } });
  for (let i = 0; i < 3; i++) assert.equal(s.post(email(s)).status, 'sent');
  assert.equal(s.post(email(s)).detail, 'day');
  s.advance(26 * 3_600_000);
  assert.equal(s.post(email(s)).status, 'sent');
  const dayKeys = [...s.store.keys()].filter((k) => /^rl:email:d:/.test(k));
  assert.equal(dayKeys.length, 1); // o contador do dia anterior foi removido
});

// ------------------------------------------------------------------------------------------------------------------------------------
test('segredo ausente ou curto: nada é aceito (not_configured)', () => {
  for (const props of [{}, { RELAY_SECRET: 'curto', EMAIL_ALLOWED_RECIPIENTS: EMAILS }]) {
    const s = createScript({ props });
    assert.equal(s.post(email(s)).status, 'not_configured');
    assert.equal(s.mail.sent.length, 0);
  }
});

test('modo simulado (DRY_RUN): valida tudo, não envia, não consome cota e não reserva o identificador', () => {
  const s = createScript({ props: { ...emailProps, DRY_RUN: 'true', EMAIL_MAX_PER_HOUR: '1' } });
  const raw = email(s);
  for (let i = 0; i < 3; i++) {
    const r = s.post(raw);
    assert.equal(r.status, 'dry_run');
    assert.equal(r.ok, true);
  }
  assert.equal(s.mail.sent.length, 0);
  assert.equal([...s.store.keys()].filter((k) => k.startsWith('rl:')).length, 0);
  // a validação continua valendo em modo simulado
  assert.equal(s.post(email(s, { subject: '', text: 'x' })).status, 'invalid_request');
});

test('erro interno inesperado: resposta com código fixo, sem a mensagem do erro', () => {
  const s = createScript({ props: emailProps });
  s.ctx.MailApp.getRemainingDailyQuota = () => {
    throw new Error('detalhe interno secreto ' + SECRET);
  };
  const r = s.post(email(s));
  assert.equal(r.status, 'failed');
  assert.equal(r.detail, 'internal_error');
  assert.ok(!JSON.stringify(r).includes('secreto'));
});

// ------------------------------------------------------------------------------------------------------------------------------------
test('SMS: sem configuração NÃO simula sucesso (not_configured) em cada tipo de falta', () => {
  const cases = [
    ['sem nada', { RELAY_SECRET: SECRET }],
    ['sem declaração de remetente', { ...smsProps, SMS_SENDER_VERIFIED: 'false' }],
    ['sem lista permitida', { ...smsProps, SMS_ALLOWED_RECIPIENTS: '' }],
    ['sem credenciais', { RELAY_SECRET: SECRET, SMS_ALLOWED_RECIPIENTS: PHONE, SMS_SENDER_VERIFIED: 'true' }],
    ['provedor desconhecido', { ...smsProps, SMS_PROVIDER: 'inexistente' }],
  ];
  for (const [what, props] of cases) {
    const s = createScript({ props });
    const r = s.post(sms(s));
    assert.equal(r.status, 'not_configured', what);
    assert.equal(r.ok, false);
    assert.equal(s.fetches.calls.length, 0, what);
  }
});

test('SMS configurado: envia ao provedor com credenciais no cabeçalho (nunca na URL ou no corpo) e só para número permitido', () => {
  const s = createScript({ props: smsProps, fetchHandler: () => ({ code: 201, body: '{"sid":"SM1"}' }) });
  assert.equal(s.post(sms(s)).status, 'sent');
  const c = s.fetches.calls[0];
  assert.ok(c.url.startsWith('https://api.twilio.com/2010-04-01/Accounts/AC'));
  assert.ok(!c.url.includes(TWILIO_TOKEN));
  assert.equal(c.options.payload.To, PHONE);
  assert.ok(!JSON.stringify(c.options.payload).includes(TWILIO_TOKEN));
  assert.match(c.options.headers.Authorization, /^Basic /);
  assert.equal(c.options.followRedirects, false);
  assert.equal(s.post(sms(s, { to: '+5511888887777', text: 'x' })).detail, 'recipient_not_allowed');
  assert.equal(s.post(sms(s, { to: '11999998888', text: 'x' })).detail, 'to_format');
  assert.equal(s.fetches.calls.length, 1);
});

test('SMS: falhas do provedor — 4xx (definitiva), 429, 5xx, tempo esgotado e redirecionamento inesperado', () => {
  const run = (handler) => {
    const s = createScript({ props: smsProps, fetchHandler: handler });
    const raw = sms(s);
    const first = s.post(raw);
    return { s, raw, first };
  };
  const r400 = run(() => ({ code: 400, body: 'x' }));
  assert.deepEqual([r400.first.status, r400.first.retryable, r400.first.ambiguous], ['failed', false, false]);
  assert.equal(r400.s.post(r400.raw).status, 'failed'); // id foi liberado: repetir tenta de novo (e falha de novo)

  const r429 = run(() => ({ code: 429, body: '' }));
  assert.deepEqual([r429.first.retryable, r429.first.ambiguous], [true, false]);

  const r500 = run(() => ({ code: 503, body: '' }));
  assert.deepEqual([r500.first.status, r500.first.retryable, r500.first.ambiguous], ['failed', true, true]);
  // ambíguo: pode ter sido enviado → o identificador fica reservado e a repetição NÃO reenvia
  const again = r500.s.post(r500.raw);
  assert.equal(again.status, 'duplicate');
  assert.equal(r500.s.fetches.calls.length, 1);

  const timeout = run(() => new Error('Exception: Timeout'));
  assert.deepEqual([timeout.first.detail, timeout.first.retryable, timeout.first.ambiguous], ['provider_unreachable', true, true]);

  const redirect = run(() => ({ code: 302, body: '' }));
  assert.equal(redirect.first.detail, 'provider_redirect');
  assert.equal(redirect.first.retryable, false);
});

test('SMS: o limite próprio do canal (3/h) vale e falha definitiva devolve a cota', () => {
  const s = createScript({ props: smsProps, fetchHandler: () => ({ code: 201, body: '{}' }) });
  for (let i = 0; i < 3; i++) assert.equal(s.post(sms(s)).status, 'sent');
  assert.equal(s.post(sms(s)).status, 'rate_limited');
  const f = createScript({ props: smsProps, fetchHandler: () => ({ code: 400, body: '' }) });
  for (let i = 0; i < 6; i++) assert.equal(f.post(sms(f)).status, 'failed'); // nunca vira rate_limited: falha definitiva não consome
});

// ------------------------------------------------------------------------------------------------------------------------------------
test('WhatsApp: sem token, número, modelo, lista ou declaração de modelo aprovado → not_configured (sem simular)', () => {
  const cases = [
    ['sem nada', { RELAY_SECRET: SECRET }],
    ['modelo não declarado aprovado', { ...waProps, WA_TEMPLATE_APPROVED: 'false' }],
    ['sem token', { ...waProps, WA_META_TOKEN: '' }],
    ['sem número de telefone da conta', { ...waProps, WA_META_PHONE_NUMBER_ID: '' }],
    ['sem nome do modelo', { ...waProps, WA_TEMPLATE_NAME: '' }],
    ['sem lista permitida', { ...waProps, WA_ALLOWED_RECIPIENTS: '' }],
    ['provedor desconhecido', { ...waProps, WA_PROVIDER: 'whatsapp-web' }],
  ];
  for (const [what, props] of cases) {
    const s = createScript({ props });
    const r = s.post(wa(s));
    assert.equal(r.status, 'not_configured', what);
    assert.equal(s.fetches.calls.length, 0, what);
  }
});

test('WhatsApp configurado: usa a API oficial (Graph), com modelo de UMA variável, texto numa linha e token só no cabeçalho', () => {
  const s = createScript({ props: waProps, fetchHandler: () => ({ code: 200, body: '{"messages":[{"id":"wamid"}]}' }) });
  const r = s.post(wa(s, { to: PHONE, text: 'Linha 1\nLinha 2\t\tfim' }));
  assert.equal(r.status, 'sent');
  const c = s.fetches.calls[0];
  assert.equal(c.url, 'https://graph.facebook.com/v23.0/1234567890/messages');
  assert.equal(c.options.headers.Authorization, `Bearer ${META_TOKEN}`);
  const body = JSON.parse(c.options.payload);
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'alerta_cortex');
  assert.equal(body.template.language.code, 'pt_BR');
  assert.equal(body.to, '5511999998888');
  assert.equal(body.template.components[0].parameters[0].text, 'Linha 1 Linha 2 fim');
  assert.ok(!c.url.includes(META_TOKEN) && !c.options.payload.includes(META_TOKEN));
});

test('WhatsApp: versão da API inválida cai no padrão; 401 é definitivo; 5xx é ambíguo; número fora da lista é recusado', () => {
  const s = createScript({ props: { ...waProps, WA_META_API_VERSION: '../../x' }, fetchHandler: () => ({ code: 401, body: '{"error":{"message":"token"}}' }) });
  const r = s.post(wa(s));
  assert.ok(s.fetches.calls[0].url.includes('/v23.0/'));
  assert.deepEqual([r.status, r.detail, r.retryable, r.ambiguous], ['failed', 'provider_http_401', false, false]);
  assert.ok(!JSON.stringify(r).includes('token'));
  const f = createScript({ props: waProps, fetchHandler: () => ({ code: 500, body: '' }) });
  const r5 = f.post(wa(f));
  assert.deepEqual([r5.retryable, r5.ambiguous], [true, true]);
  assert.equal(s.post(wa(s, { to: '+5511000000000', text: 'x' })).detail, 'recipient_not_allowed');
});

test('WhatsApp: o limite próprio usa WHATSAPP_MAX_PER_HOUR (nome documentado) e passa a recusar com rate_limited', () => {
  const s = createScript({ props: { ...waProps, WHATSAPP_MAX_PER_HOUR: '1' }, fetchHandler: () => ({ code: 200, body: '{}' }) });
  assert.equal(s.post(wa(s)).status, 'sent');
  const second = s.post(wa(s));
  assert.equal(second.status, 'rate_limited');
  assert.equal(second.detail, 'hour');
});

// ------------------------------------------------------------------------------------------------------------------------------------
test('REGISTROS: nenhum segredo, token, assinatura, destinatário, número nem texto de mensagem aparece nos logs', () => {
  const s = createScript({ props: { ...emailProps, ...smsProps, ...waProps }, fetchHandler: () => ({ code: 201, body: '{}' }) });
  const raws = [email(s, { subject: 'Assunto confidencial XYZ', text: 'Texto confidencial ABC' }), sms(s, { to: PHONE, text: 'Texto sms confidencial DEF' }), wa(s, { to: PHONE, text: 'Texto wa confidencial GHI' })];
  for (const raw of raws) s.post(raw);
  s.post(raws[0]); // duplicado
  s.post(email(s, undefined, { sig: '0'.repeat(64) })); // não autorizado
  s.post('{ruim'); // inválido
  s.ctx.showConfigStatus();
  s.ctx.selfTestDryRun();
  const all = s.logs.join('\n');
  assert.ok(s.logs.length >= 6);
  for (const forbidden of [SECRET, TWILIO_TOKEN, META_TOKEN, 'ops@example.com', 'dev@example.com', PHONE, '5511999998888', 'confidencial', ...raws.map((r) => JSON.parse(r).sig), ...raws.map((r) => JSON.parse(r).id)]) {
    assert.ok(!all.includes(forbidden), `vazou: ${forbidden.slice(0, 12)}…`);
  }
  // só campos da lista fixa, em JSON
  const allowed = new Set(['event', 'id', 'channel', 'status', 'detail', 'ms', 'recipients', 'retryable', 'provider']);
  for (const line of s.logs.filter((l) => l.startsWith('{"event"'))) for (const k of Object.keys(JSON.parse(line))) assert.ok(allowed.has(k), `campo fora da lista: ${k}`);
});

test('showConfigStatus mostra só sim/não por propriedade (nunca valores) e selfTestDryRun não envia e restaura DRY_RUN', () => {
  const s = createScript({ props: { ...emailProps, ...smsProps, ...waProps, DRY_RUN: 'false' } });
  const st = s.ctx.showConfigStatus();
  for (const v of Object.values(st)) assert.ok(typeof v === 'boolean' || typeof v === 'number');
  const out = s.ctx.selfTestDryRun();
  assert.equal(out.status, 'dry_run');
  assert.equal(s.store.get('DRY_RUN'), 'false');
  assert.equal(s.mail.sent.length, 0);
  const t = createScript({ props: emailProps });
  t.ctx.selfTestDryRun();
  assert.equal(t.store.has('DRY_RUN'), false);
});

test('doGet responde vivo sem expor configuração; safeEqual_ compara em tempo constante e rejeita tamanhos diferentes', () => {
  const s = createScript({ props: emailProps });
  const g = JSON.parse(s.ctx.doGet().getContent());
  assert.deepEqual(Object.keys(g).sort(), ['ok', 'service', 'version']);
  assert.equal(s.run("safeEqual_('abc','abc')"), true);
  assert.equal(s.run("safeEqual_('abc','abd')"), false);
  assert.equal(s.run("safeEqual_('abc','abcd')"), false);
});

test('compatibilidade com a assinatura do contrato: valor conhecido de HMAC-SHA256', () => {
  const s = createScript({ props: emailProps });
  const expected = require('node:crypto').createHmac('sha256', SECRET).update('1\n1\nid\nemail\n{}').digest('hex');
  assert.equal(s.run(`hmacHex_('${SECRET}', '1\\n1\\nid\\nemail\\n{}')`), expected);
});
