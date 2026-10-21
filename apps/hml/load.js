// Teste de carga da homologação (seção 6 do brief): 5 níveis progressivos, gerador em malha ABERTA (a taxa de chegada
// não espera a resposta — como usuários reais), com processo amostrador separado (sampler.js). Só fala com a API HML
// (3101) e o banco HML (5433). Todo dado criado leva "[HML-STRESS]" e fica só na empresa Alfa.
//
//   node load.js setup [N=300]        cria N operadores [HML-STRESS], 8 produtos com estoque alto e 1 caixa por operador
//   node load.js run <1..5|all>       executa o nível (ou todos, com 65 s entre eles para o limitador zerar)
//   node load.js custom <usuarios> <rps> <segundos>
//   node load.js cleanup              fecha os caixas e desativa os operadores (auditado, pela API; nada é apagado)
//
// O limitador (100 req/min por usuário) é comportamento do produto e NÃO é contornado: a carga é espalhada por muitos
// usuários e os 429 são contados à parte dos erros.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnTracked, spawnSyncHidden: spawnSync, guardLoad } = require('./lib/proc');
// Trava: este computador é corporativo e não gera carga. Sem remover apps/hml/LOAD_DISABLED E definir HML_ALLOW_LOAD, recusa.
guardLoad('load.js');
const { request, login } = require('./lib/api');
const { sessions, idOf } = require('./lib/harness');
const db = require('./lib/db');

const DIR = path.join(__dirname, '.hml');
const RESULTS = path.join(DIR, 'results');
const STATE = path.join(DIR, 'load.json');
const INITIAL_STOCK = 1000000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { password: `Hm1!${crypto.randomBytes(9).toString('base64url')}`, users: [], products: [], registers: {} });
const writeState = (s) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const origin = (i) => `127.0.${10 + Math.floor(i / 250)}.${1 + (i % 250)}`;
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

const LEVELS = {
  1: { name: 'normal', phases: [{ name: 'steady', users: 20, rps: 20, sec: 60 }] },
  2: { name: 'elevado', phases: [{ name: 'steady', users: 50, rps: 60, sec: 60 }] },
  3: { name: 'pesado', phases: [{ name: 'steady', users: 100, rps: 120, sec: 60 }, { name: 'pausa', users: 0, rps: 0, sec: 5 }, { name: 'recuperacao', users: 10, rps: 10, sec: 30 }] },
  4: { name: 'stress', phases: [{ name: 'steady', users: 150, rps: 200, sec: 60 }, { name: 'pausa', users: 0, rps: 0, sec: 5 }, { name: 'recuperacao', users: 10, rps: 10, sec: 30 }] },
  5: { name: 'pico-rajada', phases: [{ name: 'base', users: 20, rps: 20, sec: 20 }, { name: 'rajada', users: 150, burst: 3, sec: 10 }, { name: 'apos', users: 20, rps: 20, sec: 40 }] },
};

