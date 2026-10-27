/**
 * CÓRTEX · Relé de notificações (Google Apps Script) — CONFIGURAÇÃO.
 * Tudo que é segredo ou política mora em SCRIPT PROPERTIES (Configurações do projeto › Propriedades do script), NUNCA neste código.
 * Este arquivo só lê propriedades e define limites fixos de segurança.
 */
var VERSION_ = '1.0.0';

var LIMITS_ = {
  MAX_BODY_CHARS: 16000, // corpo bruto da requisição
  MAX_PAYLOAD_CHARS: 8000, // campo `payload` (JSON em texto)
  MAX_SKEW_SECONDS: 300, // janela do timestamp (anti-repetição)
  ID_CACHE_SECONDS: 21600, // máximo do CacheService (6 h)
  EMAIL_MAX_RECIPIENTS: 5,
  EMAIL_SUBJECT_MAX: 150,
  EMAIL_TEXT_MAX: 4000,
  SMS_TEXT_MAX: 300,
  WA_PARAM_MAX: 900,
};

var CHANNELS_ = ['email', 'sms', 'whatsapp'];

/** Padrões de limite por canal (podem ser REDUZIDOS por propriedade; nunca passam do teto de segurança do canal). */
var CHANNEL_DEFAULTS_ = {
  email: { perHour: 6, perDay: 30, ceilingDay: 90 },
  sms: { perHour: 3, perDay: 10, ceilingDay: 50 },
  whatsapp: { perHour: 3, perDay: 10, ceilingDay: 50 },
};

function prop_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === undefined ? '' : String(v).trim();
}

function propBool_(key) {
  return prop_(key).toLowerCase() === 'true';
}

function propInt_(key, fallback, min, max) {
  var raw = prop_(key);
  if (raw === '') return fallback;
  var n = Number(raw);
  if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) return fallback;
  return n;
}

function listProp_(key) {
  return prop_(key)
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
}

/** Limite efetivo do canal: propriedade (se válida) limitada pelo teto de segurança. */
function channelLimit_(channel, which) {
  var d = CHANNEL_DEFAULTS_[channel];
  var key = channel.toUpperCase() + (which === 'hour' ? '_MAX_PER_HOUR' : '_MAX_PER_DAY');
  var value = propInt_(key, which === 'hour' ? d.perHour : d.perDay, 0, d.ceilingDay);
  return Math.min(value, d.ceilingDay);
}
