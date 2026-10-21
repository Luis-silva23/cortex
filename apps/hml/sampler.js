// Amostrador de recursos da homologação (processo separado: o psql/PowerShell bloqueiam o laço de eventos e
// distorceriam a medição de latência do gerador de carga). A cada intervalo grava uma linha JSON com: CPU da máquina,
// CPU/memória da API, do Postgres (árvore de processos) e do Redis, conexões do Postgres por estado e Redis INFO +
// tamanho das filas BullMQ. Só lê. Uso: node sampler.js <arquivo.jsonl> [intervaloMs]
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawnSyncHidden: spawnSync, guardLoad } = require('./lib/proc');
guardLoad('sampler.js');
const infra = require('./infra');
const db = require('./lib/db');

const out = process.argv[2];
const every = Math.max(5000, Number(process.argv[3] || 5000)); // nunca mais rápido que 5 s
if (!out) throw new Error('uso: node sampler.js <arquivo.jsonl> [intervaloMs]');
const QUEUES = ['email', 'report', 'notification', 'audit-log', 'request-metrics'];
const redisPassword = infra.secrets().redisPassword;

// Um único `netstat` por ciclo para todas as portas (antes eram três processos por ciclo).
const pidsOnPorts = (ports) => {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15000 });
  const lines = String(r.stdout || '').split(/\r?\n/);
  const res = {};
  for (const port of ports) {
    const line = lines.find((l) => l.includes(`:${port} `) && l.includes('LISTENING'));
    res[port] = line ? Number(line.trim().split(/\s+/).pop()) : null;
  }
  return res;
};

function machineCpu(prev) {
  const cur = os.cpus().reduce((a, c) => { for (const k of Object.keys(c.times)) a[k] = (a[k] || 0) + c.times[k]; return a; }, {});
  if (!prev) return { cur, pct: null };
  const idle = cur.idle - prev.idle;
  const total = Object.keys(cur).reduce((s, k) => s + cur[k] - prev[k], 0);
  return { cur, pct: total ? Math.round((1 - idle / total) * 1000) / 10 : null };
}

function procs(roots) {
  const ids = Object.values(roots).filter(Boolean);
  if (!ids.length) return {};
  const ps = `$i=@(${ids.join(',')}); Get-CimInstance Win32_Process | Where-Object { $i -contains $_.ProcessId -or $i -contains $_.ParentProcessId } | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse(r.stdout || '[]'); if (!Array.isArray(rows)) rows = [rows]; } catch { rows = []; }
  const res = {};
  for (const [name, root] of Object.entries(roots)) {
    if (!root) continue;
    const mine = rows.filter((p) => p.ProcessId === root || p.ParentProcessId === root);
    res[name] = { cpuSec: mine.reduce((s, p) => s + (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7, 0), memMb: Math.round(mine.reduce((s, p) => s + Number(p.WorkingSetSize), 0) / 1048576), n: mine.length };
  }
  return res;
}

function pgConns() {
  try {
    const rows = db.run(`SELECT coalesce(state,'(sem estado)'), count(*) FROM pg_stat_activity WHERE datname = 'lnsystem_hml' AND pid <> pg_backend_pid() GROUP BY 1`);
    const by = Object.fromEntries(rows.map(([s, n]) => [s, Number(n)]));
    return { total: Object.values(by).reduce((a, b) => a + b, 0), by };
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}

function parseResp(buf) {
  const items = [];
  let i = 0;
  const line = () => { const e = buf.indexOf('\r\n', i); const s = buf.slice(i, e).toString(); i = e + 2; return s; };
  while (i < buf.length) {
    const t = String.fromCharCode(buf[i++]);
    if (t === '+' || t === '-') items.push(line());
    else if (t === ':') items.push(Number(line()));
    else if (t === '$') { const n = Number(line()); if (n < 0) items.push(null); else { items.push(buf.slice(i, i + n).toString()); i += n + 2; } }
    else break;
  }
  return items;
}

function redisSample() {
  return new Promise((resolve) => {
    const cmds = [['AUTH', redisPassword], ['INFO'], ...QUEUES.flatMap((q) => [['LLEN', `bull:${q}:wait`], ['LLEN', `bull:${q}:active`], ['ZCARD', `bull:${q}:delayed`], ['ZCARD', `bull:${q}:failed`]])];
    const enc = (c) => `*${c.length}\r\n${c.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
    const chunks = [];
    const s = net.connect({ host: '127.0.0.1', port: infra.REDIS_PORT });
    const done = (v) => { s.destroy(); resolve(v); };
    const t = setTimeout(() => done({ error: 'timeout' }), 1500);
    s.on('error', (e) => { clearTimeout(t); done({ error: e.code || e.message }); });
    s.on('connect', () => s.write(cmds.map(enc).join('')));
    s.on('data', (d) => {
      chunks.push(d);
      const items = parseResp(Buffer.concat(chunks));
      if (items.length < cmds.length) return;
      clearTimeout(t);
      const info = Object.fromEntries(String(items[1]).split('\r\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(':')));
      const q = {};
      QUEUES.forEach((n, k) => { const b = 2 + k * 4; q[n] = { wait: items[b], active: items[b + 1], delayed: items[b + 2], failed: items[b + 3] }; });
      done({ usedMb: Math.round(Number(info.used_memory) / 1048576 * 10) / 10, clients: Number(info.connected_clients), opsPerSec: Number(info.instantaneous_ops_per_sec), evicted: Number(info.evicted_keys), queues: q });
    });
  });
}

(async () => {
  let prevCpu = os.cpus().reduce((a, c) => { for (const k of Object.keys(c.times)) a[k] = (a[k] || 0) + c.times[k]; return a; }, {});
  let prevProc = null;
  let prevAt = Date.now();
  const stream = fs.createWriteStream(out, { flags: 'a' });

  // Fim garantido: duração máxima, pai morto (kill(0) não mata, só testa), canal IPC fechado e arquivo .pid.
  const startedAt = Date.now();
  const maxMs = Math.min(Number(process.env.HML_SAMPLER_MAX_MS || 15 * 60 * 1000), 30 * 60 * 1000);
  const parent = process.ppid;
  const parentAlive = () => { try { process.kill(parent, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  process.on('disconnect', () => process.exit(0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => process.exit(0));
  const pidFile = `${out}.pid`;
  fs.writeFileSync(pidFile, String(process.pid));
  process.on('exit', () => { try { fs.rmSync(pidFile, { force: true }); } catch { /* ok */ } });

  while (Date.now() - startedAt < maxMs && parentAlive()) {
    const pp = pidsOnPorts([3101, infra.PG_PORT, infra.REDIS_PORT]);
    const roots = { api: pp[3101], pg: pp[infra.PG_PORT], redisProc: pp[infra.REDIS_PORT] };
    const at = Date.now();
    const m = machineCpu(prevCpu);
    prevCpu = m.cur;
    const p = procs(roots);
    const pc = {};
    for (const [k, v] of Object.entries(p)) {
      const pr = prevProc && prevProc[k];
      pc[k] = { cpuPct: pr ? Math.round(((v.cpuSec - pr.cpuSec) / ((at - prevAt) / 1000)) * 1000) / 10 : null, memMb: v.memMb, procs: v.n };
    }
    prevProc = p;
    prevAt = at;
    const row = { t: at, machineCpuPct: m.pct, ...pc, pgConns: pgConns(), redis: await redisSample() };
    stream.write(`${JSON.stringify(row)}\n`);
    const wait = every - (Date.now() - at);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  process.exit(0);
})();
