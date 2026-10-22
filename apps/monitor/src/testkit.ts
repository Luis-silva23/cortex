/** Apoio dos testes do monitor (não faz parte do runtime). */
import { buildConfig } from './config';
import type { MonitorConfig, ProbeResult } from './types';

export function testConfig(extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}): MonitorConfig {
  return buildConfig(
    {
      monitorId: 'teste',
      targets: [
        { id: 'site', name: 'Site', url: 'https://site.example.com/health' },
        { id: 'api', name: 'API', url: 'https://api.example.com/health', parent: 'site' },
      ],
      controlUrls: ['https://control.example.com/'],
      ...extra,
    },
    env
  );
}

export function result(target: string, ok: boolean, over: Partial<ProbeResult> = {}): ProbeResult {
  return { target, at: 0, ok, httpStatus: ok ? 200 : 503, latencyMs: 100, failure: ok ? null : 'http', error: ok ? null : 'HTTP 503', inconclusive: false, ...over };
}

export function counter(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

/** fetch falso: responde conforme uma função e guarda as chamadas. */
export function fakeFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body?: string } | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    return new Response(r.body ?? null, { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