async function setup(N) {
  const s = readState();
  const cred = require('./lib/api').readCredentials();
  const A = cred.companies.A;
  const A1 = A.branches[0].id;
  const ses = await sessions(['ceo.a']);
  const ceo = { token: ses['ceo.a'].token };
  for (let i = s.users.length + 1; i <= N; i++) {
    const nnn = String(i).padStart(3, '0');
    const r = await request('POST', '/api/users', { ...ceo, body: { name: `[HML-STRESS] operador ${nnn}`, email: `hmlload${nnn}@hml.local`, password: s.password, userType: 'OPERATOR', branchId: A1 } });
    if (r.status !== 201) throw new Error(`criar operador ${nnn}: ${r.status} ${r.text}`);
    const u = r.body.data ?? r.body;
    s.users.push({ i, id: u.id, numericId: u.numericId, email: `hmlload${nnn}@hml.local` });
    writeState(s);
    await sleep(760); // 100 req/min por usuário: o CEO fica abaixo do limite
  }
  const tag = Date.now();
  while (s.products.length < 8) {
    const k = s.products.length + 1;
    const p = await request('POST', '/api/products', { ...ceo, body: { sku: `HMLL-${k}-${tag}`, name: `[HML-STRESS] carga ${k}`, costPrice: 10, salePrice: 25, unit: 'UN' } });
    if (p.status !== 201) throw new Error(`produto ${k}: ${p.status} ${p.text}`);
    const id = idOf(p);
    const a = await request('POST', '/api/stock/adjustment', { ...ceo, body: { productId: id, branchId: A1, newQuantity: INITIAL_STOCK, reason: 'HML-STRESS carga' } });
    if (a.status !== 201) throw new Error(`estoque ${k}: ${a.status} ${a.text}`);
    s.products.push(id);
    writeState(s);
  }
  for (let b = 0; b < s.users.length; b += 20) {
    await Promise.all(s.users.slice(b, b + 20).map(async (u) => {
      if (s.registers[u.i]) return;
      const l = await login({ numericId: u.numericId, password: s.password, localAddress: origin(u.i) });
      if (!l.ok) throw new Error(`login operador ${u.i}: ${l.status}`);
      const r = await request('POST', '/api/cash-register/open', { token: l.token, localAddress: origin(u.i), body: { branchId: A1, registerNumber: 100 + u.i, openingAmount: 100 } });
      if (r.status === 400 && /já tem um caixa aberto/.test(r.text)) {
        const cur = await request('GET', `/api/cash-register/current?branchId=${A1}`, { token: l.token, localAddress: origin(u.i) });
        if (cur.status !== 200) throw new Error(`caixa atual ${u.i}: ${cur.status} ${cur.text}`);
        s.registers[u.i] = idOf(cur);
        return;
      }
      if (r.status !== 201) throw new Error(`abrir caixa ${u.i}: ${r.status} ${r.text}`);
      s.registers[u.i] = idOf(r);
    }));
    writeState(s);
  }
  console.log(`[load] pronto: ${s.users.length} operadores, ${s.products.length} produtos, ${Object.keys(s.registers).length} caixas abertos`);
}

function summarizeSamples(file) {
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const mx = (f) => rows.reduce((m, r) => { const v = f(r); return typeof v === 'number' && v > m ? v : m; }, 0);
  const qsum = (r, k) => Object.values(r.redis?.queues || {}).reduce((a, q) => a + (q[k] || 0), 0);
  return {
    samples: rows.length,
    machineCpuMaxPct: mx((r) => r.machineCpuPct),
    apiCpuMaxPct: mx((r) => r.api?.cpuPct), apiMemMaxMb: mx((r) => r.api?.memMb),
    pgCpuMaxPct: mx((r) => r.pg?.cpuPct), pgMemMaxMb: mx((r) => r.pg?.memMb),
    redisCpuMaxPct: mx((r) => r.redisProc?.cpuPct), redisUsedMaxMb: mx((r) => r.redis?.usedMb), redisClientsMax: mx((r) => r.redis?.clients),
    pgConnsMax: mx((r) => r.pgConns?.total),
    pgConnsActiveMax: mx((r) => r.pgConns?.by?.active),
    queueWaitMax: mx((r) => qsum(r, 'wait')), queueActiveMax: mx((r) => qsum(r, 'active')), queueDelayedMax: mx((r) => qsum(r, 'delayed')), queueFailedMax: mx((r) => qsum(r, 'failed')),
  };
}

