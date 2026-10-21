/**
 * ACHADO DE AUDITORIA (corrida real): `processAuditJob` inseria o
 * `AuditLog` sempre com o `userId` capturado no momento da ação original.
 * Se esse usuário fosse apagado de verdade (DELETE /users/:id -> hard
 * delete real em user.service.ts::delete) ANTES de este job assíncrono
 * rodar, o INSERT violava a FK (`AuditLog.userId -> User.id`) e todo o
 * registro (ação/entidade/valores antigo-novo) era perdido — justo no
 * cenário de maior risco: usuário apagado logo após uma ação suspeita é
 * quando a trilha de auditoria mais importa. `onDelete: SetNull` no schema
 * só protege linhas JÁ EXISTENTES na hora da deleção, não um INSERT novo
 * cujo usuário referenciado já não existe mais. Este teste comprova que o
 * job agora verifica a existência do usuário antes de inserir e degrada
 * para userId nulo em vez de perder o registro inteiro.
 */

const findUniqueUserMock = jest.fn();
const createAuditLogMock = jest.fn().mockResolvedValue({ id: 'audit-1' });

jest.mock('@ln-system/database', () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => findUniqueUserMock(...args) },
    auditLog: { create: (...args: any[]) => createAuditLogMock(...args) },
  },
  runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

jest.mock('../services/logger.service', () => ({
  Logger: {
    audit: jest.fn(),
  },
}));

import { processAuditJob, AuditJobData } from './audit.job';

function buildJob(data: Partial<AuditJobData>): any {
  return {
    data: {
      companyId: 'company-A',
      userId: 'user-1',
      action: 'UPDATE',
      entity: 'Product',
      entityId: 'product-1',
      oldValue: null,
      newValue: null,
      ipAddress: null,
      userAgent: null,
      ...data,
    },
  };
}

describe('processAuditJob — degradação graciosa quando o usuário já foi apagado', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('grava normalmente com userId quando o usuário ainda existe', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'user-1' });

    await processAuditJob(buildJob({}));

    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1' }) })
    );
  });

  it('degrada para userId nulo (preservando ação/entidade/valores) quando o usuário já foi apagado, em vez de perder o registro inteiro', async () => {
    findUniqueUserMock.mockResolvedValueOnce(null);

    await processAuditJob(
      buildJob({ userId: 'user-deletado', action: 'DELETE', entity: 'Product', oldValue: '{"price":100}' })
    );

    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: null,
          action: 'DELETE',
          entity: 'Product',
          oldValue: '{"price":100}',
        }),
      })
    );
  });

  it('não consulta o usuário quando o job não tem userId (ação de sistema)', async () => {
    await processAuditJob(buildJob({ userId: null }));

    expect(findUniqueUserMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null }) })
    );
  });
});
