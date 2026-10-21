/**
 * Testes de deduplicação de jobs por jobId determinístico.
 *
 * Achado de auditoria: nenhuma chamada a `emailQueue.add`/`notificationQueue.add`
 * em notification.job.ts (nem em scheduler.ts:performAutoBackup) passava um
 * `jobId`. Sem isso, o BullMQ gera um id aleatório por chamada — se o worker
 * cair no meio do processamento de um job (job "stalled"), o BullMQ redistribui
 * o MESMO job (mesmo `job.id` da fila `notification`) do zero para outro
 * worker, que reexecuta o handler inteiro e chama `emailQueue.add` de novo
 * para cada destinatário, inclusive os que já tinham recebido e-mail na
 * tentativa anterior — duplicando o envio. Um jobId determinístico e estável
 * (mesma chave de negócio → mesmo jobId) faz o BullMQ recusar/no-opar o add
 * duplicado, exatamente como já acontece com os jobIds fixos dos jobs
 * recorrentes em config/scheduler.ts (ex.: 'check-expiring-licenses-daily').
 *
 * Este teste não teve como objetivo provar o comportamento de deduplicação do
 * BullMQ em si (isso exigiria Redis real, e o comportamento já é documentado/
 * garantido pela própria biblioteca) — o que é testado é a PARTE que este
 * código de fato controla: que o jobId passado é determinístico (duas
 * chamadas com os mesmos dados de negócio produzem o mesmo jobId) e que
 * chamadas com dados de negócio diferentes produzem jobIds diferentes (não
 * "trava" para sempre bloqueando notificações legítimas futuras).
 */

const companyFindUniqueMock = jest.fn();
const userFindManyMock = jest.fn();
const licenseFindManyMock = jest.fn();