async function runLevel(key, def) {
  const s = readState();
  const cred = require('./lib/api').readCredentials();
  const A1 = cred.companies.A.branches[0].id;
  const maxUsers = Math.max(...def.phases.map((p) => p.users));
  if (s.users.length < maxUsers) throw new Error(`o nível pede ${maxUsers} operadores; rode "setup" com N maior (há ${s.users.length})`);
  fs.mkdirSync(RESULTS, { recursive: true });
  const stamp = `load-${key}-${def.name}`;
  const sampFile = path.join(RESULTS, `${stamp}.samples.jsonl`);
  fs.rmSync(sampFile, { force: true });
  // Filho rastreado: morre com este processo (saída, erro, Ctrl+C, SIGTERM). Canal IPC: o amostrador sai se este fechar.
  const sampler = spawnTracked(process.execPath, [path.join(__dirname, 'sampler.js'), sampFile, '5000'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });

  // Login de todos os operadores do nível (cada um de uma origem distinta: o limite de IP não é o que se mede).
  const tokens = new Array(maxUsers);
  const loginMs = [];
  for (let b = 0; b < maxUsers; b += 25) {
    await Promise.all(s.users.slice(b, Math.min(b + 25, maxUsers)).map(async (u, k) => {
      const t0 = Date.now();
      const l = await login({ numericId: u.numericId, password: s.password, localAddress: origin(u.i) });
      loginMs.push(Date.now() - t0);
      if (!l.ok) throw new Error(`login operador ${u.i}: ${l.status}`);
      tokens[b + k] = l.token;
    }));
  }
  const startedAt = new Date(Date.now() - 2000).toISOString();
  const t00 = Date.now();
  const rec = [];
  const sales = [];
  const inflight = new Set();
  const errSamples = {};
  let lagMax = 0;
  let last = Date.now();
  const lagTimer = setInterval(() => { const now = Date.now(); lagMax = Math.max(lagMax, now - last - 50); last = now; }, 50);

  const call = async (phase, opName, idx, method, url, body) => {
    const t0 = Date.now();
    const r = await request(method, url, { token: tokens[idx], body, timeout: 15000, localAddress: origin(idx + 1) });
    const row = { at: t0 - t00, ms: r.ms, status: r.status, op: opName, phase };
    rec.push(row);
    if ((r.status === 0 || r.status >= 400) && r.status !== 429) {
      const k = `${r.status}:${opName}`;
      if (!errSamples[k]) errSamples[k] = { n: 0, text: String(r.text || r.error || '').slice(0, 160) };
      errSamples[k].n += 1;
    }
    return r;
  };
  const pickProduct = () => s.products[Math.floor(Math.random() * s.products.length)];
  const OPS = [
    [20, 'GET produtos', (ph, i) => call(ph, 'GET produtos', i, 'GET', '/api/products?limit=20')],
    [12, 'GET clientes', (ph, i) => call(ph, 'GET clientes', i, 'GET', '/api/customers?limit=20')],
    [13, 'GET saldo', (ph, i) => call(ph, 'GET saldo', i, 'GET', `/api/stock/balance/${pickProduct()}?branchId=${A1}`)],
    [8, 'GET vendas', (ph, i) => call(ph, 'GET vendas', i, 'GET', '/api/sales?limit=10')],
    [7, 'GET OS', (ph, i) => call(ph, 'GET OS', i, 'GET', '/api/service-orders?limit=10')],
    [10, 'POST cliente', (ph, i) => call(ph, 'POST cliente', i, 'POST', '/api/customers', { name: `[HML-STRESS] cliente carga ${crypto.randomBytes(4).toString('hex')}` })],
    [30, 'venda+pagamento', async (ph, i) => {
      const pid = pickProduct();
      const qty = 1 + Math.floor(Math.random() * 3);
      const rec1 = { u: i, pid, qty, sale: null, pay: null };
      sales.push(rec1);
      const sv = await call(ph, 'POST venda', i, 'POST', '/api/sales', { branchId: A1, cashRegisterId: s.registers[s.users[i].i], items: [{ productId: pid, quantity: qty, unitPrice: 25 }] });
      rec1.sale = sv.status;
      if (sv.status !== 201) return sv;
      const pay = await call(ph, 'POST pagamento', i, 'POST', '/api/payments', { saleId: idOf(sv), paymentMethod: 'CASH', amount: 25 * qty });
      rec1.pay = pay.status;
      return pay;
    }],
  ];
  const totalW = OPS.reduce((a, o) => a + o[0], 0);
  const fire = (ph, idx) => {
    let x = Math.random() * totalW;
    const op = OPS.find((o) => (x -= o[0]) < 0) || OPS[0];
    const p = op[2](ph, idx).catch((e) => rec.push({ at: Date.now() - t00, ms: 0, status: 0, op: op[1], phase: ph, err: String(e) })).finally(() => inflight.delete(p));
    inflight.add(p);
  };

  const phaseWindows = {};
  for (const ph of def.phases) {
    const t0 = Date.now() - t00;
    if (ph.burst) {
      for (let u = 0; u < ph.users; u++) for (let k = 0; k < ph.burst; k++) fire(ph.name, u);
      await sleep(ph.sec * 1000);
    } else if (ph.rps > 0) {
      let issued = 0;
      let rr = 0;
      const start = Date.now();
      while (Date.now() - start < ph.sec * 1000) {
        const target = Math.floor(((Date.now() - start) / 1000) * ph.rps);
        while (issued < target) { fire(ph.name, rr++ % ph.users); issued++; }
        await sleep(5);
      }
    } else await sleep(ph.sec * 1000);
    phaseWindows[ph.name] = { from: t0, to: Date.now() - t00 };
  }
  const drainStart = Date.now();
  while (inflight.size && Date.now() - drainStart < 25000) await sleep(100);
  const stuck = inflight.size;
  clearInterval(lagTimer);
  await sleep(4000); // deixa o amostrador ver o pós-carga (filas, conexões)
  sampler.kill();

  const stat = (rows) => {
    const ok = rows.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.ms).sort((a, b) => a - b);
    return {
      n: rows.length, ok: ok.length,
      rl429: rows.filter((r) => r.status === 429).length,
      c4xx: rows.filter((r) => r.status >= 400 && r.status < 500 && r.status !== 429).length,
      c5xx: rows.filter((r) => r.status >= 500).length,
      c503: rows.filter((r) => r.status === 503).length,
      timeouts: rows.filter((r) => r.status === 0).length,
      avgMs: ok.length ? r1(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
      p50: r1(pct(ok, 50)), p95: r1(pct(ok, 95)), p99: r1(pct(ok, 99)), maxMs: r1(ok[ok.length - 1] ?? null),
    };
  };
  const phases = {};
  for (const ph of def.phases) {
    const rows = rec.filter((r) => r.phase === ph.name);
    const w = phaseWindows[ph.name];
    const st = stat(rows);
    st.offeredRps = ph.burst ? null : ph.rps;
    st.completedPerSec = rows.length && !ph.burst ? r1(rows.length / ((w.to - w.from) / 1000)) : null;
    st.okPerSec = rows.length && !ph.burst ? r1(st.ok / ((w.to - w.from) / 1000)) : null;
    phases[ph.name] = st;
  }
  const perOp = {};
  for (const op of [...new Set(rec.map((r) => r.op))]) perOp[op] = stat(rec.filter((r) => r.op === op));
  // Série de 5 s do primeiro ao último instante: p95 e contagem de erros (mostra degradação e recuperação).
  const series = [];
  const dur = Math.max(...rec.map((r) => r.at)) + 1;
  for (let t = 0; t < dur; t += 5000) {
    const rows = rec.filter((r) => r.at >= t && r.at < t + 5000);
    const ok = rows.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.ms).sort((a, b) => a - b);
    series.push({ t: t / 1000, n: rows.length, p95: r1(pct(ok, 95)), err: rows.filter((r) => r.status === 0 || r.status >= 500).length, rl: rows.filter((r) => r.status === 429).length });
  }

  // ---- Prova no banco (HTTP 200 não prova nada) ----
  const ids = s.users.slice(0, maxUsers).map((u) => `'${u.id}'`).join(',');
  const prods = s.products.map((p) => `'${p}'`).join(',');
  const regs = Object.values(s.registers).map((x) => `'${x}'`).join(',');
  const q1 = (sql) => Number(db.scalar(sql));
  const confirmed = sales.filter((x) => x.sale === 201);
  const attempted = sales.filter((x) => x.sale === 201 || x.sale === 0 || x.sale >= 500);
  const salesDb = q1(`SELECT count(*) FROM sales WHERE "userId" IN (${ids}) AND "createdAt" >= '${startedAt}'`);
  const paidConfirmed = sales.filter((x) => x.pay === 201).length;
  const paidDb = q1(`SELECT count(*) FROM payments p JOIN sales s ON s.id = p."saleId" WHERE s."userId" IN (${ids}) AND p."createdAt" >= '${startedAt}' AND p.status = 'APPROVED'`);
  const paidAttempted = sales.filter((x) => x.pay === 201 || x.pay === 0 || (x.pay !== null && x.pay >= 500)).length;
  const qtyConfirmed = confirmed.reduce((a, x) => a + x.qty, 0);
  const qtyAttempted = attempted.reduce((a, x) => a + x.qty, 0);
  const qtyDb = q1(`SELECT coalesce(sum(abs(quantity)),0) FROM stock_movements WHERE "productId" IN (${prods}) AND "movementType"::text = 'SALE' AND "createdAt" >= '${startedAt}'`);
  const negStock = q1(`SELECT count(*) FROM (SELECT "productId", coalesce(sum(CASE WHEN "movementType"::text IN ('PURCHASE','RETURN','TRANSFER_IN','PRODUCTION') THEN abs(quantity)
      WHEN "movementType"::text IN ('SALE','TRANSFER_OUT','LOSS','SUPPLIER_RETURN') THEN -abs(quantity) WHEN "movementType"::text = 'ADJUSTMENT' THEN quantity ELSE 0 END),0) b
      FROM stock_movements WHERE "productId" IN (${prods}) GROUP BY 1) x WHERE b < 0`);
  const dupPay = q1(`SELECT count(*) FROM (SELECT p."saleId" FROM payments p JOIN sales s ON s.id = p."saleId" WHERE s."userId" IN (${ids}) AND p.status = 'APPROVED' GROUP BY 1 HAVING count(*) > 1) x`);
  const cashMismatch = q1(`SELECT count(*) FROM (SELECT cr.id,
      coalesce((SELECT sum(cm.amount) FROM cash_movements cm WHERE cm."cashRegisterId" = cr.id AND cm."movementType"::text = 'SALE'),0) cm,
      coalesce((SELECT sum(p.amount) FROM payments p JOIN sales s ON s.id = p."saleId" WHERE s."cashRegisterId" = cr.id AND p.status = 'APPROVED' AND p."paymentMethod"::text = 'CASH'),0) pm
      FROM cash_registers cr WHERE cr.id IN (${regs})) x WHERE cm <> pm`);
  const proof = {
    vendas: { confirmadasPeloCliente: confirmed.length, noBanco: salesDb, tentadas: attempted.length, ok: salesDb >= confirmed.length && salesDb <= attempted.length },
    pagamentos: { confirmados: paidConfirmed, noBanco: paidDb, tentados: paidAttempted, ok: paidDb >= paidConfirmed && paidDb <= paidAttempted },
    estoqueSaidas: { confirmadas: qtyConfirmed, noBanco: qtyDb, tentadas: qtyAttempted, ok: qtyDb >= qtyConfirmed && qtyDb <= qtyAttempted },
    saldoNegativo: negStock, vendaComPagamentoDuplicado: dupPay, caixasComDivergenciaVendaXPagamento: cashMismatch,
  };
  proof.ok = proof.vendas.ok && proof.pagamentos.ok && proof.estoqueSaidas.ok && negStock === 0 && dupPay === 0 && cashMismatch === 0;

  const inv = spawnSync(process.execPath, [path.join(__dirname, 'tests', 'invariants.js')], { encoding: 'utf8' });
  const invTail = inv.stdout.split('\n').filter((l) => /^\[invariants\]|^FAIL/.test(l)).join(' | ');

  const out = {
    nivel: key, nome: def.name, at: new Date().toISOString(), maquina: '1 máquina Windows 14 núcleos (gerador + API + PG + Redis juntos)',
    fases: phases, porOperacao: perOp, serie5s: series, login: { n: loginMs.length, maxMs: Math.max(...loginMs), mediaMs: r1(loginMs.reduce((a, b) => a + b, 0) / loginMs.length) },
    errosAmostra: errSamples, geradorLagMaxMs: lagMax, requisicoesPendentesAoFim: stuck,
    recursos: summarizeSamples(sampFile), prova: proof, invariantes: invTail,
  };
  fs.writeFileSync(path.join(RESULTS, `${stamp}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ nivel: key, nome: def.name, fases: phases, login: out.login, geradorLagMaxMs: lagMax, pendentes: stuck, recursos: out.recursos, prova: proof, invariantes: invTail, erros: errSamples }, null, 1));
  return out;
}

async function cleanup() {
  const s = readState();
  const cred = require('./lib/api').readCredentials();
  const ses = await sessions(['ceo.a']);
  const ceo = { token: ses['ceo.a'].token };
  for (const u of s.users) {
    const regId = s.registers[u.i];
    if (regId) {
      const open = db.run(`SELECT status::text FROM cash_registers WHERE id = '${regId}'`)[0]?.[0] === 'OPEN';
      if (open) {
        const exp = Number(db.scalar(`SELECT coalesce(sum(CASE WHEN "movementType"::text IN ('OPENING','SALE','DEPOSIT') THEN amount WHEN "movementType"::text IN ('WITHDRAWAL','CANCELLATION','RETURN') THEN -amount ELSE 0 END), 0) FROM cash_movements WHERE "cashRegisterId" = '${regId}'`));
        const l = await login({ numericId: u.numericId, password: s.password, localAddress: origin(u.i) });
        if (l.ok) await request('POST', `/api/cash-register/${regId}/close`, { token: l.token, body: { actualAmount: exp }, localAddress: origin(u.i) });
      }
    }
    const active = db.run(`SELECT "isActive" FROM users WHERE id = '${u.id}' AND "companyId" = '${cred.companies.A.id}'`)[0]?.[0] === 't';
    if (active) { await request('POST', `/api/users/${u.id}/toggle-active`, { ...ceo, body: {} }); await sleep(750); }
  }
  const left = Number(db.scalar(`SELECT count(*) FROM cash_registers WHERE id IN (${Object.values(s.registers).map((x) => `'${x}'`).join(',') || "''"}) AND status::text = 'OPEN'`));
  const act = Number(db.scalar(`SELECT count(*) FROM users WHERE id IN (${s.users.map((u) => `'${u.id}'`).join(',') || "''"}) AND "isActive"`));
  console.log(`[load] limpeza: caixas ainda abertos=${left}, operadores ainda ativos=${act}`);
}

(async () => {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'setup') await setup(Number(a || 300));
  else if (cmd === 'run') {
    const keys = a === 'all' ? [1, 2, 3, 4, 5] : [Number(a)];
    for (const k of keys) {
      if (!LEVELS[k]) throw new Error('nível 1..5 ou all');
      await runLevel(k, LEVELS[k]);
      if (keys.length > 1 && k !== keys[keys.length - 1]) { console.log('[load] aguardando 65 s (janela do limitador)'); await sleep(65000); }
    }
  } else if (cmd === 'custom') {
    await runLevel('x', { name: `custom-${a}u-${b}rps`, phases: [{ name: 'steady', users: Number(a), rps: Number(b), sec: Number(c) }] });
  } else if (cmd === 'cleanup') await cleanup();
  else console.log('uso: node load.js setup [N] | run <1..5|all> | custom <usuarios> <rps> <seg> | cleanup');
  process.exit(0);
})().catch((e) => { console.error('[load] erro:', e.message); process.exit(1); });
