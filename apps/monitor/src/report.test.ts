import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyRequestSignature } from '../../../packages/shared/utils/request-signature';
import { newState } from './engine';
import { MAX_RESULTS_PER_POST, buildPayload, enqueue, flush } from './report';
import { fakeFetch, result, testConfig } from './testkit';
import type { Incident } from './types';

const SECRET = 'k'.repeat(40);
const cfg = testConfig({}, { MONITOR_INGEST_URL: 'https://api.example.com/api/monitoring/external/ingest', MONITOR_INGEST_SECRET: SECRET });

function incident(id: string, over: Partial<Incident> = {}): Incident {
  return { id, target: 'site', kind: 'DOWN', type: 'EXTERNAL_SITE_DOWN', severity: 'CRITICAL', startedAt: 1, endedAt: null, detail: 'd', cause: 'c', groupedUnder: null, notifiedChannels: [], lastNotifiedAt: null, reminders: 0, ...over };
}

test('fila: resultados inconclusivos não vão; incidente é substituído pelo mais recente (sem duplicar)', () => {
  const s = newState();
  enqueue(s, [result('site', true), result('site', false, { inconclusive: true })], [{ kind: 'OPENED', incident: incident('i1') }], cfg);
  enqueue(s, [], [{ kind: 'RECOVERED', incident: incident('i1', { endedAt: 99 }) }], cfg);
  assert.equal(s.outbox.results.length, 1);
  assert.equal(s.outbox.incidents.length, 1);
  assert.equal(s.outbox.incidents[0].endedAt, 99);
});

test('fila respeita o teto descartando os resultados mais antigos', () => {
  const s = newState();
  enqueue(s, Array.from({ length: 150 }, (_, i) => result('site', true, { at: i })), [], { outboxMax: 100 });
  assert.equal(s.outbox.results.length, 100);
  assert.equal(s.outbox.results[0].at, 50);
});

test('envio assinado: a assinatura confere, o corpo não carrega URL/erro/segredo e a fila esvazia no 2xx', async () => {
  const s = newState();
  enqueue(s, [result('site', true)], [{ kind: 'OPENED', incident: incident('i1') }], cfg);
  const f = fakeFetch(() => ({ status: 202 }));
  const r = await flush(s, cfg, 1_700_000_000_000, { fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(s.outbox.results.length + s.outbox.incidents.length, 0);
  const call = f.calls[0];
  const h = call.init!.headers as Record<string, string>;
  const body = String(call.init!.body);
  const v = verifyRequestSignature({ secret: SECRET, signatureHeader: h['X-Cortex-Signature'], timestampHeader: h['X-Cortex-Timestamp'], method: 'POST', path: '/api/monitoring/external/ingest', rawBody: body, nowMs: 1_700_000_000_000 });
  assert.equal(v.ok, true);
  assert.ok(!body.includes(SECRET) && !body.includes('site.example.com') && !body.includes('HTTP 503'));
  assert.ok(!JSON.stringify(h).includes(SECRET));
});

test('API fora (5xx ou rede): nada se perde, tudo continua na fila para o próximo ciclo', async () => {
  const s = newState();
  enqueue(s, [result('site', true)], [{ kind: 'OPENED', incident: incident('i1') }], cfg);
  assert.equal((await flush(s, cfg, 1_700_000_000_000, { fetchImpl: fakeFetch(() => ({ status: 503 })).impl })).ok, false);
  assert.equal((await flush(s, cfg, 1_700_000_000_000, { fetchImpl: fakeFetch(() => new Error('ECONNREFUSED')).impl })).ok, false);
  assert.equal(s.outbox.results.length, 1);
  assert.equal(s.outbox.incidents.length, 1);
});

test('lote tem tamanho máximo; o restante vai nos ciclos seguintes, em ordem', async () => {
  const s = newState();
  enqueue(s, Array.from({ length: MAX_RESULTS_PER_POST + 30 }, (_, i) => result('site', true, { at: i })), [], cfg);
  assert.equal(buildPayload(s, cfg, 1).results.length, MAX_RESULTS_PER_POST);
  await flush(s, cfg, 1_700_000_000_000, { fetchImpl: fakeFetch(() => ({ status: 200 })).impl });
  assert.equal(s.outbox.results.length, 30);
  assert.equal(s.outbox.results[0].at, MAX_RESULTS_PER_POST);
});

test('sem painel configurado: não tenta enviar', async () => {
  const s = newState();
  enqueue(s, [result('site', true)], [], cfg);
  const f = fakeFetch(() => ({ status: 200 }));
  const r = await flush(s, testConfig(), 1, { fetchImpl: f.impl });
  assert.equal(r.attempted, false);
  assert.equal(f.calls.length, 0);
});
