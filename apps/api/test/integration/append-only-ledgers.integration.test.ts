import { prisma, prismaUnsafeBypassRLS as db, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * LIVROS APPEND-ONLY (migration 20261015120000_append_only_ledgers, Postgres real, papel da aplicação com RLS FORCE).
 * Antes: stock_movements, cash_movements, policy_changes e service_order_status_history tinham UMA policy "ALL" por empresa/filial — qualquer sessão
 * da empresa alterava ou apagava histórico de estoque, dinheiro e política. Agora: SELECT e INSERT como antes; UPDATE sem policy (negado); DELETE só
 * de Super Admin com `app.audit_purge = on` na mesma transação. Com RLS, UPDATE/DELETE negado não dá erro: afeta 0 linhas — por isso os testes
 * conferem a CONTAGEM e o valor lido depois.
 */
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
const asPlatform = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, fn);

describe('livros append-only: UPDATE negado, DELETE só com expurgo sinalizado (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let movId: string;
  let cashMovId: string;
  let changeId: string;
  let historyId: string;
  let osId: string;

  beforeAll(async () => {
    A = await createFixture('aolA');
    B = await createFixture('aolB');
    movId = (
      await asCompany(A.companyId, () =>
        prisma.stockMovement.create({ data: { companyId: A.companyId, branchId: A.branchId, productId: A.productId, movementType: 'ADJUSTMENT', quantity: 3, userId: A.userId } })
      )
    ).id;
    cashMovId = (await asCompany(A.companyId, () => prisma.cashMovement.create({ data: { cashRegisterId: A.cashRegisterId, movementType: 'DEPOSIT', amount: 7, userId: A.userId } }))).id;
    changeId = (
      await asCompany(A.companyId, () => prisma.policyChange.create({ data: { companyId: A.companyId, key: 'company.timezone', newValue: 'UTC', reason: 'teste', changedBy: A.userId } }))
    ).id;
    osId = (
      await bypass<any>(() =>
        db.serviceOrder.create({
          data: { companyId: A.companyId, branchId: A.branchId, osNumber: 9101, customerId: A.customerId, motorcycleId: A.motorcycleId, entryDate: new Date(), entryKilometer: 1, finalTotal: 0 } as any,
        })
      )
    ).id;
    historyId = (await asCompany(A.companyId, () => prisma.serviceOrderStatusHistory.create({ data: { serviceOrderId: osId, toStatus: 'ENTRADA', changedBy: A.userId } }))).id;
  });

  afterAll(async () => {
    if (A) await destroyFixture(A);
    if (B) await destroyFixture(B);
  });

  it('INSERT e SELECT continuam funcionando para a empresa dona (e só para ela)', async () => {
    expect(await asCompany(A.companyId, () => prisma.stockMovement.count({ where: { id: movId } }))).toBe(1);
    expect(await asCompany(B.companyId, () => prisma.stockMovement.count({ where: { id: movId } }))).toBe(0);
    expect(await asCompany(A.companyId, () => prisma.cashMovement.count({ where: { id: cashMovId } }))).toBe(1);
    expect(await asCompany(B.companyId, () => prisma.cashMovement.count({ where: { id: cashMovId } }))).toBe(0);
    expect(await asCompany(A.companyId, () => prisma.policyChange.count({ where: { id: changeId } }))).toBe(1);
    expect(await asCompany(A.companyId, () => prisma.serviceOrderStatusHistory.count({ where: { id: historyId } }))).toBe(1);
  });

  it('UPDATE é negado em todos os quatro livros (0 linhas afetadas, valor intacto) — inclusive para Super Admin', async () => {
    for (const ctx of [(fn: () => Promise<any>) => asCompany(A.companyId, fn), (fn: () => Promise<any>) => asPlatform(fn)]) {
      expect((await ctx(() => prisma.stockMovement.updateMany({ where: { id: movId }, data: { quantity: 999 } }))).count).toBe(0);
      expect((await ctx(() => prisma.cashMovement.updateMany({ where: { id: cashMovId }, data: { amount: 999 } }))).count).toBe(0);
      expect((await ctx(() => prisma.policyChange.updateMany({ where: { id: changeId }, data: { reason: 'adulterado' } }))).count).toBe(0);
      expect((await ctx(() => prisma.serviceOrderStatusHistory.updateMany({ where: { id: historyId }, data: { notes: 'adulterado' } }))).count).toBe(0);
    }
    expect(Number((await bypass<any>(() => db.stockMovement.findUnique({ where: { id: movId } })))!.quantity)).toBe(3);
    expect(Number((await bypass<any>(() => db.cashMovement.findUnique({ where: { id: cashMovId } })))!.amount)).toBe(7);
    expect((await bypass<any>(() => db.policyChange.findUnique({ where: { id: changeId } })))!.reason).toBe('teste');
    expect((await bypass<any>(() => db.serviceOrderStatusHistory.findUnique({ where: { id: historyId } })))!.notes).toBeNull();
  });

  it('DELETE é negado sem o expurgo sinalizado: nem a empresa, nem o Super Admin sem a flag', async () => {
    for (const ctx of [(fn: () => Promise<any>) => asCompany(A.companyId, fn), (fn: () => Promise<any>) => asPlatform(fn)]) {
      expect((await ctx(() => prisma.stockMovement.deleteMany({ where: { id: movId } }))).count).toBe(0);
      expect((await ctx(() => prisma.cashMovement.deleteMany({ where: { id: cashMovId } }))).count).toBe(0);
      expect((await ctx(() => prisma.policyChange.deleteMany({ where: { id: changeId } }))).count).toBe(0);
      expect((await ctx(() => prisma.serviceOrderStatusHistory.deleteMany({ where: { id: historyId } }))).count).toBe(0);
    }
    expect(await bypass<any>(() => db.stockMovement.count({ where: { id: movId } }))).toBe(1);
    expect(await bypass<any>(() => db.cashMovement.count({ where: { id: cashMovId } }))).toBe(1);
  });

  it('a flag de expurgo SEM ser Super Admin também não apaga (empresa não se autoriza)', async () => {
    const deleted = await asCompany(A.companyId, () =>
      runInTransaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
        return tx.stockMovement.deleteMany({ where: { id: movId } });
      })
    );
    expect(deleted.count).toBe(0);
    expect(await bypass<any>(() => db.stockMovement.count({ where: { id: movId } }))).toBe(1);
  });

  it('Super Admin COM a flag na mesma transação apaga (expurgo sinalizado: teste sintético / retenção / LGPD)', async () => {
    const deleted = await asPlatform(() =>
      runInTransaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
        const s = await tx.stockMovement.deleteMany({ where: { id: movId, companyId: A.companyId } });
        const c = await tx.cashMovement.deleteMany({ where: { id: cashMovId, cashRegisterId: A.cashRegisterId } });
        const p = await tx.policyChange.deleteMany({ where: { id: changeId, companyId: A.companyId } });
        const h = await tx.serviceOrderStatusHistory.deleteMany({ where: { id: historyId, serviceOrderId: osId } });
        return [s.count, c.count, p.count, h.count];
      })
    );
    expect(deleted).toEqual([1, 1, 1, 1]);
  });

  it('a flag é local à transação: fora dela o DELETE volta a ser negado', async () => {
    const m = await asCompany(A.companyId, () =>
      prisma.stockMovement.create({ data: { companyId: A.companyId, branchId: A.branchId, productId: A.productId, movementType: 'ADJUSTMENT', quantity: 1, userId: A.userId } })
    );
    await asPlatform(() =>
      runInTransaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
        await tx.stockMovement.count();
      })
    );
    expect((await asPlatform(() => prisma.stockMovement.deleteMany({ where: { id: m.id } }))).count).toBe(0);
    expect(await bypass<any>(() => db.stockMovement.count({ where: { id: m.id } }))).toBe(1);
  });
});
