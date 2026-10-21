import { prisma } from '@ln-system/database';

/**
 * Comissão de mecânico (FASE 27) — `MechanicCommission` já é criada por
 * `ServiceOrderService.registerPayment()` quando a OS é paga (nunca antes:
 * "comissão não deve ser criada falsamente antes do evento financeiro
 * correto"), mas o registro ficava com `isPaid=false` para sempre — não
 * existia nenhuma forma de listar comissões pendentes de um mecânico nem de
 * marcá-las como efetivamente pagas. Gap real, corrigido aqui.
 */
export class MechanicService {
  async listCommissions(
    companyId: string,
    filters: { mechanicId?: string; isPaid?: boolean; page?: number; limit?: number }
  ) {
    const { mechanicId, isPaid, page = 1, limit = 20 } = filters;
    const where = {
      companyId,
      ...(mechanicId && { mechanicId }),
      ...(isPaid !== undefined && { isPaid }),
    };

    const [commissions, total] = await Promise.all([
      prisma.mechanicCommission.findMany({
        where,
        include: {
          serviceOrder: { select: { id: true, osNumber: true, status: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.mechanicCommission.count({ where }),
    ]);

    return { commissions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Soma das comissões pendentes de um mecânico — usado para a tela de
   * "a pagar" antes de liquidar em lote.
   */
  async getPendingSummary(companyId: string, mechanicId: string) {
    const pending = await prisma.mechanicCommission.aggregate({
      where: { companyId, mechanicId, isPaid: false },
      _sum: { commissionAmount: true },
      _count: true,
    });
    return {
      mechanicId,
      pendingCount: pending._count,
      pendingAmount: Number(pending._sum.commissionAmount ?? 0),
    };
  }

  /** Marca uma comissão como paga — nunca reescreve o valor/regra original. */
  async payCommission(commissionId: string, companyId: string) {
    const commission = await prisma.mechanicCommission.findFirst({ where: { id: commissionId, companyId } });
    if (!commission) {
      throw new Error('Comissão não encontrada');
    }
    if (commission.isPaid) {
      throw new Error('Esta comissão já foi paga');
    }
    return prisma.mechanicCommission.update({
      where: { id: commission.id },
      data: { isPaid: true, paidAt: new Date() },
    });
  }
}

export default new MechanicService();
