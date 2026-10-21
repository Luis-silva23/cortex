// Ambiente dos testes de navegador. Só roda contra o banco de DESENVOLVIMENTO com a empresa demo (npm run demo:seed).
// Nada aqui grava credencial: os tokens são emitidos na hora por `demo:tools mint` e ficam só na memória do teste.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const API_DIR = path.resolve(__dirname, '../../api');
const URLS = {
  admin: process.env.E2E_ADMIN_URL || 'http://localhost:3002',
  sa: process.env.E2E_SUPER_ADMIN_URL || 'http://localhost:3000',
  pdv: process.env.E2E_PDV_URL || 'http://localhost:5173',
  balcao: process.env.E2E_BALCAO_URL || 'http://localhost:5174',
  api: process.env.E2E_API_URL || 'http://localhost:3001',
};

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Chrome não encontrado. Defina CHROME_PATH com o caminho do executável.');
  return found;
}

function databaseUrl() {
  if (process.env.NODE_ENV === 'production') throw new Error('e2e recusado em produção');
  const env = fs.readFileSync(path.join(API_DIR, '.env'), 'utf8');
  const url = env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^"|"$/g, '').trim();
  if (/test/i.test(new URL(url).pathname)) throw new Error('e2e roda no banco de DESENVOLVIMENTO (empresa demo), não no banco dos testes de integração');
  return url;
}

function demoCredentials() {
  const file = path.join(API_DIR, '.demo', 'credentials.json');
  if (!fs.existsSync(file)) throw new Error('Empresa demo ausente. Rode `npm run demo:seed` em apps/api.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mint(who) {
  const out = execSync(`npm run -s demo:tools -- mint ${who}`, { cwd: API_DIR, encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('{')));
}

const adminToken = (who) => mint(who).admin_web.match(/"(ey[^"]+)"/)[1];

function superAdminSession() {
  const m = mint('sa.e2e');
  return { token: m.accessToken, user: JSON.parse(JSON.parse(m.super_admin.match(/localStorage\.setItem\('user', (".*")\)$/)[1])) };
}

// O texto já é o JSON do estado persistido pelo PDV; entra como está (não codificar de novo).
function pdvStorage(who) {
  return JSON.parse(mint(who).pdv.match(/localStorage\.setItem\('pdv-auth-storage', (".*")\)$/)[1]);
}

// Login REAL pela tela (poucas tentativas: o login tem rate limit); a senha vem do arquivo ignorado pelo git e nunca é impressa.
function demoLogin(who) {
  const c = demoCredentials();
  const user = c.users[who];
  if (!user) throw new Error(`usuário de demonstração ausente: ${who}`);
  return { email: user.email, password: c.password, branchId: user.branch ? c.companies[user.company].branches[Number(user.branch) - 1] : null };
}

function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
  });
}

async function requireServers(names) {
  const down = [];
  for (const n of names) if (!(await reachable(n === 'api' ? `${URLS.api}/health` : URLS[n]))) down.push(`${n} (${URLS[n]})`);
  if (down.length) throw new Error(`Servidores fora do ar: ${down.join(', ')}. Suba o ambiente de desenvolvimento antes (ver apps/e2e/README.md).`);
}

module.exports = { API_DIR, URLS, chromePath, databaseUrl, demoCredentials, demoLogin, mint, adminToken, superAdminSession, pdvStorage, requireServers };
