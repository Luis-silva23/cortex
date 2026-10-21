import { resolveBackupMode } from '../services/backup-mode';
import { Logger } from '../services/logger.service';
import { notificationQueue } from './queue';
import { jobKey } from './job-id';
import { checkExpiringLicenses, checkLowStockProducts } from '../jobs/notification.job';

const logger = Logger; // Logger tem apenas métodos estáticos, não getInstance()

// `QueueScheduler` foi removido do BullMQ a partir da v3 — o processamento de
// jobs atrasados/repetidos passou a ser responsabilidade do próprio Worker/Queue.
// O import antigo (`bullmq`@^5.1.0 não exporta mais `QueueScheduler`) quebraria
// o build. Os Workers já são criados em config/queue.ts e cobrem esse papel.
// A conexão Redis própria também foi removida: este arquivo só usa as filas
// já configuradas (com sua própria conexão) importadas de ./queue.

/**
 * Configurar jobs recorrentes
 */
export async function setupRecurringJobs() {
  try {
    // Limpar jobs repetidos antigos
    const repeatableJobs = await notificationQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await notificationQueue.removeRepeatableByKey(job.key);
    }

    // Job diário: verificar licenças expirando (todo dia às 9h)
    await notificationQueue.add(
      'check-expiring-licenses',
      {},
      {
        repeat: {
          pattern: '0 9 * * *', // Cron: 9h todo dia
        },
        jobId: 'check-expiring-licenses-daily',
      }
    );

    // Job de hora em hora: verificar estoque baixo
    await notificationQueue.add(
      'check-low-stock',
      {},
      {
        repeat: {
          pattern: '0 * * * *', // Cron: a cada hora
        },
        jobId: 'check-low-stock-hourly',
      }
    );

    // Job diário: limpar logs antigos (todo dia à meia-noite)
    await notificationQueue.add(
      'cleanup-old-logs',
      {},
      {
        repeat: {
          pattern: '0 0 * * *', // Cron: meia-noite
        },
        jobId: 'cleanup-old-logs-daily',
      }
    );

    // Job semanal: backup automático (domingo às 2h). `ENABLE_AUTO_BACKUP=false` (documentado no .env.example, antes ignorado) o desliga:
    // em produção o backup deve ser da infraestrutura (dump diário + WAL), ver docs/CORTEX/PRODUCAO.md §7.
    // Modo delegado (decisão 152): o agendamento é do serviço de backup dedicado (00:00), não da API — esta nem tem a credencial.
    if (process.env.ENABLE_AUTO_BACKUP !== 'false' && resolveBackupMode(process.env) !== 'delegated') {
      await notificationQueue.add(
        'auto-backup',
        {},
        {
          repeat: {
            pattern: '0 2 * * 0', // Cron: domingo 2h
          },
          jobId: 'auto-backup-weekly',
        }
      );
    }

    // Job mensal: relatório mensal automático (dia 1 de cada mês às 8h)
    await notificationQueue.add(
      'monthly-report',
      {},
      {
        repeat: {
          pattern: '0 8 1 * *', // Cron: dia 1, 8h
        },
        jobId: 'monthly-report',
      }
    );

    // Job diário: marcar contas a pagar/receber vencidas como OVERDUE
    // (conciliação financeira automática, meia-noite e meia)
    await notificationQueue.add(
      'mark-overdue-accounts',
      {},
      {
        repeat: {
          pattern: '30 0 * * *',
        },
        jobId: 'mark-overdue-accounts-daily',
      }
    );

    // Diário (03:15): apaga o conteúdo das exportações de titular (LGPD) vencidas — validade de 24 h, decisão 120
    await notificationQueue.add(
      'purge-privacy-exports',
      {},
      {
        repeat: {
          pattern: '15 3 * * *',
        },
        jobId: 'purge-privacy-exports-daily',
      }
    );

    // A cada minuto: avalia a saúde das filiais e abre/encerra incidentes (histórico de saúde)
    await notificationQueue.add(
      'evaluate-health',
      {},
      {
        repeat: {
          pattern: '* * * * *',
        },
        jobId: 'evaluate-health-1min',
      }
    );

    // A cada 5 min: consulta o provedor dos pagamentos por terminal/PIX que ficaram PENDING (resposta perdida)
    await notificationQueue.add(
      'reconcile-external-payments',
      {},
      {
        repeat: {
          pattern: '*/5 * * * *',
        },
        jobId: 'reconcile-external-payments-5min',
      }
    );

    // [Commerce API, Fase 2] A cada minuto: marca EXPIRED as reservas de estoque vencidas dos pedidos externos e leva o pedido aceito a
    // EXPIRED. Só estado e histórico: o disponível para venda já ignora reserva vencida mesmo que esta rotina atrase.
    await notificationQueue.add(
      'expire-stock-reservations',
      {},
      {
        repeat: {
          pattern: '* * * * *',
        },
        jobId: 'expire-stock-reservations-1min',
      }
    );

    // [Integration Gateway, Fase 3] A cada minuto: envia a caixa de saída dos canais com provedor (estoque, preço, catálogo, estado do
    // pedido, entrega) — prazo, espera crescente e disjuntor por canal; só varre linhas devidas. Sem canal com provedor, não faz nada.
    await notificationQueue.add(
      'process-channel-outbox',
      {},
      {
        repeat: {
          pattern: '* * * * *',
        },
        jobId: 'process-channel-outbox-1min',
      }
    );

    // [Integration Gateway, Fase 3] A cada 2 minutos: consulta os provedores que oferecem consulta (cobre webhook que não chegou) e
    // expira evento guardado fora de ordem cujo pedido nunca chegou (24 h).
    await notificationQueue.add(
      'poll-channel-events',
      {},
      {
        repeat: {
          pattern: '*/2 * * * *',
        },
        jobId: 'poll-channel-events-2min',
      }
    );

    // [orçamentos 2026-09-27] Diário (01:10): encerra os orçamentos SENT vencidos nas filiais com quote.autoExpire
    // ligado (desligado por padrão — sem a política, a rotina não muda nada). Evento EXPIRED, performedBy 'SYSTEM'.
    await notificationQueue.add(
      'expire-overdue-quotes',
      {},
      {
        repeat: {
          pattern: '10 1 * * *',
        },
        jobId: 'expire-overdue-quotes-daily',
      }
    );

    // [convênios 2026-09-27] Diário (01:20): bloqueia conveniadas ATIVAS com conta vencida há mais de X dias
    // (blockAfterDaysOverdue próprio ou padrão da política; vazio = só manual). NÃO envia cobrança — cobrança é manual.
    await notificationQueue.add(
      'auto-block-agreement-companies',
      {},
      {
        repeat: {
          pattern: '20 1 * * *',
        },
        jobId: 'auto-block-agreement-companies-daily',
      }
    );

    logger.info('Recurring jobs configured successfully', {
      jobs: [
        'check-expiring-licenses (daily 9h)',
        'check-low-stock (hourly)',
        'cleanup-old-logs (daily midnight)',
        'auto-backup (weekly sunday 2h)',
        'monthly-report (monthly 1st 8h)',
        'mark-overdue-accounts (daily 00:30)',
        'reconcile-external-payments (every 5 min)',
        'expire-stock-reservations (every minute)',
        'process-channel-outbox (every minute)',
        'poll-channel-events (every 2 min)',
        'evaluate-health (every minute)',
        'expire-overdue-quotes (daily 01:10)',
        'auto-block-agreement-companies (daily 01:20)',
      ],
    });
  } catch (error) {
    logger.error('Failed to setup recurring jobs', {
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Processar jobs agendados específicos
 */
export async function processScheduledJob(jobName: string, data: any) {
  try {
    logger.job(jobName, 'started', { data });

    switch (jobName) {
      case 'check-expiring-licenses':
        await checkExpiringLicenses();
        break;

      case 'check-low-stock':
        await checkLowStockProducts();
        break;

      case 'cleanup-old-logs':
        await cleanupOldLogs();
        // retenção da telemetria da Central (amostras, entregas externas, alertas encerrados): nunca lança
        await require('../services/monitoring-central/retention').purgeMonitoringTelemetry();
        break;

      case 'auto-backup':
        await performAutoBackup();
        break;

      case 'monthly-report':
        await generateMonthlyReports();
        break;

      case 'mark-overdue-accounts':
        await markOverdueAccounts();
        break;

      case 'evaluate-health': {
        const monitoringService = require('../services/monitoring.service').default;
        const result = await monitoringService.evaluateIncidents();
        if (result.opened || result.closed) logger.info('Health incidents evaluated', result);
        // Central de Monitoramento: amostras de saúde + alertas centrais no intervalo configurado (nunca lança; custo só quando devido)
        const { runCentralEvaluation } = require('../services/monitoring-central/sampler.service');
        await runCentralEvaluation();
        break;
      }

      // [orçamentos 2026-09-27]
      case 'expire-overdue-quotes': {
        const quoteService = require('../services/quote.service').default;
        const result = await quoteService.expireOverdue();
        logger.info('Overdue quotes expired', result);
        break;
      }

      // [convênios 2026-09-27]
      case 'auto-block-agreement-companies': {
        const agreementCompanyService = require('../services/agreement-company.service').default;
        const result = await agreementCompanyService.autoBlockOverdue();
        logger.info('Agreement companies auto-block evaluated', result);
        break;
      }

      case 'reconcile-external-payments': {
        const paymentService = require('../services/payment.service').default;
        const result = await paymentService.reconcilePendingExternal();
        logger.info('External payments reconciled', result);
        break;
      }

      case 'expire-stock-reservations': {
        const reservationService = require('../services/commerce/reservation.service').default;
        const result = await reservationService.expireDue();
        if (result.orders > 0) logger.info('Stock reservations expired', result);
        break;
      }

      case 'process-channel-outbox': {
        const { processDue } = require('../services/integrations/outbox.service');
        const result = await processDue();
        if (result.claimed > 0) logger.info('Channel outbox processed', result);
        break;
      }

      case 'purge-privacy-exports': {
        const { purgeExpiredExports } = require('../services/privacy/privacy.service');
        const purged = await purgeExpiredExports();
        if (purged > 0) logger.info('Privacy exports purged', { purged });
        break;
      }

      case 'poll-channel-events': {
        const { pollChannels } = require('../services/integrations/poller');
        const { sweepDeferred } = require('../services/integrations/inbound.service');
        const polled = await pollChannels();
        const swept = await sweepDeferred();
        if (polled.channels > 0 || swept.expired > 0) logger.info('Channel events polled', { ...polled, ...swept });
        break;
      }

      default:
        logger.warn('Unknown scheduled job', { jobName });
    }

    logger.job(jobName, 'completed');
  } catch (error) {
    logger.error('Scheduled job failed', {
      jobName,
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Marcar contas a pagar/receber vencidas como OVERDUE (conciliação diária)
 */
async function markOverdueAccounts() {
  const financialService = require('../services/financial.service').default;
  const result = await financialService.markOverdueAccounts();
  logger.info('Overdue accounts marked', result);
}

/**
 * Limpar logs antigos — retenções diferentes por tipo:
 * - AuditLog (auditoria de negócio): 90 dias, valor de compliance maior.
 * - SystemLog (segurança/integração/erros técnicos): 90 dias, mesmo motivo.
 * - RequestLog (métrica de toda requisição, altíssimo volume): 30 dias —
 *   sem valor de compliance, existe só para P50/P95/P99 e volume recentes.
 * - IdempotencyKey: expira em `expiresAt` (janela de 24 h, ver middleware/idempotency.ts). Sem este expurgo as chaves nunca saíam da tabela e a
 *   MESMA chave devolvia a resposta antiga para sempre (a janela era só um campo gravado, nunca aplicado).
 * Configurável via env sem exigir deploy de código.
 */
export async function cleanupOldLogs() {
  const { prisma, runWithRLSContext } = require('@ln-system/database');

  const auditRetentionDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);
  const systemLogRetentionDays = parseInt(process.env.SYSTEM_LOG_RETENTION_DAYS || '90', 10);
  const requestLogRetentionDays = parseInt(process.env.REQUEST_LOG_RETENTION_DAYS || '30', 10);
  // Telemetria bruta (alta granularidade) 30 dias; incidentes encerrados 1 ano. O histórico longo sai agregado por balde.
  const telemetryCutoff = new Date(Date.now() - parseInt(process.env.TELEMETRY_RETENTION_DAYS || '30', 10) * 86_400_000);
  const incidentCutoff = new Date(Date.now() - parseInt(process.env.INCIDENT_RETENTION_DAYS || '365', 10) * 86_400_000);

  const auditCutoff = new Date();
  auditCutoff.setDate(auditCutoff.getDate() - auditRetentionDays);
  const systemLogCutoff = new Date();
  systemLogCutoff.setDate(systemLogCutoff.getDate() - systemLogRetentionDays);
  const requestLogCutoff = new Date();
  requestLogCutoff.setDate(requestLogCutoff.getDate() - requestLogRetentionDays);

  // Job agendado roda fora de qualquer requisição HTTP — sem este bypass de
  // RLS, `deleteMany` sempre afetava 0 linhas (a política nega tudo sem
  // `set_config` ativo), então a política de retenção nunca purgava nada de
  // verdade, silenciosamente. Ver mesma causa-raiz em observability.job.ts.
  const [auditDeleted, systemLogDeleted, requestLogDeleted, telemetryDeleted, incidentsDeleted, idempotencyDeleted] = await runWithRLSContext(
    { companyId: null, userType: 'SUPER_ADMIN', branchId: null },
    () =>
      Promise.all([
        // audit_logs é append-only (migration 20260925100000): o DELETE só passa com o expurgo sinalizado na MESMA
        // transação, em contexto de Super Admin.
        require('@ln-system/database').runInTransaction(async (tx: any) => {
          await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
          return tx.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
        }),
        prisma.systemLog.deleteMany({ where: { createdAt: { lt: systemLogCutoff } } }),
        prisma.requestLog.deleteMany({ where: { createdAt: { lt: requestLogCutoff } } }),
        prisma.deviceTelemetry.deleteMany({ where: { collectedAt: { lt: telemetryCutoff } } }),
        prisma.healthIncident.deleteMany({ where: { endedAt: { lt: incidentCutoff } } }),
        // chave vencida (concluída, falha ou travada em PENDING): a próxima requisição com a mesma chave é uma operação nova
        prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
      ])
  );

  logger.info('Old logs cleaned up', {
    auditLogsDeleted: auditDeleted.count,
    systemLogsDeleted: systemLogDeleted.count,
    requestLogsDeleted: requestLogDeleted.count,
    telemetryDeleted: telemetryDeleted.count,
    incidentsDeleted: incidentsDeleted.count,
    idempotencyKeysDeleted: idempotencyDeleted.count,
  });

  return {
    auditLogsDeleted: auditDeleted.count as number,
    systemLogsDeleted: systemLogDeleted.count as number,
    requestLogsDeleted: requestLogDeleted.count as number,
    telemetryDeleted: telemetryDeleted.count as number,
    incidentsDeleted: incidentsDeleted.count as number,
    idempotencyKeysDeleted: idempotencyDeleted.count as number,
  };
}

/**
 * Realizar backup automático
 *
 * ANTES: esta função nunca chamava o BackupService real — apenas logava
 * "Backing up company" e enviava uma notificação com dados FALSOS e fixos
 * (`backupSize: '100MB'`, `duration: '5 minutes'`), sem nenhum backup de
 * verdade acontecer. O banco é compartilhado entre empresas (multi-tenant
 * via RLS em um único Postgres), então o backup real (pg_dump) é único para
 * toda a plataforma — não "por empresa". Chamamos o BackupService real uma
 * única vez e notificamos cada empresa ativa do resultado real.
 */
async function performAutoBackup() {
  const { prisma, runWithRLSContext } = require('@ln-system/database');
  const { backupService } = require('../services/BackupService');

  // Ver nota em cleanupOldLogs: sem bypass de RLS, este SELECT sempre
  // retornava vazio (nenhuma empresa notificada do backup, silenciosamente).
  const companies = await runWithRLSContext(
    { companyId: null, userType: 'SUPER_ADMIN', branchId: null },
    () => prisma.company.findMany({ where: { isActive: true }, select: { id: true } })
  );

  logger.info('Starting auto backup', { companyCount: companies.length });

  const result = await backupService.createBackup();

  if (!result.success) {
    logger.error('Auto backup failed', { error: result.error });
    // Não notificar sucesso quando o backup falhou de verdade.
    return;
  }

  // jobId por (empresa, arquivo de backup): mesmo motivo do comentário em
  // notification.job.ts (handleBackupCompletedNotification) — deduplica
  // reentrega de job "stalled" sem bloquear a notificação do PRÓXIMO backup
  // real (que sempre gera um filePath diferente).
  for (const company of companies) {
    await notificationQueue.add(
      'process-notification',
      {
        type: 'backup-completed',
        companyId: company.id,
        data: {
          filePath: result.filePath,
        },
      },
      { jobId: jobKey('notify-backup-completed', company.id, result.filePath) }
    );
  }

  logger.info('Auto backup completed', { companyCount: companies.length, filePath: result.filePath });
}

/**
 * Gerar relatórios mensais automáticos
 */
async function generateMonthlyReports() {
  const { prisma, runWithRLSContext } = require('@ln-system/database');
  const { reportQueue } = require('./queue');

  // Buscar todas as empresas ativas — Company.status não existe (é
  // isActive), companyName não existe (é name, e nem é usado aqui), e o
  // enum UserType não tem valor 'OWNER' (o mais próximo é COMPANY_ADMIN).
  // Ver nota em cleanupOldLogs sobre o bypass de RLS ser necessário aqui.
  const companies = await runWithRLSContext(
    { companyId: null, userType: 'SUPER_ADMIN', branchId: null },
    () =>
      prisma.company.findMany({
        where: { isActive: true },
        select: {
          id: true,
          users: {
            where: { userType: 'COMPANY_ADMIN' },
            select: { id: true },
          },
        },
      })
  );

  logger.info('Starting monthly report generation', { companyCount: companies.length });

  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0);

  for (const company of companies) {
    if (company.users.length === 0) continue;

    // Adicionar job para gerar relatório mensal
    await reportQueue.add('generate-report', {
      type: 'monthly-summary',
      companyId: company.id,
      startDate,
      endDate,
      format: 'pdf',
      userId: company.users[0].id,
    });
  }

  logger.info('Monthly reports queued', { companyCount: companies.length });
}

// Inicializar scheduler. `ENABLE_SCHEDULER=false` (documentado no .env.example, antes ignorado) faz esta instância NÃO registrar as
// rotinas recorrentes (réplicas só de atendimento); os workers continuam processando o que outra instância agendou.
if (process.env.ENABLE_SCHEDULER === 'false') {
  logger.info('Scheduler desativado nesta instância (ENABLE_SCHEDULER=false): rotinas recorrentes não registradas aqui');
} else {
  setupRecurringJobs().catch((error) => {
    logger.error('Failed to initialize scheduler', { error: error.message });
  });
}
