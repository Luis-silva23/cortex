/**
 * Teste de deduplicação por jobId em performAutoBackup (mesma classe de gap
 * corrigida em notification.job.ts — ver comentário lá). Este call site é
 * separado porque vive em scheduler.ts, não em notification.job.ts: o loop
 * que notifica cada empresa ativa sobre um backup concluído não passava
 * jobId, então uma reentrega de job "stalled" no meio do loop duplicaria a
 * notificação para as empresas já notificadas na tentativa anterior.
 *
 * `scheduler.ts` chama `setupRecurringJobs()` como efeito colateral no
 * import (mesmo padrão documentado em scheduler.cleanup.test.ts) — por isso
 * `notificationQueue` precisa estar mockado ANTES do import do módulo.
 */

const companyFindManyMock = jest.fn();

jest.mock('@ln-system/database', () => ({
  prisma: {
    company: { findMany: companyFindManyMock },
  },
  runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

jest.mock('../services/logger.service', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    job: jest.fn(),
  },
}));

const createBackupMock = jest.fn();
jest.mock('../services/BackupService', () => ({
  backupService: { createBackup: createBackupMock },
}));

const notificationQueueMock = {
  getRepeatableJobs: jest.fn().mockResolvedValue([]),
  removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
  add: jest.fn().mockResolvedValue(undefined),
};

jest.mock('./queue', () => ({
  notificationQueue: notificationQueueMock,
}));

jest.mock('../jobs/notification.job', () => ({
  checkExpiringLicenses: jest.fn().mockResolvedValue(undefined),
  checkLowStockProducts: jest.fn().mockResolvedValue(undefined),
}));

import { processScheduledJob } from './scheduler';

describe('scheduler performAutoBackup (via processScheduledJob("auto-backup")) — jobId determinístico', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    companyFindManyMock.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
  });

  it('mesmo backup real (mesmo filePath) redistribuído para o mesmo worker não duplica a notificação: jobId estável por (empresa, filePath)', async () => {
    createBackupMock.mockResolvedValue({ success: true, filePath: '/backups/2026-09-15.dump' });

    await processScheduledJob('auto-backup', {});
    await processScheduledJob('auto-backup', {});

    // 2 empresas x 2 execuções = 4 chamadas, mas cada (empresa, filePath) só
    // deveria gerar 2 jobIds distintos (um por empresa), repetidos.
    expect(notificationQueueMock.add).toHaveBeenCalledTimes(4);
    const jobIds = notificationQueueMock.add.mock.calls.map((call: any[]) => call[2]?.jobId);
    expect(jobIds.every((id: string | undefined) => !!id)).toBe(true);
    expect(new Set(jobIds).size).toBe(2);
    expect(jobIds).toEqual(
      expect.arrayContaining([
        'notify-backup-completed|c1|/backups/2026-09-15.dump',
        'notify-backup-completed|c2|/backups/2026-09-15.dump',
      ])
    );
  });

  it('backup real seguinte (filePath diferente) não fica bloqueado pelo jobId do backup anterior', async () => {
    createBackupMock.mockResolvedValueOnce({ success: true, filePath: '/backups/2026-09-15.dump' });
    createBackupMock.mockResolvedValueOnce({ success: true, filePath: '/backups/2026-09-22.dump' });

    await processScheduledJob('auto-backup', {});
    await processScheduledJob('auto-backup', {});

    const jobIds = notificationQueueMock.add.mock.calls.map((call: any[]) => call[2]?.jobId);
    expect(new Set(jobIds).size).toBe(4); // 2 empresas x 2 backups distintos, todos diferentes
  });

  it('não notifica quando o backup real falha', async () => {
    createBackupMock.mockResolvedValue({ success: false, error: 'disco cheio' });

    await processScheduledJob('auto-backup', {});

    expect(notificationQueueMock.add).not.toHaveBeenCalled();
  });
});
