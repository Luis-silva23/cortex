/**
 * Canal WHATSAPP — INTERFACE + adaptador para a API OFICIAL (WhatsApp Business Platform / Cloud API da Meta). Nada de WhatsApp Web, bibliotecas não oficiais ou automação.
 * Mensagem iniciada pela empresa só pode usar MODELO (template) APROVADO pela Meta: WA_TEMPLATE_APPROVED=true é a declaração do operador depois da aprovação.
 * O modelo precisa ter UMA variável de corpo ({{1}}), que recebe o texto do alerta. Sem token/número/modelo/lista permitida/declaração → `not_configured` (sem simular sucesso).
 * Custos: a Meta cobra por mensagem enviada pela empresa (categorias e tabela de preços mudam — conferir a página oficial); por isso o padrão é DESLIGADO.
 */
var WA_PROVIDERS_ = { meta: waMeta_ };

function waMeta_(to, text) {
  var version = prop_('WA_META_API_VERSION') || 'v23.0';
  if (!/^v[0-9]{1,2}\.[0-9]$/.test(version)) version = 'v23.0';
  var phoneId = prop_('WA_META_PHONE_NUMBER_ID');
  var body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: prop_('WA_TEMPLATE_NAME'),
      language: { code: prop_('WA_TEMPLATE_LANG') || 'pt_BR' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: text }] }],
    },
  };
  return fetchProvider_('https://graph.facebook.com/' + version + '/' + encodeURIComponent(phoneId) + '/messages', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + prop_('WA_META_TOKEN') },
    muteHttpExceptions: true,
    followRedirects: false,
  });
}

function prepareWhatsapp_(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, status: 'invalid_request', detail: 'payload' };
  if (typeof p.to !== 'string' || typeof p.text !== 'string') return { ok: false, status: 'invalid_request', detail: 'fields' };
  var to = p.to.trim();
  // parâmetro de modelo do WhatsApp não aceita quebra de linha, tabulação nem sequência longa de espaços
  var text = cleanLine_(p.text).slice(0, LIMITS_.WA_PARAM_MAX);
  if (!PHONE_RE_.test(to)) return { ok: false, status: 'invalid_request', detail: 'to_format' };
  if (text.length < 1) return { ok: false, status: 'invalid_request', detail: 'text' };

  var providerName = prop_('WA_PROVIDER') || 'meta';
  var provider = WA_PROVIDERS_[providerName];
  if (!provider) return { ok: false, status: 'not_configured', detail: 'provider' };
  var allowed = listProp_('WA_ALLOWED_RECIPIENTS');
  if (allowed.length === 0 || !propBool_('WA_TEMPLATE_APPROVED')) return { ok: false, status: 'not_configured', detail: 'recipients_or_template' };
  if (providerName === 'meta' && (!prop_('WA_META_TOKEN') || !prop_('WA_META_PHONE_NUMBER_ID') || !prop_('WA_TEMPLATE_NAME'))) {
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
