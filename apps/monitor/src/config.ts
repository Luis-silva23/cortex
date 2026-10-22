/**
 * Configuração do monitor: um arquivo JSON (sem segredo: alvos, limiares, política) + variáveis de ambiente (segredos e canais). Nada é inventado: sem alvo, sem URL do painel ou
 * sem canal, o monitor diz o que falta e não finge que monitora. Os canais (e-mail, SMS, WhatsApp) usam as MESMAS variáveis da API (`@ln-system/shared/utils/alert-channels`).
 */
import * as fs from 'fs';
import type { AlertChannel } from '../../../packages/shared/utils/alert-channels';
import type { MonitorConfig, Severity, TargetConfig } from './types';

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const CHANNELS: AlertChannel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`);
  }
}

function int(v: unknown, fallback: number, min: number, max: number, name: string, problems: string[]): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} deve ser um inteiro entre ${min} e ${max}`);
    return fallback;
  }
  return n;
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** https obrigatório (http só para localhost, em teste local); sem usuário/senha na URL. Devolve o problema ou null. */
export function urlProblem(raw: string, label: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${label}: endereço inválido`;
  }
  if (u.username || u.password) return `${label}: não coloque usuário/senha no endereço`;
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && (allowInsecure || isLocalHost(u.hostname))) return null;
  return `${label}: use https:// (http só para localhost)`;
}

function channelList(v: unknown, fallback: AlertChannel[], name: string, problems: string[]): AlertChannel[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) {
    problems.push(`${name} deve ser uma lista`);
    return fallback;
  }
  const out: AlertChannel[] = [];
  for (const c of v) {
    const up = String(c).toUpperCase() as AlertChannel;
    if (!CHANNELS.includes(up)) problems.push(`${name}: canal desconhecido "${String(c)}"`);
    else if (!out.includes(up)) out.push(up);
  }
  return out;
}

function severity(v: unknown, fallback: Severity, name: string, problems: string[]): Severity {
  if (v === undefined || v === null) return fallback;
  if (v === 'ATTENTION' || v === 'CRITICAL') return v;
  problems.push(`${name} deve ser ATTENTION ou CRITICAL`);
  return fallback;
}

export function parseTargets(raw: unknown, allowInsecure: boolean, problems: string[]): TargetConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push('targets: informe ao menos um alvo');
    return [];
  }
  const targets: TargetConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((t: any, i: number) => {
    const label = `targets[${i}]`;
    const id = String(t?.id ?? '');
    if (!ID_RE.test(id)) problems.push(`${label}.id inválido (minúsculas, números, - e _; 2 a 40 caracteres)`);
    if (seen.has(id)) problems.push(`${label}.id repetido: ${id}`);
    seen.add(id);
    const url = String(t?.url ?? '');
    const up = urlProblem(url, `${label}.url`, allowInsecure);
    if (up) problems.push(up);
    const method = t?.method === 'HEAD' ? 'HEAD' : 'GET';
    const expect = Array.isArray(t?.expectStatus) && t.expectStatus.length ? t.expectStatus.map(Number) : [200];
    if (expect.some((n: number) => !Number.isInteger(n) || n < 100 || n > 599)) problems.push(`${label}.expectStatus inválido`);
    const bodyIncludes = typeof t?.bodyIncludes === 'string' && t.bodyIncludes ? t.bodyIncludes : null;
    if (bodyIncludes && method === 'HEAD') problems.push(`${label}: bodyIncludes exige GET`);
    targets.push({
      id,
      name: String(t?.name ?? id).slice(0, 80),
      url,
      method,
      expectStatus: expect,
      bodyIncludes,
      timeoutMs: int(t?.timeoutMs, 8000, 1000, 30_000, `${label}.timeoutMs`, problems),
      severity: severity(t?.severity, 'CRITICAL', `${label}.severity`, problems),
      latencyWarnMs: int(t?.latencyWarnMs, 1500, 50, 60_000, `${label}.latencyWarnMs`, problems),
      latencyCritMs: int(t?.latencyCritMs, 4000, 50, 60_000, `${label}.latencyCritMs`, problems),
      parent: t?.parent ? String(t.parent) : null,
    });
  });
  for (const t of targets) {
    if (t.latencyCritMs < t.latencyWarnMs) problems.push(`${t.id}: latencyCritMs deve ser maior ou igual a latencyWarnMs`);
    if (t.parent) {
      if (!targets.some((p) => p.id === t.parent)) problems.push(`${t.id}: parent "${t.parent}" não existe`);
      if (t.parent === t.id) problems.push(`${t.id}: parent não pode ser o próprio alvo`);
    }
  }
  // sem ciclo de pais (A → B → A)
  for (const t of targets) {
    const chain = new Set<string>([t.id]);
    let cur = t.parent;
    while (cur) {
      if (chain.has(cur)) {
        problems.push(`${t.id}: ciclo de parent`);
        break;
      }
      chain.add(cur);
      cur = targets.find((x) => x.id === cur)?.parent ?? null;
    }
  }
  return targets;
}

