jest.mock('@ln-system/database', () => ({
  prisma: {
    serviceHealthSample: { groupBy: jest.fn(), createMany: jest.fn(), findFirst: jest.fn() },
    monitoringAlert: { findFirst: jest.fn() },
  },
  runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn(),
  runInTransaction: jest.fn(),
}));
jest.mock('../monitoring.service', () => ({ __esModule: true, default: { applyAlert: jest.fn().mockResolvedValue('opened') } }));

import { prisma } from '@ln-system/database';
import monitoringService from '../monitoring.service';
import { alertCategory, alertGuidance } from './model';
import { externalMonitorState, ingest, ingestSchema, ingestSecret, serviceOf, type IngestPayload } from './external-monitor.service';

const sample = prisma.serviceHealthSample as unknown as Record<'groupBy' | 'createMany' | 'findFirst', jest.Mock>;
const alert = prisma.monitoringAlert as unknown as { findFirst: jest.Mock };
const apply = monitoringService.applyAlert as unknown as jest.Mock;

const NOW = new Date('2026-10-22T15:00:00Z');
const T = NOW.getTime();

function payload(over: Partial<IngestPayload> = {}): IngestPayload {
  return { monitorId: 'monitor-a', location: 'Região B', sentAt: T, targets: [{ id: 'api', name: 'API', status: 'UP' }], results: [], incidents: [], ...over };
}
const res = (at: number, ok = true) => ({ target: 'api', at, ok, httpStatus: ok ? 200 : 503, latencyMs: 120, failure: ok ? null : ('http' as const) });
const incident = (over: Record<string, unknown> = {}) => ({
  id: 'inc-12345678', target: 'api', kind: 'DOWN' as const, type: 'EXTERNAL_API_DOWN', severity: 'CRITICAL' as const, startedAt: T - 60_000, endedAt: null as number | null,
  detail: '3 verificações seguidas sem sucesso', cause: 'resposta HTTP 503', groupedUnder: null, notifiedChannels: [] as Array<'EMAIL'>, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  sample.groupBy.mockResolvedValue([]);
  sample.createMany.mockResolvedValue({ count: 0 });
  alert.findFirst.mockResolvedValue(null);
  apply.mockResolvedValue('opened');
});

describe('segredo de ingestão', () => {
  it('só vale com 32+ caracteres; sem ele a entrada fica desligada', () => {
    expect(ingestSecret({})).toBeNull();
    expect(ingestSecret({ MONITOR_INGEST_SECRET: 'curto' } as never)).toBeNull();
    expect(ingestSecret({ MONITOR_INGEST_SECRET: 'x'.repeat(32) } as never)).toBe('x'.repeat(32));
  });
});

describe('validação do corpo', () => {
  it('aceita o formato que o monitor envia', () => {
    expect(ingestSchema.safeParse(payload({ results: [res(T)], incidents: [incident()] })).success).toBe(true);
  });
  it.each([
    ['alvo com caractere perigoso', { results: [{ ...res(T), target: "a'; DROP TABLE x;--" }] }],
    ['tipo de alerta fora do padrão', { incidents: [incident({ type: 'DATABASE_DOWN' })] }],
    ['lote grande demais', { results: Array.from({ length: 201 }, (_, i) => res(T - i)) }],
    ['latência absurda', { results: [{ ...res(T), latencyMs: 9_999_999 }] }],
    ['status HTTP inválido', { results: [{ ...res(T), httpStatus: 42 }] }],
    ['monitorId inválido', { monitorId: '../etc' }],
  ])('recusa %s', (_n, over) => {
    expect(ingestSchema.safeParse(payload(over as Partial<IngestPayload>)).success).toBe(false);
  });
});

