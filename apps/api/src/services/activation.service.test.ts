const findUniqueLicenseMock = jest.fn();
const countDeviceMock = jest.fn();
const findManyDeviceMock = jest.fn();
const transactionMock = jest.fn();
const findUniqueDeviceMock = jest.fn();
const updateDeviceMock = jest.fn();
const findFirstActivationMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    license: { findUnique: findUniqueLicenseMock },
    device: {
      count: countDeviceMock,
      findMany: findManyDeviceMock,
      findUnique: findUniqueDeviceMock,
      update: updateDeviceMock,
    },
    activation: { findFirst: findFirstActivationMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

jest.mock('@ln-system/shared/utils/token', () => ({
  generateDeviceCredential: jest.fn(() => 'fake-credential'),
}));

import { ActivationService } from './activation.service';

describe('ActivationService.requestActivation — regras de negócio', () => {
  const service = new ActivationService();

  it('rejeita solicitação para licença que não está ACTIVE', async () => {
    findUniqueLicenseMock.mockResolvedValueOnce({
      id: 'lic-1',
      status: 'PENDING_APPROVAL',
      maxDevices: 5,
      _count: { devices: 0 },
    });

    await expect(
      service.requestActivation({
        licenseId: 'lic-1',
        userId: 'user-1',
        deviceName: 'PDV Loja 1',
        deviceType: 'POS',
      })
    ).rejects.toThrow('Licença não está ativa');
  });

  it('rejeita quando o limite de dispositivos da licença já foi atingido', async () => {
    findUniqueLicenseMock.mockResolvedValueOnce({
      id: 'lic-1',
      status: 'ACTIVE',
      maxDevices: 2,
      _count: { devices: 2 },
    });
    countDeviceMock.mockResolvedValueOnce(2); // já no limite

    await expect(
      service.requestActivation({
        licenseId: 'lic-1',
        userId: 'user-1',
        deviceName: 'PDV Loja 1',
        deviceType: 'POS',
      })
    ).rejects.toThrow('Limite de dispositivos atingido');
  });

  it('permite a solicitação quando a licença está ativa e há vaga', async () => {
    findUniqueLicenseMock.mockResolvedValueOnce({
      id: 'lic-1',
      status: 'ACTIVE',
      maxDevices: 5,
      _count: { devices: 1 },
    });
    countDeviceMock.mockResolvedValueOnce(1);
    transactionMock.mockImplementationOnce(async (cb) =>
      cb({
        device: { create: jest.fn().mockResolvedValue({ id: 'device-1', status: 'PENDING' }) },
        activation: {
          create: jest
            .fn()
            .mockResolvedValue({ id: 'activation-1', activationCode: 'ABC123', status: 'PENDING' }),
        },
      })
    );

    const result = await service.requestActivation({
      licenseId: 'lic-1',
      userId: 'user-1',
      deviceName: 'PDV Loja 1',
      deviceType: 'POS',
    });

    expect(result.device.status).toBe('PENDING');
    expect(result.activation.status).toBe('PENDING');
  });
});

describe('ActivationService.listAllDevices — paginação (achado de auditoria)', () => {
  const service = new ActivationService();

  beforeEach(() => {
    findManyDeviceMock.mockReset();
    countDeviceMock.mockReset();
  });

  it('usa os defaults page=1/limit=20 e passa skip/take corretos ao Prisma', async () => {
    findManyDeviceMock.mockResolvedValueOnce([{ id: 'd1' }]);
    countDeviceMock.mockResolvedValueOnce(1);

    const result = await service.listAllDevices();

    expect(findManyDeviceMock).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 })
    );
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
  });

  it('calcula skip a partir da página pedida e nunca deixa o limit passar de 100', async () => {
    findManyDeviceMock.mockResolvedValueOnce([]);
    countDeviceMock.mockResolvedValueOnce(250);

    const result = await service.listAllDevices({ page: 3, limit: 500 });

    // página 3, limit efetivo travado em 100 → skip = (3-1)*100 = 200
    expect(findManyDeviceMock).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 200, take: 100 })
    );
    expect(result.pagination).toEqual({ page: 3, limit: 100, total: 250, pages: 3 });
  });

  it('nunca retorna a tabela inteira de uma vez: sempre passa `take` ao Prisma', async () => {
    findManyDeviceMock.mockResolvedValueOnce([]);
    countDeviceMock.mockResolvedValueOnce(0);

    await service.listAllDevices({ page: 1, limit: 20 });

    const callArg = findManyDeviceMock.mock.calls[0][0];
    expect(callArg.take).toBeDefined();
    expect(typeof callArg.take).toBe('number');
    expect(callArg.skip).toBeDefined();
  });
});

describe('ActivationService.unblockDevice — desbloquear não pode aprovar (achado de auditoria)', () => {
  const service = new ActivationService();

  beforeEach(() => {
    findUniqueDeviceMock.mockReset();
    updateDeviceMock.mockReset();
    findFirstActivationMock.mockReset();
    updateDeviceMock.mockImplementation(async ({ data }: any) => ({ id: 'dev-1', ...data }));
  });

  it('dispositivo bloqueado ainda PENDENTE de aprovação volta a PENDING — nunca vira ACTIVE sem aprovação', async () => {
    findUniqueDeviceMock.mockResolvedValueOnce({ id: 'dev-1', status: 'BLOCKED' });
    findFirstActivationMock.mockResolvedValueOnce(null); // nenhuma ativação APPROVED para ele

    const result: any = await service.unblockDevice('dev-1');

    expect(findFirstActivationMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deviceId: 'dev-1', status: 'APPROVED' }) })
    );
    expect(result.status).toBe('PENDING');
  });

  it('dispositivo que já tinha ativação APROVADA volta a ACTIVE ao desbloquear', async () => {
    findUniqueDeviceMock.mockResolvedValueOnce({ id: 'dev-1', status: 'BLOCKED' });
    findFirstActivationMock.mockResolvedValueOnce({ id: 'act-1' });

    const result: any = await service.unblockDevice('dev-1');

    expect(result.status).toBe('ACTIVE');
  });

  it('só dispositivos BLOCKED podem ser desbloqueados (PENDING/REVOKED/ACTIVE são recusados)', async () => {
    for (const status of ['PENDING', 'REVOKED', 'ACTIVE']) {
      findUniqueDeviceMock.mockResolvedValueOnce({ id: 'dev-1', status });
      await expect(service.unblockDevice('dev-1')).rejects.toThrow('Apenas dispositivos bloqueados');
    }
    expect(updateDeviceMock).not.toHaveBeenCalled();
  });
});
