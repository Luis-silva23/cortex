/**
 * Retirada de caixa (sangria) com dupla autorização — cobre exatamente os
 * cenários exigidos: rejeição sem permissão, autoautorização bloqueada,
 * MFA inválido/ausente, MFA válido, sucesso com e sem MFA, e o impacto no
 * expectedAmount do caixa.
 */

const findFirstCashRegisterMock = jest.fn();
const findFirstUserMock = jest.fn();
const updateUserMock = jest.fn();
const updateManyUserMock = jest.fn();
const findUniqueUserMock = jest.fn();
const cashMovementCreateMock = jest.fn();
const cashRegisterUpdateMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    cashRegister: { findFirst: findFirstCashRegisterMock, update: cashRegisterUpdateMock },
    user: { findFirst: findFirstUserMock, update: updateUserMock, updateMany: updateManyUserMock, findUnique: findUniqueUserMock },
    cashMovement: { create: cashMovementCreateMock },
    $transaction: transactionMock,
  })),
  Prisma: {},
}));

jest.mock('@ln-system/shared/utils/password', () => ({
  comparePassword: jest.fn(),
}));

const verifyCodeMock = jest.fn();
const verifyBackupCodeMock = jest.fn();
jest.mock('./MFAService', () => ({
  mfaService: {
    verifyCode: (...args: any[]) => verifyCodeMock(...args),
    verifyBackupCode: (...args: any[]) => verifyBackupCodeMock(...args),
  },
}));

import { CashRegisterService } from './cash-register.service';
import { comparePassword } from '@ln-system/shared/utils/password';

function baseRegister(overrides: Partial<any> = {}) {
  return {
    id: 'register-1',
    companyId: 'company-A',
    status: 'OPEN',
    expectedAmount: 500,
    ...overrides,
  };
}

function baseAuthorizer(overrides: Partial<any> = {}) {
  return {
    id: 'authorizer-1',
    companyId: 'company-A',
    userType: 'MANAGER',
    isActive: true,
    lockedUntil: null,
    password: 'hashed',
    mfaEnabled: false,
    mfaSecret: null,
    mfaBackupCodes: [],
    ...overrides,
  };
}

function baseRequest(overrides: Partial<any> = {}) {
  return {
    cashRegisterId: 'register-1',
    companyId: 'company-A',
    requesterId: 'requester-1',
    amount: 100,
    reason: 'Depósito bancário',
    authorizerNumericId: 123456,
    authorizerPassword: 'senha-correta',
    ...overrides,
  };
}

