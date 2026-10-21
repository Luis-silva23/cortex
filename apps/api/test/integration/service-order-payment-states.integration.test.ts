import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import serviceOrderService from '../../src/services/service-order.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Pagamento da OS por estado (business-state-machines.md, "OS — pagamento"): só depois da conclusão técnica, quando
 * o total é final — PRONTO e ENTREGA. Antes disso o valor ainda muda (itens, mão de obra) e a comissão congelaria um
 * total provisório; ENCERRADA já é o pós-pagamento; CANCELADA nunca.
 */
describe('Pagamento de OS respeita a máquina de estados (integração real)', () => {
  let fixture: IntegrationFixture;
  const PAYABLE = ['PRONTO', 'ENTREGA'];
  const ALL = ['ENTRADA', 'DIAGNOSTICO', 'ORCAMENTO', 'APROVACAO', 'EXECUCAO', 'PRONTO', 'ENTREGA', 'ENCERRADA', 'CANCELADA'] as const;

  beforeAll(async () => {
    fixture = await createFixture('ospaystates');
  });
  afterAll(async () => {
    if (fixture) {
      await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: fixture.companyId } }));
      await destroyFixture(fixture);
    }
  });

  it.each(ALL.map((s, i) => [s, i] as const))('estado %s', async (status, i) => {
    const os = await bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, osNumber: 7100 + i, customerId: fixture.customerId,
          motorcycleId: fixture.motorcycleId, entryDate: new Date(), entryKilometer: 1000, status, laborTotal: 50, finalTotal: 50,
          isPaid: status === 'ENCERRADA',
        },
      })
    );
    const pay = runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
      serviceOrderService.registerPayment(os.id, fixture.companyId, 'CASH')
    );
    const receivables = () => bypass<any[]>(() => db.accountsReceivable.findMany({ where: { companyId: fixture.companyId, referenceId: os.id } }));

    if (PAYABLE.includes(status)) {
      await expect(pay).resolves.toMatchObject({ isPaid: true });
      expect(await receivables()).toHaveLength(1);
    } else {
      await expect(pay).rejects.toThrow();
      expect(await receivables()).toHaveLength(0);
    }
  });
});
