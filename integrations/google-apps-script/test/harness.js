'use strict';
/**
 * Carrega os arquivos .gs REAIS (os mesmos que vão para o Google) num contexto `vm` com simulações dos serviços do Apps Script
 * (PropertiesService, CacheService, LockService, MailApp, UrlFetchApp, Utilities, ContentService, Logger). Nenhuma rede, nenhum e-mail real.
 * Também é usado pelos testes da API (compatibilidade de assinatura entre o TypeScript e o script).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const FILES = ['Config.gs', 'Log.gs', 'Security.gs', 'Quota.gs', 'Email.gs', 'Sms.gs', 'Whatsapp.gs', 'Main.gs'];
const SECRET = 'test-secret-'.padEnd(40, 'x'); // valor de TESTE, nunca um segredo real

function createScript(opts = {}) {
  const store = new Map(Object.entries(opts.props || {}));
  const cache = new Map();
  const logs = [];
  const mail = { sent: [], remaining: opts.mailRemaining ?? 100, throwOnSend: null };
  const fetches = { calls: [], handler: opts.fetchHandler || (() => ({ code: 200, body: '{}' })) };
  let clock = opts.now ?? Date.UTC(2026, 9, 23, 15, 0, 0);

  const ctx = {
    Logger: { log: (s) => logs.push(String(s)) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (store.has(k) ? store.get(k) : null),
        setProperty: (k, v) => void store.set(k, String(v)),
        deleteProperty: (k) => void store.delete(k),
        getKeys: () => [...store.keys()],
      }),
    },
    CacheService: {
      getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => void cache.set(k, v), remove: (k) => void cache.delete(k) }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: {
      getRemainingDailyQuota: () => mail.remaining,
      sendEmail: (o) => {
        if (mail.throwOnSend) throw new Error(mail.throwOnSend);
        mail.sent.push(o);
      },
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetches.calls.push({ url, options });
        const r = fetches.handler(url, options);
        if (r instanceof Error) throw r;
        return { getResponseCode: () => r.code, getContentText: () => r.body ?? '' };
      },
    },
    Utilities: {
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, _tz, fmt) => {
        const l = new Date(d.getTime() - 3 * 3_600_000); // America/Sao_Paulo (sem horário de verão desde 2019)
        const p = (n, w = 2) => String(n).padStart(w, '0');
        const base = `${l.getUTCFullYear()}${p(l.getUTCMonth() + 1)}${p(l.getUTCDate())}`;
        return fmt === 'yyyyMMddHH' ? base + p(l.getUTCHours()) : base;
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ getContent: () => s, setMimeType() { return this; } }),
    },
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    isFinite,
  };
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  // relógio controlável (a função do script é global e substituível)
  ctx.nowMs_ = () => clock;

  const api = {
    ctx,
    store,
    cache,
    logs,
    mail,
    fetches,
    secret: SECRET,
    setNow: (ms) => (clock = ms),
    advance: (ms) => (clock += ms),
    now: () => clock,
    /** Assina exatamente como o contrato descreve (implementação independente do script). */
    sign(fields) {
      const e = { v: 1, ts: Math.floor(clock / 1000), id: crypto.randomBytes(12).toString('hex'), channel: 'email', ...fields };
      const payload = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload);
      const sig = crypto.createHmac('sha256', fields.secret ?? SECRET).update(`${e.v}\n${e.ts}\n${e.id}\n${e.channel}\n${payload}`).digest('hex');
      const env = { v: e.v, ts: e.ts, id: e.id, channel: e.channel, payload, sig: fields.sig ?? sig };
      return JSON.stringify(env);
    },
    /** Entrega o corpo ao `doPost` e devolve o JSON de resposta. */
    post(raw) {
      const out = ctx.doPost({ postData: { contents: raw, type: 'application/json' } });
      return JSON.parse(out.getContent());
    },
    run: (code) => vm.runInContext(code, ctx),
  };
  return api;
}

module.exports = { createScript, SECRET, FILES };
