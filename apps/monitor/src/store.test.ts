import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newState } from './engine';
import { appendHistory, heartbeatAgeSec, historyFile, loadState, saveState, stateFile, writeHeartbeat } from './store';
import { result } from './testkit';

function dir() {
  return mkdtempSync(join(tmpdir(), 'cortex-monitor-'));
}

test('grava e relê o estado; sem arquivo temporário sobrando', () => {
  const d = dir();
  try {
    const s = newState();
    s.lastTickAt = 123;
    saveState(d, s);
    assert.equal(loadState(d).lastTickAt, 123);
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('estado corrompido não derruba: guarda a cópia ruim e começa limpo', () => {
  const d = dir();
  try {
    writeFileSync(stateFile(d), '{ isto não é json', 'utf8');
    const s = loadState(d, 777);
    assert.equal(s.lastTickAt, null);
    assert.ok(existsSync(`${stateFile(d)}.corrupt-777`));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('estado de formato desconhecido também é isolado', () => {
  const d = dir();
  try {
    writeFileSync(stateFile(d), JSON.stringify({ version: 99 }), 'utf8');
    assert.equal(loadState(d, 5).version, 1);
    assert.ok(existsSync(`${stateFile(d)}.corrupt-5`));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('histórico: uma linha por sondagem, sem corpo/URL/erro; gira ao passar do limite', () => {
  const d = dir();
  try {
    appendHistory(d, [result('site', true), result('api', false)], 1000);
    const lines = readFileSync(historyFile(d), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(!lines[1].includes('HTTP 503') && !lines[1].includes('example.com'));
    for (let i = 0; i < 40; i++) appendHistory(d, Array.from({ length: 50 }, () => result('site', true)), 1000);
    assert.ok(existsSync(`${historyFile(d)}.1`));
    assert.ok(readFileSync(historyFile(d), 'utf8').split('\n').filter(Boolean).length <= 1000);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('heartbeat: idade em segundos, nulo quando nunca escreveu', () => {
  const d = dir();
  try {
    assert.equal(heartbeatAgeSec(d), null);
    writeHeartbeat(d, 1_000_000);
    assert.equal(heartbeatAgeSec(d, 1_045_000), 45);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
