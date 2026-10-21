import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { ContactChannel } from '@prisma/client';
import { AppError, ConflictError } from '@ln-system/shared';
import { policyService } from './policy.service';
import {
  agendaWindow,
  assertAgendaCapacity,
  assertMechanicForBranch,
  assertWindowInBusinessHours,
  effectiveDuration,
} from './agenda-capacity.service';
import { verifyDualAuthorization } from './dual-authorization.service';
import { translateMessage } from '../middleware/translate-errors';
import type { SystemLogContext } from './logger.service';

// Estados em que o agendamento ainda pode mudar. Toda transição grava com guarda neste estado (updateMany + count):
// duas ações simultâneas (ex.: confirmar × cancelar) nunca passam as duas.
const ACTIVE: Array<'PROPOSED' | 'CONFIRMED'> = ['PROPOSED', 'CONFIRMED'];

/** Motivo mínimo para concluir sem a confirmação do cliente. */
export const COMPLETION_REASON_MIN = 10;

export interface CompletionAuthorization {
  authorizerNumericId: number;
  authorizerPassword: string;
  authorizerMfaCode?: string;
  reason: string;
}

export { slotOf } from './agenda-capacity.service';

/**
 * Regras de horário e capacidade da agenda (docs/CORTEX/policies/AGENDA.md), aplicadas a TODO caminho que define horário
 * (propor e remarcar) — implementação em agenda-capacity.service.ts:
 * 1. Janela = [início, início + duração); duração = a do agendamento → `agenda.defaultDurationMinutes` → um horário.
 * 2. `agenda.respectBusinessHours` + horário cadastrado → a janela inteira precisa caber: 409 OUTSIDE_BUSINESS_HOURS.
 * 3. Sob trava por filial (e por mecânico), na mesma transação da gravação: indisponibilidade (AGENDA_UNAVAILABLE /
 *    MECHANIC_UNAVAILABLE), mecânico ocupado (MECHANIC_CONFLICT), `agenda.maxPerSlot` (SLOT_FULL), `agenda.boxCount`
 *    (NO_BOX_AVAILABLE), `agenda.maxPerDay` (DAY_FULL), `agenda.maxPerMonth` (MONTH_FULL). Todos 409.
 */
async function prepareWindow(input: {
  companyId: string;
  branchId: string | null | undefined;
  scheduledAt: Date;
  durationMinutes: number | null | undefined;
  mechanicId: string | null | undefined;
  validateMechanic: boolean;
}) {
  if (input.mechanicId && input.validateMechanic) await assertMechanicForBranch(input.companyId, input.branchId, input.mechanicId);
  const policies = await policyService.effective(input.companyId, input.branchId);
  const window = agendaWindow(input.scheduledAt, input.durationMinutes, policies);
  await assertWindowInBusinessHours(input.companyId, input.branchId, window, policies);
  return { policies, window };
}

