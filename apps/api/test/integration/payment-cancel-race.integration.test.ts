import { prismaUnsafeBypassRLS as db, runWithRLSContext, CONTEXT_SET_CONFIG_SQL, contextSqlParams, PLATFORM_CONTEXT } from '@ln-system/database';
import paymentService from '../../src/services/payment.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Pagamento x cancelamento concorrentes (Postgres real, interleaving forçado): processPayment conferia o status
 * da venda ANTES da transação e, depois do `FOR UPDATE`, não conferia de novo. Se o cancelamento comitasse nesse
 * intervalo, o pagamento era criado APROVADO e a venda cancelada voltava a PAID — dinheiro entrando numa venda
 * cujo estoque já tinha sido reposto.
 *
 * O teste segura o lock da linha da venda numa transação própria, deixa o pagamento passar pela checagem inicial
 * e esperar o lock, cancela a venda e só então libera.
 */
describe('Venda cancelada não recebe pagamento concorrente (integração real)', () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createFixture('paycancel');
  });
  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  });

  it('cancelamento que comita enquanto o pagamento espera o lock => pagamento recusado, venda segue CANCELLED', async () => {
    const sale = await bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          saleNumber: 7001,
          customerId: fixture.customerId,
          userId: fixture.userId,
          cashRegisterId: fixture.cashRegisterId,
          status: 'PENDING',
          subtotal: 30,
          totalAmount: 30,
        },
      })
    );

    let paymentOutcome: Promise<unknown> | undefined;
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(PLATFORM_CONTEXT));
        await tx.$queryRawUnsafe(`SELECT id FROM sales WHERE id = $1 FOR UPDATE`, sale.id);

        paymentOutcome = runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
          paymentService.processPayment({ companyId: fixture.companyId, saleId: sale.id, paymentMethod: 'CASH', amount: 30 })
        ).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error: String(error?.message ?? error) })
        );
        await new Promise((resolve) => setTimeout(resolve, 800)); // pagamento já passou da checagem e está no lock

        await tx.sale.update({ where: { id: sale.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'race' } });
      },
      { timeout: 15000 }
    );

    const outcome: any = await paymentOutcome;
    expect(outcome.ok).toBe(false);

    const after = await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id }, include: { payments: true } }));
    expect(after.status).toBe('CANCELLED');
    expect(after.payments.filter((p: any) => p.status === 'APPROVED')).toHaveLength(0);
  });
});
