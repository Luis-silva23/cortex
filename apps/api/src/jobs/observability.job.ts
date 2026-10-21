import type { Job } from 'bullmq';
import { prisma, runWithRLSContext } from '@ln-system/database';

/**
 * Persistência assíncrona de métricas de requisição e logs técnicos —
 * mesmo padrão de audit.job.ts (fila BullMQ), mas com prioridade
 * diferente: ao contrário de auditoria de negócio, perder uma métrica
 * isolada não é crítico (por isso `removeOnFail` finito nestas filas, ver
 * config/queue.ts, em vez de nunca-descartar como na fila de auditoria).
 */

export interface RequestLogJobData {
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  companyId?: string | null;
  branchId?: string | null;
  userId?: string | null;
  device?: string | null;
}

export async function processRequestLogJob(job: Job<RequestLogJobData>) {
  const data = job.data;
  // Workers do BullMQ rodam FORA de qualquer requisição HTTP — não existe
  // AsyncLocalStorage de RLS ativo aqui (só populado por `tenantIsolation`
  // dentro de uma requisição real). Sem este bypass explícito, TODA escrita
  // aqui era negada pela RLS (`FORCE ROW LEVEL SECURITY` também vale para o
  // dono da tabela) — confirmado em produção real desta sessão: nenhum
  // RequestLog/SystemLog/AuditLog assíncrono foi persistido no banco desde
  // que a RLS entrou em vigor na FASE 1, apenas o log local (console/
  // winston) funcionava, mascarando o problema. Mesmo bypass usado em
  // login/logout (pré-tenant): estas são escritas de SISTEMA, não de um
  // usuário de uma empresa específica — o companyId gravado (quando
  // presente) vem do `job.data`, nunca do contexto de sessão.
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    await prisma.requestLog.create({
      data: {
        requestId: data.requestId,
        method: data.method,
        route: data.route,
        statusCode: data.statusCode,
        durationMs: data.durationMs,
        companyId: data.companyId ?? null,
        branchId: data.branchId ?? null,
        userId: data.userId ?? null,
        device: data.device ?? null,
      },
    });
  });
}

export interface SystemLogJobData {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  category: 'application' | 'security' | 'integration' | 'performance';
  service: string;
  event: string;
  message: string;
  requestId?: string | null;
  companyId?: string | null;
  branchId?: string | null;
  userId?: string | null;
  device?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  stackTrace?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function processSystemLogJob(job: Job<SystemLogJobData>) {
  const data = job.data;
  // Ver nota em processRequestLogJob sobre o bypass de RLS ser necessário
  // em todo worker do BullMQ.
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    await prisma.systemLog.create({
      data: {
        level: data.level,
        category: data.category,
        service: data.service,
        event: data.event,
        message: data.message,
        requestId: data.requestId ?? null,
        companyId: data.companyId ?? null,
        branchId: data.branchId ?? null,
        userId: data.userId ?? null,
        device: data.device ?? null,
        durationMs: data.durationMs ?? null,
        errorMessage: data.errorMessage ?? null,
        stackTrace: data.stackTrace ?? null,
        metadata: (data.metadata as any) ?? undefined,
      },
    });
  });
}
