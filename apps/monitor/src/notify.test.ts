import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newState, runTick } from './engine';
import { planJobs, processJobs } from './notify';
import { counter, fakeFetch, result, testConfig } from './testkit';
import type { EngineEvent, MonitorState } from './types';

const SECRET_ENV: NodeJS.ProcessEnv = {
  RESEND_API_KEY: 're_SECRETKEY123456789',
  ALERT_EMAIL_FROM: 'alertas@example.com',
  ALERT_EMAIL_TO: 'ops@example.com',
  RESEND_DOMAIN_VERIFIED: 'true',
  TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
  TWILIO_AUTH_TOKEN: 'tok_SECRET_TWILIO',
  ALERT_SMS_FROM: '+15005550006',
  ALERT_SMS_TO: '+5511987654321',
  ALERT_SMS_SENDER_VERIFIED: 'true',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
  TWILIO_WHATSAPP_CONTENT_SID: 'HX' + 'b'.repeat(32),
  ALERT_WHATSAPP_TO: '+5511987654321',
  ALERT_WHATSAPP_PROVIDERS: 'twilio',
  ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true',
};

const cfg = testConfig();
const NOW = 5_000_000;

function openDown(): { state: MonitorState; events: EngineEvent[] } {
  let state = newState();
  const events: EngineEvent[] = [];
  const id = counter();
  for (let i = 0; i < 3; i++) {
    const t = runTick(state, [result('site', false)], cfg, NOW + i * 30_000, id);
    state = t.state;
    events.push(...t.events);
  }
  return { state, events };
}

test('queda CRÍTICA gera uma tarefa por canal; a mensagem não traz segredo, e-mail nem número', () => {
  const { state, events } = openDown();
  const jobs = planJobs(state, events[0], cfg, cfg.targets, NOW, counter());
  assert.deepEqual(jobs.map((j) => j.channel).sort(), ['EMAIL', 'SMS', 'WHATSAPP']);
  for (const j of jobs) assert.ok(!/@|\+55|re_|tok_/.test(j.text + j.subject), j.text);
});

test('ATENÇÃO vai só ao e-mail; incidente agrupado não gera aviso', () => {
  const { state, events } = openDown();
  const attention = { ...events[0], incident: { ...events[0].incident, severity: 'ATTENTION' as const } };
  assert.deepEqual(planJobs(state, attention, cfg, cfg.targets, NOW, counter()).map((j) => j.channel), ['EMAIL']);
  const grouped = { ...events[0], incident: { ...events[0].incident, groupedUnder: 'pai' } };
  assert.deepEqual(planJobs(state, grouped, cfg, cfg.targets, NOW, counter()), []);
});

test('canais independentes: e-mail falha e SMS/WhatsApp seguem; falha repetível reprograma, com espera', async () => {
  const { state, events } = openDown();
  state.pending.push(...planJobs(state, events[0], cfg, cfg.targets, NOW, counter()));
  const f = fakeFetch((url) => (url.includes('resend') ? { status: 503 } : { status: 201, body: JSON.stringify({ sid: 'SM1' }) }));
  const log = await processJobs(state, cfg, SECRET_ENV, NOW, { fetchImpl: f.impl });
  const by = Object.fromEntries(log.map((l) => [l.channel, l.outcome]));
  assert.equal(by.EMAIL, 'RETRY');
  assert.equal(by.SMS, 'SENT');
  assert.equal(by.WHATSAPP, 'SENT');
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].channel, 'EMAIL');
  assert.equal(state.pending[0].attempts, 1);
  assert.ok(state.pending[0].nextTryAt >= NOW + 60_000);
  assert.deepEqual([...state.targets.site.incidents.DOWN!.notifiedChannels].sort(), ['SMS', 'WHATSAPP']);
  // antes do prazo, nada é reenviado (sem duplicar)
  const again = await processJobs(state, cfg, SECRET_ENV, NOW + 1000, { fetchImpl: f.impl });
  assert.equal(again.length, 0);
});

