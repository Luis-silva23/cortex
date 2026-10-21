import { requireDeviceForCashOps } from './device';
import { policyService } from '../services/policy.service';

jest.mock('../services/policy.service', () => ({ policyService: { get: jest.fn() } }));
const getPolicy = policyService.get as jest.Mock;

const run = async (user: Record<string, unknown> | undefined) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await requireDeviceForCashOps({ user } as any, res, next);
  return { res, next };
};

describe('guarda de equipamento nas operações de caixa (devices.requiredUserTypes)', () => {
  beforeEach(() => getPolicy.mockReset());

  it('lista vazia (padrão): passa, com ou sem equipamento — sem consultar além da política', async () => {
    getPolicy.mockResolvedValue([]);
    const { next, res } = await run({ userId: 'u', userType: 'OPERATOR', companyId: 'A', branchId: 'b1' });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('perfil listado SEM sessão de equipamento (dsid): 403 DEVICE_REQUIRED e não segue', async () => {
    getPolicy.mockResolvedValue(['OPERATOR']);
    const { next, res } = await run({ userId: 'u', userType: 'OPERATOR', companyId: 'A', branchId: 'b1' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('DEVICE_REQUIRED');
    expect(next).not.toHaveBeenCalled();
    expect(getPolicy).toHaveBeenCalledWith('A', 'b1', 'devices.requiredUserTypes'); // a política é DA empresa do usuário
  });

  it('perfil listado COM sessão de equipamento: passa sem nem ler a política', async () => {
    const { next } = await run({ userId: 'u', userType: 'OPERATOR', companyId: 'A', dsid: 'sessao-1' });
    expect(next).toHaveBeenCalledWith();
    expect(getPolicy).not.toHaveBeenCalled();
  });

  it('perfil fora da lista e Super Admin (sem empresa) não são afetados', async () => {
    getPolicy.mockResolvedValue(['OPERATOR']);
    expect((await run({ userId: 'u', userType: 'MANAGER', companyId: 'A' })).next).toHaveBeenCalledWith();
    getPolicy.mockClear();
    expect((await run({ userId: 'sa', userType: 'SUPER_ADMIN' })).next).toHaveBeenCalledWith();
    expect(getPolicy).not.toHaveBeenCalled();
  });

  it('falha ao ler a política vira erro (500), nunca "libera" a operação em silêncio', async () => {
    getPolicy.mockRejectedValue(new Error('banco fora'));
    const { next, res } = await run({ userId: 'u', userType: 'OPERATOR', companyId: 'A' });
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });
});
