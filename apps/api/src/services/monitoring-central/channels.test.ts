jest.mock('@ln-system/database', () => ({
  prisma: { company: { findUnique: jest.fn().mockResolvedValue({ name: 'Loja Teste' }) }, externalDelivery: { count: jest.fn() } },
  runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
jest.mock('./alert-events', () => ({ recordAlertEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./deliveries', () => ({
  ...jest.requireActual('./deliveries'),
  sentCounts: jest.fn(),
  lastDeliveryAt: jest.fn(),
  recordDelivery: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./settings.service', () => {
  const actual = jest.requireActual('./settings.service');
  return { ...actual, getEffective: jest.fn(async (env: NodeJS.ProcessEnv) => actual.resolveEffective(env, null)) };
});
jest.mock('./resend.service', () => ({ ...jest.requireActual('./resend.service'), sendEmail: jest.fn() }));

import { prisma } from '@ln-system/database';
import { recordAlertEvent } from './alert-events';
import { lastDeliveryAt, recordDelivery, sentCounts } from './deliveries';
import { getEffective, resolveEffective } from './settings.service';
import { sendEmail } from './resend.service';
import { sendSms, smsBreaker } from './sms.service';
import { sendWhatsapp, whatsappBreaker } from './whatsapp.service';
import { decideChannelSend, createBreaker } from './channel-core';
import { channelsStatus, notifyAlert, recoveryDedupeKey, type NotifiableAlert } from './notifier';

// Tudo fictício; nenhuma rede real (fetch simulado em cada teste).
const SMS = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'token-de-teste-123',
  ALERT_SMS_FROM: '+15005550006',
  ALERT_SMS_TO: '11999998888,21988887777',
  ALERT_SMS_SENDER_VERIFIED: 'true',
};
const WA = {
  META_WHATSAPP_TOKEN: 'EAAtoken-de-teste-1234567890',
  META_WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  ALERT_WHATSAPP_TEMPLATE_NAME: 'alerta_cortex',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'token-de-teste-123',
  TWILIO_WHATSAPP_FROM: '+15005550006',
  TWILIO_WHATSAPP_CONTENT_SID: 'HX00000000000000000000000000000000',
  ALERT_WHATSAPP_TO: '11999998888',
  ALERT_WHATSAPP_TEMPLATE_APPROVED: 'true',
};
const EMAIL = { RESEND_API_KEY: 're_k_123456789', ALERT_EMAIL_FROM: 'a@exemplo.test', ALERT_EMAIL_TO: 'o@exemplo.test', RESEND_DOMAIN_VERIFIED: 'true', SUPER_ADMIN_URL: 'https://super.exemplo.test' };
const ALL = { ...EMAIL, ...SMS, ...WA } as unknown as NodeJS.ProcessEnv;
const now = new Date('2026-10-22T15:00:00Z');
const counts = (c: Partial<{ hour: number; day: number; month: number }> = {}) => ({ hour: 0, day: 0, month: 0, ...c });
const noSleep = async () => {};
const res = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
const alert = (over: Partial<NotifiableAlert> = {}): NotifiableAlert => ({ id: 'a1', type: 'EXTERNAL_API_DOWN', severity: 'CRITICAL', companyId: null, branchId: null, deviceId: null, detail: '3 falhas seguidas', value: null, threshold: null, startedAt: new Date('2026-10-22T14:40:00Z'), endedAt: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  smsBreaker.reset();
  whatsappBreaker.reset();
  (sentCounts as jest.Mock).mockResolvedValue(counts());
  (lastDeliveryAt as jest.Mock).mockResolvedValue(null);
  (getEffective as jest.Mock).mockImplementation(async (env: NodeJS.ProcessEnv) => resolveEffective(env, null));
  (sendEmail as jest.Mock).mockResolvedValue({ status: 'SENT' });
  (prisma as any).externalDelivery.count.mockResolvedValue(0);
});

describe('núcleo dos canais (decisão pura e disjuntor)', () => {
  const base = { configured: true, enabled: true, counts: counts(), limits: { maxPerHour: 3, maxPerDay: 10, maxPerMonth: 100, dedupeMinutes: 120 }, lastSameKeyAt: null, now, breakerOpenUntil: 0 };
  it('envia quando tudo permite e considera o número de destinatários no limite', () => {
    expect(decideChannelSend(base)).toEqual({ send: true });
    expect(decideChannelSend({ ...base, counts: counts({ hour: 2 }), needed: 2 })).toEqual({ send: false, reason: 'HOUR_CAP' });
    expect(decideChannelSend({ ...base, counts: counts({ hour: 1 }), needed: 2 })).toEqual({ send: true });
  });
  it('motivos na ordem: não configurado, desligado, disjuntor, repetição, hora, dia, mês', () => {
    expect(decideChannelSend({ ...base, configured: false })).toEqual({ send: false, reason: 'NOT_CONFIGURED' });
    expect(decideChannelSend({ ...base, enabled: false })).toEqual({ send: false, reason: 'DISABLED' });
    expect(decideChannelSend({ ...base, breakerOpenUntil: now.getTime() + 1 })).toEqual({ send: false, reason: 'BREAKER' });
    expect(decideChannelSend({ ...base, lastSameKeyAt: new Date(now.getTime() - 60 * 60_000) })).toEqual({ send: false, reason: 'DEDUPE' });
    expect(decideChannelSend({ ...base, counts: counts({ day: 10 }) })).toEqual({ send: false, reason: 'DAY_CAP' });
    expect(decideChannelSend({ ...base, counts: counts({ month: 100 }) })).toEqual({ send: false, reason: 'MONTH_CAP' });
  });
  it('disjuntor abre depois de N falhas seguidas e fecha com um sucesso', () => {
    const b = createBreaker(2, 1000);
    b.fail(100);
    expect(b.openUntil()).toBe(0);
    b.fail(200);
    expect(b.openUntil()).toBe(1200);
    b.ok();
    expect(b.state().failures).toBe(0);
  });
});

describe('SMS', () => {
  it('sem configuração: não chama a rede nem grava nada', async () => {
    const fetchImpl = jest.fn();
    const r = await sendSms({ text: 'x', dedupeKey: 'k' }, { env: {} as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ status: 'SUPPRESSED', reason: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it('envia para CADA destinatário e registra uma entrega ENVIADA por número, sem o texto nem o número', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(201, { sid: 'SM1' }));
    const r = await sendSms({ text: 'Falha crítica', dedupeKey: 'alert:X', alertId: 'a1' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(r).toMatchObject({ status: 'SENT', accepted: 2, failed: 0, provider: 'twilio' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const rows = (recordDelivery as jest.Mock).mock.calls.map((c) => c[0]);
    expect(rows).toEqual([
      { channel: 'SMS', status: 'SENT', dedupeKey: 'alert:X', alertId: 'a1' },
      { channel: 'SMS', status: 'SENT', dedupeKey: 'alert:X', alertId: 'a1' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/99999|88887777|Falha/);
  });

  it('repetição na janela e limite por hora: suprime sem chamar a rede (um rastro por motivo e hora)', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(201, { sid: 'SM1' }));
    (lastDeliveryAt as jest.Mock).mockResolvedValue(new Date(now.getTime() - 10 * 60_000));
    const a = await sendSms({ text: 'x', dedupeKey: 'chave-dedupe-sms-1' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    const b = await sendSms({ text: 'x', dedupeKey: 'chave-dedupe-sms-1' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect([a.reason, b.reason]).toEqual(['DEDUPE', 'DEDUPE']);
    expect((recordDelivery as jest.Mock).mock.calls.filter((c) => c[0].status === 'SUPPRESSED')).toHaveLength(1);
    (lastDeliveryAt as jest.Mock).mockResolvedValue(null);
    (sentCounts as jest.Mock).mockResolvedValue(counts({ hour: 2 })); // 2 destinatários + 2 já enviados > 3 por hora
    expect((await sendSms({ text: 'x', dedupeKey: 'chave-2' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch })).reason).toBe('HOUR_CAP');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('desligado em tempo de execução (Super Admin): não envia', async () => {
    (getEffective as jest.Mock).mockResolvedValueOnce(resolveEffective(SMS as unknown as NodeJS.ProcessEnv, { toggles: { smsNotifications: false } }));
    const fetchImpl = jest.fn();
    expect(await sendSms({ text: 'x', dedupeKey: 'k' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ status: 'SUPPRESSED', reason: 'DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falha do provedor: tenta de novo (429), registra FALHA mascarada, não lança; 3 falhas abrem o disjuntor', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => res(429, { code: 20429, message: 'Too many requests para +5511999998888', status: 429 }));
    for (let i = 0; i < 3; i++) {
      const r = await sendSms({ text: 'x', dedupeKey: `falha-${i}` }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
      expect(r.status).toBe('FAILED');
    }
    const failed = (recordDelivery as jest.Mock).mock.calls.map((c) => c[0]).filter((d) => d.status === 'FAILED');
    expect(failed.length).toBe(6); // 3 envios × 2 destinatários
    for (const d of failed) expect(d.error).not.toMatch(/99999|88887777/);
    expect(smsBreaker.openUntil()).toBeGreaterThan(now.getTime());
    const calls = fetchImpl.mock.calls.length;
    expect(await sendSms({ text: 'x', dedupeKey: 'depois' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep })).toMatchObject({ status: 'SUPPRESSED', reason: 'BREAKER' });
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('contagem indisponível (banco fora): NÃO envia', async () => {
    (sentCounts as jest.Mock).mockRejectedValue(new Error('db down'));
    const fetchImpl = jest.fn();
    expect(await sendSms({ text: 'x', dedupeKey: 'k9' }, { env: SMS as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ status: 'SUPPRESSED', reason: 'COUNT_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('WhatsApp com provedor alternativo', () => {
  it('o primeiro provedor (Meta) falha sem repetição possível: o segundo (Twilio) entrega e fica registrado como alternativo', async () => {
    const fetchImpl = jest.fn().mockImplementation((url: string) => (url.includes('graph.facebook.com') ? res(400, { error: { message: 'Template inexistente', code: 132001 } }) : res(201, { sid: 'SMwa' })));
    const r = await sendWhatsapp({ text: 'x', dedupeKey: 'wa1', alertId: 'a1' }, { env: WA as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(r).toMatchObject({ status: 'SENT', provider: 'twilio-whatsapp', usedFallback: true, accepted: 1 });
    expect(fetchImpl.mock.calls.map((c) => String(c[0]).split('/')[2])).toEqual(['graph.facebook.com', 'api.twilio.com']);
  });
  it('sem declaração do modelo aprovado: não envia', async () => {
    const fetchImpl = jest.fn();
    const r = await sendWhatsapp({ text: 'x', dedupeKey: 'wa2' }, { env: { ...WA, ALERT_WHATSAPP_TEMPLATE_APPROVED: '' } as unknown as NodeJS.ProcessEnv, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ status: 'SUPPRESSED', reason: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('queda crítica: os três canais são independentes', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const wire = (impl: (url: string) => Promise<Response>) => {
    const f = jest.fn().mockImplementation(impl);
    global.fetch = f as unknown as typeof fetch;
    return f;
  };

  it('tenta e-mail, SMS e WhatsApp e registra cada um no histórico do alerta', async () => {
    const f = wire(() => res(201, { sid: 'SM1', messages: [{ id: 'w1' }] }));
    await notifyAlert(alert(), 'OPENED', ALL);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const hosts = f.mock.calls.map((c) => String(c[0]).split('/')[2]);
    expect(hosts.filter((h) => h === 'api.twilio.com')).toHaveLength(2); // SMS para 2 números (o WhatsApp usa a Meta primeiro)
    expect(hosts).toContain('graph.facebook.com');
    const notes = (recordAlertEvent as jest.Mock).mock.calls.map((c) => c[0].note);
    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining('e-mail'), expect.stringContaining('SMS'), expect.stringContaining('WhatsApp')]));
  });

  it('e-mail com o provedor fora (exceção): SMS e WhatsApp são entregues do mesmo jeito', async () => {
    (sendEmail as jest.Mock).mockRejectedValue(new Error('resend fora do ar'));
    const f = wire(() => res(201, { sid: 'SM1', messages: [{ id: 'w1' }] }));
    await expect(notifyAlert(alert(), 'OPENED', ALL)).resolves.toBeUndefined();
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((recordDelivery as jest.Mock).mock.calls.map((c) => c[0].channel)).toEqual(expect.arrayContaining(['SMS', 'WHATSAPP']));
  });

  it('SMS com a operadora/provedor fora: e-mail e WhatsApp seguem; a falha do SMS fica registrada', async () => {
    const f = wire((url) => (url.includes('Messages.json') && !url.includes('whatsapp') ? Promise.reject(new Error('timeout')) : res(200, { messages: [{ id: 'w1' }], sid: 'SMwa' })));
    // o WhatsApp usa a Meta (graph) primeiro, então só o SMS (Twilio) cai
    await notifyAlert(alert(), 'OPENED', { ...ALL, ALERT_WHATSAPP_PROVIDERS: 'meta' } as unknown as NodeJS.ProcessEnv);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const rows = (recordDelivery as jest.Mock).mock.calls.map((c) => c[0]);
    expect(rows.some((d) => d.channel === 'SMS' && d.status === 'FAILED')).toBe(true);
    expect(rows.some((d) => d.channel === 'WHATSAPP' && d.status === 'SENT')).toBe(true);
    expect(f).toHaveBeenCalled();
  });

  it('abaixo da gravidade mínima do canal (padrão CRITICAL) SMS e WhatsApp não são usados; ATTENTION por escolha', async () => {
    const f = wire(() => res(201, { sid: 'SM1', messages: [{ id: 'w1' }] }));
    await notifyAlert(alert({ severity: 'ATTENTION' }), 'OPENED', ALL);
    expect(f).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    await notifyAlert(alert({ severity: 'ATTENTION' }), 'OPENED', { ...ALL, ALERT_SMS_MIN_SEVERITY: 'attention' } as unknown as NodeJS.ProcessEnv);
    expect(f.mock.calls.every((c) => String(c[0]).includes('api.twilio.com'))).toBe(true);
    expect(f.mock.calls.length).toBe(2);
  });

  it('nenhum canal configurado: não consulta banco nem rede', async () => {
    const f = wire(() => res(200, {}));
    await notifyAlert(alert(), 'OPENED', {} as NodeJS.ProcessEnv);
    expect(f).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordAlertEvent).not.toHaveBeenCalled();
  });
});

describe('recuperação', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const ended = new Date('2026-10-22T14:47:00Z');

  it('só avisa os canais que haviam avisado o alerta, com a duração e uma chave própria', async () => {
    const f = jest.fn().mockImplementation(() => res(201, { sid: 'SM1', messages: [{ id: 'w1' }] }));
    global.fetch = f as unknown as typeof fetch;
    (prisma as any).externalDelivery.count.mockImplementation(async ({ where }: any) => (where.channel === 'SMS' || where.channel === 'EMAIL' ? 1 : 0));
    await notifyAlert(alert({ endedAt: ended }), 'RECOVERED', ALL);
    expect((sendEmail as jest.Mock).mock.calls[0][0].text).toContain('RECUPERADO');
    expect((sendEmail as jest.Mock).mock.calls[0][0].text).toContain('Duração: 7 min');
    expect((sendEmail as jest.Mock).mock.calls[0][0].dedupeKey).toBe(recoveryDedupeKey(alert({ endedAt: ended })));
    // SMS avisou antes: a recuperação vai por SMS; o WhatsApp NUNCA avisou: nada de recuperação "solta"
    expect(f.mock.calls.every((c) => String(c[0]).includes('api.twilio.com'))).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('nenhum canal avisou antes: nenhuma mensagem de recuperação', async () => {
    const f = jest.fn().mockImplementation(() => res(201, {}));
    global.fetch = f as unknown as typeof fetch;
    await notifyAlert(alert({ endedAt: ended }), 'RECOVERED', ALL);
    expect(f).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('estado dos canais para a tela', () => {
  it('mostra o que falta, a quantidade de destinatários e a gravidade mínima — nunca o número, a chave ou o e-mail', () => {
    const s = channelsStatus({} as NodeJS.ProcessEnv);
    expect(s.SMS.configured).toBe(false);
    expect(s.SMS.missing).toContain('ALERT_SMS_SENDER_VERIFIED=true');
    expect(s.EMAIL.missing).toContain('RESEND_API_KEY');
    const full = channelsStatus({ ...ALL, ALERT_WHATSAPP_MIN_SEVERITY: 'attention' } as unknown as NodeJS.ProcessEnv);
    expect(full.SMS).toMatchObject({ configured: true, recipients: 2, minSeverity: 'CRITICAL' });
    expect(full.WHATSAPP).toMatchObject({ configured: true, recipients: 1, minSeverity: 'ATTENTION', providers: ['meta', 'twilio'] });
    expect(JSON.stringify(full)).not.toMatch(/99999|88887777|token-de-teste|re_k_|o@exemplo/);
  });
});
