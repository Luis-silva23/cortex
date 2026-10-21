#!/usr/bin/env node
// Infraestrutura ISOLADA da homologação (HML): Postgres próprio (porta 5433) e Redis próprio (porta 6390), com
// diretórios de dados fora do repositório. Nada aqui toca no Postgres/Redis de desenvolvimento (5432/6379).
// Segredos (senha do banco, JWT, DATA_ENCRYPTION_KEY) são gerados na hora em apps/hml/.hml/ (gitignorado).
//
// Uso: node apps/hml/infra.js <init|start|stop|status|migrate|api-env|kill-redis|start-redis|kill-pg|start-pg>
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process'); // só os daemons desacoplados (postgres/redis/api): já usam detached + windowsHide
const { spawnSyncHidden: spawnSync } = require('./lib/proc');

const TOOLS = process.env.LN_TOOLS_DIR || path.join(process.env.LOCALAPPDATA || '', 'ln-system-tools');
const PG_BIN = path.join(TOOLS, 'pg-extract', 'pgsql', 'bin');
const REDIS_EXE = path.join(TOOLS, 'redis', 'Redis-8.10.1-Windows-x64-msys2', 'redis-server.exe');
const HOME = path.join(TOOLS, 'hml');
const PGDATA = path.join(HOME, 'pgdata');
const REDIS_DATA = path.join(HOME, 'redis-data');
const SECRETS_DIR = path.join(__dirname, '.hml');
const SECRETS = path.join(SECRETS_DIR, 'env.json');
const REPO = path.resolve(__dirname, '../..');

const PG_PORT = 5433;
const REDIS_PORT = 6390;
const DB_NAME = 'lnsystem_hml';
const DB_USER = 'lnsystem';

