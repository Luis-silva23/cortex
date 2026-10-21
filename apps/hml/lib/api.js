// Cliente HTTP mínimo da homologação: keep-alive, medição de latência, Idempotency-Key automática nas escritas,
// login com MFA (TOTP RFC 6238 por crypto nativo). Sem dependências.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = new URL(process.env.HML_API_URL || 'http://127.0.0.1:3101');
if (!/^(127\.0\.0\.1|localhost)$/.test(BASE.hostname) || BASE.port !== '3101') {
  throw new Error('A homologação só fala com a API HML local (porta 3101).');
}
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
const localAgents = new Map(); // origem 127.0.0.N: a API enxerga IPs distintos (o limitador de login é por IP)
const agentFor = (la) => { if (!la) return agent; if (!localAgents.has(la)) localAgents.set(la, new http.Agent({ keepAlive: true, maxSockets: 64, localAddress: la })); return localAgents.get(la); };
const CRED_FILE = path.join(__dirname, '..', '.hml', 'credentials.json');

function request(method, urlPath, { token, body, headers = {}, idem = true, timeout = 30000, raw = false, localAddress } = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const payload = body === undefined ? undefined : (raw ? body : JSON.stringify(body));
    const h = { Accept: 'application/json', ...headers };
    if (payload !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    if (token) h.Authorization = `Bearer ${token}`;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (write && idem && !h['Idempotency-Key']) h['Idempotency-Key'] = crypto.randomUUID();
    const req = http.request({ host: BASE.hostname, port: BASE.port, path: urlPath, method, headers: h, agent: agentFor(localAddress), timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, body: json, text, ms: Number(process.hrtime.bigint() - t0) / 1e6, headers: res.headers });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o = {}) => request('POST', p, { ...o, body }),
  put: (p, body, o = {}) => request('PUT', p, { ...o, body }),
  patch: (p, body, o = {}) => request('PATCH', p, { ...o, body }),
  del: (p, o) => request('DELETE', p, o),
  request,
};

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1e6).padStart(6, '0');
}

/** Login por e-mail ou ID numérico; completa o MFA quando exigido. Devolve { ok, status, token, refreshToken, user, res }. */
async function login({ email, numericId, password, mfaSecret, headers, localAddress }) {
  const body = numericId ? { numericId, password } : { email, password };
  const r = await request('POST', '/api/auth/login', { body, idem: false, headers, localAddress });
  if (r.status !== 200) return { ok: false, status: r.status, res: r };
  let d = r.body;
  if (d.mfaRequired) {
    if (!mfaSecret) return { ok: false, status: 200, mfaRequired: true, res: r };
    const r2 = await request('POST', '/api/auth/verify-mfa', { body: { mfaToken: d.mfaToken, code: totp(mfaSecret) }, idem: false, headers, localAddress });
    if (r2.status !== 200) return { ok: false, status: r2.status, res: r2 };
    d = r2.body;
  }
  const tok = d.accessToken || d.tokens?.accessToken || d.data?.accessToken;
  const ref = d.refreshToken || d.tokens?.refreshToken || d.data?.refreshToken;
  return { ok: !!tok, status: 200, token: tok, refreshToken: ref, user: d.user || d.data?.user, res: r };
}

function readCredentials() {
  return fs.existsSync(CRED_FILE) ? JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) : {};
}
function writeCredentials(c) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2));
}

module.exports = { api, request, login, totp, readCredentials, writeCredentials, BASE };
