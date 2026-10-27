/**
 * Registro SEM dados sensíveis: só campos de uma lista fixa (identificador abreviado, canal, estado, código curto, duração, contagens). Nunca grava destinatário, texto,
 * assinatura, segredo, token nem a URL do provedor.
 */
var LOG_FIELDS_ = ['id', 'channel', 'status', 'detail', 'ms', 'recipients', 'retryable', 'provider'];

function log_(event, fields) {
  var out = { event: String(event) };
  var f = fields || {};
  for (var i = 0; i < LOG_FIELDS_.length; i++) {
    var k = LOG_FIELDS_[i];
    if (f[k] === undefined || f[k] === null) continue;
    var v = f[k];
    if (k === 'id') v = String(v).slice(0, 8); // só o começo do identificador
    else if (typeof v === 'string') v = v.slice(0, 60).replace(/[^A-Za-z0-9_:.\- ]/g, '?');
    out[k] = v;
  }
  Logger.log(JSON.stringify(out));
}
