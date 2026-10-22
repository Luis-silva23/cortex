/**
 * Sondagem HTTP dos alvos. Uma sondagem é UM pedido com prazo; "falha" só vale depois das retentativas rápidas (protege contra o soluço momentâneo de um pedido só) e depois
 * de conferir que a PRÓPRIA rede do monitor está de pé (pontos de referência): se nem a referência responde, o problema é do ponto de medição e nada é acusado contra o alvo.
 * Nunca lê nem grava o corpo da resposta (só confere o texto esperado, se configurado) e nunca envia credencial.
 */
import { redact } from '../../../packages/shared/utils/alert-channels';
import type { FailureKind, MonitorConfig, ProbeResult, TargetConfig } from './types';

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const BODY_LIMIT = 64 * 1024;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function failure(kind: FailureKind): string {
  return kind === 'timeout' ? 'tempo esgotado' : kind === 'network' ? 'falha de rede/DNS/TLS' : kind === 'content' ? 'resposta sem o conteúdo esperado' : 'status HTTP inesperado';
}

export async function probeOnce(t: TargetConfig, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const base = { target: t.id, at: started, inconclusive: false };
  try {
    const res = await (deps.fetchImpl ?? fetch)(t.url, {
      method: t.method,
      redirect: 'manual',
      headers: { 'User-Agent': 'CortexMonitor/1.0', 'Cache-Control': 'no-cache', Accept: '*/*' },
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    let bodyOk = true;
    if (t.bodyIncludes && t.method === 'GET') {
      const text = (await res.text()).slice(0, BODY_LIMIT);
      bodyOk = text.includes(t.bodyIncludes);
    } else {
      try {
        await res.body?.cancel();
      } catch {
        /* corpo já consumido ou sem corpo */
      }
    }
    const latencyMs = Math.max(0, now() - started);
    const statusOk = t.expectStatus.includes(res.status);
    if (statusOk && bodyOk) return { ...base, ok: true, httpStatus: res.status, latencyMs, failure: null, error: null };
    const kind: FailureKind = statusOk ? 'content' : 'http';
    return { ...base, ok: false, httpStatus: res.status, latencyMs, failure: kind, error: kind === 'http' ? `HTTP ${res.status}` : failure(kind) };
  } catch (error) {
    const latencyMs = Math.max(0, now() - started);
    const name = error instanceof Error ? error.name : '';
    const kind: FailureKind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
    return { ...base, ok: false, httpStatus: null, latencyMs, failure: kind, error: redact(`${failure(kind)}${error instanceof Error && kind === 'network' ? ` (${error.message})` : ''}`, 120) };
  }
}

/** Uma sondagem com retentativas RÁPIDAS só quando falha (sucesso devolve na hora). O resultado final é o da última tentativa. */
export async function probeWithRetries(t: TargetConfig, cfg: Pick<MonitorConfig, 'quickRetries' | 'quickRetryDelayMs'>, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let last = await probeOnce(t, deps);
  for (let i = 0; i < cfg.quickRetries && !last.ok; i++) {
    await sleep(cfg.quickRetryDelayMs);
    last = await probeOnce(t, deps);
  }
  return last;
}

/**
 * A rede do próprio monitor está de pé? Qualquer resposta HTTP (mesmo 404/500) de um ponto de referência prova que a saída de rede funciona. Sem pontos de referência, assume que sim
 * (não dá para saber). Só devolve `false` quando TODOS os pontos de referência falham em conectar.
 */
export async function networkLooksUp(urls: string[], deps: ProbeDeps = {}, timeoutMs = 5000): Promise<boolean> {
  if (urls.length === 0) return true;
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        await (deps.fetchImpl ?? fetch)(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'CortexMonitor/1.0' } }).then((r) => r.body?.cancel().catch(() => undefined));
        return true;
      } catch {
        return false;
      }
    })
  );
  return results.some(Boolean);
}
