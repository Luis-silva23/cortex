import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { ConflictError } from '@ln-system/shared';

export class FollowUpService {
  async create(data: {
    companyId: string;
    branchId?: string;
    revisionId?: string;
    customerId: string;
    motorcycleId: string;
    dueDate: Date;
    notes?: string;
    createdBy: string;
  }) {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, companyId: data.companyId },
      select: { id: true },
    });
    if (!customer) {
      throw new Error('Customer not found');
    }

    const motorcycle = await prisma.motorcycle.findFirst({
      where: { id: data.motorcycleId, companyId: data.companyId, customerId: data.customerId },
      select: { id: true },
    });
    if (!motorcycle) {
      throw new Error('Motorcycle not found for this customer');
    }

    if (data.revisionId) {
      const revision = await prisma.revision.findFirst({
        where: { id: data.revisionId, companyId: data.companyId },
        select: { id: true, customerId: true, motorcycleId: true },
      });
      if (!revision) {
        throw new Error('Revision not found');
      }
      // Mesma classe de achado corrigida em revision.service.ts: a revisão
      // referenciada precisa ser do MESMO cliente/moto do follow-up, senão
      // o pós-venda de um veículo fica silenciosamente atrelado ao
      // histórico de revisão de outro.
      if (revision.customerId !== data.customerId || revision.motorcycleId !== data.motorcycleId) {
        throw new Error('Revision does not belong to the given customer/motorcycle');
      }
    }

    return prisma.followUp.create({
      data: {
        companyId: data.companyId,
        branchId: data.branchId,
        revisionId: data.revisionId,
        customerId: data.customerId,
        motorcycleId: data.motorcycleId,
        dueDate: data.dueDate,
        createdBy: data.createdBy,
        notes: data.notes,
      },
      include: { customer: true, motorcycle: true },
    });
  }

  async getById(id: string, companyId: string) {
    return prisma.followUp.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        motorcycle: true,
        revision: true,
        appointment: true,
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async list(filters: {
    companyId: string;
    branchId?: string;
    status?: string;
    customerId?: string;
    page: number;
    limit: number;
  }) {
    const where: any = { companyId: filters.companyId };
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;

    const [followUps, total] = await Promise.all([
      prisma.followUp.findMany({
        where,
        include: { customer: true, motorcycle: true, appointment: true },
        orderBy: { dueDate: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.followUp.count({ where }),
    ]);

    return { followUps, pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) } };
  }

  // Dashboard de pós-venda (seção 28 do domínio): exatamente os 3 baldes —
  // de propósito NÃO existe "Aguardando contato" como status, então não há
  // um 4º balde aqui. Tentativas de contato ficam só no histórico
  // (FollowUpEvent), nunca mudam este agrupamento.
  async dashboard(companyId: string, branchId?: string) {
    const where: any = { companyId };
    if (branchId) where.branchId = branchId;

    const [pending, scheduled, cancelled] = await Promise.all([
      prisma.followUp.count({ where: { ...where, status: 'PENDING' } }),
      prisma.followUp.count({ where: { ...where, status: 'SCHEDULED' } }),
      prisma.followUp.count({ where: { ...where, status: 'CANCELLED' } }),
    ]);

    return {
      upcomingRevisions: pending,
      scheduled,
      cancelled,
    };
  }

  private async assertPending(id: string, companyId: string) {
    const followUp = await prisma.followUp.findFirst({ where: { id, companyId } });
    if (!followUp) {
      throw new Error('Follow-up not found');
    }
    if (followUp.status !== 'PENDING') {
      throw new Error(`Follow-up is ${followUp.status}, not PENDING`);
    }
    return followUp;
  }

  // Registrar uma tentativa de contato — NUNCA muda o status (ver
  // comentário no schema). Só adiciona ao histórico.
  async logContact(id: string, companyId: string, data: { channel: string; message?: string; performedBy: string }) {
    const followUp = await prisma.followUp.findFirst({ where: { id, companyId } });
    if (!followUp) {
      throw new Error('Follow-up not found');
    }

    return prisma.followUpEvent.create({
      data: {
        followUpId: id,
        eventType: 'CONTACT_ATTEMPTED',
        channel: data.channel as any,
        message: data.message,
        performedBy: data.performedBy,
      },
    });
  }

  // O cliente aceitou ser contatado/agendar, mas isso ainda NÃO agenda nada
  // — o balde do dashboard só muda para "Agendadas" quando existir um
  // Appointment de verdade (ver AppointmentService.propose). Aceitar fica
  // registrado no histórico; o FollowUp continua PENDING até lá.
  async recordAcceptance(id: string, companyId: string, data: { performedBy: string; notes?: string }) {
    await this.assertPending(id, companyId);
    return prisma.followUpEvent.create({
      data: {
        followUpId: id,
        eventType: 'CUSTOMER_ACCEPTED',
        message: data.notes,
        performedBy: data.performedBy,
      },
    });
  }

  async decline(id: string, companyId: string, data: { reason?: string; performedBy: string }) {
    await this.assertPending(id, companyId);
    return runInTransaction(async (tx) => {
      const followUp = await this.closeFollowUp(tx, id, ['PENDING']);
      await tx.followUpEvent.create({
        data: {
          followUpId: id,
          eventType: 'CUSTOMER_DECLINED',
          message: data.reason,
          performedBy: data.performedBy,
        },
      });
      return followUp;
    });
  }

  // Cancelar o pós-venda também cancela o agendamento ATIVO ligado a ele (antes o agendamento ficava ativo, apontando
  // para um pós-venda cancelado).
  async cancel(id: string, companyId: string, data: { reason?: string; performedBy: string }) {
    const followUp = await prisma.followUp.findFirst({ where: { id, companyId } });
    if (!followUp) {
      throw new Error('Follow-up not found');
    }
    if (followUp.status === 'CANCELLED') {
      throw new Error('Follow-up is already cancelled');
    }
    return runInTransaction(async (tx) => {
      const closed = await this.closeFollowUp(tx, id, ['PENDING', 'SCHEDULED']);
      await tx.followUpEvent.create({
        data: {
          followUpId: id,
          eventType: 'CUSTOMER_CANCELLED',
          message: data.reason,
          performedBy: data.performedBy,
        },
      });
      const appointment = await tx.appointment.findFirst({ where: { followUpId: id, status: { in: ['PROPOSED', 'CONFIRMED'] } }, select: { id: true } });
      if (appointment) {
        const cancelled = await tx.appointment.updateMany({ where: { id: appointment.id, status: { in: ['PROPOSED', 'CONFIRMED'] } }, data: { status: 'CANCELLED' } });
        if (cancelled.count === 1) {
          await tx.appointmentEvent.create({
            data: { appointmentId: appointment.id, eventType: 'CANCELLED', reason: `Pós-venda cancelado${data.reason ? `: ${data.reason}` : ''}`, performedBy: data.performedBy },
          });
        }
      }
      return closed;
    });
  }

  /** PENDING/SCHEDULED → CANCELLED com guarda: duas ações simultâneas não passam as duas. */
  private async closeFollowUp(tx: PrismaTransactionClient, id: string, from: Array<'PENDING' | 'SCHEDULED'>) {
    const done = await tx.followUp.updateMany({ where: { id, status: { in: from } }, data: { status: 'CANCELLED' } });
    if (done.count === 0) {
      throw new ConflictError('O pós-venda mudou de situação enquanto esta ação era feita. Atualize e tente de novo.', 'FOLLOW_UP_STATUS_CHANGED');
    }
    return tx.followUp.findUniqueOrThrow({ where: { id } });
  }
}

export default new FollowUpService();
