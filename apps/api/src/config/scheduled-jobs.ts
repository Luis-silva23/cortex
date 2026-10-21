// Jobs recorrentes adicionados na fila `notification` por setupRecurringJobs (scheduler.ts) e despachados pelo worker
// (queue.ts) para processScheduledJob. Fonte única: job agendado fora desta lista falhava a cada disparo com
// "Unknown notification job" (scheduled-jobs.test.ts confere).
export const SCHEDULED_JOB_NAMES: readonly string[] = [
  'check-expiring-licenses',
  'check-low-stock',
  'cleanup-old-logs',
  'auto-backup',
  'monthly-report',
  'mark-overdue-accounts',
  'reconcile-external-payments',
  'evaluate-health',
  // [orçamentos 2026-09-27] encerra os orçamentos vencidos nas filiais com quote.autoExpire ligado
  'expire-overdue-quotes',
  // [convênios 2026-09-27] bloqueio automático de conveniada inadimplente (política; cobrança continua manual)
  'auto-block-agreement-companies',
  // [reservas 2026-10-05] expira reservas de estoque de pedidos externos vencidas (a disponibilidade já ignora as vencidas na hora)
  'expire-stock-reservations',
  // [Integration Gateway 2026-10-06] caixa de saída dos canais (envio ao provedor) e consulta periódica de eventos
  'process-channel-outbox',
  'poll-channel-events',
  // [LGPD 2026-10-14] apaga o conteúdo das exportações de titular vencidas (validade de 24 h; decisão 120)
  'purge-privacy-exports',
];
