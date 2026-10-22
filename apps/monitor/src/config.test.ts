import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, buildConfig, describeConfig, loadConfig, urlProblem } from './config';
import { testConfig } from './testkit';

test('configuração mínima válida usa os padrões seguros', () => {
  const c = testConfig();
  assert.equal(c.failThreshold, 3);
  assert.equal(c.recoverThreshold, 2);
  assert.deepEqual(c.notify.criticalChannels, ['EMAIL', 'SMS', 'WHATSAPP']);
  assert.deepEqual(c.notify.attentionChannels, ['EMAIL']);
  assert.equal(c.ingest, null);
});

test('rejeita http fora de localhost, usuário/senha na URL e lista TODOS os problemas de uma vez', () => {
  assert.match(urlProblem('http://x.example.com', 'u', false) ?? '', /https/);
  assert.match(urlProblem('https://user:pw@x.example.com', 'u', false) ?? '', /usuário/);
  assert.equal(urlProblem('http://localhost:3000', 'u', false), null);
  try {
    buildConfig({ monitorId: 'Inválido!', targets: [{ id: 'a', url: 'http://x.example.com' }, { id: 'a', url: 'https://ok.example.com', parent: 'zzz' }] }, {});
    assert.fail('deveria lançar');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(e.problems.length >= 4, e.problems.join('|'));
  }
});

test('detecta ciclo de parent e latência crítica menor que o aviso', () => {
  assert.throws(() => buildConfig({ monitorId: 'm1', targets: [{ id: 'aa', url: 'https://a.example.com', parent: 'bb' }, { id: 'bb', url: 'https://b.example.com', parent: 'aa' }] }, {}), /ciclo/);
  assert.throws(() => testConfig({ targets: [{ id: 'aa', url: 'https://a.example.com', latencyWarnMs: 2000, latencyCritMs: 1000 }] }), ConfigError);
});

test('painel: segredo curto é recusado e o segredo nunca aparece no resumo', () => {
  assert.throws(() => testConfig({}, { MONITOR_INGEST_URL: 'https://api.example.com/api/x', MONITOR_INGEST_SECRET: 'curto' }), /32 caracteres/);
  const secret = 'S'.repeat(40);
  const c = testConfig({}, { MONITOR_INGEST_URL: 'https://api.example.com/api/x', MONITOR_INGEST_SECRET: secret });
  assert.ok(c.ingest);
  assert.ok(!JSON.stringify(describeConfig(c)).includes(secret));
});

test('segredo de ingestão sem URL e canal desconhecido são recusados', () => {
  assert.throws(() => testConfig({}, { MONITOR_INGEST_SECRET: 'S'.repeat(40) }), /sem MONITOR_INGEST_URL/);
  assert.throws(() => testConfig({ notify: { criticalChannels: ['PIGEON'] } }), /canal desconhecido/);
});

test('loadConfig exige MONITOR_CONFIG_FILE e trata arquivo ilegível', () => {
  assert.throws(() => loadConfig({}), /MONITOR_CONFIG_FILE/);
  assert.throws(() => loadConfig({ MONITOR_CONFIG_FILE: 'x.json' }, () => '{não é json'), /não foi possível/);
  const ok = loadConfig({ MONITOR_CONFIG_FILE: 'x.json' }, () => JSON.stringify({ monitorId: 'm1', targets: [{ id: 'aa', url: 'https://a.example.com' }] }));
  assert.equal(ok.targets.length, 1);
});
