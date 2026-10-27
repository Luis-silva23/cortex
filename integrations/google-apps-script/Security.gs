/**
 * Autenticação e anti-repetição.
 * O `doPost` do Apps Script NÃO entrega os cabeçalhos HTTP da requisição ao código (só `postData` e `parameter`); por isso TUDO que precisa ser assinado vai no CORPO:
 *   { "v": 1, "ts": <segundos Unix>, "id": "<identificador único>", "channel": "email|sms|whatsapp", "payload": "<JSON em TEXTO>", "sig": "<hex>" }
 *   sig = HMAC-SHA256(RELAY_SECRET, v + "\n" + ts + "\n" + id + "\n" + channel + "\n" + payload)
 * `payload` é um TEXTO (a string exata que foi assinada): não há canonicalização de JSON para divergir entre quem assina e quem confere.
 */

function toHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256; // o Apps Script devolve bytes COM sinal
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function hmacHex_(secret, message) {
  return toHex_(Utilities.computeHmacSha256Signature(message, secret));
}

/** Comparação em tempo constante (não vaza em qual posição a assinatura difere). */
function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function nowMs_() {
  return Date.now();
}

/**
 * Valida a ESTRUTURA do envelope e a assinatura. Devolve { ok:true, req } ou { ok:false, status, detail }.
 * Estrutura inválida → invalid_request; assinatura errada / fora da janela de tempo → unauthorized (sem dizer qual dos dois: não é um oráculo para quem tenta adivinhar).
 */
function verifyEnvelope_(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LIMITS_.MAX_BODY_CHARS) return { ok: false, status: 'invalid_request', detail: 'body_size' };
  var req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    return { ok: false, status: 'invalid_request', detail: 'json' };
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, status: 'invalid_request', detail: 'shape' };
  if (req.v !== 1) return { ok: false, status: 'invalid_request', detail: 'version' };
  if (typeof req.ts !== 'number' || !isFinite(req.ts) || Math.floor(req.ts) !== req.ts) return { ok: false, status: 'invalid_request', detail: 'ts' };
  if (typeof req.id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(req.id)) return { ok: false, status: 'invalid_request', detail: 'id' };
  if (CHANNELS_.indexOf(req.channel) < 0) return { ok: false, status: 'invalid_request', detail: 'channel' };
  if (typeof req.payload !== 'string' || req.payload.length === 0 || req.payload.length > LIMITS_.MAX_PAYLOAD_CHARS) return { ok: false, status: 'invalid_request', detail: 'payload_size' };
  if (typeof req.sig !== 'string' || !/^[0-9a-f]{64}$/.test(req.sig)) return { ok: false, status: 'invalid_request', detail: 'sig_format' };

  var secret = prop_('RELAY_SECRET');
  if (secret.length < 32) return { ok: false, status: 'not_configured', detail: 'secret' };

  var skew = Math.abs(nowMs_() / 1000 - req.ts);
  var expected = hmacHex_(secret, req.v + '\n' + req.ts + '\n' + req.id + '\n' + req.channel + '\n' + req.payload);
  // confere SEMPRE a assinatura (tempo parecido nos dois caminhos) e só então olha a janela
  var sigOk = safeEqual_(expected, req.sig);
  if (!sigOk || skew > LIMITS_.MAX_SKEW_SECONDS) return { ok: false, status: 'unauthorized', detail: 'auth' };
  return { ok: true, req: req };
}

/**
 * Reserva o identificador (anti-repetição). Devolve true se ESTA chamada é a primeira; false se já foi vista (duplicada).
 * CacheService é "melhor esforço" (pode descartar antes das 6 h): a deduplicação do CÓRTEX continua sendo a primeira barreira.
 */
function claimId_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('id:' + id)) return false;
    cache.put('id:' + id, '1', LIMITS_.ID_CACHE_SECONDS);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function releaseId_(id) {
  CacheService.getScriptCache().remove('id:' + id);
}
