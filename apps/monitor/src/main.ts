/**
 * Ponto de entrada do monitor independente do CÓRTEX. Sem servidor HTTP (nada para atacar), sem banco: lê um JSON de alvos + variáveis de ambiente, sonda, decide, avisa.
 *
 *   node dist/apps/monitor/src/main.js              laço contínuo (o modo de produção)
 *   node ... --once                                  um ciclo e sai (cron / teste manual)
 *   node ... --check-config                          valida a configuração e imprime o resumo SEM segredos
 *   node ... --dry-run                               mede e decide, mas NÃO avisa e NÃO envia ao painel (e não grava estado)
 *   node ... --test-notify                           envia UMA mensagem de teste pelos canais configurados (só quando você mandar)
 *   node ... --health                                sai 0 se o último ciclo é recente (para healthcheck do contêiner)
 *
 * Este código só vale como monitoramento EXTERNO quando roda FORA da infraestrutura monitorada (outro provedor/região) — ver README.
 */
import { randomUUID } from 'node:crypto';
import { redact } from '../../../packages/shared/utils/alert-channels';
import { ConfigError, describeConfig, loadConfig } from './config';
import { runTick } from './engine';
import { deliver, planJobs, processJobs } from './notify';
import { networkLooksUp, probeWithRetries } from './probe';
import { flush, enqueue } from './report';
import { appendHistory, ensureDir, heartbeatAgeSec, loadState, saveState, writeHeartbeat } from './store';
import type { MonitorConfig, NotificationJob, ProbeResult } from './types';

const out = (obj: Record<string, unknown>) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function cycle(cfg: MonitorConfig, env: NodeJS.ProcessEnv, opts: { dryRun: boolean }): Promise<{ results: ProbeResult[]; opened: number; recovered: number }> {
  const now = Date.now();
  const state = loadState(cfg.stateDir, now);

  let results = await Promise.all(cfg.targets.map((t) => probeWithRetries(t, cfg)));
  if (results.some((r) => !r.ok) && !(await networkLooksUp(cfg.controlUrls))) {
    // nem os pontos de referência respondem: o problema é a rede DESTE monitor — não acusa ninguém
    results = results.map((r) => (r.ok ? r : { ...r, inconclusive: true }));
    state.lastNetworkDownAt = now;
    out({ level: 'warn', msg: 'rede do monitor parece fora (pontos de referência não respondem): falhas desta rodada não contam contra os alvos' });
  }

  const tick = runTick(state, results, cfg, now, randomUUID);
  const next = tick.state;
  for (const ev of tick.events) {
    out({ level: ev.kind === 'RECOVERED' ? 'info' : 'warn', msg: `incidente ${ev.kind}`, type: ev.incident.type, severity: ev.incident.severity, grouped: Boolean(ev.incident.groupedUnder) });
  }

  if (!opts.dryRun) {
    appendHistory(cfg.stateDir, results, cfg.historyMaxLines);
    enqueue(next, results, tick.events, cfg);
    for (const ev of tick.events) next.pending.push(...planJobs(next, ev, cfg, cfg.targets, now, randomUUID));
    for (const l of await processJobs(next, cfg, env, now)) out({ level: l.outcome === 'FAILED' ? 'error' : 'info', msg: 'aviso', ...l });
    const f = await flush(next, cfg, now);
    if (f.attempted) out({ level: f.ok ? 'info' : 'warn', msg: f.ok ? 'enviado ao painel' : 'painel indisponível (fica na fila)', results: f.sentResults, incidents: f.sentIncidents, error: f.error });
    saveState(cfg.stateDir, next);
    writeHeartbeat(cfg.stateDir, Date.now());
  }
  out({ level: 'info', msg: 'ciclo', targets: results.map((r) => ({ id: r.target, ok: r.ok, ms: r.latencyMs, status: r.httpStatus, inconclusive: r.inconclusive || undefined })) });
  return { results, opened: tick.events.filter((e) => e.kind === 'OPENED').length, recovered: tick.events.filter((e) => e.kind === 'RECOVERED').length };
}

async function testNotify(cfg: MonitorConfig, env: NodeJS.ProcessEnv): Promise<number> {
  let failed = 0;
  const channels = [...new Set([...cfg.notify.criticalChannels, ...cfg.notify.attentionChannels])];
  for (const channel of channels) {
    const job: NotificationJob = { id: randomUUID(), channel, phase: 'OPEN', incidentId: 'teste', subject: '[CÓRTEX] TESTE do monitor externo', text: `TESTE: mensagem de verificação do monitor externo (${cfg.monitorId}, ${cfg.location}). Nenhum incidente real.`, attempts: 0, nextTryAt: 0, createdAt: Date.now() };
    const r = await deliver(job, env, {});
    if (r.skipped) out({ level: 'warn', channel, resultado: 'NÃO ENVIADO', motivo: r.skipped });
    else if (r.ok) out({ level: 'info', channel, resultado: 'ACEITO PELO PROVEDOR', obs: 'aceito ≠ entregue: confira no aparelho/caixa de entrada' });
    else {
      failed++;
      out({ level: 'error', channel, resultado: 'FALHOU', motivo: redact(r.error ?? 'sem detalhe', 120) });
    }
  }
  return failed ? 1 : 0;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const has = (f: string) => argv.includes(f);
  let cfg: MonitorConfig;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Configuração inválida:\n${e.problems.map((p) => ` - ${p}`).join('\n')}\n`);
      return 2;
    }
    throw e;
  }
  if (has('--check-config')) {
    process.stdout.write(JSON.stringify(describeConfig(cfg), null, 2) + '\n');
    return 0;
  }
  if (has('--health')) {
    const age = heartbeatAgeSec(cfg.stateDir);
    return age !== null && age <= cfg.intervalSec * 3 + 30 ? 0 : 1;
  }
  if (has('--test-notify')) return testNotify(cfg, env);
  ensureDir(cfg.stateDir);
  const dryRun = has('--dry-run');
  if (has('--once')) {
    await cycle(cfg, env, { dryRun });
    return 0;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  out({ level: 'info', msg: 'monitor iniciado', monitorId: cfg.monitorId, location: cfg.location, targets: cfg.targets.length, intervalSec: cfg.intervalSec, dryRun });
  while (!stopping) {
    const started = Date.now();
    try {
      await cycle(cfg, env, { dryRun });
    } catch (e) {
      // um ciclo ruim nunca derruba o monitor
      out({ level: 'error', msg: 'erro no ciclo', error: redact(e instanceof Error ? e.message : e, 160) });
    }
    const wait = Math.max(1000, cfg.intervalSec * 1000 - (Date.now() - started));
    for (let waited = 0; waited < wait && !stopping; waited += 500) await sleep(500);
  }
  out({ level: 'info', msg: 'monitor encerrado' });
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`falha fatal: ${redact(e instanceof Error ? e.message : e, 200)}\n`);
      process.exit(1);
    }
  );
}
