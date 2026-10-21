import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { prismaUnsafeBypassRLS as db, contextStatement } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * audit_logs append-only (Postgres real): nenhuma rota apaga/edita auditoria, mas a policy única do 0_init valia
 * para todos os comandos — qualquer sessão da aplicação no contexto da empresa podia UPDATE/DELETE a própria
 * trilha. Migration 20260925100000: UPDATE negado; DELETE só com expurgo sinalizado (retenção) em Super Admin.
 */
describe('audit_logs é append-only (HTTP + banco)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  const stamp = `aud-${Date.now()}`;
  let logId: string;

  const tokenAs = (userType: string) =>
    generateAccessToken({ userId: fixture.userId, email: 'x@test.local', companyId: fixture.companyId, branchId: undefined as any, userType });

  // Executa SQL cru sob um contexto RLS explícito, numa transação (como a aplicação faz).
  async function rawAs(ctx: { company: string; userType: string; purge?: boolean }, sql: string, ...params: unknown[]) {
    const results = await db.$transaction([
      contextStatement(db, { companyId: ctx.company, userType: ctx.userType, branchId: null }),
      db.$executeRawUnsafe(`SELECT set_config('app.audit_purge', $1, true)`, ctx.purge ? 'on' : 'off'),
      db.$executeRawUnsafe(sql, ...params),
    ]);
    return results[2] as number;
  }

  const exists = async (id: string) => (await bypass<any>(() => db.auditLog.findUnique({ where: { id } }))) !== null;

  beforeAll(async () => {
    fixture = await createFixture('auditappend');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    logId = (
      await bypass<any>(() =>
        db.auditLog.create({ data: { companyId: fixture.companyId, userId: fixture.userId, action: 'UPDATE', entity: 'IntegrationProbe', entityId: stamp } })
      )
    ).id;
  });
  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  });

  it.each(['COMPANY_ADMIN', 'MANAGER', 'SUPER_ADMIN'])('API: DELETE /audit-logs/:id como %s não existe e o registro fica', async (userType) => {
    const res = await request(app)
      .delete(`/api/audit-logs/${logId}`)
      .set({ Authorization: `Bearer ${tokenAs(userType)}`, 'X-Company-Id': fixture.companyId });
    expect([404, 405]).toContain(res.status);
    expect(await exists(logId)).toBe(true);
  });

  it('banco: a própria empresa não apaga nem altera sua trilha (0 linhas)', async () => {
    expect(await rawAs({ company: fixture.companyId, userType: 'COMPANY_ADMIN' }, 'DELETE FROM audit_logs WHERE id = $1', logId)).toBe(0);
    expect(await rawAs({ company: fixture.companyId, userType: 'COMPANY_ADMIN' }, `UPDATE audit_logs SET action = 'DELETE' WHERE id = $1`, logId)).toBe(0);
    expect(await exists(logId)).toBe(true);
  });

  it('banco: Super Admin também não altera, e só apaga com expurgo sinalizado', async () => {
    expect(await rawAs({ company: '', userType: 'SUPER_ADMIN' }, `UPDATE audit_logs SET action = 'DELETE' WHERE id = $1`, logId)).toBe(0);
    expect(await rawAs({ company: '', userType: 'SUPER_ADMIN' }, 'DELETE FROM audit_logs WHERE id = $1', logId)).toBe(0);
    expect(await exists(logId)).toBe(true);

    const purgeable = (
      await bypass<any>(() =>
        db.auditLog.create({ data: { companyId: fixture.companyId, action: 'UPDATE', entity: 'IntegrationProbe', entityId: `${stamp}-purge` } })
      )
    ).id;
    expect(await rawAs({ company: '', userType: 'SUPER_ADMIN', purge: true }, 'DELETE FROM audit_logs WHERE id = $1', purgeable)).toBe(1);
  });

  it('continua possível gravar auditoria no contexto da empresa (INSERT)', async () => {
    const n = await rawAs(
      { company: fixture.companyId, userType: 'COMPANY_ADMIN' },
      `INSERT INTO audit_logs (id, "companyId", action, entity, "entityId", "createdAt") VALUES (gen_random_uuid(), $1, 'CREATE', 'IntegrationProbe', $2, now())`,
      fixture.companyId,
      `${stamp}-insert`
    );
    expect(n).toBe(1);
  });
});
