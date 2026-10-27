/**
 * Canal E-MAIL (Gmail via MailApp: escopo mínimo `script.send_mail`, sem ler caixa de entrada).
 * Política de destinatários: a requisição NUNCA escolhe livremente quem recebe. O script só envia para endereços da LISTA PERMITIDA (propriedade EMAIL_ALLOWED_RECIPIENTS);
 * se a requisição informar `to`, cada endereço precisa estar nessa lista; se não informar, vai para a lista inteira (até o máximo). Sem lista → not_configured.
 * O remetente é a conta dona do script (limitação do MailApp); só o NOME exibido é configurável (EMAIL_FROM_NAME).
 */
var EMAIL_RE_ = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,24}$/;

/** Troca caracteres de controle (inclui quebras de linha e separadores Unicode de linha) por espaço e comprime espaços: impede injeção de cabeçalho. */
function cleanLine_(s) {
  var str = String(s);
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    out += c < 32 || c === 127 || c === 8232 || c === 8233 ? ' ' : str.charAt(i);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Valida o payload do e-mail e devolve { ok:true, send } ou { ok:false, status, detail }. NÃO envia nada. */
function prepareEmail_(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, status: 'invalid_request', detail: 'payload' };
  if (typeof p.subject !== 'string' || typeof p.text !== 'string') return { ok: false, status: 'invalid_request', detail: 'fields' };
  var subject = cleanLine_(p.subject);
  var text = p.text.trim();
  if (subject.length < 1 || subject.length > LIMITS_.EMAIL_SUBJECT_MAX) return { ok: false, status: 'invalid_request', detail: 'subject' };
  if (text.length < 1 || text.length > LIMITS_.EMAIL_TEXT_MAX) return { ok: false, status: 'invalid_request', detail: 'text' };

  var allowed = listProp_('EMAIL_ALLOWED_RECIPIENTS').map(function (s) {
    return s.toLowerCase();
  });
  if (allowed.length === 0) return { ok: false, status: 'not_configured', detail: 'recipients' };

  var to;
  if (p.to === undefined || p.to === null) {
    to = allowed.slice(0, LIMITS_.EMAIL_MAX_RECIPIENTS);
  } else {
    if (!Array.isArray(p.to) || p.to.length < 1 || p.to.length > LIMITS_.EMAIL_MAX_RECIPIENTS) return { ok: false, status: 'invalid_request', detail: 'to_count' };
    to = [];
    for (var i = 0; i < p.to.length; i++) {
      var addr = typeof p.to[i] === 'string' ? p.to[i].trim().toLowerCase() : '';
      if (!EMAIL_RE_.test(addr)) return { ok: false, status: 'invalid_request', detail: 'to_format' };
      if (allowed.indexOf(addr) < 0) return { ok: false, status: 'invalid_request', detail: 'recipient_not_allowed' };
      if (to.indexOf(addr) < 0) to.push(addr);
    }
  }

  // cota diária do Gmail (consumidor: 100 destinatários/dia; Workspace: 1.500 — ver doc oficial de cotas) com reserva de segurança
  var reserve = propInt_('EMAIL_QUOTA_RESERVE', 5, 0, 50);
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining < to.length + reserve) return { ok: false, status: 'rate_limited', detail: 'gmail_quota' };

  var prefix = prop_('EMAIL_SUBJECT_PREFIX') || '[CÓRTEX] ';
  return {
    ok: true,
    recipients: to.length,
    send: function () {
      try {
        MailApp.sendEmail({ to: to.join(','), subject: cleanLine_(prefix + subject).slice(0, 200), body: text, name: prop_('EMAIL_FROM_NAME') || 'CÓRTEX', noReply: true });
        return { status: 'sent' };
      } catch (e) {
        var msg = String(e && e.message);
        // "Service invoked too many times" é limite de taxa do Google: nada saiu e vale tentar mais tarde
        if (/too many times|quota/i.test(msg)) return { status: 'rate_limited', detail: 'apps_script_quota', ambiguous: false };
        return { status: 'failed', detail: 'mail_exception', retryable: false, ambiguous: false };
      }
    },
  };
}
