import type { Job } from 'bullmq';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { Logger } from '../services/logger.service';

export interface AuditJobData {
  /**
   * Identidade do registro de auditoria, gerada ANTES de enfileirar. Serve de `jobId` da fila e de chave primária da linha: a mesma
   * auditoria entregue duas vezes (fila + gravação direta de reserva) vira UMA linha só.
   */
  id?: string;
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Persiste um registro de auditoria no PostgreSQL (fonte da verdade).
 * Auditoria nunca deve ser perdida silenciosamente: se a escrita falhar,
 * o erro é propagado para que o BullMQ aplique retry/backoff/DLQ
 * (configurados na fila `audit-log` em config/queue.ts), em vez de
 * engolir o erro e fingir que o log foi criado.
 */
export async function persistAuditLog(data: AuditJobData): Promise<void> {
  // Ver nota equivalente em observability.job.ts: worker do BullMQ roda
  // fora de qualquer requisição HTTP, sem contexto de RLS — sem este
  // bypass, TODA gravação de AuditLog assíncrona (a maioria do sistema,
  // via middleware `auditLog()`) era negada pela RLS desde a FASE 1,
  // silenciosamente (o job falhava, ia para retry/DLQ, nunca aparecia
  // como auditoria persistida de verdade). Escrita de sistema, não de uma
  // empresa específica — companyId vem do `job.data`, não da sessão.
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    // ACHADO DE AUDITORIA: se o usuário referenciado por este job for
    // apagado de verdade (DELETE /users/:id -> user.service.ts::delete,
    // hard delete real) entre a ação original e o processamento
    // assíncrono deste job, um INSERT com esse userId viola a FK e faz
    // TODO o registro (ação, entidade, valores antigo/novo) ser perdido
    // — justo no cenário de maior risco: um usuário apagado logo após uma
    // ação suspeita é exatamente quando a trilha de auditoria mais
    // importa. `onDelete: SetNull` no schema já degrada graciosamente
    // linhas EXISTENTES quando o usuário é apagado depois delas — mas não
    // cobre um INSERT novo cujo usuário já não existe MAIS no momento em
    // que o job roda. Replicamos aqui a mesma degradação graciosa: se o
    // usuário já não existe, grava com userId nulo em vez de perder o
    // registro inteiro (ação/entidade/valores continuam preservados).
    let userId = data.userId ?? null;
    if (userId) {
      const stillExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!stillExists) {
        userId = null;
      }
    }

    try {
      await prisma.auditLog.create({
        data: {
          ...(data.id ? { id: data.id } : {}),
          companyId: data.companyId ?? null,
          userId,
          action: data.action as any,
          entity: data.entity,
          entityId: data.entityId ?? null,
          oldValue: data.oldValue ?? null,
          newValue: data.newValue ?? null,
          ipAddress: data.ipAddress ?? null,
          userAgent: data.userAgent ?? null,
        },
      });
    } catch (error) {
      // Mesma auditoria já gravada (id repetido): idempotente, nada a fazer.
      if (data.id && (error as { code?: string })?.code === 'P2002') return;
      throw error;
    }
  });
}

/** Job da fila `audit-log`: grava (idempotente) e registra no log da aplicação. Erro propaga para o retry/DLQ do BullMQ. */
export async function processAuditJob(job: Job<AuditJobData>) {
  const data = job.data;
  await persistAuditLog(data);
  Logger.audit(data.action, data.userId || 'unknown', data.entity, data.entityId || '');
}
