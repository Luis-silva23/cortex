import { Job } from 'bullmq';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { Logger } from '../services/logger.service';
import { emailQueue } from '../config/queue';
import { jobKey } from '../config/job-id';
import { stockLedger } from '../services/stock-ledger';

const logger = Logger; // Logger tem apenas métodos estáticos, não getInstance()

export interface NotificationJobData {
  type: 'license-expiring' | 'low-stock' | 'payment-reminder' | 'sale-alert' | 'backup-completed';
  companyId: string;
  data: Record<string, any>;
}

/**
 * Processa notificações do sistema
 */
export async function processNotificationJob(job: Job<NotificationJobData>) {
  const { type, companyId, data } = job.data;

  try {
    logger.job(job.name, 'started', {
      jobId: job.id,
      type,
      companyId,
    });

    // Worker do BullMQ roda fora de qualquer requisição HTTP — sem este
    // bypass de RLS, toda consulta abaixo (company/user) retornava vazia
    // silenciosamente, então nenhuma notificação por e-mail era realmente
    // enfileirada (0 destinatários encontrados sempre). Ver mesma
    // causa-raiz em observability.job.ts/audit.job.ts/report.job.ts.
    await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      switch (type) {
        case 'license-expiring':
          await handleLicenseExpiringNotification(companyId, data);
          break;
        case 'low-stock':
          await handleLowStockNotification(companyId, data);
          break;
        case 'payment-reminder':
          await handlePaymentReminderNotification(companyId, data);
          break;
        case 'sale-alert':
          await handleSaleAlertNotification(companyId, data);
          break;
        case 'backup-completed':
          await handleBackupCompletedNotification(companyId, data);
          break;
        default:
          throw new Error(`Unknown notification type: ${type}`);
      }
    });

    logger.job(job.name, 'completed', {
      jobId: job.id,
      type,
      companyId,
    });

    return { success: true, type, companyId };
  } catch (error) {
    logger.error('Failed to process notification', {
      jobId: job.id,
      type,
      companyId,
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Notificação de licença expirando
 */
async function handleLicenseExpiringNotification(companyId: string, data: any) {
  // Company tem `licenses: License[]` (lista), nunca um `license` singular —
  // e não precisamos buscar de novo: licenseType já vem em `data`
  // (calculado em checkExpiringLicenses, que sabe exatamente qual licença
  // está expirando). company.companyName também não existe — é `name`.
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      users: {
        where: { userType: { in: ['COMPANY_ADMIN'] } },
        select: { email: true, name: true },
      },
    },
  });

  if (!company) {
    logger.warn('Company not found for expiring license notification', { companyId });
    return;
  }

  const { daysRemaining, licenseType } = data;

  // Enviar email para os administradores da empresa
  //
  // jobId determinístico: se o worker do BullMQ cair no meio deste loop
  // (job "stalled"), o mesmo job é redistribuído do zero para outro worker,
  // que re-executaria este handler inteiro — sem jobId, cada admin já
  // notificado na tentativa anterior receberia um SEGUNDO e-mail idêntico.
  // Com jobId fixo por (empresa, destinatário, limiar de dias), o BullMQ
  // recusa/no-opa o add duplicado (mesmo padrão já usado nos jobs
  // recorrentes fixos de config/scheduler.ts, ex. 'check-expiring-licenses-daily').
  for (const admin of company.users) {
    await emailQueue.add(
      'send-email',
      {
        to: admin.email,
        subject: 'Sua licença está expirando',
        template: 'license-expiring',
        data: {
          companyName: company.name,
          userName: admin.name,
          daysRemaining,
          planName: licenseType,
          renewUrl: `${process.env.WEB_URL}/license/renew`,
        },
        companyId,
      },
      { jobId: jobKey('license-expiring', companyId, admin.email, daysRemaining) }
    );
  }

  logger.info('License expiring notifications sent', {
    companyId,
    daysRemaining,
    recipientCount: company.users.length,
  });
}

/**
 * Notificação de estoque baixo
 */
async function handleLowStockNotification(companyId: string, data: any) {
  const { productId, productName, currentStock, minStock, branchId } = data;

  // Buscar usuários com permissão de gerenciar estoque
  const users = await prisma.user.findMany({
    where: {
      companyId,
      branchId,
      userType: { in: ['COMPANY_ADMIN', 'MANAGER'] },
      isActive: true,
    },
    select: { email: true, name: true },
  });

  // jobId por dia: mesmo motivo do comentário em handleLicenseExpiringNotification
  // (proteção contra redelivery de job "stalled" duplicando o e-mail). Inclui a
  // data porque, ao contrário de uma licença expirando, estoque baixo é uma
  // condição que pode legitimamente continuar verdadeira por vários ciclos do
  // job horário (checkLowStockProducts) — o objetivo é deduplicar reentregas
  // dentro do mesmo dia, não silenciar o alerta em dias seguintes.
  const today = new Date().toISOString().slice(0, 10);

  for (const user of users) {
    await emailQueue.add(
      'send-email',
      {
        to: user.email,
        subject: `Estoque baixo: ${productName}`,
        template: 'low-stock',
        data: {
          userName: user.name,
          productName,
          currentStock,
          minStock,
          productUrl: `${process.env.WEB_URL}/products/${productId}`,
        },
        companyId,
      },
      { jobId: jobKey('low-stock', companyId, user.email, productId, today) }
    );
  }

  logger.info('Low stock notifications sent', {
    companyId,
    productId,
    productName,
    recipientCount: users.length,
  });
}

