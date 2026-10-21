const findFirstCustomerMock = jest.fn();
const findFirstMotoMock = jest.fn();
const findFirstFollowUpMock = jest.fn();
const findUniqueAppointmentByFollowUpMock = jest.fn();
const findFirstAppointmentMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    customer: { findFirst: findFirstCustomerMock },
    motorcycle: { findFirst: findFirstMotoMock },
    followUp: { findFirst: findFirstFollowUpMock },
    appointment: { findUnique: findUniqueAppointmentByFollowUpMock, findFirst: findFirstAppointmentMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

// Políticas e horário de funcionamento: padrão do produto (sem limite por horário, sem horário cadastrado, confirmação
// do cliente exigida). Cada teste de regra de agenda sobrescreve o que precisa.
const policyValues: Record<string, unknown> = {};
const POLICY_DEFAULTS: Record<string, unknown> = {
  'company.timezone': 'America/Sao_Paulo',
  'agenda.requireCustomerConfirmation': true,
  'agenda.completionAuthorizerRoles': ['MANAGER', 'COMPANY_ADMIN'],
  'agenda.slotMinutes': 60,
  'agenda.maxPerSlot': null,
  'agenda.maxPerDay': null,
  'agenda.maxPerMonth': null,
  'agenda.boxCount': null,
  'agenda.defaultDurationMinutes': null,
  'agenda.respectBusinessHours': true,
};
const effectivePolicies = () => ({ ...POLICY_DEFAULTS, ...policyValues });
jest.mock('./policy.service', () => ({
  policyService: {
    effective: jest.fn(async () => effectivePolicies()),
    get: jest.fn(async (_c: string, _b: string, key: string) => (effectivePolicies() as any)[key]),
  },
}));
// A agenda confere a JANELA inteira (início + duração): isWindowOpen(companyId, branchId, start, end).
const isOpenAtMock = jest.fn();
jest.mock('./business-hours.service', () => ({
  ...jest.requireActual('./business-hours.service'),
  businessHoursService: { isWindowOpen: (...args: any[]) => isOpenAtMock(...args) },
}));
const verifyDualAuthorizationMock = jest.fn();
jest.mock('./dual-authorization.service', () => ({ verifyDualAuthorization: (...args: any[]) => verifyDualAuthorizationMock(...args) }));

import { AppointmentService, slotOf } from './appointment.service';

/** Transação falsa: transições com guarda (updateMany → count) e releitura (findUniqueOrThrow). */
function fakeTx(
  opts: { count?: number; after?: Record<string, unknown>; followUpCount?: number; taken?: number; busy?: Array<{ scheduledAt: Date; durationMinutes: number | null }> } = {}
) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ ut: 'OPERATOR', br: 'branch-1' }]),
    agendaUnavailability: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: {
      findMany: jest.fn().mockResolvedValue(opts.busy ?? []),
      count: jest.fn().mockResolvedValue(opts.taken ?? 0),
      create: jest.fn().mockResolvedValue({ id: 'appointment-new', status: 'PROPOSED' }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.count ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'appointment-1', ...(opts.after ?? {}) }),
    },
    appointmentEvent: { create: jest.fn().mockResolvedValue({}) },
    followUp: { updateMany: jest.fn().mockResolvedValue({ count: opts.followUpCount ?? 1 }) },
  };
  transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));
  return tx;
}

const confirmation = { performedBy: 'employee-1', channel: 'PHONE' as const, confirmedByName: 'João (dono da moto)' };

