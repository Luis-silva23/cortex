/**
 * Limites próprios por canal (hora e dia, no fuso do projeto), guardados em Script Properties com trava (LockService). Contam TENTATIVAS de envio reais:
 * uma validação que falha antes de enviar não consome. Se o envio falha com certeza de que NADA saiu, a reserva é devolvida (`refund_`).
 */
function stamp_(fmt) {
  return Utilities.formatDate(new Date(nowMs_()), 'America/Sao_Paulo', fmt);
}

function counterKeys_(channel) {
  return { hour: 'rl:' + channel + ':h:' + stamp_('yyyyMMddHH'), day: 'rl:' + channel + ':d:' + stamp_('yyyyMMdd') };
}

/** Remove contadores de dias antigos (as chaves moram em Script Properties, que tem espaço limitado). */
function pruneCounters_(props, keepDay) {
  var keys = props.getKeys();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k.indexOf('rl:') !== 0) continue;
    var m = /:(h|d):(\d{8})/.exec(k);
    if (m && m[2] < keepDay) props.deleteProperty(k);
  }
}

/** Reserva UMA tentativa. Devolve { ok:true } ou { ok:false, detail:'hour'|'day' }. */
function reserve_(channel) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var k = counterKeys_(channel);
    var hour = Number(props.getProperty(k.hour) || 0);
    var day = Number(props.getProperty(k.day) || 0);
    if (hour >= channelLimit_(channel, 'hour')) return { ok: false, detail: 'hour' };
    if (day >= channelLimit_(channel, 'day')) return { ok: false, detail: 'day' };
    props.setProperty(k.hour, String(hour + 1));
    props.setProperty(k.day, String(day + 1));
    pruneCounters_(props, stamp_('yyyyMMdd'));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Devolve a reserva quando se TEM CERTEZA de que nada foi enviado. */
function refund_(channel) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var k = counterKeys_(channel);
    [k.hour, k.day].forEach(function (key) {
      var n = Number(props.getProperty(key) || 0);
      props.setProperty(key, String(Math.max(0, n - 1)));
    });
  } finally {
    lock.releaseLock();
  }
}
