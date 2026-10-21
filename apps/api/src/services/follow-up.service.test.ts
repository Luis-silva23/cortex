const findFirstCustomerMock = jest.fn();
const findFirstMotoMock = jest.fn();
const findFirstRevisionMock = jest.fn();
const createFollowUpMock = jest.fn();
const findFirstFollowUpMock = jest.fn();
const countFollowUpMock = jest.fn();
const createFollowUpEventMock = jest.fn();
const updateFollowUpMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    customer: { findFirst: findFirstCustomerMock },
    motorcycle: { findFirst: findFirstMotoMock },
    revision: { findFirst: findFirstRevisionMock },
    followUp: {
      create: createFollowUpMock,
      findFirst: findFirstFollowUpMock,
      count: countFollowUpMock,
      update: updateFollowUpMock,
    },
    followUpEvent: { create: createFollowUpEventMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

import { FollowUpService } from './follow-up.service';

describe('FollowUpService', () => {
  const service = new FollowUpService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstCustomerMock.mockResolvedValue({ id: 'customer-1' });
    findFirstMotoMock.mockResolvedValue({ id: 'moto-1' });
  });

  describe('create', () => {
    const baseInput = {
      companyId: 'company-A',
      customerId: 'customer-1',
      motorcycleId: 'moto-1',
      dueDate: new Date('2026-04-15T00:00:00.000Z'),
      createdBy: 'user-1',
    };

    it('rejeita quando o cliente não pertence à empresa (isolamento cross-tenant)', async () => {
      findFirstCustomerMock.mockResolvedValueOnce(null);

      await expect(service.create(baseInput)).rejects.toThrow('Customer not found');
      expect(createFollowUpMock).not.toHaveBeenCalled();
    });

    it('rejeita quando a revisão vinculada não pertence à empresa', async () => {
      findFirstRevisionMock.mockResolvedValueOnce(null);

      await expect(service.create({ ...baseInput, revisionId: 'rev-of-another-company' })).rejects.toThrow(
        'Revision not found'
      );
      expect(createFollowUpMock).not.toHaveBeenCalled();
    });

    it('cria o follow-up quando tudo é válido', async () => {
      createFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'PENDING' });

      const result = await service.create(baseInput);

      expect(result.id).toBe('followup-1');
      expect(createFollowUpMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('dashboard — exatamente 3 baldes (sem "Aguardando contato")', () => {
    it('retorna upcomingRevisions/scheduled/cancelled a partir dos status PENDING/SCHEDULED/CANCELLED', async () => {
      countFollowUpMock.mockResolvedValueOnce(5).mockResolvedValueOnce(2).mockResolvedValueOnce(1);

      const result = await service.dashboard('company-A');

      expect(result).toEqual({ upcomingRevisions: 5, scheduled: 2, cancelled: 1 });
      expect(Object.keys(result)).toHaveLength(3);
    });
  });

  describe('logContact — nunca muda o status', () => {
    it('registra o evento de contato sem alterar o status do follow-up', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'PENDING', companyId: 'company-A' });
      createFollowUpEventMock.mockResolvedValueOnce({ id: 'event-1', eventType: 'CONTACT_ATTEMPTED' });

      await service.logContact('followup-1', 'company-A', { channel: 'PHONE', performedBy: 'user-1' });

      expect(createFollowUpEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'CONTACT_ATTEMPTED' }) })
      );
      expect(updateFollowUpMock).not.toHaveBeenCalled();
    });

    it('rejeita contato em follow-up de outra empresa', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce(null);

      await expect(
        service.logContact('followup-of-another-company', 'company-A', { channel: 'PHONE', performedBy: 'user-1' })
      ).rejects.toThrow('Follow-up not found');
    });
  });

  describe('recordAcceptance — aceitar não agenda, não muda status', () => {
    it('registra CUSTOMER_ACCEPTED sem alterar o status (só o Appointment agenda de fato)', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'PENDING', companyId: 'company-A' });
      createFollowUpEventMock.mockResolvedValueOnce({ id: 'event-1', eventType: 'CUSTOMER_ACCEPTED' });

      await service.recordAcceptance('followup-1', 'company-A', { performedBy: 'user-1' });

      expect(updateFollowUpMock).not.toHaveBeenCalled();
    });

    it('rejeita aceitar um follow-up que não está PENDING', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'SCHEDULED', companyId: 'company-A' });

      await expect(service.recordAcceptance('followup-1', 'company-A', { performedBy: 'user-1' })).rejects.toThrow(
        'Follow-up is SCHEDULED, not PENDING'
      );
    });
  });

  describe('decline / cancel — preservam histórico e movem para CANCELLED', () => {
    const fakeTx = (opts: { count?: number; appointment?: { id: string } | null } = {}) => {
      const tx = {
        followUpEvent: { create: jest.fn().mockResolvedValue({}) },
        followUp: {
          updateMany: jest.fn().mockResolvedValue({ count: opts.count ?? 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'followup-1', status: 'CANCELLED' }),
        },
        appointment: {
          findFirst: jest.fn().mockResolvedValue(opts.appointment ?? null),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        appointmentEvent: { create: jest.fn().mockResolvedValue({}) },
      };
      transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));
      return tx;
    };

    it('decline grava CUSTOMER_DECLINED e muda para CANCELLED com guarda (só a partir de PENDING), atomicamente', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'PENDING', companyId: 'company-A' });
      const tx = fakeTx();

      const result = await service.decline('followup-1', 'company-A', { reason: 'Não quer mais', performedBy: 'user-1' });

      expect(tx.followUpEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'CUSTOMER_DECLINED' }) }));
      expect(tx.followUp.updateMany).toHaveBeenCalledWith({ where: { id: 'followup-1', status: { in: ['PENDING'] } }, data: { status: 'CANCELLED' } });
      expect(result.status).toBe('CANCELLED');
    });

    it('decline concorrente (já mudou de situação): 409, sem evento', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'PENDING', companyId: 'company-A' });
      const tx = fakeTx({ count: 0 });
      await expect(service.decline('followup-1', 'company-A', { performedBy: 'user-1' })).rejects.toMatchObject({ statusCode: 409 });
      expect(tx.followUpEvent.create).not.toHaveBeenCalled();
    });

    it('cancel também cancela o agendamento ATIVO ligado (antes ficava ativo apontando para um pós-venda cancelado)', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'SCHEDULED', companyId: 'company-A' });
      const tx = fakeTx({ appointment: { id: 'appointment-1' } });

      await service.cancel('followup-1', 'company-A', { reason: 'Vendeu a moto', performedBy: 'user-1' });

      expect(tx.appointment.updateMany).toHaveBeenCalledWith({ where: { id: 'appointment-1', status: { in: ['PROPOSED', 'CONFIRMED'] } }, data: { status: 'CANCELLED' } });
      expect(tx.appointmentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ appointmentId: 'appointment-1', eventType: 'CANCELLED', reason: expect.stringContaining('Vendeu a moto') }) })
      );
    });

    it('cancel rejeita quando já está CANCELLED (não reabre nem duplica histórico)', async () => {
      findFirstFollowUpMock.mockResolvedValueOnce({ id: 'followup-1', status: 'CANCELLED', companyId: 'company-A' });

      await expect(
        service.cancel('followup-1', 'company-A', { performedBy: 'user-1' })
      ).rejects.toThrow('Follow-up is already cancelled');
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });
});
