import { prisma, Prisma } from '@ln-system/database';

/**
 * Consulta de trilha de auditoria (`AuditLog`) — a tabela era escrita há
 * sessões inteiras (middleware/audit.ts::auditLog aplicado em praticamente
 * toda rota de CREATE/UPDATE/DELETE do sistema, mais createAuditLog() para
 * login/logout), mas não existia NENHUMA rota para lê-la de volta: uma
 * trilha de auditoria só de escrita não serve ao seu propósito ("quem fez
 * o quê, quando"). `companyId` é nullable no schema — ações de escopo de
 * plataforma (aprovação de licença, ativação de dispositivo por Super
 * Admin) ficam com companyId null; a RLS (`audit_logs_isolation`, via
 * `rls_company_match`) já trata null como "só Super Admin enxerga".
 */
export class AuditLogService {
  async list(filters: {
    companyId?: string;
    userId?: string;
    action?: string;
    entity?: string;
    entityId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 50;

    const where: Prisma.AuditLogWhereInput = {
      ...(filters.companyId && { companyId: filters.companyId }),
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.action && { action: filters.action as any }),
      ...(filters.entity && { entity: filters.entity }),
      ...(filters.entityId && { entityId: filters.entityId }),
      ...((filters.startDate || filters.endDate) && {
        createdAt: {
          ...(filters.startDate && { gte: new Date(filters.startDate) }),
          ...(filters.endDate && { lte: new Date(filters.endDate) }),
        },
      }),
    };

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, numericId: true, userType: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getById(id: string, companyId?: string) {
    return prisma.auditLog.findFirst({
      where: { id, ...(companyId ? { companyId } : {}) },
      include: {
        user: { select: { id: true, name: true, numericId: true, userType: true } },
      },
    });
  }

  /** Histórico de um registro específico (ex.: todas as alterações de um Product) — usado em telas de "histórico" de uma entidade. */
  async listForEntity(entity: string, entityId: string, companyId?: string) {
    return prisma.auditLog.findMany({
      where: { entity, entityId, ...(companyId ? { companyId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, numericId: true, userType: true } },
      },
    });
  }
}

export default new AuditLogService();
