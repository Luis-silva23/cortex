jest.mock('@ln-system/database', () => ({ prisma: {}, runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn() }));
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

import { sentCounts, lastDeliveryAt, recordDelivery } from './deliveries';
import { getEffective, resolveEffective } from './settings.service';
import { __resetResendBreaker, breakerState, checkResendDomain, decideSend, resendConfig, sendEmail } from './resend.service';

const FULL = { RESEND_API_KEY: 're_testkey_1234567890', ALERT_EMAIL_FROM: 'CÓRTEX <alertas@exemplo.test>', ALERT_EMAIL_TO: 'ops1@exemplo.test, ops2@exemplo.test', RESEND_DOMAIN_VERIFIED: 'true' } as unknown as NodeJS.ProcessEnv;
const now = new Date('2026-10-19T12:00:00Z');
const counts = (c: Partial<{ hour: number; day: number; month: number }> = {}) => ({ hour: 0, day: 0, month: 0, ...c });
const input = { subject: 's', text: 't', dedupeKey: 'alert:X:central:-:-:CRITICAL' };
const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);

beforeEach(() => {
  jest.clearAllMocks();
  __resetResendBreaker();
  (sentCounts as jest.Mock).mockResolvedValue(counts());
  (lastDeliveryAt as jest.Mock).mockResolvedValue(null);
});