export class AppointmentService {
  // A equipe PROPÕE um horário — isso NÃO é confirmação (ver
  // customerConfirmed no schema). Se ligado a um FollowUp, o follow-up
  // muda para SCHEDULED atomicamente (mesma transação) — é isso que tira o
  // cliente do balde "Próximas revisões" e o coloca em "Agendadas" no
  // dashboard.
  async propose(data: {
    companyId: string;
    branchId?: string;
    followUpId?: string;
    customerId: string;
    motorcycleId?: string;
    scheduledAt: Date;
    /** Duração prevista (min); vazio = política da filial. */
    durationMinutes?: number | null;
    /** Mecânico previsto (opcional). */
    mechanicId?: string | null;
    notes?: string;
    proposedBy: string;
  }) {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, companyId: data.companyId },
      select: { id: true },
    });
    if (!customer) {
      throw new Error('Customer not found');
    }

    if (data.motorcycleId) {
      const motorcycle = await prisma.motorcycle.findFirst({
        where: { id: data.motorcycleId, companyId: data.companyId, customerId: data.customerId },
        select: { id: true },
      });
      if (!motorcycle) {
        throw new Error('Motorcycle not found for this customer');
      }
    }

    let replacedAppointmentId: string | null = null;
    if (data.followUpId) {
      const followUp = await prisma.followUp.findFirst({ where: { id: data.followUpId, companyId: data.companyId } });
      if (!followUp) {
        throw new Error('Follow-up not found');
      }
      if (followUp.status === 'CANCELLED') {
        throw new Error('Cannot schedule an appointment for a cancelled follow-up');
      }
      // O agendamento tem de ser do mesmo cliente/moto do pós-venda (antes aceitava outro cliente).
      if (followUp.customerId !== data.customerId || (followUp.motorcycleId && data.motorcycleId && followUp.motorcycleId !== data.motorcycleId)) {
        throw new AppError('O pós-venda é de outro cliente ou outra moto', 400, 'FOLLOW_UP_MISMATCH');
      }
      const existingAppointment = await prisma.appointment.findUnique({ where: { followUpId: data.followUpId } });
      if (existingAppointment) {
        // Ativo: remarque o existente. Encerrado (cancelado/não compareceu): uma nova proposta substitui o antigo, que
        // perde o vínculo (antes o pós-venda ficava preso: nem propor de novo, nem remarcar o cancelado).
        if (ACTIVE.includes(existingAppointment.status as (typeof ACTIVE)[number])) {
          throw new Error('This follow-up already has an appointment — reschedule the existing one instead');
        }
        replacedAppointmentId = existingAppointment.id;
      }
    }

    const { policies, window } = await prepareWindow({
      companyId: data.companyId,
      branchId: data.branchId,
      scheduledAt: data.scheduledAt,
      durationMinutes: data.durationMinutes,
      mechanicId: data.mechanicId,
      validateMechanic: true,
    });

    return runInTransaction(async (tx) => {
      await assertAgendaCapacity(tx, { companyId: data.companyId, branchId: data.branchId, window, mechanicId: data.mechanicId, policies });

      if (data.followUpId) {
        if (replacedAppointmentId) {
          const unlinked = await tx.appointment.updateMany({
            where: { id: replacedAppointmentId, followUpId: data.followUpId, status: { notIn: ACTIVE } },
            data: { followUpId: null },
          });
          if (unlinked.count === 0) throw new ConflictError('O agendamento anterior mudou de situação. Atualize e tente de novo.', 'APPOINTMENT_STATUS_CHANGED');
        }
        const scheduled = await tx.followUp.updateMany({ where: { id: data.followUpId, status: { not: 'CANCELLED' } }, data: { status: 'SCHEDULED' } });
        if (scheduled.count === 0) throw new Error('Cannot schedule an appointment for a cancelled follow-up');
      }

      const appointment = await tx.appointment.create({
        data: {
          companyId: data.companyId,
          branchId: data.branchId,
          followUpId: data.followUpId,
          customerId: data.customerId,
          motorcycleId: data.motorcycleId,
          scheduledAt: data.scheduledAt,
          durationMinutes: data.durationMinutes ?? null,
          mechanicId: data.mechanicId ?? null,
          proposedBy: data.proposedBy,
          notes: data.notes,
        },
      });

      await tx.appointmentEvent.create({
        data: {
          appointmentId: appointment.id,
          eventType: 'PROPOSED',
          newScheduledAt: data.scheduledAt,
          performedBy: data.proposedBy,
          reason: replacedAppointmentId ? `Substitui o agendamento ${replacedAppointmentId} (encerrado)` : undefined,
        },
      });

      return appointment;
    });
  }

  async getById(id: string, companyId: string) {
    return prisma.appointment.findFirst({
      where: { id, companyId },
      include: { customer: true, motorcycle: true, followUp: true, events: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async list(filters: {
    companyId: string;
    branchId?: string;
    status?: string;
    customerId?: string;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }) {
    const where: any = { companyId: filters.companyId };
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.from || filters.to) {
      where.scheduledAt = {};
      if (filters.from) where.scheduledAt.gte = filters.from;
      if (filters.to) where.scheduledAt.lte = filters.to;
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include: { customer: true, motorcycle: true },
        orderBy: { scheduledAt: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.appointment.count({ where }),
    ]);

    // Para as telas: nome do mecânico previsto (sem FK no schema) e a duração efetiva (a do agendamento ou a da política
    // da filial dele).
    const mechanicIds = [...new Set(appointments.map((a) => a.mechanicId).filter((m): m is string => !!m))];
    const mechanics = mechanicIds.length
      ? await prisma.user.findMany({ where: { id: { in: mechanicIds }, companyId: filters.companyId }, select: { id: true, name: true } })
      : [];
    const branchIds = [...new Set(appointments.map((a) => a.branchId ?? null))];
    const policiesByBranch = new Map(
      await Promise.all(branchIds.map(async (b) => [b, await policyService.effective(filters.companyId, b)] as const))
    );
    const enriched = appointments.map((a) => ({
      ...a,
      mechanic: a.mechanicId ? (mechanics.find((m) => m.id === a.mechanicId) ?? { id: a.mechanicId, name: null }) : null,
      effectiveDurationMinutes: effectiveDuration(a.durationMinutes, policiesByBranch.get(a.branchId ?? null)!),
    }));

    return { appointments: enriched, pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) } };
  }

  private async assertActive(id: string, companyId: string) {
    const appointment = await prisma.appointment.findFirst({ where: { id, companyId } });
    if (!appointment) {
      throw new Error('Appointment not found');
    }
    if (['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(appointment.status)) {
      throw new Error(`Appointment is ${appointment.status} and can no longer be changed`);
    }
    return appointment;
  }

  /** Grava a transição só se o agendamento ainda estiver num dos estados esperados. */
  private async transition(tx: PrismaTransactionClient, id: string, from: readonly string[], data: Record<string, unknown>) {
    const done = await tx.appointment.updateMany({ where: { id, status: { in: [...from] as any } }, data });
    if (done.count === 0) {
      throw new ConflictError('O agendamento mudou de situação enquanto esta ação era feita. Atualize e tente de novo.', 'APPOINTMENT_STATUS_CHANGED');
    }
    return tx.appointment.findUniqueOrThrow({ where: { id } });
  }

  // REGRA FUNDAMENTAL do domínio: isto é a única forma de customerConfirmed virar true. `performedBy` é o funcionário
  // que REGISTRA (o cliente não tem login); quem CONFIRMOU — o cliente ou o responsável pelo veículo — e por qual
  // canal ficam gravados junto (obrigatórios). Só confirma o que está PROPOSTO (confirmar de novo não reescreve).
  async confirm(id: string, companyId: string, data: { performedBy: string; channel: ContactChannel; confirmedByName: string; notes?: string }) {
    await this.assertActive(id, companyId);
    return runInTransaction(async (tx) => {
      const updated = await this.transition(tx, id, ['PROPOSED'], {
        status: 'CONFIRMED',
        customerConfirmed: true,
        confirmedAt: new Date(),
        confirmationChannel: data.channel,
        confirmedByName: data.confirmedByName,
      });
      await tx.appointmentEvent.create({
        data: {
          appointmentId: id,
          eventType: 'CONFIRMED',
          reason: [`Confirmado por ${data.confirmedByName} (${data.channel})`, data.notes].filter(Boolean).join(' — '),
          performedBy: data.performedBy,
        },
      });
      return updated;
    });
  }

  // Reagendar reseta a confirmação — uma confirmação para um horário
  // específico não vale automaticamente para outro horário.
  // Duração e mecânico: ausentes = mantém os do agendamento; `null` = limpa (volta à duração da política / sem mecânico).
  async reschedule(
    id: string,
    companyId: string,
    data: { newScheduledAt: Date; reason?: string; performedBy: string; durationMinutes?: number | null; mechanicId?: string | null }
  ) {
    const appointment = await this.assertActive(id, companyId);
    const durationMinutes = data.durationMinutes !== undefined ? data.durationMinutes : (appointment.durationMinutes ?? null);
    const mechanicId = data.mechanicId !== undefined ? data.mechanicId : (appointment.mechanicId ?? null);
    const { policies, window } = await prepareWindow({
      companyId,
      branchId: appointment.branchId,
      scheduledAt: data.newScheduledAt,
      durationMinutes,
      mechanicId,
      // Mecânico trocado é validado; o que já estava no agendamento não é revalidado a cada remarcação.
      validateMechanic: data.mechanicId !== undefined && data.mechanicId !== appointment.mechanicId,
    });
    return runInTransaction(async (tx) => {
      // O próprio agendamento não conta contra a nova janela (remarcar dentro do mesmo horário não "lota" a si mesmo).
      await assertAgendaCapacity(tx, { companyId, branchId: appointment.branchId, window, mechanicId, excludeId: id, policies });
      const updated = await this.transition(tx, id, ACTIVE, {
        scheduledAt: data.newScheduledAt,
        ...(data.durationMinutes !== undefined ? { durationMinutes: data.durationMinutes } : {}),
        ...(data.mechanicId !== undefined ? { mechanicId: data.mechanicId } : {}),
        status: 'PROPOSED',
        customerConfirmed: false,
        confirmedAt: null,
        confirmationChannel: null,
        confirmedByName: null,
      });
      await tx.appointmentEvent.create({
        data: {
          appointmentId: id,
          eventType: 'RESCHEDULED',
          previousScheduledAt: appointment.scheduledAt,
          newScheduledAt: data.newScheduledAt,
          reason: data.reason,
          performedBy: data.performedBy,
        },
      });
      return updated;
    });
  }

  // Cancelar o agendamento devolve o follow-up ligado para PENDING (volta
  // ao balde "Próximas revisões" para uma nova tentativa) — não cancela o
  // follow-up em si; para isso existe FollowUpService.cancel.
  async cancel(id: string, companyId: string, data: { reason?: string; performedBy: string }) {
    const appointment = await this.assertActive(id, companyId);
    return runInTransaction(async (tx) => {
      const updated = await this.transition(tx, id, ACTIVE, { status: 'CANCELLED' });
      await tx.appointmentEvent.create({
        data: { appointmentId: id, eventType: 'CANCELLED', reason: data.reason, performedBy: data.performedBy },
      });
      if (appointment.followUpId) {
        // só um pós-venda ainda AGENDADO volta para pendente (cancelado continua cancelado)
        await tx.followUp.updateMany({ where: { id: appointment.followUpId, status: 'SCHEDULED' }, data: { status: 'PENDING' } });
      }
      return updated;
    });
  }

  /**
   * Concluir. A confirmação definitiva é do CLIENTE: com `agenda.requireCustomerConfirmation` (padrão), agendamento não
   * confirmado só é concluído com autorização presencial de um responsável interno (`agenda.completionAuthorizerRoles`,
   * ≠ quem solicita, senha e MFA do autorizador — verifyDualAuthorization) e motivo (mín. 10). Sem autorização:
   * 409 APPOINTMENT_NOT_CONFIRMED (a tela abre o pedido de autorização). A guarda de estado na gravação separa os dois
   * caminhos: o "confirmado" só grava se ainda estiver CONFIRMED com confirmação do cliente; o "autorizado" só se ainda
   * estiver PROPOSED — remarcar/confirmar no meio do caminho vira 409, nunca uma conclusão pelo caminho errado.
   */
  async complete(
    id: string,
    companyId: string,
    data: { performedBy: string; notes?: string; authorization?: CompletionAuthorization; securityContext?: SystemLogContext }
  ) {
    const appointment = await this.assertActive(id, companyId);

    if (appointment.status === 'CONFIRMED' && appointment.customerConfirmed) {
      return runInTransaction(async (tx) => {
        const updated = await this.transition(tx, id, ['CONFIRMED'], { status: 'COMPLETED' });
        await tx.appointmentEvent.create({
          data: { appointmentId: id, eventType: 'COMPLETED', reason: data.notes, performedBy: data.performedBy },
        });
        return updated;
      });
    }

    const requireConfirmation = await policyService.get(companyId, appointment.branchId, 'agenda.requireCustomerConfirmation');
    if (!requireConfirmation) {
      // Política da empresa não exige a confirmação: conclui, mas fica registrado que foi sem ela.
      return runInTransaction(async (tx) => {
        const updated = await this.transition(tx, id, ['PROPOSED'], {
          status: 'COMPLETED',
          completedWithoutConfirmation: true,
          completionReason: data.notes ?? null,
        });
        await tx.appointmentEvent.create({
          data: {
            appointmentId: id,
            eventType: 'COMPLETED',
            reason: ['Concluído sem confirmação do cliente (a política da empresa não exige)', data.notes].filter(Boolean).join(' — '),
            performedBy: data.performedBy,
          },
        });
        return updated;
      });
    }

    const auth = data.authorization;
    if (!auth) {
      throw new AppError(
        'O cliente ainda não confirmou este agendamento. Para concluir sem a confirmação, é preciso a autorização de um responsável e o motivo.',
        409,
        'APPOINTMENT_NOT_CONFIRMED'
      );
    }
    const reason = typeof auth.reason === 'string' ? auth.reason.trim() : '';
    if (reason.length < COMPLETION_REASON_MIN) {
      throw new AppError(`Informe o motivo para concluir sem a confirmação do cliente (mínimo ${COMPLETION_REASON_MIN} caracteres)`, 400, 'REASON_REQUIRED');
    }
    if (!Number.isInteger(auth.authorizerNumericId) || auth.authorizerNumericId <= 0 || typeof auth.authorizerPassword !== 'string' || auth.authorizerPassword === '') {
      throw new AppError('Informe o código e a senha do responsável que autoriza', 400, 'AUTHORIZER_REQUIRED');
    }

    let authorizer: Awaited<ReturnType<typeof verifyDualAuthorization>>;
    try {
      authorizer = await verifyDualAuthorization({
        companyId,
        requesterId: data.performedBy,
        authorizerNumericId: auth.authorizerNumericId,
        authorizerPassword: auth.authorizerPassword,
        authorizerMfaCode: auth.authorizerMfaCode,
        allowedRoles: await policyService.get(companyId, appointment.branchId, 'agenda.completionAuthorizerRoles'),
        actionEvent: 'APPOINTMENT_COMPLETION',
        subjectLabel: 'conclusão de agendamento sem confirmação do cliente',
        securityContext: { ...(data.securityContext ?? {}), companyId, userId: data.performedBy },
      });
    } catch (error: any) {
      // Autorizador inexistente, sem perfil, a própria pessoa, senha/MFA errados: recusa de permissão (403), não 500.
      throw new AppError(translateMessage(String(error?.message ?? 'Autorização recusada')), 403, 'AUTHORIZATION_FAILED');
    }

    return runInTransaction(async (tx) => {
      const updated = await this.transition(tx, id, ['PROPOSED'], {
        status: 'COMPLETED',
        completedWithoutConfirmation: true,
        completionAuthorizedBy: authorizer.id,
        completionReason: reason,
      });
      await tx.appointmentEvent.create({
        data: {
          appointmentId: id,
          eventType: 'COMPLETED',
          reason: `Concluído SEM confirmação do cliente — autorizado por ${authorizer.name} (#${authorizer.numericId}): ${reason}${data.notes ? ` — ${data.notes}` : ''}`,
          performedBy: data.performedBy,
        },
      });
      return updated;
    });
  }

  // "Não compareceu" só depois do horário marcado.
  async markNoShow(id: string, companyId: string, data: { performedBy: string; notes?: string }, now = new Date()) {
    const appointment = await this.assertActive(id, companyId);
    if (appointment.scheduledAt.getTime() > now.getTime()) {
      throw new AppError('Só é possível marcar "não compareceu" depois do horário agendado', 400, 'NO_SHOW_BEFORE_SLOT');
    }
    return runInTransaction(async (tx) => {
      const updated = await this.transition(tx, id, ACTIVE, { status: 'NO_SHOW' });
      await tx.appointmentEvent.create({
        data: { appointmentId: id, eventType: 'NO_SHOW', reason: data.notes, performedBy: data.performedBy },
      });
      return updated;
    });
  }
}

export default new AppointmentService();
