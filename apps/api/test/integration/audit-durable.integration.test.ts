import crypto from 'crypto';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { persistAuditLog } from '../../src/jobs/audit.job';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Auditoria durável e IDEMPOTENTE (Fase 4): a mesma auditoria entregue pela fila e pela gravação direta de reserva vira UMA linha.
 * Prova real contra o Postgres.
 */
async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}
const db = prismaUnsafeBypassRLS as any;

describe('auditoria durável e idempotente', () => {
  let A: IntegrationFixture;
  beforeAll(async () => {
    A = await createFixture('audD');
  }, 60000);
  afterAll(async () => {
    await destroyFixture(A);
  }, 60000);

  const base = (id: string | undefined) => ({ id, companyId: A.companyId, userId: A.userId, action: 'UPDATE', entity: 'Sale', entityId: 'sale-x', oldValue: null, newValue: '{"ok":true}', ipAddress: '10.0.0.1', userAgent: 'jest' });

  it('gravar a mesma auditoria duas vezes (fila + reserva) deixa UMA linha', async () => {
    const id = crypto.randomUUID();
    await persistAuditLog(base(id));
    await persistAuditLog(base(id));
    await Promise.all([persistAuditLog(base(id)), persistAuditLog(base(id))]);
    expect(await bypass<number>(() => db.auditLog.count({ where: { id } }))).toBe(1);
    const row = await bypass<any>(() => db.auditLog.findUnique({ where: { id } }));
    expect(row).toMatchObject({ companyId: A.companyId, userId: A.userId, entity: 'Sale', ipAddress: '10.0.0.1' });
  });

  it('sem id continua gravando uma linha por chamada (compatível com os chamadores antigos)', async () => {
    const before = await bypass<number>(() => db.auditLog.count({ where: { companyId: A.companyId, entityId: 'sale-noid' } }));
    await persistAuditLog({ ...base(undefined), entityId: 'sale-noid' });
    await persistAuditLog({ ...base(undefined), entityId: 'sale-noid' });
    expect(await bypass<number>(() => db.auditLog.count({ where: { companyId: A.companyId, entityId: 'sale-noid' } }))).toBe(before + 2);
  });

  it('usuário apagado entre a ação e a gravação: a auditoria é preservada com userId nulo', async () => {
    const id = crypto.randomUUID();
    await persistAuditLog({ ...base(id), userId: crypto.randomUUID() });
    const row = await bypass<any>(() => db.auditLog.findUnique({ where: { id } }));
    expect(row.userId).toBeNull();
    expect(row.entity).toBe('Sale');
  });
});