describe('resultados → amostras EXT_<ALVO>', () => {
  it('grava só os novos, em ordem, com status por resultado', async () => {
    sample.groupBy.mockResolvedValue([{ service: 'EXT_API', _max: { sampledAt: new Date(T - 120_000) } }]);
    const r = await ingest(payload({ results: [res(T - 30_000, false), res(T - 150_000), res(T - 60_000)] }), NOW);
    expect(r.samples).toBe(2);
    expect(r.skippedSamples).toBe(1);
    const rows = sample.createMany.mock.calls[0][0].data;
    expect(rows.map((x: { sampledAt: Date }) => x.sampledAt.getTime())).toEqual([T - 60_000, T - 30_000]);
    expect(rows.map((x: { status: string }) => x.status)).toEqual(['NORMAL', 'CRITICAL']);
    expect(rows[0].service).toBe(serviceOf('api'));
  });
  it('reenvio do mesmo lote não duplica (nada novo → nenhuma gravação)', async () => {
    sample.groupBy.mockResolvedValue([{ service: 'EXT_API', _max: { sampledAt: new Date(T) } }]);
    const r = await ingest(payload({ results: [res(T - 1000), res(T)] }), NOW);
    expect(r.samples).toBe(0);
    expect(sample.createMany).not.toHaveBeenCalled();
  });
  it('relógio implausível é descartado (futuro distante e mais de 7 dias atrás)', async () => {
    const r = await ingest(payload({ results: [res(T + 3_600_000), res(T - 8 * 86_400_000), res(T - 1000)] }), NOW);
    expect(r.samples).toBe(1);
  });
  it('o detalhe de uma falha não contém URL nem corpo', async () => {
    await ingest(payload({ results: [res(T - 1000, false)] }), NOW);
    const detail = sample.createMany.mock.calls[0][0].data[0].detail as string;
    expect(detail).toMatch(/http HTTP 503/);
    expect(detail).not.toMatch(/https?:\/\//);
  });
});

describe('incidentes → alertas (mesmo mecanismo, sem notificar de novo)', () => {
  it('incidente aberto vira alerta EXTERNAL de plataforma com a gravidade do monitor', async () => {
    const r = await ingest(payload({ incidents: [incident()] }), NOW);
    expect(r.incidents).toEqual({ opened: 1 });
    const cond = apply.mock.calls[0][0];
    expect(cond).toMatchObject({ source: 'EXTERNAL', companyId: null, branchId: null, deviceId: null, type: 'EXTERNAL_API_DOWN', status: 'CRITICAL', metric: 'externalProbe' });
    expect(cond.detail).toContain('medido por Região B');
  });
  it('recuperação (endedAt) encerra pelo mesmo caminho', async () => {
    apply.mockResolvedValue('closed');
    await ingest(payload({ incidents: [incident({ endedAt: T - 1000 })] }), NOW);
    expect(apply.mock.calls[0][0].status).toBe('NORMAL');
  });
  it('reenvio atrasado de incidente JÁ encerrado não reabre o alerta', async () => {
    alert.findFirst.mockResolvedValue({ endedAt: new Date(T - 10_000) });
    const r = await ingest(payload({ incidents: [incident({ startedAt: T - 60_000 })] }), NOW);
    expect(apply).not.toHaveBeenCalled();
    expect(r.staleIncidents).toBe(1);
  });
  it('novo episódio depois de um encerrado abre normalmente', async () => {
    alert.findFirst.mockResolvedValue({ endedAt: new Date(T - 600_000) });
    await ingest(payload({ incidents: [incident({ startedAt: T - 60_000 })] }), NOW);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('incidente agrupado sob o pai deixa isso claro no detalhe', async () => {
    await ingest(payload({ incidents: [incident({ groupedUnder: 'site' })] }), NOW);
    expect(apply.mock.calls[0][0].detail).toContain('consequência de site');
  });
});

describe('estado do monitor externo (homem-morto)', () => {
  it('nunca relatou: não está "velho" (não há o que esperar)', async () => {
    sample.findFirst.mockResolvedValue(null);
    const s = await externalMonitorState(NOW, { MONITOR_INGEST_SECRET: 'x'.repeat(32) } as never);
    expect(s).toMatchObject({ enabled: true, everReported: false, stale: false, ageMinutes: null });
  });
  it('relatou há 25 min com limite padrão de 10: velho', async () => {
    sample.findFirst.mockResolvedValue({ sampledAt: new Date(T - 25 * 60_000) });
    const s = await externalMonitorState(NOW, { MONITOR_INGEST_SECRET: 'x'.repeat(32) } as never);
    expect(s).toMatchObject({ everReported: true, stale: true, ageMinutes: 25 });
  });
  it('relatou há 3 min: em dia', async () => {
    sample.findFirst.mockResolvedValue({ sampledAt: new Date(T - 3 * 60_000) });
    expect((await externalMonitorState(NOW, {})).stale).toBe(false);
  });
});

describe('modelo de alertas', () => {
  it('EXTERNAL_* tem categoria e orientação próprias; SMS/WhatsApp contam como notificação', () => {
    expect(alertCategory('EXTERNAL_API_DOWN')).toBe('EXTERNAL');
    expect(alertCategory('EXTERNAL_MONITOR_STALE')).toBe('EXTERNAL');
    expect(alertCategory('SMS_DELIVERY_FAILING')).toBe('NOTIFICATION');
    expect(alertCategory('WHATSAPP_DELIVERY_FAILING')).toBe('NOTIFICATION');
    expect(alertGuidance('EXTERNAL_MONITOR_STALE')).toMatch(/monitor externo parou/);
    expect(alertGuidance('EXTERNAL_API_DOWN')).toMatch(/de fora/);
  });
});