describe('CashRegisterService.requestWithdrawal', () => {
  const service = new CashRegisterService();

  beforeEach(() => {
    jest.clearAllMocks();
    transactionMock.mockImplementation(async (cb: any) =>
      cb({
        cashMovement: { create: cashMovementCreateMock },
        cashRegister: { update: cashRegisterUpdateMock },
      })
    );
    cashMovementCreateMock.mockResolvedValue({ id: 'movement-1' });
    cashRegisterUpdateMock.mockResolvedValue({});
    (comparePassword as jest.Mock).mockResolvedValue(true);
  });

  it('rejeita retirada sem caixa aberto', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(null);

    await expect(service.requestWithdrawal(baseRequest())).rejects.toThrow(
      'Cash register not found or already closed'
    );
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita autoautorização: solicitante não pode autorizar a própria retirada', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ id: 'requester-1' }));

    await expect(
      service.requestWithdrawal(baseRequest({ requesterId: 'requester-1' }))
    ).rejects.toThrow('cannot authorize their own withdrawal');
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita autorizador sem perfil permitido (ex: OPERATOR)', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ userType: 'OPERATOR' }));

    await expect(service.requestWithdrawal(baseRequest())).rejects.toThrow(
      'does not have permission to approve'
    );
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita senha do autorizador inválida', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());
    (comparePassword as jest.Mock).mockResolvedValueOnce(false);

    await expect(service.requestWithdrawal(baseRequest())).rejects.toThrow('Invalid authorizer credentials');
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita quando MFA é exigido (autorizador com MFA habilitado) e código não foi informado', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));

    await expect(service.requestWithdrawal(baseRequest())).rejects.toThrow('MFA code is required');
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita código MFA inválido', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));
    verifyCodeMock.mockReturnValueOnce({ valid: false });

    await expect(
      service.requestWithdrawal(baseRequest({ authorizerMfaCode: '000000' }))
    ).rejects.toThrow('Invalid or expired authorizer MFA code');
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita código MFA "expirado" (mesmo tratamento que inválido — TOTP não reconhece)', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));
    verifyCodeMock.mockReturnValueOnce({ valid: false, error: 'expired' });

    await expect(
      service.requestWithdrawal(baseRequest({ authorizerMfaCode: '111111' }))
    ).rejects.toThrow('Invalid or expired authorizer MFA code');
  });

  it('aceita código MFA válido e cria a retirada', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));
    verifyCodeMock.mockReturnValueOnce({ valid: true, step: 100 });
    updateManyUserMock.mockResolvedValueOnce({ count: 1 });

    const result = await service.requestWithdrawal(baseRequest({ authorizerMfaCode: '654321' }));

    expect(result.authorizer.id).toBe('authorizer-1');
    expect(cashMovementCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        movementType: 'WITHDRAWAL',
        amount: 100,
        requestedBy: 'requester-1',
        authorizedBy: 'authorizer-1',
      }),
    });
  });

  it('aceita código de backup MFA válido e consome (uso único)', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(
      baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET', mfaBackupCodes: ['hash-a', 'hash-b'] })
    );
    verifyCodeMock.mockReturnValueOnce({ valid: false });
    findUniqueUserMock.mockResolvedValueOnce({ mfaBackupCodes: ['hash-a', 'hash-b'] });
    verifyBackupCodeMock.mockReturnValueOnce({ valid: true, matchedHash: 'hash-a' });
    updateManyUserMock.mockResolvedValueOnce({ count: 1 });

    await service.requestWithdrawal(baseRequest({ authorizerMfaCode: 'backupcode123456' }));

    // consumo atômico: só grava se a lista no banco ainda for a que foi lida (compare-and-swap)
    expect(updateManyUserMock).toHaveBeenCalledWith({
      where: { id: 'authorizer-1', mfaBackupCodes: { equals: ['hash-a', 'hash-b'] } },
      data: { mfaBackupCodes: ['hash-b'] },
    });
  });

  it('rejeita o REUSO do código TOTP: o passo já consumido não autoriza uma segunda retirada', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET' }));
    verifyCodeMock.mockReturnValueOnce({ valid: true, step: 100 });
    updateManyUserMock.mockResolvedValueOnce({ count: 0 }); // outro pedido já consumiu este passo

    await expect(service.requestWithdrawal(baseRequest({ authorizerMfaCode: '654321' }))).rejects.toThrow('Authorizer MFA code already used');
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('rejeita código de backup já consumido por outra requisição (a lista mudou entre a leitura e a gravação e o código saiu dela)', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer({ mfaEnabled: true, mfaSecret: 'SECRET', mfaBackupCodes: ['hash-a'] }));
    verifyCodeMock.mockReturnValueOnce({ valid: false });
    findUniqueUserMock.mockResolvedValueOnce({ mfaBackupCodes: ['hash-a'] });
    verifyBackupCodeMock.mockReturnValueOnce({ valid: true, matchedHash: 'hash-a' });
    updateManyUserMock.mockResolvedValueOnce({ count: 0 }); // perdeu a corrida
    findUniqueUserMock.mockResolvedValueOnce({ mfaBackupCodes: [] }); // relê: o código já saiu da lista
    verifyBackupCodeMock.mockReturnValueOnce({ valid: false, error: 'Invalid or already used backup code' });

    await expect(service.requestWithdrawal(baseRequest({ authorizerMfaCode: 'backupcode123456' }))).rejects.toThrow('Invalid or expired authorizer MFA code');
    expect(cashMovementCreateMock).not.toHaveBeenCalled();
  });

  it('sucesso sem MFA (autorizador não tem MFA habilitado) decrementa expectedAmount do caixa', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister({ expectedAmount: 500 }));
    findFirstUserMock.mockResolvedValueOnce(baseAuthorizer());

    const result = await service.requestWithdrawal(baseRequest({ amount: 150 }));

    expect(cashRegisterUpdateMock).toHaveBeenCalledWith({
      where: { id: 'register-1' },
      data: { expectedAmount: { decrement: 150 } },
    });
    expect(result.drawerSupported).toBe(false);
  });

  it('permite múltiplas retiradas sequenciais (cada uma com sua própria autorização)', async () => {
    findFirstCashRegisterMock.mockResolvedValue(baseRegister());
    findFirstUserMock.mockResolvedValue(baseAuthorizer());

    await service.requestWithdrawal(baseRequest({ amount: 50 }));
    await service.requestWithdrawal(baseRequest({ amount: 75 }));

    expect(cashMovementCreateMock).toHaveBeenCalledTimes(2);
  });

  it('rejeita valor zero ou negativo', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());

    await expect(service.requestWithdrawal(baseRequest({ amount: 0 }))).rejects.toThrow(
      'Amount must be greater than zero'
    );
  });

  it('rejeita motivo vazio/curto demais', async () => {
    findFirstCashRegisterMock.mockResolvedValueOnce(baseRegister());

    await expect(service.requestWithdrawal(baseRequest({ reason: 'ab' }))).rejects.toThrow(
      'Reason is required'
    );
  });
});

describe('CashRegisterService.addCashMovement — retirada bloqueada na rota genérica', () => {
  const service = new CashRegisterService();

  it('rejeita WITHDRAWAL na rota de movimento genérico (deve usar requestWithdrawal)', async () => {
    await expect(
      service.addCashMovement({
        cashRegisterId: 'register-1',
        companyId: 'company-A',
        movementType: 'WITHDRAWAL',
        amount: 50,
        userId: 'user-1',
      })
    ).rejects.toThrow('exige autorização de um segundo usuário');
    expect(findFirstCashRegisterMock).not.toHaveBeenCalled();
  });
});