/**
 * Notificação de lembrete de pagamento
 */
async function handlePaymentReminderNotification(companyId: string, data: any) {
  const { invoiceId, customerEmail, customerName, amount, dueDate } = data;

  // jobId por dia: mesmo motivo do comentário em handleLowStockNotification —
  // um lembrete de pagamento pode legitimamente repetir em dias diferentes
  // até a fatura ser paga, mas uma reentrega do mesmo job dentro do mesmo dia
  // não deve gerar um segundo e-mail.
  const today = new Date().toISOString().slice(0, 10);

  await emailQueue.add(
    'send-email',
    {
      to: customerEmail,
      subject: 'Lembrete de pagamento',
      template: 'payment-reminder',
      data: {
        customerName,
        invoiceId,
        amount,
        dueDate,
        paymentUrl: `${process.env.WEB_URL}/invoice/${invoiceId}/pay`,
      },
      companyId,
    },
    { jobId: jobKey('payment-reminder', companyId, invoiceId, today) }
  );

  logger.info('Payment reminder notification sent', {
    companyId,
    invoiceId,
    customerEmail,
  });
}

/**
 * Notificação de alerta de venda
 */
async function handleSaleAlertNotification(companyId: string, data: any) {
  const { saleId, total, customerName, sellerName } = data;

  // Buscar proprietários e gerentes
  const users = await prisma.user.findMany({
    where: {
      companyId,
      userType: { in: ['COMPANY_ADMIN', 'MANAGER'] },
      isActive: true,
    },
    select: { email: true, name: true },
  });

  // jobId por venda: saleId é um evento único (uma venda só "acontece" uma
  // vez), então não precisa de componente de data — mesmo motivo do
  // comentário em handleLicenseExpiringNotification (proteção contra
  // redelivery de job "stalled" duplicando o e-mail).
  for (const user of users) {
    await emailQueue.add(
      'send-email',
      {
        to: user.email,
        subject: 'Nova venda realizada',
        template: 'sale-alert',
        data: {
          userName: user.name,
          saleId,
          total,
          customerName,
          sellerName,
          saleUrl: `${process.env.WEB_URL}/sales/${saleId}`,
        },
        companyId,
      },
      { jobId: jobKey('sale-alert', companyId, user.email, saleId) }
    );
  }

  logger.info('Sale alert notifications sent', {
    companyId,
    saleId,
    recipientCount: users.length,
  });
}

/**
 * Notificação de backup completado
 */
async function handleBackupCompletedNotification(companyId: string, data: any) {
  const { filePath } = data;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      users: {
        where: { userType: 'COMPANY_ADMIN' },
        select: { email: true, name: true },
      },
    },
  });

  if (!company) {
    logger.warn('Company not found for backup notification', { companyId });
    return;
  }

  // jobId por arquivo de backup: filePath é único por execução real de
  // backup (BackupService.createBackup), então identifica de forma estável
  // "este backup específico, para este destinatário" — mesmo motivo do
  // comentário em handleLicenseExpiringNotification.
  for (const admin of company.users) {
    await emailQueue.add(
      'send-email',
      {
        to: admin.email,
        subject: 'Backup completado com sucesso',
        template: 'backup-completed',
        data: {
          userName: admin.name,
          companyName: company.name,
          filePath,
          timestamp: new Date().toISOString(),
        },
        companyId,
      },
      { jobId: jobKey('backup-completed', companyId, admin.email, filePath) }
    );
  }

  logger.info('Backup completed notifications sent', {
    companyId,
    recipientCount: company.users.length,
  });
}

/**
 * Verificar licenças expirando (executar diariamente)
 */