/** Monta e valida a configuração. Lança ConfigError com TODOS os problemas de uma vez (não um por tentativa). */
export function buildConfig(file: any, env: NodeJS.ProcessEnv): MonitorConfig {
  const problems: string[] = [];
  const f = file && typeof file === 'object' ? file : {};
  const allowInsecure = env.MONITOR_ALLOW_INSECURE === 'true' || f.allowInsecure === true;
  const targets = parseTargets(f.targets, allowInsecure, problems);

  const monitorId = String(env.MONITOR_ID ?? f.monitorId ?? '');
  if (!ID_RE.test(monitorId)) problems.push('monitorId inválido (defina MONITOR_ID ou "monitorId" no arquivo: minúsculas, números, - e _)');
  const location = String(env.MONITOR_LOCATION ?? f.location ?? '').slice(0, 80) || 'não informado';

  const controlUrls: string[] = Array.isArray(f.controlUrls) ? f.controlUrls.map(String) : ['https://www.cloudflare.com/cdn-cgi/trace', 'https://www.google.com/generate_204'];
  controlUrls.forEach((u, i) => {
    const p = urlProblem(u, `controlUrls[${i}]`, allowInsecure);
    if (p) problems.push(p);
  });

  const n = f.notify ?? {};
  const notify = {
    criticalChannels: channelList(n.criticalChannels, ['EMAIL', 'SMS', 'WHATSAPP'], 'notify.criticalChannels', problems),
    attentionChannels: channelList(n.attentionChannels, ['EMAIL'], 'notify.attentionChannels', problems),
    maxPerHourPerChannel: int(n.maxPerHourPerChannel, 6, 1, 100, 'notify.maxPerHourPerChannel', problems),
    maxAttempts: int(n.maxAttempts, 5, 1, 20, 'notify.maxAttempts', problems),
    retryDelaysSec: Array.isArray(n.retryDelaysSec) && n.retryDelaysSec.length ? n.retryDelaysSec.map((x: unknown) => Math.max(5, Math.min(3600, Number(x) || 60))) : [60, 120, 300, 600],
  };

  const ingestUrl = String(env.MONITOR_INGEST_URL ?? f.ingestUrl ?? '').trim();
  const ingestSecret = String(env.MONITOR_INGEST_SECRET ?? '').trim();
  let ingest: MonitorConfig['ingest'] = null;
  if (ingestUrl) {
    const p = urlProblem(ingestUrl, 'MONITOR_INGEST_URL', allowInsecure);
    if (p) problems.push(p);
    if (ingestSecret.length < 32) problems.push('MONITOR_INGEST_SECRET precisa ter ao menos 32 caracteres (segredo compartilhado com a API; nunca vai para o arquivo)');
    else ingest = { url: ingestUrl, secret: ingestSecret };
  } else if (ingestSecret) problems.push('MONITOR_INGEST_SECRET definido sem MONITOR_INGEST_URL');

  const panelUrl = String(env.MONITOR_PANEL_URL ?? f.panelUrl ?? '').trim() || null;
  if (panelUrl) {
    const p = urlProblem(panelUrl, 'panelUrl', allowInsecure);
    if (p) problems.push(p);
  }

  const cfg: MonitorConfig = {
    monitorId,
    location,
    targets,
    intervalSec: int(env.MONITOR_INTERVAL_SEC ?? f.intervalSec, 30, 10, 3600, 'intervalSec', problems),
    failThreshold: int(f.failThreshold, 3, 1, 20, 'failThreshold', problems),
    recoverThreshold: int(f.recoverThreshold, 2, 1, 20, 'recoverThreshold', problems),
    quickRetries: int(f.quickRetries, 2, 0, 5, 'quickRetries', problems),
    quickRetryDelayMs: int(f.quickRetryDelayMs, 3000, 100, 30_000, 'quickRetryDelayMs', problems),
    latencyWindow: int(f.latencyWindow, 5, 3, 50, 'latencyWindow', problems),
    latencyStreak: int(f.latencyStreak, 3, 1, 50, 'latencyStreak', problems),
    errorRateWindow: int(f.errorRateWindow, 20, 10, 200, 'errorRateWindow', problems),
    errorRatePct: int(f.errorRatePct, 25, 5, 100, 'errorRatePct', problems),
    controlUrls,
    reminderMinutes: int(f.reminderMinutes, 60, 5, 1440, 'reminderMinutes', problems),
    maxReminders: int(f.maxReminders, 6, 0, 100, 'maxReminders', problems),
    stateDir: String(env.MONITOR_STATE_DIR ?? f.stateDir ?? './monitor-state'),
    ingest,
    panelUrl,
    notify,
    historyMaxLines: int(f.historyMaxLines, 50_000, 1000, 1_000_000, 'historyMaxLines', problems),
    outboxMax: int(f.outboxMax, 20_000, 100, 200_000, 'outboxMax', problems),
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): MonitorConfig {
  const path = env.MONITOR_CONFIG_FILE;
  if (!path) throw new ConfigError(['defina MONITOR_CONFIG_FILE (caminho do JSON com os alvos; veja apps/monitor/monitor.example.json)']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch (e) {
    throw new ConfigError([`não foi possível ler/interpretar ${path}: ${e instanceof Error ? e.message : String(e)}`]);
  }
  return buildConfig(parsed, env);
}

/** Resumo SEM segredo para `--check-config`. */
export function describeConfig(cfg: MonitorConfig): Record<string, unknown> {
  return {
    monitorId: cfg.monitorId,
    location: cfg.location,
    intervalSec: cfg.intervalSec,
    targets: cfg.targets.map((t) => ({ id: t.id, name: t.name, host: new URL(t.url).host, severity: t.severity, parent: t.parent })),
    thresholds: { failThreshold: cfg.failThreshold, recoverThreshold: cfg.recoverThreshold, quickRetries: cfg.quickRetries, latencyStreak: cfg.latencyStreak },
    controlUrls: cfg.controlUrls.map((u) => new URL(u).host),
    ingest: cfg.ingest ? { host: new URL(cfg.ingest.url).host, secret: 'definido' } : 'desligado (resultados só em arquivo)',
    notify: cfg.notify,
  };
}