const exe = (n) => path.join(PG_BIN, `${n}.exe`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function secrets() {
  if (!fs.existsSync(SECRETS)) throw new Error('Ambiente HML não inicializado. Rode: node apps/hml/infra.js init');
  return JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
}

function dbUrl(s) {
  return `postgresql://${DB_USER}:${encodeURIComponent(s.dbPassword)}@127.0.0.1:${PG_PORT}/${DB_NAME}?schema=public`;
}

function adminUrl(s) {
  return `postgresql://postgres:${encodeURIComponent(s.pgSuperPassword)}@127.0.0.1:${PG_PORT}/postgres`;
}

function psql(url, sql) {
  const r = spawnSync(exe('psql'), [url, '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql falhou: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// Log do Postgres HML por padrão (gitignorado, em apps/hml/.hml/): a queda de 14:08 e 16:40 de 2026-10-04 não deixou rastro
// porque o servidor subia com stdio ignorado. Agora qualquer desligamento, queda ou erro do servidor fica registrado.
const PG_LOG = path.join(SECRETS_DIR, 'pg-hml.log');
const PG_ARGS = [
  '-D', PGDATA, '-p', String(PG_PORT), '-c', 'max_connections=200',
  '-c', 'log_line_prefix=%m [%p] %q%u@%d ', '-c', 'log_checkpoints=on', '-c', 'log_min_messages=info',
];

function startPg() {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  const log = fs.openSync(PG_LOG, 'a');
  fs.writeSync(log, `\n===== partida do Postgres HML ${new Date().toISOString()} =====\n`);
  const child = spawn(exe('postgres'), PG_ARGS, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
}

// A porta abre antes de o Postgres aceitar consultas (recuperação/partida): quem usa o banco logo depois via erro enganoso.
function pgAccepting() {
  const r = spawnSync(exe('pg_isready'), ['-h', '127.0.0.1', '-p', String(PG_PORT)], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0;
}

async function waitPgReady(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pgAccepting()) return true;
    await sleep(500);
  }
  return false;
}

function startRedis(s) {
  const child = spawn(REDIS_EXE, ['--port', String(REDIS_PORT), '--requirepass', s.redisPassword, '--dir', REDIS_DATA, '--save', '', '--appendonly', 'no'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

async function waitPort(port, up, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await portOpen(port)) === up) return true;
    await sleep(300);
  }
  return false;
}

function pidOnPort(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const line = r.stdout.split(/\r?\n/).find((l) => /:(\d+)\s/.test(l) && l.includes(`:${port} `) && l.includes('LISTENING'));
  return line ? Number(line.trim().split(/\s+/).pop()) : null;
}

function killPort(port) {
  // Só o processo que escuta na porta HML (5433/6390); as portas de desenvolvimento nunca são tocadas.
  if (![PG_PORT, REDIS_PORT].includes(port)) throw new Error(`porta ${port} não pertence à homologação`);
  const pid = pidOnPort(port);
  if (!pid) return false;
  spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' });
  return true;
}

const cmds = {
  async init() {
    if (fs.existsSync(SECRETS)) throw new Error('HML já inicializado (apps/hml/.hml/env.json existe). Para recomeçar, remova o diretório HML manualmente.');
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.mkdirSync(REDIS_DATA, { recursive: true });
    const rnd = (n) => crypto.randomBytes(n).toString('base64url');
    const s = {
      pgSuperPassword: rnd(18), dbPassword: rnd(18), redisPassword: rnd(18),
      jwtSecret: crypto.randomBytes(48).toString('base64'), jwtRefreshSecret: crypto.randomBytes(48).toString('base64'),
      dataEncryptionKey: crypto.randomBytes(32).toString('base64'),
    };
    fs.writeFileSync(SECRETS, JSON.stringify(s, null, 2));
    const pwfile = path.join(SECRETS_DIR, 'pg.pw');
    fs.writeFileSync(pwfile, s.pgSuperPassword);
    const r = spawnSync(exe('initdb'), ['-D', PGDATA, '-U', 'postgres', '--pwfile', pwfile, '--auth', 'scram-sha-256', '-E', 'UTF8'], { encoding: 'utf8' });
    fs.rmSync(pwfile, { force: true });
    if (r.status !== 0) throw new Error(`initdb falhou: ${r.stderr}`);
    startPg();
    if (!(await waitPort(PG_PORT, true))) throw new Error('Postgres HML não subiu');
    if (!(await waitPgReady())) throw new Error('Postgres HML abriu a porta mas não aceita consultas (ver apps/hml/.hml/pg-hml.log)');
    psql(adminUrl(s), `CREATE ROLE ${DB_USER} LOGIN PASSWORD '${s.dbPassword}'`);
    psql(adminUrl(s), `CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}`);
    console.log(`[hml] Postgres ${PG_PORT} e banco ${DB_NAME} criados (dono ${DB_USER}, sem BYPASSRLS).`);
    startRedis(s);
    console.log((await waitPort(REDIS_PORT, true)) ? `[hml] Redis ${REDIS_PORT} no ar.` : '[hml] Redis HML não subiu');
    cmds.migrate();
    cmds['api-env']();
  },
  migrate() {
    const s = secrets();
    const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.join(REPO, 'packages/database'), env: { ...process.env, DATABASE_URL: dbUrl(s) }, stdio: 'inherit', shell: true,
    });
    if (r.status !== 0) throw new Error('prisma migrate deploy falhou no banco HML');
  },
  async start() {
    const s = secrets();
    if (!(await portOpen(PG_PORT))) { startPg(); await waitPort(PG_PORT, true); }
    // Porta aberta não é banco pronto: só segue quando o Postgres aceita consultas.
    if (!(await waitPgReady())) throw new Error('Postgres HML abriu a porta mas não aceita consultas em 30 s (ver apps/hml/.hml/pg-hml.log)');
    if (!(await portOpen(REDIS_PORT))) { startRedis(s); await waitPort(REDIS_PORT, true); }
    return cmds.status();
  },
  async stop() {
    killPort(REDIS_PORT);
    const r = spawnSync(exe('pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast'], { encoding: 'utf8' });
    if (r.status !== 0) killPort(PG_PORT);
    return cmds.status();
  },
  async status() {
    const out = { postgres5433: await portOpen(PG_PORT), redis6390: await portOpen(REDIS_PORT) };
    console.log(JSON.stringify(out));
    return out;
  },
  // Variáveis que a API recebe: vão no ambiente do processo, num arquivo gitignorado — nunca versionado.
  'api-env'() {
    const s = secrets();
    const env = {
      NODE_ENV: 'development', API_PORT: '3101', API_HOST: 'localhost',
      // Só a API HML: neste computador (Postgres no Windows, com varredura de segurança) abrir ~30 conexões de uma vez, como o
      // painel faz com o pool frio, passa dos 5 s padrão do Prisma e vira 503 `P1001` com o banco de pé (visto às 14:08 e 18:00
      // de 2026-10-04). O produto não é alterado; ver docs/CORTEX/DIAGNOSTICO_FASE6.md.
      DATABASE_URL: `${dbUrl(s)}&connect_timeout=30&pool_timeout=30`,
      REDIS_HOST: '127.0.0.1', REDIS_PORT: String(REDIS_PORT), REDIS_PASSWORD: s.redisPassword, REDIS_DB: '0',
      REDIS_URL: `redis://:${encodeURIComponent(s.redisPassword)}@127.0.0.1:${REDIS_PORT}/0`,
      JWT_SECRET: s.jwtSecret, JWT_REFRESH_SECRET: s.jwtRefreshSecret, JWT_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d',
      DATA_ENCRYPTION_KEY: s.dataEncryptionKey, ENCRYPTION_KEY: s.dataEncryptionKey,
      WEB_URL: 'http://localhost:3102',
    };
    fs.writeFileSync(path.join(SECRETS_DIR, 'api.env.json'), JSON.stringify(env, null, 2));
    console.log('[hml] apps/hml/.hml/api.env.json atualizado (gitignorado).');
  },
  // API compilada (apps/api/dist) com o ambiente HML, porta 3101. Workers BullMQ rodam no mesmo processo.
  async 'api-start'() {
    if (await portOpen(3101)) { console.log('API HML já no ar'); return; }
    cmds['api-env']();
    const env = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'api.env.json'), 'utf8'));
    const out = fs.openSync(path.join(SECRETS_DIR, 'api.log'), 'a');
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: path.join(REPO, 'apps/api'), env: { ...process.env, ...env, ...(process.env.HML_API_EXTRA ? JSON.parse(process.env.HML_API_EXTRA) : {}) },
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    child.unref();
    console.log('API HML no ar:', await waitPort(3101, true, 60000), 'pid', child.pid);
  },
  async 'api-stop'() {
    const pid = pidOnPort(3101);
    if (pid) spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' });
    console.log('API HML parada:', await waitPort(3101, false, 10000));
  },
  async 'kill-redis'() { console.log('redis morto:', killPort(REDIS_PORT)); await waitPort(REDIS_PORT, false, 5000); },
  async 'start-redis'() { startRedis(secrets()); console.log('redis no ar:', await waitPort(REDIS_PORT, true)); },
  async 'kill-pg'() { console.log('postgres morto:', killPort(PG_PORT)); await waitPort(PG_PORT, false, 10000); },
  async 'start-pg'() { startPg(); console.log('postgres no ar:', (await waitPort(PG_PORT, true)) && (await waitPgReady())); },
};

if (require.main === module) {
  const c = process.argv[2];
  if (!cmds[c]) { console.error('uso: node apps/hml/infra.js <' + Object.keys(cmds).join('|') + '>'); process.exit(2); }
  Promise.resolve(cmds[c]()).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { secrets, dbUrl, adminUrl, killPort, portOpen, waitPort, waitPgReady, startPg, startRedis, PG_PORT, REDIS_PORT, DB_NAME };