describe('configuração do Resend', () => {
  it('só está configurado com chave, remetente, destinatários E a declaração de domínio verificado', () => {
    expect(resendConfig({}).configured).toBe(false);
    expect(resendConfig({}).missing).toEqual(['RESEND_API_KEY', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO', 'RESEND_DOMAIN_VERIFIED=true']);
    expect(resendConfig({ ...FULL, RESEND_DOMAIN_VERIFIED: 'false' }).missing).toEqual(['RESEND_DOMAIN_VERIFIED=true']);
    const full = resendConfig(FULL);
    expect(full).toMatchObject({ configured: true, domain: 'exemplo.test', to: ['ops1@exemplo.test', 'ops2@exemplo.test'] });
  });
});

describe('decisão de envio (pura)', () => {
  const base = { configured: true, enabled: true, counts: counts(), limits: resolveEffective({}, null).limits, lastSameKeyAt: null, now, breakerOpenUntil: 0 };
  it('envia quando tudo permite', () => expect(decideSend(base)).toEqual({ send: true }));
  it('motivos, na ordem', () => {
    expect(decideSend({ ...base, configured: false })).toEqual({ send: false, reason: 'NOT_CONFIGURED' });
    expect(decideSend({ ...base, enabled: false })).toEqual({ send: false, reason: 'DISABLED' });
    expect(decideSend({ ...base, breakerOpenUntil: now.getTime() + 1 })).toEqual({ send: false, reason: 'BREAKER' });
    expect(decideSend({ ...base, lastSameKeyAt: new Date(now.getTime() - 10 * 60_000) })).toEqual({ send: false, reason: 'DEDUPE' });
    expect(decideSend({ ...base, lastSameKeyAt: new Date(now.getTime() - 61 * 60_000) })).toEqual({ send: true });
    expect(decideSend({ ...base, counts: counts({ hour: 6 }) })).toEqual({ send: false, reason: 'HOUR_CAP' });
    expect(decideSend({ ...base, counts: counts({ day: 30 }) })).toEqual({ send: false, reason: 'DAY_CAP' });
    expect(decideSend({ ...base, counts: counts({ month: 600 }) })).toEqual({ send: false, reason: 'MONTH_CAP' });
  });
});

describe('sendEmail (rede simulada: nenhum e-mail real é enviado)', () => {
  it('sem configuração NÃO chama a rede nem grava nada', async () => {
    const fetchImpl = jest.fn();
    const r = await sendEmail(input, { env: {}, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ status: 'SUPPRESSED', reason: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it('com configuração: chama o provedor com a chave só no cabeçalho, para a lista de operadores, e registra ENVIADO sem o conteúdo', async () => {
    const fetchImpl = jest.fn().mockImplementation(ok);
    const r = await sendEmail({ ...input, alertId: 'a1' }, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ status: 'SENT' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_testkey_1234567890');
    expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f]{48}$/);
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['ops1@exemplo.test', 'ops2@exemplo.test']);
    expect(body.from).toContain('alertas@exemplo.test');
    expect(init.body).not.toContain('re_testkey');
    expect(recordDelivery).toHaveBeenCalledWith({ channel: 'EMAIL', status: 'SENT', dedupeKey: input.dedupeKey, alertId: 'a1' });
  });

  it('desligado em tempo de execução: suprime sem chamar a rede', async () => {
    (getEffective as jest.Mock).mockResolvedValueOnce(resolveEffective(FULL, { toggles: { emailNotifications: false } }));
    const fetchImpl = jest.fn();
    expect(await sendEmail(input, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ status: 'SUPPRESSED', reason: 'DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deduplicação e limite por hora: suprime e deixa UM rastro por motivo e hora (a proteção não vira tempestade de gravações)', async () => {
    const fetchImpl = jest.fn().mockImplementation(ok);
    (lastDeliveryAt as jest.Mock).mockResolvedValue(new Date(now.getTime() - 60_000));
    const key = { ...input, dedupeKey: 'chave-dedupe-unica-1' };
    expect((await sendEmail(key, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch })).reason).toBe('DEDUPE');
    expect((await sendEmail(key, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch })).reason).toBe('DEDUPE');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((recordDelivery as jest.Mock).mock.calls.filter((c) => c[0].status === 'SUPPRESSED')).toHaveLength(1);

    (lastDeliveryAt as jest.Mock).mockResolvedValue(null);
    (sentCounts as jest.Mock).mockResolvedValue(counts({ hour: 6 }));
    expect((await sendEmail({ ...input, dedupeKey: 'outra-chave-2' }, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch })).reason).toBe('HOUR_CAP');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('contagem indisponível (banco fora): NÃO envia — melhor suprimir que estourar o limite sem saber', async () => {
    (sentCounts as jest.Mock).mockRejectedValue(new Error('db down'));
    const fetchImpl = jest.fn();
    expect(await sendEmail({ ...input, dedupeKey: 'k3' }, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ status: 'SUPPRESSED', reason: 'COUNT_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falha do provedor: registra FALHA mascarada, não lança, e 3 falhas seguidas abrem o disjuntor', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ message: 'limite da conta (re_testkey_1234567890) para ops1@exemplo.test' }) } as Response);
    for (let i = 0; i < 3; i++) {
      const r = await sendEmail({ ...input, dedupeKey: `falha-${i}` }, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(r.status).toBe('FAILED');
    }
    const failed = (recordDelivery as jest.Mock).mock.calls.map((c) => c[0]).filter((d) => d.status === 'FAILED');
    expect(failed).toHaveLength(3);
    for (const d of failed) {
      expect(d.error).toContain('http_429');
      expect(d.error).not.toContain('re_testkey');
      expect(d.error).not.toContain('ops1@exemplo.test');
    }
    expect(breakerState().openUntil).toBeGreaterThan(now.getTime());
    const after = await sendEmail({ ...input, dedupeKey: 'depois' }, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(after).toEqual({ status: 'SUPPRESSED', reason: 'BREAKER' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rede que explode (timeout) também não lança', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network timeout'));
    const r = await sendEmail({ ...input, dedupeKey: 'net' }, { env: FULL, now, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.status).toBe('FAILED');
  });
});

describe('verificação do domínio (somente leitura, ação explícita)', () => {
  it('sem chave não chama nada', async () => {
    const fetchImpl = jest.fn();
    const r = await checkResendDomain({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.checked).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('lê GET /domains e informa o estado do domínio do remetente', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ name: 'exemplo.test', status: 'verified' }] }) } as Response);
    const r = await checkResendDomain({ env: FULL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ checked: true, domain: 'exemplo.test', domainStatus: 'verified' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/domains');
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined(); // GET
  });
  it('domínio ausente na conta: diz que não está cadastrado (não declara verificado)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) } as Response);
    const r = await checkResendDomain({ env: FULL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.domainStatus).toBeNull();
    expect(r.message).toMatch(/não está cadastrado/);
  });
});