jest.mock('@ln-system/database', () => ({
  prisma: {
    company: { findUnique: companyFindUniqueMock },
    user: { findMany: userFindManyMock },
    license: { findMany: licenseFindManyMock },
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

const balancesMock = jest.fn();
jest.mock('../services/stock-ledger', () => ({ stockLedger: { balances: (...a: unknown[]) => balancesMock(...a) } }));

// config/queue já é mockado globalmente via moduleNameMapper (jest.config.js)
// apontando para src/config/__mocks__/queue.ts — emailQueue/notificationQueue
// já vêm com `.add` como jest.fn(). Importamos daqui para inspecionar as
// chamadas.
import { emailQueue, notificationQueue } from '../config/queue';
import {
  processNotificationJob,
  checkExpiringLicenses,
  checkLowStockProducts,
} from './notification.job';

function fakeJob(type: string, companyId: string, data: Record<string, any>) {
  return { id: 'bullmq-job-id', name: 'process-notification', data: { type, companyId, data } } as any;
}

function jobIdsOf(mock: jest.Mock): (string | undefined)[] {
  return mock.mock.calls.map((call) => call[2]?.jobId);
}

describe('notification.job — jobId determinístico (proteção contra redelivery duplicando envio)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('license-expiring: mesmo (empresa, destinatário, dias restantes) produz o mesmo jobId em execuções repetidas', async () => {
    companyFindUniqueMock.mockResolvedValue({
      id: 'c1',
      name: 'Empresa 1',
      users: [{ email: 'admin@empresa1.com', name: 'Admin' }],
    });

    const job = fakeJob('license-expiring', 'c1', { daysRemaining: 7, licenseType: 'PRO' });
    await processNotificationJob(job);
    await processNotificationJob(job); // simula redelivery do mesmo job

    expect(emailQueue.add).toHaveBeenCalledTimes(2);
    const [jobId1, jobId2] = jobIdsOf(emailQueue.add as jest.Mock);
    expect(jobId1).toBeDefined();
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toBe('license-expiring|c1|admin@empresa1.com|7');
  });

  it('license-expiring: limiares de dias diferentes para o mesmo destinatário geram jobIds diferentes (não deve travar futuras notificações)', async () => {
    companyFindUniqueMock.mockResolvedValue({
      id: 'c1',
      name: 'Empresa 1',
      users: [{ email: 'admin@empresa1.com', name: 'Admin' }],
    });

    await processNotificationJob(fakeJob('license-expiring', 'c1', { daysRemaining: 30, licenseType: 'PRO' }));
    await processNotificationJob(fakeJob('license-expiring', 'c1', { daysRemaining: 7, licenseType: 'PRO' }));

    const jobIds = jobIdsOf(emailQueue.add as jest.Mock);
    expect(new Set(jobIds).size).toBe(2);
  });

  it('low-stock: mesmo produto/destinatário no mesmo dia produz o mesmo jobId em execuções repetidas', async () => {
    userFindManyMock.mockResolvedValue([{ email: 'gerente@empresa1.com', name: 'Gerente' }]);

    const job = fakeJob('low-stock', 'c1', {
      productId: 'p1',
      productName: 'Óleo 10w40',
      currentStock: 2,
      minStock: 5,
      branchId: 'b1',
    });
    await processNotificationJob(job);
    await processNotificationJob(job);

    expect(emailQueue.add).toHaveBeenCalledTimes(2);
    const [jobId1, jobId2] = jobIdsOf(emailQueue.add as jest.Mock);
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toMatch(/^low-stock\|c1\|gerente@empresa1\.com\|p1\|\d{4}-\d{2}-\d{2}$/);
  });

  it('sale-alert: mesma venda/destinatário produz o mesmo jobId (evento único, sem componente de data)', async () => {
    userFindManyMock.mockResolvedValue([{ email: 'dono@empresa1.com', name: 'Dono' }]);

    const job = fakeJob('sale-alert', 'c1', { saleId: 's1', total: 100, customerName: 'Cliente', sellerName: 'Vendedor' });
    await processNotificationJob(job);
    await processNotificationJob(job);

    const [jobId1, jobId2] = jobIdsOf(emailQueue.add as jest.Mock);
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toBe('sale-alert|c1|dono@empresa1.com|s1');
  });

  it('backup-completed: mesmo filePath/destinatário produz o mesmo jobId; filePath diferente (próximo backup real) produz jobId diferente', async () => {
    companyFindUniqueMock.mockResolvedValue({
      id: 'c1',
      name: 'Empresa 1',
      users: [{ email: 'admin@empresa1.com', name: 'Admin' }],
    });

    await processNotificationJob(fakeJob('backup-completed', 'c1', { filePath: '/backups/2026-09-15.dump' }));
    await processNotificationJob(fakeJob('backup-completed', 'c1', { filePath: '/backups/2026-09-15.dump' }));
    await processNotificationJob(fakeJob('backup-completed', 'c1', { filePath: '/backups/2026-09-22.dump' }));

    const jobIds = jobIdsOf(emailQueue.add as jest.Mock);
    expect(jobIds[0]).toBe(jobIds[1]); // mesma execução/redelivery → mesmo jobId
    expect(jobIds[2]).not.toBe(jobIds[0]); // backup real seguinte → jobId diferente, não fica bloqueado
  });

  it('payment-reminder: mesma fatura no mesmo dia produz o mesmo jobId', async () => {
    const job = fakeJob('payment-reminder', 'c1', {
      invoiceId: 'inv1',
      customerEmail: 'cliente@empresa1.com',
      customerName: 'Cliente',
      amount: 500,
      dueDate: '2026-09-20',
    });
    await processNotificationJob(job);
    await processNotificationJob(job);

    const [jobId1, jobId2] = jobIdsOf(emailQueue.add as jest.Mock);
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toMatch(/^payment-reminder\|c1\|inv1\|\d{4}-\d{2}-\d{2}$/);
  });

  it('checkExpiringLicenses: enfileira process-notification com jobId por (licença, dias restantes)', async () => {
    const now = Date.now();
    const in7Days = new Date(now + 7 * 24 * 60 * 60 * 1000);
    licenseFindManyMock.mockResolvedValue([
      { id: 'lic1', companyId: 'c1', licenseType: 'PRO', expiryDate: in7Days, status: 'ACTIVE' },
    ]);

    await checkExpiringLicenses();
    await checkExpiringLicenses(); // simula o cron rodando de novo / redelivery

    expect(notificationQueue.add).toHaveBeenCalledTimes(2);
    const [jobId1, jobId2] = jobIdsOf(notificationQueue.add as jest.Mock);
    expect(jobId1).toBeDefined();
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toBe('notify-license-expiring|lic1|7');
  });

  it('checkLowStockProducts: enfileira process-notification com jobId por (produto, dia) apenas quando há movimentação real', async () => {
    const { prisma } = require('@ln-system/database');
    prisma.product = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'p1', name: 'Óleo 10w40', companyId: 'c1', branchId: 'b1', minStock: 5 },
      ]),
    };
    balancesMock.mockResolvedValue(new Map([['p1', { balance: 2, count: 3 }]]));

    await checkLowStockProducts();
    await checkLowStockProducts();

    expect(notificationQueue.add).toHaveBeenCalledTimes(2);
    const [jobId1, jobId2] = jobIdsOf(notificationQueue.add as jest.Mock);
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toMatch(/^notify-low-stock\|p1\|\d{4}-\d{2}-\d{2}$/);
  });

  // Regressão (2026-10-20): o BullMQ 5 recusa jobId com ":" ("Custom Id cannot contain :"). Com a fila simulada os testes acima não viam isso,
  // e 10 jobs reais falharam no Redis de dev (2026-10-13 e 2026-10-18). Nenhum jobId gerado por este módulo pode conter ":".
  it('nenhum jobId contém ":" (regra do BullMQ), nem com caminho de backup do Windows', async () => {
    companyFindUniqueMock.mockResolvedValue({ id: 'c1', name: 'Empresa 1', users: [{ email: 'admin@empresa1.com', name: 'Admin' }] });
    userFindManyMock.mockResolvedValue([{ email: 'gerente@empresa1.com', name: 'Gerente' }]);
    await processNotificationJob(fakeJob('license-expiring', 'c1', { daysRemaining: 7, licenseType: 'PRO' }));
    await processNotificationJob(fakeJob('backup-completed', 'c1', { filePath: 'C:\\backups\\2026-09-15.dump' }));
    await processNotificationJob(fakeJob('sale-alert', 'c1', { saleId: 's1', total: 1, customerName: 'C', sellerName: 'V' }));
    const ids = jobIdsOf(emailQueue.add as jest.Mock);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      expect(id).toBeDefined();
      expect(id).not.toContain(':');
    }
  });
});
