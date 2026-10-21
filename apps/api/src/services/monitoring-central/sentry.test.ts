jest.mock('@ln-system/database', () => ({ prisma: {}, runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn() }));
jest.mock('./deliveries', () => ({
  ...jest.requireActual('./deliveries'),
  sentCounts: jest.fn(),
  recordDelivery: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./settings.service', () => {
  const actual = jest.requireActual('./settings.service');
  return { ...actual, getEffective: jest.fn(async (env: NodeJS.ProcessEnv) => actual.resolveEffective(env, null)) };
});

import { recordDelivery, sentCounts } from './deliveries';
import { getEffective, resolveEffective } from './settings.service';
import { __resetSentryState, buildEnvelope, buildEvent, captureException, decideCapture, fingerprint, parseDsn, routeTemplate, scrubStack, scrubText, sentryConfigStatus, sentryRuntime } from './sentry.service';

const DSN = 'https://abc123key@o99.ingest.exemplo.test/4501';
const ENV = { SENTRY_DSN: DSN, SENTRY_SAMPLE_RATE: '1', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv;
const ok = () => Promise.resolve({ ok: true, status: 200 } as Response);

// a impressão digital inclui o primeiro quadro da pilha: o MESMO defeito nasce sempre na mesma linha (aqui, a mesma função)
const make = (message: string) => new Error(message);

beforeEach(() => {
  jest.clearAllMocks();
  __resetSentryState();
  (sentCounts as jest.Mock).mockResolvedValue({ hour: 0, day: 0, month: 0 });
});

describe('DSN', () => {
  it('aceita só https com chave e projeto numérico', () => {
    expect(parseDsn(DSN)).toEqual({ key: 'abc123key', host: 'o99.ingest.exemplo.test', projectId: '4501', endpoint: 'https://o99.ingest.exemplo.test/api/4501/envelope/' });
    expect(parseDsn('http://k@h.test/1')).toBeNull();
    expect(parseDsn('https://h.test/1')).toBeNull();
    expect(parseDsn('https://k@h.test/projeto')).toBeNull();
    expect(parseDsn('')).toBeNull();
    expect(parseDsn(undefined)).toBeNull();
  });
  it('estado de configuração nunca devolve a chave', () => {
    const s = sentryConfigStatus(ENV);
    expect(s).toMatchObject({ configured: true, host: 'o99.ingest.exemplo.test' });
    expect(JSON.stringify(s)).not.toContain('abc123key');
    expect(sentryConfigStatus({ SENTRY_DSN: 'lixo' } as NodeJS.ProcessEnv)).toMatchObject({ configured: false, invalidDsn: true });
  });
});

describe('mascaramento antes de sair da máquina', () => {
  it('tira e-mail, CPF/CNPJ, token, URL com senha, chave de provedor, hash longo e caminho local — sem estragar URL comum', () => {
    const raw =
      'falha para maria@loja.com cpf 123.456.789-09 cnpj 12.345.678/0001-95 Bearer abc.def.ghi jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.assinaturaxx ' +
      'conexão postgresql://app:Segredo123@db.interno:5432/x chave re_AbCdEf123456 hash 0123456789abcdef0123456789abcdef01 em C:\\Users\\luis.silva\\Desktop\\proj\\src\\a.ts e /home/ana/app/b.ts ' +
      'site https://exemplo.test/pagina';
    const s = scrubText(raw, 2000);
    for (const leak of ['maria@loja.com', '123.456.789-09', '12.345.678/0001-95', 'abc.def.ghi', 'eyJhbGciOiJIUzI1NiJ9', 'Segredo123', 're_AbCdEf123456', '0123456789abcdef0123456789abcdef01', 'luis.silva', '/home/ana']) {
      expect(s).not.toContain(leak);
    }
    expect(s).toContain('https://exemplo.test/pagina');
  });

  it('pilha sem caminho de máquina e rota como modelo (sem id real nem query)', () => {
    const err = new Error('x');
    err.stack = 'Error: x\n    at fn (C:\\Users\\luis.silva\\Desktop\\Minha bagunça\\proj\\apps\\api\\src\\a.ts:10:5)\n    at /home/ana/app/b.ts:2:1';
    const frames = scrubStack(err.stack).join('\n');
    expect(frames).not.toContain('luis.silva');
    expect(frames).not.toContain('/home/ana');
    expect(routeTemplate('/api/users/0f8fad5b-d9cb-469f-a165-70867728950e?token=segredo')).toBe('/api/users/:id');
  });

  it('o evento enviado não leva usuário, empresa, cabeçalhos nem corpo: só rota, método, status e requestId', () => {
    const err = new Error('erro com joao@x.com');
    const ev = buildEvent(err, { route: '/api/sales/0f8fad5b-d9cb-469f-a165-70867728950e', method: 'POST', statusCode: 500, requestId: 'req-1' }, ENV);
    const json = JSON.stringify(ev);
    expect(json).not.toContain('joao@x.com');
    expect(ev.tags).toEqual({ route: '/api/sales/:id', method: 'POST', status: '500', request_id: 'req-1' });
    expect(Object.keys(ev)).not.toEqual(expect.arrayContaining(['user', 'request', 'contexts']));
    const envelope = buildEnvelope(ev, DSN);
    expect(envelope.split('\n')).toHaveLength(3);
    expect(JSON.parse(envelope.split('\n')[1])).toEqual({ type: 'event' });
  });

  it('mesma causa, mesma impressão digital (mesmo com id diferente na mensagem de e-mail)', () => {
    expect(fingerprint(make('falha com a@b.com'))).toBe(fingerprint(make('falha com c@d.com')));
    expect(fingerprint(make('outra coisa'))).not.toBe(fingerprint(make('falha com a@b.com')));
  });
});

describe('decisão de captura (pura)', () => {
  const base = { configured: true, enabled: true, sampleRate: 1, random: 0.5, lastSameAt: null, now: 1_000_000, dedupeMinutes: 5, counts: { hour: 0, day: 0 }, maxPerHour: 30, maxPerDay: 200, breakerOpenUntil: 0 };
  it('motivos para descartar, na ordem', () => {
    expect(decideCapture(base)).toEqual({ send: true });
    expect(decideCapture({ ...base, configured: false })).toEqual({ send: false, reason: 'NOT_CONFIGURED' });
    expect(decideCapture({ ...base, enabled: false })).toEqual({ send: false, reason: 'DISABLED' });
    expect(decideCapture({ ...base, breakerOpenUntil: 2_000_000 })).toEqual({ send: false, reason: 'BREAKER' });
    expect(decideCapture({ ...base, lastSameAt: 1_000_000 - 60_000 })).toEqual({ send: false, reason: 'DEDUPE' });
    expect(decideCapture({ ...base, sampleRate: 0.25, random: 0.9 })).toEqual({ send: false, reason: 'SAMPLED_OUT' });
    expect(decideCapture({ ...base, counts: { hour: 30, day: 0 } })).toEqual({ send: false, reason: 'HOUR_CAP' });
    expect(decideCapture({ ...base, counts: { hour: 0, day: 200 } })).toEqual({ send: false, reason: 'DAY_CAP' });
  });
});

describe('captureException', () => {
  it('sem DSN: não faz nada (nem consulta limites)', async () => {
    const fetchImpl = jest.fn();
    expect(await captureException(new Error('x'), {}, { env: {}, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ sent: false, reason: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sentCounts).not.toHaveBeenCalled();
  });

  it('com DSN: envia o envelope ao endpoint do projeto com a chave no cabeçalho e registra ENVIADO', async () => {
    const fetchImpl = jest.fn().mockImplementation(ok);
    const r = await captureException(new Error('quebrou'), { route: '/api/x', method: 'GET', statusCode: 500, requestId: 'r1' }, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: 1_700_000_000_000, random: () => 0 });
    expect(r).toEqual({ sent: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://o99.ingest.exemplo.test/api/4501/envelope/');
    expect(init.headers['X-Sentry-Auth']).toContain('sentry_key=abc123key');
    expect(init.headers['Content-Type']).toBe('application/x-sentry-envelope');
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ channel: 'SENTRY', status: 'SENT' }));
  });

  it('deduplica o mesmo erro dentro da janela e conta o descarte', async () => {
    const fetchImpl = jest.fn().mockImplementation(ok);
    const deps = { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: 1_700_000_000_000, random: () => 0 };
    expect((await captureException(make('repetido'), {}, deps)).sent).toBe(true);
    expect(await captureException(make('repetido'), {}, { ...deps, now: deps.now + 60_000 })).toEqual({ sent: false, reason: 'DEDUPE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentryRuntime().dropped.DEDUPE).toBe(1);
  });

  it('amostragem descarta sem rede; teto por hora também', async () => {
    const fetchImpl = jest.fn().mockImplementation(ok);
    expect((await captureException(new Error('a1'), {}, { env: { ...ENV, SENTRY_SAMPLE_RATE: '0.1' }, fetchImpl: fetchImpl as unknown as typeof fetch, random: () => 0.9 })).reason).toBe('SAMPLED_OUT');
    (sentCounts as jest.Mock).mockResolvedValue({ hour: 30, day: 30, month: 30 });
    expect((await captureException(new Error('a2'), {}, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, random: () => 0 })).reason).toBe('HOUR_CAP');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('desligado em tempo de execução: descarta', async () => {
    (getEffective as jest.Mock).mockResolvedValueOnce(resolveEffective(ENV, { toggles: { sentry: false } }));
    const fetchImpl = jest.fn();
    expect((await captureException(new Error('z'), {}, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch })).reason).toBe('DISABLED');
  });

  it('indisponibilidade do Sentry NUNCA lança e 5 falhas seguidas abrem o disjuntor', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET com maria@x.com'));
    for (let i = 0; i < 5; i++) {
      const r = await captureException(new Error(`erro distinto ${i}`), {}, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: 1_700_000_000_000 + i, random: () => 0 });
      expect(r.sent).toBe(false);
    }
    const failed = (recordDelivery as jest.Mock).mock.calls.map((c) => c[0]).filter((d) => d.status === 'FAILED');
    expect(failed).toHaveLength(5);
    expect(failed[0].error).not.toContain('maria@x.com');
    expect(await captureException(new Error('depois do disjuntor'), {}, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: 1_700_000_000_100, random: () => 0 })).toEqual({ sent: false, reason: 'BREAKER' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('erro inesperado dentro da própria captura é engolido', async () => {
    (getEffective as jest.Mock).mockRejectedValueOnce(new Error('settings quebrou'));
    const r = await captureException(new Error('x'), {}, { env: ENV });
    expect(r.sent).toBe(false);
  });
});
