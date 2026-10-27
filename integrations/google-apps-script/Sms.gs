/**
 * Canal SMS — INTERFACE + adaptador HTTP substituível. O Apps Script NÃO envia SMS sozinho: precisa de um provedor externo. Adaptadores ficam em SMS_PROVIDERS_
 * (hoje: `twilio`); para trocar de provedor, acrescente uma função com a mesma forma e escolha-a em SMS_PROVIDER — nada mais muda.
 * NÃO simula sucesso: sem provedor/credencial/lista permitida/declaração de remetente → `not_configured`.
 * Não existe provedor gratuito adequado para alertas no Brasil (ver doc): o adaptador fica pronto e desligado até haver conta e remetente aprovados.
 */
var PHONE_RE_ = /^\+[1-9][0-9]{9,14}$/;

var SMS_PROVIDERS_ = { twilio: smsTwilio_ };

/** Contrato de adaptador: recebe (to, text) e devolve { status:'sent'|'failed', detail, retryable, ambiguous }. `ambiguous` = pode ter sido enviado (timeout/5xx). */
function smsTwilio_(to, text) {
  var sid = prop_('SMS_TWILIO_ACCOUNT_SID');
  var token = prop_('SMS_TWILIO_AUTH_TOKEN');
  var form = { To: to, Body: text };
  if (prop_('SMS_TWILIO_MESSAGING_SERVICE_SID')) form.MessagingServiceSid = prop_('SMS_TWILIO_MESSAGING_SERVICE_SID');
  else form.From = prop_('SMS_FROM');
  return fetchProvider_('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
    method: 'post',
    payload: form,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(sid + ':' + token) },
    muteHttpExceptions: true,
    followRedirects: false,
  });
}

/** Chamada HTTP a provedor com classificação uniforme (usada por SMS e WhatsApp). Nunca devolve o corpo da resposta nem credenciais. */
function fetchProvider_(url, options) {
  var res;
  try {
    res = UrlFetchApp.fetch(url, options);
  } catch (e) {
    // tempo esgotado / falha de rede: o provedor PODE ter recebido
    return { status: 'failed', detail: 'provider_unreachable', retryable: true, ambiguous: true };
  }
  var code = Number(res.getResponseCode());
  if (code >= 200 && code < 300) return { status: 'sent' };
  if (code === 429) return { status: 'failed', detail: 'provider_http_429', retryable: true, ambiguous: false };
  if (code >= 500) return { status: 'failed', detail: 'provider_http_' + code, retryable: true, ambiguous: true };
  if (code >= 300 && code < 400) return { status: 'failed', detail: 'provider_redirect', retryable: false, ambiguous: false };
  return { status: 'failed', detail: 'provider_http_' + code, retryable: false, ambiguous: false };
}

function prepareSms_(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, status: 'invalid_request', detail: 'payload' };
  if (typeof p.to !== 'string' || typeof p.text !== 'string') return { ok: false, status: 'invalid_request', detail: 'fields' };
  var to = p.to.trim();
  var text = cleanLine_(p.text);
  if (!PHONE_RE_.test(to)) return { ok: false, status: 'invalid_request', detail: 'to_format' };
  if (text.length < 1 || text.length > LIMITS_.SMS_TEXT_MAX) return { ok: false, status: 'invalid_request', detail: 'text' };

  var providerName = prop_('SMS_PROVIDER') || 'twilio';
  var provider = SMS_PROVIDERS_[providerName];
  if (!provider) return { ok: false, status: 'not_configured', detail: 'provider' };
  var allowed = listProp_('SMS_ALLOWED_RECIPIENTS');
  if (allowed.length === 0 || !propBool_('SMS_SENDER_VERIFIED')) return { ok: false, status: 'not_configured', detail: 'recipients_or_sender' };
  if (providerName === 'twilio' && (!prop_('SMS_TWILIO_ACCOUNT_SID') || !prop_('SMS_TWILIO_AUTH_TOKEN') || !(prop_('SMS_FROM') || prop_('SMS_TWILIO_MESSAGING_SERVICE_SID')))) {
    return { ok: false, status: 'not_configured', detail: 'credentials' };
  }
  if (allowed.indexOf(to) < 0) return { ok: false, status: 'invalid_request', detail: 'recipient_not_allowed' };
  return {
    ok: true,
    recipients: 1,
    provider: providerName,
    send: function () {
      return provider(to, text);
    },
  };
}
