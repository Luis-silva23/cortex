import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import cashRegisterService from '../../src/services/cash-register.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Reforços de caixa simultâneos (Postgres real): addCashMovement gravava `expectedAmount` ABSOLUTO calculado de
 * uma leitura feita antes da transação — reforços concorrentes sobrescreviam uns aos outros e o caixa "esquecia"
 * dinheiro que entrou (o movimento existe, o saldo esperado não o soma).
 */
describe('Caixa: reforços simultâneos somam todos no saldo esperado (integração real)', () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createFixture('cashrace');
    await bypass(() =>
      db.cashRegister.update({ where: { id: fixture.cashRegisterId }, data: { status: 'OPEN', expectedAmount: 0, openingAmount: 0 } })
    );
  });
  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  });

  it('6 reforços de R$ 10 em paralelo => saldo esperado R$ 60 (igual à soma dos movimentos)', async () => {
    const deposit = () =>
      runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        cashRegisterService.addCashMovement({
          cashRegisterId: fixture.cashRegisterId,
          companyId: fixture.companyId,
          movementType: 'DEPOSIT',
          amount: 10,
          userId: fixture.userId,
          requesterUserType: 'COMPANY_ADMIN',
        })
      );
    const results = await Promise.allSettled(Array.from({ length: 6 }, deposit));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);

    const register = await bypass<any>(() => db.cashRegister.findUnique({ where: { id: fixture.cashRegisterId } }));
    const movements = await bypass<any[]>(() => db.cashMovement.findMany({ where: { cashRegisterId: fixture.cashRegisterId, movementType: 'DEPOSIT' } }));
    expect(movements.reduce((s, m) => s + Number(m.amount), 0)).toBe(60);
    expect(Number(register.expectedAmount)).toBe(60);
  });

  it('reforço num caixa que acabou de ser fechado é recusado', async () => {
    await bypass(() => db.cashRegister.update({ where: { id: fixture.cashRegisterId }, data: { status: 'CLOSED', closedAt: new Date() } }));
    await expect(
      runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        cashRegisterService.addCashMovement({
          cashRegisterId: fixture.cashRegisterId, companyId: fixture.companyId, movementType: 'DEPOSIT', amount: 10,
          userId: fixture.userId, requesterUserType: 'COMPANY_ADMIN',
        })
      )
    ).rejects.toThrow();
  });
});
