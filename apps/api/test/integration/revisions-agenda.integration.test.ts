import { prisma, prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import revisionService from '../../src/services/revision.service';
import followUpService from '../../src/services/follow-up.service';
import appointmentService from '../../src/services/appointment.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Suíte de integração REAL (PostgreSQL + RLS reais, nenhum mock) para o
 * domínio Revisões / Pós-venda / Agenda (2026-09-14). Cobre o que a suíte
 * unitária (Prisma mockado) não consegue provar: isolamento de tenant
 * imposto pelas políticas RLS reais (FORCE ROW LEVEL SECURITY), incluindo as
 * tabelas de evento sem companyId próprio (follow_up_events,
 * appointment_events) cujo isolamento depende do join com a tabela pai.
 */

async function runInRLSContext<T>(companyId: string, branchId: string | null, fn: () => Promise<T>): Promise<T> {
  return runWithRLSContext({ companyId, userType: 'OPERATOR', branchId }, fn);
}

/**
 * Leitura de verificação com bypass total de RLS — mesmo padrão já
 * comprovado em rbac.integration.test.ts (`verifyUserRoles`): uma
 * `runWithRLSContext` NOVA, chamada logo em seguida de várias outras já
 * acumuladas na mesma suíte, provou ser instável neste ambiente para
 * releituras imediatas de verificação (ver comentário longo em
 * rbac.integration.test.ts). `prismaUnsafeBypassRLS.$transaction([...])`
 * com `set_config` explícito é o workaround já validado — usado aqui só
 * para CONFIRMAR o estado real do banco depois de escrever pelos serviços
 * (que já passam pela extensão de RLS normalmente), nunca em código de
 * produção.
 */
async function verifyAppointmentEventTypes(appointmentId: string): Promise<string[]> {
  const [, rows] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.appointmentEvent.findMany({
      where: { appointmentId },
      orderBy: { createdAt: 'asc' },
      select: { eventType: true },
    }) as any,
  ]);
  return (rows as Array<{ eventType: string }>).map((e) => e.eventType);
}

async function verifyFollowUpEventTypes(followUpId: string): Promise<string[]> {
  const [, rows] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.followUpEvent.findMany({
      where: { followUpId },
      orderBy: { createdAt: 'asc' },
      select: { eventType: true },
    }) as any,
  ]);
  return (rows as Array<{ eventType: string }>).map((e) => e.eventType);
}