export async function checkExpiringLicenses() {
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  // O campo real no schema é `expiryDate`, não `endDate` — esta query nunca
  // retornava resultado algum (ou lançava erro de argumento desconhecido).
  // Bypass de RLS necessário (ver nota em processNotificationJob) — sem
  // ele, esta busca cross-tenant sempre voltava vazia.
  const expiringLicenses = await runWithRLSContext(
    { companyId: null, userType: 'SUPER_ADMIN', branchId: null },
    () =>
      prisma.license.findMany({
        where: {
          expiryDate: {
            lte: thirtyDaysFromNow,
            gte: new Date(),
          },
          status: 'ACTIVE',
        },
        include: {
          company: true,
        },
      })
  );

  logger.info('Checking expiring licenses', {
    count: expiringLicenses.length,
  });

  // Adicionar notificações na fila
  const { notificationQueue } = require('../config/queue');

  for (const license of expiringLicenses) {
    const daysRemaining = Math.ceil(
      (new Date(license.expiryDate!).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    // Notificar em 30, 15, 7, 3 e 1 dia antes
    if ([30, 15, 7, 3, 1].includes(daysRemaining)) {
      // jobId determinístico (license.id + limiar de dias): cada combinação só
      // deveria acontecer uma vez na vida da licença (daysRemaining é
      // recalculado a cada execução diária deste job e decresce
      // monotonicamente), então isso deduplica tanto uma reentrega de job
      // "stalled" quanto uma execução acidental em duplicidade do cron no
      // mesmo dia — mesmo padrão dos jobIds fixos em config/scheduler.ts.
      await notificationQueue.add(
        'process-notification',
        {
          type: 'license-expiring',
          companyId: license.companyId,
          // Repassamos licenseType aqui em vez de o handler ter que buscar de
          // novo — Company tem uma lista `licenses` (não um singular
          // `license`), então "a licença expirando" é justamente esta.
          data: { daysRemaining, licenseType: license.licenseType },
        },
        { jobId: jobKey('notify-license-expiring', license.id, daysRemaining) }
      );
    }
  }
}

/**
 * Verificar produtos com estoque baixo (executar a cada hora)
 *
 * ANTES: usava `prisma.stock` (model que nunca existiu no schema — o saldo é
 * sempre derivado do ledger StockMovement) e `prisma.raw(...)`, que também
 * não é uma API real do Prisma Client (raw SQL usa `$queryRaw`). Esta função
 * nunca executava sem lançar exceção.
 *
 * Saldo agregado no banco por empresa/filial (stockLedger.balances) — antes
 * era uma varredura do histórico inteiro produto a produto.
 */
export async function checkLowStockProducts() {
  // Import tardio proposital: config/queue.ts importa processNotificationJob
  // (deste mesmo arquivo) para montar o Worker — um import estático de
  // notificationQueue aqui no topo do arquivo criaria uma dependência
  // circular entre os dois módulos.
  const { notificationQueue } = require('../config/queue');

  // Bypass de RLS necessário (ver nota em processNotificationJob) — sem
  // ele, `products` sempre vinha vazio (confirmado em execução real:
  // "Checking low stock products {totalProducts: 0}" mesmo com produtos
  // reais cadastrados), então o alerta de estoque baixo nunca disparava
  // para NENHUMA empresa.
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    const products = await prisma.product.findMany({
      where: { isActive: true, minStock: { gt: 0 } },
      select: { id: true, name: true, companyId: true, branchId: true, minStock: true },
    });

    logger.info('Checking low stock products', { totalProducts: products.length });

    // Uma consulta por (empresa, filial do produto) — mesmo escopo que getBalance usava produto a produto.
    const groups = new Map<string, typeof products>();
    for (const p of products) {
      const key = `${p.companyId}|${p.branchId ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const ledger = new Map<string, { balance: number; count: number }>();
    for (const group of groups.values()) {
      const { companyId, branchId } = group[0];
      const balances = await stockLedger.balances({ companyId, branchId, productIds: group.map((p) => p.id) });
      balances.forEach((v, id) => ledger.set(id, v));
    }

    for (const product of products) {
      const { balance, count } = ledger.get(product.id)!;
      const hasMovements = count > 0;

      // ACHADO DE AUDITORIA DE INTEGRAÇÃO: um produto NUNCA inventariado
      // (hasMovements=false) tem balance=0 só porque não há movimentação
      // nenhuma no ledger — não porque o estoque real chegou a zero.
      // Sem esta checagem, todo produto recém-cadastrado com minStock>0
      // disparava um alerta real de "estoque baixo" por e-mail no primeiro
      // ciclo do job, antes mesmo de qualquer compra/venda acontecer.
      if (hasMovements && balance <= product.minStock) {
        // jobId por dia: mesmo motivo do comentário em
        // handleLowStockNotification — deduplica reentrega de job "stalled"
        // dentro do mesmo dia sem silenciar o alerta em dias seguintes,
        // enquanto o produto continuar abaixo do mínimo.
        const today = new Date().toISOString().slice(0, 10);
        await notificationQueue.add(
          'process-notification',
          {
            type: 'low-stock',
            companyId: product.companyId,
            data: {
              productId: product.id,
              productName: product.name,
              currentStock: balance,
              minStock: product.minStock,
              branchId: product.branchId,
            },
          },
          { jobId: jobKey('notify-low-stock', product.id, today) }
        );
      }
    }
  });
}
