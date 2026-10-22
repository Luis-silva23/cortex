import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkLooksUp, probeOnce, probeWithRetries } from './probe';
import { fakeFetch, testConfig } from './testkit';

const target = testConfig().targets[0];
const noSleep = async () => undefined;

test('200 é saudável e não envia credencial', async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  const r = await probeOnce(target, { fetchImpl: f.impl });
  assert.equal(r.ok, true);
  const headers = JSON.stringify(f.calls[0].init?.headers ?? {}).toLowerCase();
  assert.ok(!headers.includes('authorization') && !headers.includes('cookie'));
});

test('503 é falha HTTP; timeout e erro de rede são classificados', async () => {
  assert.equal((await probeOnce(target, { fetchImpl: fakeFetch(() => ({ status: 503 })).impl })).failure, 'http');
  const to = Object.assign(new Error('x'), { name: 'TimeoutError' });
  assert.equal((await probeOnce(target, { fetchImpl: fakeFetch(() => to).impl })).failure, 'timeout');
  assert.equal((await probeOnce(target, { fetchImpl: fakeFetch(() => new Error('getaddrinfo ENOTFOUND')).impl })).failure, 'network');
});

test('texto esperado ausente é falha de conteúdo (200 com página de erro não passa)', async () => {
  const t = { ...target, bodyIncludes: '"status":"ok"' };
  assert.equal((await probeOnce(t, { fetchImpl: fakeFetch(() => ({ status: 200, body: '<html>erro</html>' })).impl })).failure, 'content');
  assert.equal((await probeOnce(t, { fetchImpl: fakeFetch(() => ({ status: 200, body: '{"status":"ok"}' })).impl })).ok, true);
});

test('retentativas rápidas: soluço de um pedido só NÃO vira falha; falha persistente vira', async () => {
  let n = 0;
  const flaky = fakeFetch(() => ({ status: ++n === 1 ? 503 : 200 }));
  const cfg = { quickRetries: 2, quickRetryDelayMs: 1 };
  assert.equal((await probeWithRetries(target, cfg, { fetchImpl: flaky.impl, sleep: noSleep })).ok, true);
  assert.equal(flaky.calls.length, 2);
  const dead = fakeFetch(() => ({ status: 503 }));
  assert.equal((await probeWithRetries(target, cfg, { fetchImpl: dead.impl, sleep: noSleep })).ok, false);
  assert.equal(dead.calls.length, 3);
});

test('mensagem de erro de rede não vaza e-mail, telefone nem token', async () => {
  const r = await probeOnce(target, { fetchImpl: fakeFetch(() => new Error('falha com a@b.com +5511999998888 Bearer abc.def.ghi')).impl });
  assert.ok(!/a@b\.com|99999|abc\.def/.test(r.error ?? ''));
});

test('controle de rede: qualquer resposta HTTP prova a rede; só cai quando todos falham', async () => {
  assert.equal(await networkLooksUp(['https://c1.example.com'], { fetchImpl: fakeFetch(() => ({ status: 500 })).impl }), true);
  assert.equal(await networkLooksUp(['https://c1.example.com', 'https://c2.example.com'], { fetchImpl: fakeFetch(() => new Error('rede')).impl }), false);
  assert.equal(await networkLooksUp(['https://c1.example.com', 'https://c2.example.com'], { fetchImpl: fakeFetch((u) => (u.includes('c2') ? { status: 204 } : new Error('x'))).impl }), true);
  assert.equal(await networkLooksUp([]), true);
});
