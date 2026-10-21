const findFirstCustomerMock = jest.fn();
const findFirstMotoMock = jest.fn();
const findFirstServiceOrderMock = jest.fn();
const createRevisionMock = jest.fn();
const updateManyMotoMock = jest.fn();

jest.mock('@prisma/client', () => {
  const client: any = {
    customer: { findFirst: findFirstCustomerMock },
    motorcycle: { findFirst: findFirstMotoMock, updateMany: updateManyMotoMock },
    serviceOrder: { findFirst: findFirstServiceOrderMock },
    revision: { create: createRevisionMock },
  };
  // runInTransaction (packages/database/src/index.ts) chama
  // `basePrisma.$transaction(fn)` e passa o próprio client como `tx` quando
  // não há `$extends` (mock de teste, sem RLS real) — replicando esse
  // comportamento aqui para que create() (agora transacional) funcione.
  client.$transaction = jest.fn((fn: any) => fn(client));
  return { PrismaClient: jest.fn().mockImplementation(() => client), Prisma: {} };
});

import { RevisionService, addMonthsClamped } from './revision.service';

describe('addMonthsClamped (próxima revisão por meses)', () => {
  it.each([
    ['2026-01-31T12:00:00.000Z', 1, '2026-02-28T12:00:00.000Z'], // antes: 03/03 (setMonth transbordava)
    ['2028-01-31T12:00:00.000Z', 1, '2028-02-29T12:00:00.000Z'], // ano bissexto
    ['2026-08-31T12:00:00.000Z', 1, '2026-09-30T12:00:00.000Z'],
    ['2026-11-30T12:00:00.000Z', 3, '2027-02-28T12:00:00.000Z'], // vira o ano
    ['2026-01-15T00:00:00.000Z', 3, '2026-04-15T00:00:00.000Z'], // dia comum: mantém o dia
  ])('%s + %i mês(es) = %s', (from, months, expected) => {
    expect(addMonthsClamped(new Date(from), months).toISOString()).toBe(expected);
  });
});

describe('RevisionService', () => {
  const service = new RevisionService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstCustomerMock.mockResolvedValue({ id: 'customer-1' });
    findFirstMotoMock.mockResolvedValue({ id: 'moto-1' });
    updateManyMotoMock.mockResolvedValue({ count: 1 });
  });

  describe('create', () => {
    const baseInput = {
      companyId: 'company-A',
      customerId: 'customer-1',
      motorcycleId: 'moto-1',
      performedAt: new Date('2026-01-15T00:00:00.000Z'),
      kilometerAtService: 10000,
      servicesPerformed: 'Troca de óleo',
      intervalMonths: 3,
      recordedBy: 'user-1',
    };

    it('calcula nextDueDate como performedAt + intervalMonths', async () => {
      createRevisionMock.mockImplementationOnce((args: any) => Promise.resolve(args.data));

      const result = await service.create(baseInput);

      expect(result.nextDueDate).toEqual(new Date('2026-04-15T00:00:00.000Z'));
    });

    it('calcula nextDueKilometer quando intervalKilometers é informado, null caso contrário', async () => {
      createRevisionMock.mockImplementation((args: any) => Promise.resolve(args.data));

      const withKm = await service.create({ ...baseInput, intervalKilometers: 3000 });
      expect(withKm.nextDueKilometer).toBe(13000);

      const withoutKm = await service.create(baseInput);
      expect(withoutKm.nextDueKilometer).toBeNull();
    });

    it('rejeita quando o cliente não pertence à empresa (isolamento cross-tenant)', async () => {
      findFirstCustomerMock.mockResolvedValueOnce(null);

      await expect(service.create(baseInput)).rejects.toThrow('Customer not found');
      expect(createRevisionMock).not.toHaveBeenCalled();
    });

    it('rejeita quando a moto não pertence ao cliente informado', async () => {
      findFirstMotoMock.mockResolvedValueOnce(null);

      await expect(service.create(baseInput)).rejects.toThrow('Motorcycle not found for this customer');
      expect(createRevisionMock).not.toHaveBeenCalled();
    });

    it('valida a OS quando serviceOrderId é informado', async () => {
      findFirstServiceOrderMock.mockResolvedValueOnce(null);

      await expect(service.create({ ...baseInput, serviceOrderId: 'os-of-another-company' })).rejects.toThrow(
        'Service order not found'
      );
      expect(createRevisionMock).not.toHaveBeenCalled();
    });

    it('não exige serviceOrderId — revisão pode ser registrada manualmente', async () => {
      createRevisionMock.mockResolvedValueOnce({ id: 'revision-1' });

      await service.create(baseInput);

      expect(findFirstServiceOrderMock).not.toHaveBeenCalled();
      expect(createRevisionMock).toHaveBeenCalledTimes(1);
    });
  });
});
