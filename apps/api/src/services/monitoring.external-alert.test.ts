/**
 * Alerta de origem EXTERNAL (medido pelo monitor independente, que JÁ avisou por conta própria): o painel registra e encerra, mas NUNCA dispara um segundo aviso.
 * Os alertas de origem CENTRAL continuam avisando normalmente (regressão).
 */
const alertTable = { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() };
jest.mock('@ln-system/database', () => ({ prisma: { monitoringAlert: alertTable }, runInTransaction: jest.fn(), runWithRLSContext: (_c: unknown, fn: () => unknown) => fn() }));
jest.mock('../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('./observability.service', () => ({ __esModule: true, default: {} }));
jest.mock('./monitoring-thresholds.service', () => ({ __esModule: true, default: {} }));
jest.mock('./monitoring-central/alert-events', () => ({ recordAlertEvent: jest.fn().mockResolvedValue(undefined) }));
const notifyMock = jest.fn().mockResolvedValue(undefined);
jest.mock('./monitoring-central/notifier', () => ({ notifyAlert: (...a: unknown[]) => notifyMock(...a) }));

import monitoringService, { type AlertCondition } from './monitoring.service';

const now = new Date('2026-10-22T15:00:00Z');
const base = (over: Partial<AlertCondition> = {}): AlertCondition => ({
  source: 'EXTERNAL', companyId: null, branchId: null, deviceId: null, type: 'EXTERNAL_API_DOWN', metric: 'externalProbe', value: null, threshold: null, status: 'CRITICAL', detail: 'API fora', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  alertTable.findFirst.mockResolvedValue(null);
  alertTable.create.mockResolvedValue({ id: 'a1', companyId: null });
  alertTable.updateMany.mockResolvedValue({ count: 1 });
});

describe('applyAlert × origem EXTERNAL', () => {
  it('abrir NÃO notifica (o monitor já avisou)', async () => {
    expect(await monitoringService.applyAlert(base(), now)).toBe('opened');
    expect(alertTable.create).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('agravar e reabrir NÃO notificam', async () => {
    alertTable.findFirst.mockResolvedValueOnce({ id: 'a1', companyId: null, branchId: null, deviceId: null, type: 'EXTERNAL_API_SLOW', severity: 'ATTENTION', endedAt: null });
    alertTable.update.mockResolvedValue({});
    await monitoringService.applyAlert(base({ type: 'EXTERNAL_API_SLOW', status: 'CRITICAL' }), now);
    alertTable.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'a2', companyId: null, endedAt: new Date(now.getTime() - 60_000) });
    await monitoringService.applyAlert(base(), now);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('recuperar NÃO notifica', async () => {
    alertTable.findFirst.mockResolvedValueOnce({ id: 'a1', companyId: null, branchId: null, deviceId: null, type: 'EXTERNAL_API_DOWN', severity: 'CRITICAL', detail: 'x', startedAt: new Date(now.getTime() - 600_000), endedAt: null });
    expect(await monitoringService.applyAlert(base({ status: 'NORMAL' }), now)).toBe('closed');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('regressão: alerta CENTRAL continua notificando ao abrir', async () => {
    await monitoringService.applyAlert(base({ source: 'CENTRAL', type: 'SERVER_CPU' }), now);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1]).toBe('OPENED');
  });
});