describe('Revisões / Pós-venda / Agenda — integração real (Postgres + RLS)', () => {
  let fixtureA: IntegrationFixture;
  let fixtureB: IntegrationFixture;

  beforeAll(async () => {
    [fixtureA, fixtureB] = await Promise.all([createFixture('revagendaA'), createFixture('revagendaB')]);
  }, 30000);

  afterAll(async () => {
    await Promise.all([destroyFixture(fixtureA), destroyFixture(fixtureB)]);
  }, 30000);

  it('fluxo completo: Revisão -> FollowUp -> Appointment proposto -> confirmado (regra fundamental) -> reagendado -> cancelado (reverte FollowUp para PENDING)', async () => {
    const revision = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      revisionService.create({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        performedAt: new Date('2026-01-15T00:00:00.000Z'),
        kilometerAtService: 10000,
        servicesPerformed: 'Troca de óleo e filtro',
        intervalMonths: 3,
        recordedBy: fixtureA.userId,
      })
    );
    expect(revision.nextDueDate).toEqual(new Date('2026-04-15T00:00:00.000Z'));

    const followUp = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.create({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        revisionId: revision.id,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        dueDate: revision.nextDueDate,
        createdBy: fixtureA.userId,
      })
    );
    expect(followUp.status).toBe('PENDING');

    // Dashboard antes de qualquer agendamento: 1 em "Próximas revisões", 0 agendadas.
    let dashboard = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.dashboard(fixtureA.companyId, fixtureA.branchId)
    );
    expect(dashboard).toEqual({ upcomingRevisions: 1, scheduled: 0, cancelled: 0 });

    // Tentativa de contato NÃO muda o balde (não existe "Aguardando contato").
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.logContact(followUp.id, fixtureA.companyId, {
        channel: 'PHONE',
        message: 'Ligado, cliente vai confirmar depois',
        performedBy: fixtureA.userId,
      })
    );
    dashboard = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.dashboard(fixtureA.companyId, fixtureA.branchId)
    );
    expect(dashboard).toEqual({ upcomingRevisions: 1, scheduled: 0, cancelled: 0 });

    const appointment = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      appointmentService.propose({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        followUpId: followUp.id,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        scheduledAt: new Date('2026-04-20T13:00:00.000Z'),
        proposedBy: fixtureA.userId,
      })
    );
    expect(appointment.status).toBe('PROPOSED');
    expect(appointment.customerConfirmed).toBe(false);

    // Propor o horário move o FollowUp para "Agendadas".
    dashboard = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.dashboard(fixtureA.companyId, fixtureA.branchId)
    );
    expect(dashboard).toEqual({ upcomingRevisions: 0, scheduled: 1, cancelled: 0 });

    // REGRA FUNDAMENTAL: só confirm() grava customerConfirmed=true.
    const confirmed = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      appointmentService.confirm(appointment.id, fixtureA.companyId, { performedBy: fixtureA.userId, channel: 'WHATSAPP', confirmedByName: 'Cliente da integração' })
    );
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.customerConfirmed).toBe(true);
    expect(confirmed.confirmedAt).not.toBeNull();

    // Reagendar reseta a confirmação.
    const rescheduled = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      appointmentService.reschedule(appointment.id, fixtureA.companyId, {
        newScheduledAt: new Date('2026-04-22T09:00:00.000Z'),
        reason: 'Cliente pediu para mudar o dia',
        performedBy: fixtureA.userId,
      })
    );
    expect(rescheduled.status).toBe('PROPOSED');
    expect(rescheduled.customerConfirmed).toBe(false);
    expect(rescheduled.confirmedAt).toBeNull();

    // Cancelar o agendamento devolve o FollowUp para PENDING.
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      appointmentService.cancel(appointment.id, fixtureA.companyId, {
        reason: 'Cliente desistiu do horário',
        performedBy: fixtureA.userId,
      })
    );
    const followUpAfterCancel = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.getById(followUp.id, fixtureA.companyId)
    );
    expect(followUpAfterCancel!.status).toBe('PENDING');

    dashboard = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.dashboard(fixtureA.companyId, fixtureA.branchId)
    );
    expect(dashboard).toEqual({ upcomingRevisions: 1, scheduled: 0, cancelled: 0 });

    // Histórico imutável completo: PROPOSED, CONFIRMED, RESCHEDULED, CANCELLED — nada apagado.
    const eventTypes = await verifyAppointmentEventTypes(appointment.id);
    expect(eventTypes).toEqual(['PROPOSED', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED']);
  }, 30000);

  it('recusa/cancelamento do cliente preserva histórico e move para CANCELLED (não reabre)', async () => {
    const followUp = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.create({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        dueDate: new Date('2026-06-01T00:00:00.000Z'),
        createdBy: fixtureA.userId,
      })
    );

    const declined = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.decline(followUp.id, fixtureA.companyId, {
        reason: 'Vendeu a moto',
        performedBy: fixtureA.userId,
      })
    );
    expect(declined.status).toBe('CANCELLED');

    await expect(
      runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
        followUpService.cancel(followUp.id, fixtureA.companyId, { performedBy: fixtureA.userId })
      )
    ).rejects.toThrow('Follow-up is already cancelled');

    const eventTypes = await verifyFollowUpEventTypes(followUp.id);
    expect(eventTypes).toEqual(['CUSTOMER_DECLINED']);
  }, 30000);

  it('isolamento cross-tenant real via RLS (FORCE ROW LEVEL SECURITY) — Empresa B nunca vê dados da Empresa A', async () => {
    const revisionA = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      revisionService.create({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        performedAt: new Date('2026-02-01T00:00:00.000Z'),
        kilometerAtService: 5000,
        servicesPerformed: 'Revisão de isolamento cross-tenant',
        intervalMonths: 3,
        recordedBy: fixtureA.userId,
      })
    );
    const followUpA = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.create({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        revisionId: revisionA.id,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        dueDate: revisionA.nextDueDate,
        createdBy: fixtureA.userId,
      })
    );
    const appointmentA = await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      appointmentService.propose({
        companyId: fixtureA.companyId,
        branchId: fixtureA.branchId,
        followUpId: followUpA.id,
        customerId: fixtureA.customerId,
        motorcycleId: fixtureA.motorcycleId,
        scheduledAt: new Date('2026-04-25T10:00:00.000Z'),
        proposedBy: fixtureA.userId,
      })
    );
    await runInRLSContext(fixtureA.companyId, fixtureA.branchId, () =>
      followUpService.logContact(followUpA.id, fixtureA.companyId, {
        channel: 'WHATSAPP',
        message: 'Confirmar comparecimento',
        performedBy: fixtureA.userId,
      })
    );

    // Via serviço, sob o contexto da Empresa B, os IDs da Empresa A não existem.
    const [revisionFromB, followUpFromB, appointmentFromB] = await runInRLSContext(
      fixtureB.companyId,
      fixtureB.branchId,
      async () => [
        await revisionService.getById(revisionA.id, fixtureB.companyId),
        await followUpService.getById(followUpA.id, fixtureB.companyId),
        await appointmentService.getById(appointmentA.id, fixtureB.companyId),
      ]
    );
    expect(revisionFromB).toBeNull();
    expect(followUpFromB).toBeNull();
    expect(appointmentFromB).toBeNull();

    // Listagens da Empresa B ficam vazias mesmo com dados reais da Empresa A no banco.
    const [revisionsListB, followUpsListB, appointmentsListB] = await runInRLSContext(
      fixtureB.companyId,
      fixtureB.branchId,
      async () => [
        await revisionService.list({ companyId: fixtureB.companyId, page: 1, limit: 50 }),
        await followUpService.list({ companyId: fixtureB.companyId, page: 1, limit: 50 }),
        await appointmentService.list({ companyId: fixtureB.companyId, page: 1, limit: 50 }),
      ]
    );
    expect(revisionsListB.revisions).toHaveLength(0);
    expect(followUpsListB.followUps).toHaveLength(0);
    expect(appointmentsListB.appointments).toHaveLength(0);

    // Dashboard da Empresa B não conta os baldes da Empresa A.
    const dashboardB = await runInRLSContext(fixtureB.companyId, fixtureB.branchId, () =>
      followUpService.dashboard(fixtureB.companyId, fixtureB.branchId)
    );
    expect(dashboardB).toEqual({ upcomingRevisions: 0, scheduled: 0, cancelled: 0 });

    // Prova direta de RLS (não apenas filtro da camada de aplicação): uma
    // consulta SEM cláusula where de companyId, sob o contexto da Empresa B,
    // não pode retornar linhas da Empresa A — a política do banco é quem
    // precisa barrar isso via FORCE ROW LEVEL SECURITY.
    const [rawRevisionsB, rawFollowUpsB, rawAppointmentsB] = await runInRLSContext(
      fixtureB.companyId,
      fixtureB.branchId,
      async () => [
        await prisma.revision.findMany({}),
        await prisma.followUp.findMany({}),
        await prisma.appointment.findMany({}),
      ]
    );
    expect(rawRevisionsB.find((r) => r.id === revisionA.id)).toBeUndefined();
    expect(rawFollowUpsB.find((f) => f.id === followUpA.id)).toBeUndefined();
    expect(rawAppointmentsB.find((a) => a.id === appointmentA.id)).toBeUndefined();

    // Tabelas de evento sem companyId próprio (isolamento via join com o
    // pai, ver migration RLS) — mesma prova, direto sob o contexto B.
    const [rawFollowUpEventsB, rawAppointmentEventsB] = await runInRLSContext(
      fixtureB.companyId,
      fixtureB.branchId,
      async () => [await prisma.followUpEvent.findMany({}), await prisma.appointmentEvent.findMany({})]
    );
    expect(rawFollowUpEventsB.find((e) => e.followUpId === followUpA.id)).toBeUndefined();
    expect(rawAppointmentEventsB.find((e) => e.appointmentId === appointmentA.id)).toBeUndefined();
  }, 30000);
});
