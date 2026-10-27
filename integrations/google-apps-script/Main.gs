/**
 * CÓRTEX · Relé de notificações — PONTO DE ENTRADA (aplicativo da web).
 * Publicar como: Executar como "Eu" · Acesso "Qualquer pessoa" (o CÓRTEX não é um usuário Google; a URL NÃO é segredo — a assinatura HMAC é a autenticação).
 * Resposta SEMPRE JSON com HTTP 200 (o Apps Script não permite escolher o código HTTP): { ok, status, id, channel, detail?, retryable?, ambiguous? }
 *   status: sent | duplicate | rate_limited | not_configured | failed | unauthorized | invalid_request | dry_run
 * `dry_run` = modo de teste (propriedade DRY_RUN=true): tudo foi validado, NADA foi enviado. Quem chama NÃO deve tratar dry_run como entregue.
 */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Verificação de vida sem dados de configuração. */
function doGet() {
  return json_({ ok: true, service: 'cortex-notify-relay', version: VERSION_ });
}

function doPost(e) {
  var started = nowMs_();
  var out;
  try {
    out = handle_(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    // nunca devolve a mensagem do erro (pode conter dados): só um código
    out = { ok: false, status: 'failed', detail: 'internal_error', retryable: false, ambiguous: true };
  }
  log_('request', { id: out.id, channel: out.channel, status: out.status, detail: out.detail, ms: nowMs_() - started });
  return json_(out);
}

var PREPARE_ = { email: prepareEmail_, sms: prepareSms_, whatsapp: prepareWhatsapp_ };

/** Núcleo testável: recebe o corpo bruto, devolve o objeto de resposta. */
function handle_(raw) {
  var v = verifyEnvelope_(raw);
  if (!v.ok) return { ok: false, status: v.status, detail: v.detail };
  var req = v.req;
  var base = { id: req.id, channel: req.channel };

  var payload;
  try {
    payload = JSON.parse(req.payload);
  } catch (e) {
    return merge_(base, { ok: false, status: 'invalid_request', detail: 'payload_json' });
  }

  // 1) validação e prontidão do canal (nada é reservado nem enviado ainda)
  var prep = PREPARE_[req.channel](payload);
  if (!prep.ok) return merge_(base, { ok: false, status: prep.status, detail: prep.detail });

  // 2) anti-repetição: o identificador é reservado ANTES de enviar
  if (!claimId_(req.id)) return merge_(base, { ok: true, status: 'duplicate' });

  // modo de teste: valida tudo e NÃO envia
  if (propBool_('DRY_RUN')) {
    releaseId_(req.id);
    return merge_(base, { ok: true, status: 'dry_run', recipients: prep.recipients });
  }

  // 3) limites próprios do canal (hora/dia)
  var r = reserve_(req.channel);
  if (!r.ok) {
    releaseId_(req.id);
    return merge_(base, { ok: false, status: 'rate_limited', detail: r.detail });
  }

  // 4) envio
  var result = prep.send();
  if (result.status === 'sent') return merge_(base, { ok: true, status: 'sent', recipients: prep.recipients });

  // não enviou: se TEM CERTEZA (não ambíguo), devolve a reserva e libera o identificador para nova tentativa
  if (!result.ambiguous) {
    refund_(req.channel);
    releaseId_(req.id);
  }
  return merge_(base, {
    ok: false,
    status: result.status === 'rate_limited' ? 'rate_limited' : 'failed',
    detail: result.detail,
    retryable: result.retryable === true,
    ambiguous: result.ambiguous === true,
  });
}

function merge_(a, b) {
  var o = {};
  for (var k in a) o[k] = a[k];
  for (var j in b) o[j] = b[j];
  return o;
}

/* ---------------------------------------------------------------------------------------------------------------------------------------
 * Funções para rodar MANUALMENTE no editor (menu "Executar"). Nenhuma envia mensagem.
 * ------------------------------------------------------------------------------------------------------------------------------------- */

/** Mostra QUAIS propriedades estão definidas (sim/não) — nunca os valores. */
function showConfigStatus() {
  var names = [
    'RELAY_SECRET', 'DRY_RUN', 'EMAIL_ALLOWED_RECIPIENTS', 'EMAIL_FROM_NAME',
    'SMS_PROVIDER', 'SMS_ALLOWED_RECIPIENTS', 'SMS_SENDER_VERIFIED', 'SMS_TWILIO_ACCOUNT_SID', 'SMS_TWILIO_AUTH_TOKEN', 'SMS_FROM',
    'WA_PROVIDER', 'WA_ALLOWED_RECIPIENTS', 'WA_TEMPLATE_APPROVED', 'WA_META_TOKEN', 'WA_META_PHONE_NUMBER_ID', 'WA_TEMPLATE_NAME',
  ];
  var status = {};
  names.forEach(function (n) {
    status[n] = prop_(n) !== '';
  });
  status.RELAY_SECRET_length_ok = prop_('RELAY_SECRET').length >= 32;
  status.gmail_remaining_quota = MailApp.getRemainingDailyQuota();
  Logger.log(JSON.stringify(status));
  return status;
}

/** Autoteste ASSINADO em modo simulado: monta uma requisição de e-mail com o próprio RELAY_SECRET e passa por todo o caminho SEM enviar (força dry_run só nesta execução). */
function selfTestDryRun() {
  var secret = prop_('RELAY_SECRET');
  if (secret.length < 32) throw new Error('Defina RELAY_SECRET (32+ caracteres) em Propriedades do script.');
  var payload = JSON.stringify({ subject: 'autoteste', text: 'autoteste do relé (nada é enviado)' });
  var ts = Math.floor(nowMs_() / 1000);
  var id = 'selftest-' + Utilities.getUuid().replace(/-/g, '');
  var sig = hmacHex_(secret, '1\n' + ts + '\n' + id + '\nemail\n' + payload);
  var props = PropertiesService.getScriptProperties();
  var previous = props.getProperty('DRY_RUN');
  props.setProperty('DRY_RUN', 'true');
  try {
    var out = handle_(JSON.stringify({ v: 1, ts: ts, id: id, channel: 'email', payload: payload, sig: sig }));
    Logger.log(JSON.stringify(out));
    return out;
  } finally {
    if (previous === null) props.deleteProperty('DRY_RUN');
    else props.setProperty('DRY_RUN', previous);
  }
}
