import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incidentType, median, newState, runTick } from './engine';
import { counter, result, testConfig } from './testkit';
import type { EngineEvent, MonitorState, ProbeResult } from './types';

const MIN = 60_000;

/** Roda ciclos seguidos; cada item é o resultado por alvo. Devolve estado final e todos os eventos. */
function drive(rounds: ProbeResult[][], cfgExtra: Record<string, unknown> = {}, start?: MonitorState) {
  const cfg = testConfig(cfgExtra);
  const id = counter();
  let state = start ?? newState();
  const events: EngineEvent[] = [];
  rounds.forEach((rs, i) => {
    const t = runTick(state, rs, cfg, 1_000_000 + i * 30_000, id);
    state = t.state;
    events.push(...t.events);
  });
  return { state, events, cfg };
}

const ok = (t: string, ms = 100) => result(t, true, { latencyMs: ms });
const bad = (t: string) => result(t, false);

test('falha isolada NÃO abre incidente; 3 seguidas abrem queda CRÍTICA; recupera com 2 sucessos', () => {
  const a = drive([[bad('site')], [ok('site')], [bad('site')], [bad('site')]]);
  assert.equal(a.events.length, 0);
  const b = drive([[bad('site')], [bad('site')], [bad('site')]]);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].kind, 'OPENED');
  assert.equal(b.events[0].incident.type, 'EXTERNAL_SITE_DOWN');
  assert.equal(b.events[0].incident.severity, 'CRITICAL');
  assert.equal(b.state.targets.site.status, 'DOWN');
  const c = drive([[ok('site')], [ok('site')]], {}, b.state);
  assert.deepEqual(c.events.map((e) => e.kind), ['RECOVERED']);
  assert.ok(c.events[0].incident.endedAt);
  assert.equal(c.state.targets.site.status, 'UP');
});

test('um sucesso no meio da queda não recupera (precisa de 2 seguidos)', () => {
  const down = drive([[bad('site')], [bad('site')], [bad('site')]]);
  const r = drive([[ok('site')], [bad('site')], [ok('site')]], {}, down.state);
  assert.ok(!r.events.some((e) => e.kind === 'RECOVERED'));
  assert.equal(r.state.targets.site.status, 'DOWN');
});

test('resultado inconclusivo (rede do monitor fora) não conta a favor nem contra', () => {
  const inc = (t: string) => result(t, false, { inconclusive: true });
  const r = drive([[inc('site')], [inc('site')], [inc('site')], [inc('site')]]);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.targets.site.failStreak, 0);
});

test('agrupamento: filho cai junto com o pai → um aviso só (o do pai); filho agrupado não gera aviso próprio', () => {
  const both = () => [bad('site'), bad('api')];
  const r = drive([both(), both(), both()]);
  const opened = r.events.filter((e) => e.kind === 'OPENED');
  assert.equal(opened.length, 2);
  const child = opened.find((e) => e.incident.target === 'api')!;
  assert.equal(child.incident.groupedUnder, 'site');
  assert.equal(opened.find((e) => e.incident.target === 'site')!.incident.groupedUnder, null);
});

test('pai volta e o filho continua fora: filho é desagrupado e aparece como novo aviso', () => {
  const down = drive([[bad('site'), bad('api')], [bad('site'), bad('api')], [bad('site'), bad('api')]]);
  const r = drive([[ok('site'), bad('api')], [ok('site'), bad('api')]], {}, down.state);
  const kinds = r.events.map((e) => `${e.kind}:${e.incident.target}:${e.incident.groupedUnder ?? '-'}`);
  assert.ok(kinds.includes('RECOVERED:site:-'), kinds.join(','));
  assert.ok(kinds.includes('OPENED:api:-'), kinds.join(','));
});

test('lentidão: mediana acima do limite por 3 avaliações abre ATENÇÃO; crítico escala; volta ao normal recupera', () => {
  const slow = (ms: number) => [ok('site', ms)];
  const warmup = Array.from({ length: 4 }, () => slow(100));
  const a = drive([...warmup, ...Array.from({ length: 8 }, () => slow(2500))]);
  const opened = a.events.find((e) => e.kind === 'OPENED' && e.incident.kind === 'SLOW');
  assert.ok(opened, 'abriu lentidão');
  assert.equal(opened!.incident.severity, 'ATTENTION');
  const b = drive(Array.from({ length: 10 }, () => slow(5000)), {}, a.state);
  assert.ok(b.events.some((e) => e.kind === 'ESCALATED' && e.incident.severity === 'CRITICAL'));
  const c = drive(Array.from({ length: 12 }, () => slow(100)), {}, b.state);
  assert.ok(c.events.some((e) => e.kind === 'RECOVERED' && e.incident.kind === 'SLOW'));
});

test('um pico isolado de latência não abre lentidão (mediana)', () => {
  const r = drive([[ok('site', 100)], [ok('site', 100)], [ok('site', 100)], [ok('site', 9000)], [ok('site', 100)], [ok('site', 100)], [ok('site', 100)]]);
  assert.equal(r.events.length, 0);
});

test('taxa de erros: falha intermitente (sem 3 seguidas) abre ERRORS e recupera quando melhora', () => {
  // padrão F,F,S repetido: nunca 3 falhas seguidas, mas ~67% de falha
  const pattern = Array.from({ length: 12 }, (_, i) => (i % 3 === 2 ? [ok('site')] : [bad('site')]));
  const a = drive(pattern);
  assert.ok(!a.events.some((e) => e.incident.kind === 'DOWN'));
  assert.ok(a.events.some((e) => e.kind === 'OPENED' && e.incident.kind === 'ERRORS'));
  const b = drive(Array.from({ length: 25 }, () => [ok('site')]), {}, a.state);
  assert.ok(b.events.some((e) => e.kind === 'RECOVERED' && e.incident.kind === 'ERRORS'));
});

test('lembrete a cada reminderMinutes, limitado a maxReminders; incidente agrupado não lembra', () => {
  const cfg = testConfig({ reminderMinutes: 5, maxReminders: 2 });
  const id = counter();
  let state = newState();
  const events: EngineEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const t = runTick(state, [bad('site'), bad('api')], cfg, 1_000_000 + i * MIN, id);
    state = t.state;
    events.push(...t.events);
  }
  const reminders = events.filter((e) => e.kind === 'REMINDER');
  assert.equal(reminders.length, 2);
  assert.ok(reminders.every((e) => e.incident.target === 'site'));
});

test('eventos carregam cópia: alterar o evento não altera o estado do motor', () => {
  const r = drive([[bad('site')], [bad('site')], [bad('site')]]);
  const ev = r.events[0];
  ev.incident.detail = 'ALTERADO';
  assert.notEqual(r.state.targets.site.incidents.DOWN!.detail, 'ALTERADO');
});

test('utilidades: mediana e nome do tipo', () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(incidentType('minha-api', 'DOWN'), 'EXTERNAL_MINHA_API_DOWN');
});