test('desiste depois de maxAttempts e registra FALHOU; log sem segredo', async () => {
  const c = testConfig({ notify: { maxAttempts: 2, retryDelaysSec: [5] } });
  const { state, events } = openDown();
  state.pending.push(...planJobs(state, events[0], c, c.targets, NOW, counter()).filter((j) => j.channel === 'EMAIL'));
  const f = fakeFetch(() => ({ status: 503 }));
  const all = [...(await processJobs(state, c, SECRET_ENV, NOW, { fetchImpl: f.impl })), ...(await processJobs(state, c, SECRET_ENV, NOW + 10_000, { fetchImpl: f.impl }))];
  assert.deepEqual(all.map((l) => l.outcome), ['RETRY', 'FAILED']);
  assert.equal(state.pending.length, 0);
  assert.ok(!/re_SECRET|tok_SECRET|ops@example|987654321/.test(JSON.stringify(all)));
});

test('canal sem configuração é descartado como NÃO ENVIADO (não finge que avisou)', async () => {
  const { state, events } = openDown();
  state.pending.push(...planJobs(state, events[0], cfg, cfg.targets, NOW, counter()));
  const f = fakeFetch(() => ({ status: 200 }));
  const log = await processJobs(state, cfg, {}, NOW, { fetchImpl: f.impl });
  assert.ok(log.every((l) => l.outcome === 'SKIPPED'));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(state.targets.site.incidents.DOWN!.notifiedChannels, []);
});

test('teto por hora: excedido, a tarefa ESPERA sem gastar tentativa', async () => {
  const c = testConfig({ notify: { maxPerHourPerChannel: 1 } });
  const { state, events } = openDown();
  state.sent.EMAIL = [NOW - 1000];
  state.pending.push(...planJobs(state, events[0], c, c.targets, NOW, counter()).filter((j) => j.channel === 'EMAIL'));
  const f = fakeFetch(() => ({ status: 200, body: '{"id":"1"}' }));
  const log = await processJobs(state, c, SECRET_ENV, NOW, { fetchImpl: f.impl });
  assert.equal(log[0].outcome, 'WAITING');
  assert.equal(f.calls.length, 0);
  assert.equal(state.pending[0].attempts, 0);
});

test('recuperação só vai ao canal que avisou da queda e cancela avisos de queda ainda pendentes', async () => {
  const { state, events } = openDown();
  const jobs = planJobs(state, events[0], cfg, cfg.targets, NOW, counter());
  state.pending.push(...jobs);
  // só o SMS é entregue antes da recuperação; os demais ficam pendentes
  const smsJob = state.pending.find((j) => j.channel === 'SMS')!;
  const only = { ...state, pending: [smsJob] };
  await processJobs(only, cfg, SECRET_ENV, NOW, { fetchImpl: fakeFetch(() => ({ status: 201, body: JSON.stringify({ sid: 'SM1' }) })).impl });
  state.targets = only.targets;
  state.pending = jobs.filter((j) => j.channel !== 'SMS'); // EMAIL e WHATSAPP ainda esperando
  const t1 = runTick(state, [result('site', true)], cfg, NOW + 60_000, counter());
  const t2 = runTick(t1.state, [result('site', true)], cfg, NOW + 90_000, counter());
  const ev = t2.events.find((e) => e.kind === 'RECOVERED')!;
  assert.deepEqual(ev.incident.notifiedChannels, ['SMS']);
  const rec = planJobs(t2.state, ev, cfg, cfg.targets, NOW + 90_000, counter());
  assert.deepEqual(rec.map((j) => j.channel), ['SMS']);
  assert.equal(rec[0].phase, 'RECOVERED');
  assert.match(rec[0].text, /Duração/);
  assert.equal(t2.state.pending.filter((j) => j.phase === 'OPEN').length, 0);
});

test('mesma fase do mesmo incidente não duplica tarefa pendente', () => {
  const { state, events } = openDown();
  state.pending.push(...planJobs(state, events[0], cfg, cfg.targets, NOW, counter()));
  assert.equal(planJobs(state, events[0], cfg, cfg.targets, NOW, counter()).length, 0);
});