describe('AppointmentService', () => {
  const service = new AppointmentService();

  beforeEach(() => {
    jest.clearAllMocks();
    transactionMock.mockReset();
    for (const k of Object.keys(policyValues)) delete policyValues[k];
    isOpenAtMock.mockResolvedValue({ configured: false, open: true, reason: null });
    findFirstCustomerMock.mockResolvedValue({ id: 'customer-1' });
  });

  describe('propose', () => {
    const baseInput = {
      companyId: 'company-A',
      customerId: 'customer-1',
      scheduledAt: new Date('2026-05-01T14:00:00.000Z'),
      proposedBy: 'user-1',
    };
    const followUp = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'followup-1', status, companyId: 'company-A', customerId: 'customer-1', motorcycleId: null, ...extra });

    it('rejeita quando o cliente não pertence à empresa (isolamento cross-tenant)', async () => {
      findFirstCustomerMock.mockResolvedValueOnce(null);
      await expect(service.propose(baseInput)).rejects.toThrow('Customer not found');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejeita agendar para um follow-up já CANCELLED', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce(followUp('CANCELLED'));
      await expect(service.propose({ ...baseInput, followUpId: 'followup-1' })).rejects.toThrow('Cannot schedule an appointment for a cancelled follow-up');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejeita um pós-venda de OUTRO cliente', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce(followUp('PENDING', { customerId: 'customer-2' }));
      await expect(service.propose({ ...baseInput, followUpId: 'followup-1' })).rejects.toThrow('O pós-venda é de outro cliente ou outra moto');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejeita quando o follow-up já tem um agendamento ATIVO (deve reagendar, não duplicar)', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce(followUp('SCHEDULED'));
      findUniqueAppointmentByFollowUpMock.mockResolvedValueOnce({ id: 'appointment-existing', status: 'CONFIRMED' });
      await expect(service.propose({ ...baseInput, followUpId: 'followup-1' })).rejects.toThrow('This follow-up already has an appointment — reschedule the existing one instead');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('com o agendamento anterior CANCELADO, a nova proposta desvincula o antigo e registra a substituição', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce(followUp('PENDING'));
      findUniqueAppointmentByFollowUpMock.mockResolvedValueOnce({ id: 'appointment-old', status: 'CANCELLED' });
      const tx = fakeTx();
      await service.propose({ ...baseInput, followUpId: 'followup-1' });
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({
        where: { id: 'appointment-old', followUpId: 'followup-1', status: { notIn: ['PROPOSED', 'CONFIRMED'] } },
        data: { followUpId: null },
      });
      expect(tx.appointmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: expect.stringContaining('appointment-old') }) }));
    });

    it('cria o appointment, registra evento PROPOSED e move o follow-up para SCHEDULED com guarda, atomicamente', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce(followUp('PENDING'));
      findUniqueAppointmentByFollowUpMock.mockResolvedValueOnce(null);
      const tx = fakeTx();
      const result = await service.propose({ ...baseInput, followUpId: 'followup-1' });
      expect(result.id).toBe('appointment-new');
      expect(tx.appointmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'PROPOSED' }) }));
      expect(tx.followUp.updateMany).toHaveBeenCalledWith({ where: { id: 'followup-1', status: { not: 'CANCELLED' } }, data: { status: 'SCHEDULED' } });
    });

    it('não mexe em nenhum follow-up quando o agendamento é criado avulso (sem followUpId)', async () => {
      const tx = fakeTx();
      await service.propose(baseInput);
      expect(findFirstFollowUpMock).not.toHaveBeenCalled();
      expect(tx.followUp.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('confirm — REGRA FUNDAMENTAL (confirmação do cliente/responsável)', () => {
    it('só a partir de PROPOSED; grava customerConfirmed, quem confirmou e o canal; evento CONFIRMED com o funcionário que registrou', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'PROPOSED' });
      const tx = fakeTx({ after: { status: 'CONFIRMED', customerConfirmed: true } });
      const result = await service.confirm('appointment-1', 'company-A', confirmation);
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({
        where: { id: 'appointment-1', status: { in: ['PROPOSED'] } },
        data: { status: 'CONFIRMED', customerConfirmed: true, confirmedAt: expect.any(Date), confirmationChannel: 'PHONE', confirmedByName: 'João (dono da moto)' },
      });
      expect(tx.appointmentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'CONFIRMED', performedBy: 'employee-1', reason: expect.stringContaining('João (dono da moto)') }) })
      );
      expect(result.customerConfirmed).toBe(true);
    });

    it('mudou de situação no meio (confirmar × cancelar simultâneos): 409 e nenhum evento', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'PROPOSED' });
      const tx = fakeTx({ count: 0 });
      await expect(service.confirm('appointment-1', 'company-A', confirmation)).rejects.toMatchObject({ statusCode: 409 });
      expect(tx.appointmentEvent.create).not.toHaveBeenCalled();
    });

    it('rejeita confirmar um appointment já CANCELLED/COMPLETED/NO_SHOW', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'CANCELLED' });
      await expect(service.confirm('appointment-1', 'company-A', confirmation)).rejects.toThrow('Appointment is CANCELLED and can no longer be changed');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejeita confirmar um appointment de outra empresa', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce(null);
      await expect(service.confirm('appointment-of-another-company', 'company-A', confirmation)).rejects.toThrow('Appointment not found');
    });
  });

  describe('reschedule — reseta a confirmação', () => {
    it('reseta customerConfirmed/confirmedAt/quem/canal e volta para PROPOSED, registrando previousScheduledAt/newScheduledAt', async () => {
      const previousScheduledAt = new Date('2026-05-01T14:00:00.000Z');
      const newScheduledAt = new Date('2026-05-03T09:00:00.000Z');
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'CONFIRMED', scheduledAt: previousScheduledAt });
      const tx = fakeTx({ after: { status: 'PROPOSED', customerConfirmed: false } });
      const result = await service.reschedule('appointment-1', 'company-A', { newScheduledAt, performedBy: 'employee-1' });
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({
        where: { id: 'appointment-1', status: { in: ['PROPOSED', 'CONFIRMED'] } },
        data: { scheduledAt: newScheduledAt, status: 'PROPOSED', customerConfirmed: false, confirmedAt: null, confirmationChannel: null, confirmedByName: null },
      });
      expect(tx.appointmentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'RESCHEDULED', previousScheduledAt, newScheduledAt }) })
      );
      expect(result.status).toBe('PROPOSED');
    });
  });

  describe('cancel — devolve o follow-up AGENDADO para PENDING', () => {
    it('cancela com guarda e devolve o follow-up só se ele ainda estiver SCHEDULED', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'CONFIRMED', followUpId: 'followup-1' });
      const tx = fakeTx();
      await service.cancel('appointment-1', 'company-A', { performedBy: 'employee-1' });
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({ where: { id: 'appointment-1', status: { in: ['PROPOSED', 'CONFIRMED'] } }, data: { status: 'CANCELLED' } });
      expect(tx.followUp.updateMany).toHaveBeenCalledWith({ where: { id: 'followup-1', status: 'SCHEDULED' }, data: { status: 'PENDING' } });
    });

    it('cancela normalmente um appointment avulso (sem followUpId)', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-2', companyId: 'company-A', status: 'PROPOSED', followUpId: null });
      const tx = fakeTx();
      await service.cancel('appointment-2', 'company-A', { performedBy: 'employee-1' });
      expect(tx.followUp.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('não compareceu', () => {
    it('antes do horário marcado: recusado', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'CONFIRMED', scheduledAt: new Date('2026-05-01T14:00:00.000Z') });
      await expect(service.markNoShow('appointment-1', 'company-A', { performedBy: 'employee-1' }, new Date('2026-05-01T13:00:00.000Z'))).rejects.toThrow(
        'depois do horário agendado'
      );
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('depois do horário: grava NO_SHOW com guarda', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', status: 'CONFIRMED', scheduledAt: new Date('2026-05-01T14:00:00.000Z') });
      const tx = fakeTx({ after: { status: 'NO_SHOW' } });
      await service.markNoShow('appointment-1', 'company-A', { performedBy: 'employee-1' }, new Date('2026-05-01T15:00:00.000Z'));
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({ where: { id: 'appointment-1', status: { in: ['PROPOSED', 'CONFIRMED'] } }, data: { status: 'NO_SHOW' } });
    });
  });

  describe('horário da agenda (política)', () => {
    const at = new Date('2026-05-01T13:37:00.000Z'); // 10:37 em São Paulo
    const input = { companyId: 'company-A', branchId: 'branch-1', customerId: 'customer-1', scheduledAt: at, proposedBy: 'user-1' };

    it('slot de 60 min alinhado à hora local: 10:37 → [10:00, 11:00)', () => {
      const slot = slotOf(at, 'America/Sao_Paulo', 60);
      expect(slot.start.toISOString()).toBe('2026-05-01T13:00:00.000Z');
      expect(slot.end.toISOString()).toBe('2026-05-01T14:00:00.000Z');
      expect(slotOf(at, 'America/Sao_Paulo', 30).start.toISOString()).toBe('2026-05-01T13:30:00.000Z');
    });

    it('fora do funcionamento (horário cadastrado): 409 OUTSIDE_BUSINESS_HOURS com o motivo, nada gravado', async () => {
      isOpenAtMock.mockResolvedValueOnce({ configured: true, open: false, reason: 'Fora do horário de funcionamento (08:00–18:00)' });
      const error = await service.propose(input).catch((e) => e);
      expect(error).toMatchObject({ statusCode: 409, code: 'OUTSIDE_BUSINESS_HOURS' });
      expect(error.message).toContain('08:00–18:00');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('com respectBusinessHours desligado, o horário de funcionamento não bloqueia', async () => {
      policyValues['agenda.respectBusinessHours'] = false;
      isOpenAtMock.mockResolvedValue({ configured: true, open: false, reason: 'x' });
      fakeTx();
      await expect(service.propose(input)).resolves.toMatchObject({ id: 'appointment-new' });
      expect(isOpenAtMock).not.toHaveBeenCalled();
    });

    it('funcionamento confere a JANELA: fim = início + duração (pedido → padrão da política → um horário)', async () => {
      fakeTx();
      await service.propose({ ...input, durationMinutes: 90 });
      expect(isOpenAtMock).toHaveBeenLastCalledWith('company-A', 'branch-1', at, new Date(at.getTime() + 90 * 60_000));
      policyValues['agenda.defaultDurationMinutes'] = 45;
      fakeTx();
      await service.propose(input);
      expect(isOpenAtMock).toHaveBeenLastCalledWith('company-A', 'branch-1', at, new Date(at.getTime() + 45 * 60_000));
      delete policyValues['agenda.defaultDurationMinutes'];
      const tx = fakeTx();
      await service.propose(input);
      expect(isOpenAtMock).toHaveBeenLastCalledWith('company-A', 'branch-1', at, new Date(at.getTime() + 60 * 60_000));
      expect(tx.appointment.create.mock.calls[0][0].data).toMatchObject({ durationMinutes: null, mechanicId: null });
    });

    it('boxes: um atendimento de 90 min iniciado 1 h antes ainda ocupa o único box → 409 NO_BOX_AVAILABLE', async () => {
      policyValues['agenda.boxCount'] = 1;
      const tx = fakeTx({ busy: [{ scheduledAt: new Date(at.getTime() - 60 * 60_000), durationMinutes: 90 }] });
      await expect(service.propose(input)).rejects.toMatchObject({ statusCode: 409, code: 'NO_BOX_AVAILABLE' });
      expect(tx.appointment.create).not.toHaveBeenCalled();
      // terminou exatamente no início: box livre
      policyValues['agenda.boxCount'] = 1;
      fakeTx({ busy: [{ scheduledAt: new Date(at.getTime() - 60 * 60_000), durationMinutes: 60 }] });
      await expect(service.propose(input)).resolves.toMatchObject({ id: 'appointment-new' });
    });

    it('horário lotado: trava por filial, conta os ATIVOS do horário e recusa com 409 SLOT_FULL', async () => {
      policyValues['agenda.maxPerSlot'] = 2;
      const tx = fakeTx({ taken: 2 });
      await expect(service.propose(input)).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_FULL' });
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(tx.appointment.count).toHaveBeenCalledWith({
        where: {
          companyId: 'company-A',
          branchId: 'branch-1',
          status: { in: ['PROPOSED', 'CONFIRMED'] },
          scheduledAt: { gte: new Date('2026-05-01T13:00:00.000Z'), lt: new Date('2026-05-01T14:00:00.000Z') },
        },
      });
      expect(tx.appointment.create).not.toHaveBeenCalled();
    });

    it('remarcar não conta o próprio agendamento', async () => {
      policyValues['agenda.maxPerSlot'] = 1;
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'appointment-1', companyId: 'company-A', branchId: 'branch-1', status: 'PROPOSED', scheduledAt: at });
      const tx = fakeTx({ taken: 0 });
      await service.reschedule('appointment-1', 'company-A', { newScheduledAt: at, performedBy: 'employee-1' });
      expect(tx.appointment.count.mock.calls[0][0].where.id).toEqual({ not: 'appointment-1' });
    });
  });

  describe('concluir — confirmação do cliente', () => {
    const authorization = { authorizerNumericId: 7, authorizerPassword: 'senha', reason: 'Cliente veio sem confirmar pelo WhatsApp' };

    it('confirmado pelo cliente: conclui só se ainda estiver CONFIRMED', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'a1', companyId: 'company-A', status: 'CONFIRMED', customerConfirmed: true });
      const tx = fakeTx({ after: { status: 'COMPLETED' } });
      await service.complete('a1', 'company-A', { performedBy: 'employee-1' });
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({ where: { id: 'a1', status: { in: ['CONFIRMED'] } }, data: { status: 'COMPLETED' } });
      expect(verifyDualAuthorizationMock).not.toHaveBeenCalled();
    });

    it('não confirmado e sem autorização: 409 APPOINTMENT_NOT_CONFIRMED, nada gravado', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'a1', companyId: 'company-A', status: 'PROPOSED', customerConfirmed: false });
      await expect(service.complete('a1', 'company-A', { performedBy: 'employee-1' })).rejects.toMatchObject({ statusCode: 409, code: 'APPOINTMENT_NOT_CONFIRMED' });
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('motivo curto: 400 REASON_REQUIRED antes de checar a senha', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'a1', companyId: 'company-A', status: 'PROPOSED', customerConfirmed: false });
      await expect(service.complete('a1', 'company-A', { performedBy: 'employee-1', authorization: { ...authorization, reason: 'curto' } })).rejects.toMatchObject({ statusCode: 400, code: 'REASON_REQUIRED' });
      expect(verifyDualAuthorizationMock).not.toHaveBeenCalled();
    });

    it('autorização recusada (ex.: a própria pessoa): 403 AUTHORIZATION_FAILED em português', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'a1', companyId: 'company-A', status: 'PROPOSED', customerConfirmed: false });
      verifyDualAuthorizationMock.mockRejectedValueOnce(new Error('The requesting user cannot authorize their own conclusão de agendamento sem confirmação do cliente'));
      const error = await service.complete('a1', 'company-A', { performedBy: 'employee-1', authorization }).catch((e) => e);
      expect(error).toMatchObject({ statusCode: 403, code: 'AUTHORIZATION_FAILED' });
      expect(error.message).toMatch(/^Quem solicita não pode autorizar a própria .*conclusão de agendamento sem confirmação do cliente/);
    });

    it('autorizado: usa os perfis da política, grava quem autorizou e o motivo, só a partir de PROPOSED', async () => {
      findFirstAppointmentMock.mockResolvedValueOnce({ id: 'a1', companyId: 'company-A', status: 'PROPOSED', customerConfirmed: false });
      verifyDualAuthorizationMock.mockResolvedValueOnce({ id: 'manager-1', name: 'Gerente', numericId: 7 });
      const tx = fakeTx({ after: { status: 'COMPLETED' } });
      await service.complete('a1', 'company-A', { performedBy: 'employee-1', authorization });
      expect(verifyDualAuthorizationMock).toHaveBeenCalledWith(expect.objectContaining({ requesterId: 'employee-1', authorizerNumericId: 7, allowedRoles: ['MANAGER', 'COMPANY_ADMIN'] }));
      expect(tx.appointment.updateMany).toHaveBeenCalledWith({
        where: { id: 'a1', status: { in: ['PROPOSED'] } },
        data: { status: 'COMPLETED', completedWithoutConfirmation: true, completionAuthorizedBy: 'manager-1', completionReason: authorization.reason },
      });
      expect(tx.appointmentEvent.create.mock.calls[0][0].data.reason).toContain('SEM confirmação do cliente — autorizado por Gerente (#7)');
    });
  });
});
