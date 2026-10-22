#!/usr/bin/env node
// Prova de PROCESSO REAL do monitor (`main.js --once`) contra servidores locais que este script controla. Nenhum provedor real é contactado (os canais ficam sem
// configuração e o monitor registra "NÃO ENVIADO"). Uso:  npm run build --workspace=@ln-system/monitor && node apps/monitor/scripts/smoke-local.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIST = path.join(__dirname, '..', 'dist');
const MAIN = path.join(DIST, 'apps/monitor/src/main.js');
const SIG = require(path.join(DIST, 'packages/shared/utils/request-signature.js'));
const SECRET = 'smoke-secret-'.padEnd(40, 'x');

let targetUp = true;
const ingestPosts = [];
const mk = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${what}`); if (!ok) failures++; };

(async () => {
  const target = await mk((req, res) => { res.statusCode = targetUp ? 200 : 503; res.end(targetUp ? 'ok' : 'down'); });
  const control = await mk((req, res) => { res.statusCode = 204; res.end(); });
  const ingest = await mk((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const v = SIG.verifyRequestSignature({ secret: SECRET, signatureHeader: req.headers['x-cortex-signature'], timestampHeader: req.headers['x-cortex-timestamp'], method: 'POST', path: req.url, rawBody: body });
      ingestPosts.push({ ok: v.ok, body: JSON.parse(body) });
      res.statusCode = v.ok ? 202 : 401;
      res.end();
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-monitor-smoke-'));
  const cfgFile = path.join(dir, 'monitor.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    monitorId: 'smoke', location: 'local', intervalSec: 10, failThreshold: 3, recoverThreshold: 2, quickRetries: 0,
    controlUrls: [`http://127.0.0.1:${control.address().port}/`],
    ingestUrl: `http://127.0.0.1:${ingest.address().port}/monitor/v1/ingest`,
    targets: [{ id: 'alvo', name: 'Alvo de teste', url: `http://127.0.0.1:${target.address().port}/`, timeoutMs: 2000 }],
  }));
  const env = { ...process.env, MONITOR_CONFIG_FILE: cfgFile, MONITOR_STATE_DIR: path.join(dir, 'state'), MONITOR_INGEST_SECRET: SECRET };
  for (const k of Object.keys(env)) if (/^(RESEND|TWILIO|META_|ALERT_)/.test(k)) delete env[k];

  // ASSÍNCRONO de propósito: com spawnSync o laço de eventos deste processo ficaria bloqueado e os servidores locais não responderiam ao monitor
  const run = async () => {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [MAIN, '--once'], { env });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (status) => resolve({ status, stdout }));
    });
    return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8'));
  const open = () => Object.keys(state().targets.alvo.incidents);

  targetUp = true;
  await run();
  check(open().length === 0, 'alvo saudável: nenhum incidente');
  targetUp = false;
  await run(); await run();
  check(open().length === 0, 'duas falhas seguidas: ainda nenhum incidente (falha isolada não acusa)');
  const third = await run();
  check(open().join() === 'DOWN', 'terceira falha seguida: queda aberta');
  check(third.filter((l) => l.outcome === 'SKIPPED').length === 3, 'canais sem configuração: e-mail, SMS e WhatsApp registrados como NÃO ENVIADO (não finge que avisou)');
  targetUp = true;
  await run();
  check(open().join() === 'DOWN', 'um sucesso só não recupera');
  await run();
  check(open().length === 0, 'dois sucessos seguidos: recuperado');
  control.close();
  targetUp = false;
  for (let i = 0; i < 4; i++) await run();
  check(open().length === 0, 'rede de referência fora: o alvo caído NÃO é acusado (problema é do ponto de medição)');

  check(ingestPosts.length > 0 && ingestPosts.every((p) => p.ok), `envios ao painel simulado: ${ingestPosts.length}, todos com assinatura válida`);
  const incs = ingestPosts.flatMap((p) => p.body.incidents).map((i) => `${i.type}:${i.endedAt ? 'encerrado' : 'aberto'}`);
  check(incs.includes('EXTERNAL_ALVO_DOWN:aberto') && incs.includes('EXTERNAL_ALVO_DOWN:encerrado'), 'o painel recebeu a abertura E a recuperação do incidente');
  check(!fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8').includes(SECRET), 'o segredo de ingestão não aparece no arquivo de estado');
  for (const s of [target, ingest]) s.close();
  console.log(failures ? `\n${failures} verificação(ões) FALHOU` : '\nTodas as verificações passaram');
  process.exit(failures ? 1 : 0);
})();
