import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import serviceOrderService from '../../src/services/service-order.service';
import stockService from '../../src/services/stock.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * OS (Postgres real):
 *  - duas transições simultâneas APROVACAO -> EXECUCAO: o status era conferido fora da transação e o update não
 *    tinha condição; as duas liam os itens com isCompleted=false e baixavam as peças DUAS vezes;
 *  - OS CANCELADA aceitava registerPayment: gerava conta a receber PAGA e comissão do mecânico.
 */
describe('OS: transições concorrentes e pagamento de OS cancelada (integração real)', () => {
  let fixture: IntegrationFixture;

  const asCompany = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

  const newOs = (osNumber: number, status: 'APROVACAO' | 'CANCELADA', productId: string = fixture.productId, partQty = 2) =>
    bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          osNumber,
          customerId: fixture.customerId,
          motorcycleId: fixture.motorcycleId,
          entryDate: new Date(),
          entryKilometer: 1000,
          status,
          laborTotal: 100,
          partsTotal: 20,
          finalTotal: 120,
          items: {
            create: [{ itemType: 'PART', productId, description: 'Peça', quantity: partQty, unitPrice: 10, totalPrice: 10 * partQty }],
          },
        },
      })
    );

  beforeAll(async () => {
    fixture = await createFixture('osrace');
    await bypass(() =>
      db.stockMovement.create({
        data: { companyId: fixture.companyId, branchId: fixture.branchId, productId: fixture.productId, movementType: 'PURCHASE', quantity: 10, userId: fixture.userId },
      })
    );
  });

  afterAll(async () => {
    if (fixture) {
      await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: fixture.companyId } }));
      await destroyFixture(fixture);
    }
  });

  it('duas transições simultâneas para EXECUCAO: peças baixadas uma única vez', async () => {
    const os = await newOs(8001, 'APROVACAO');
    const start = () => asCompany(() => serviceOrderService.transitionStatus(os.id, fixture.companyId, 'EXECUCAO', fixture.userId));
    const results = await Promise.allSettled([start(), start()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const moves = await bypass<any[]>(() => db.stockMovement.findMany({ where: { companyId: fixture.companyId, referenceId: os.id } }));
    expect(moves.reduce((s, m) => s + Number(m.quantity), 0)).toBe(-2);
    const history = await bypass<any[]>(() => db.serviceOrderStatusHistory.findMany({ where: { serviceOrderId: os.id } }));
    expect(history).toHaveLength(1);
  });

  it('várias OS diferentes disputam a ÚLTIMA unidade ao iniciar a execução: uma executa, a outra é recusada e o saldo nunca fica negativo', async () => {
    const product = await bypass<any>(() =>
      db.product.create({
        data: { companyId: fixture.companyId, branchId: fixture.branchId, sku: `LAST-${Date.now()}`, name: 'Última peça', costPrice: 5, salePrice: 10, isActive: true },
      })
    );
    await bypass(() =>
      db.stockMovement.create({
        data: { companyId: fixture.companyId, branchId: fixture.branchId, productId: product.id, movementType: 'PURCHASE', quantity: 1, userId: fixture.userId },
      })
    );
    const contenders: any[] = [];
    for (let i = 0; i < 6; i++) contenders.push(await newOs(8003 + i, 'APROVACAO', product.id, 1));
    const start = (id: string) => asCompany(() => serviceOrderService.transitionStatus(id, fixture.companyId, 'EXECUCAO', fixture.userId));
    const results = await Promise.allSettled(contenders.map((o) => start(o.id)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const moves = await bypass<any[]>(() =>
      db.stockMovement.findMany({ where: { companyId: fixture.companyId, productId: product.id, movementType: 'SALE' } })
    );
    expect(moves).toHaveLength(1);
    const balance = await asCompany(() => stockService.getBalance(product.id, fixture.companyId, fixture.branchId));
    expect(balance.balance).toBe(0);
    const statuses = await bypass<any[]>(() => db.serviceOrder.findMany({ where: { id: { in: contenders.map((o) => o.id) }, companyId: fixture.companyId } }));
    expect(statuses.filter((o) => o.status === 'EXECUCAO')).toHaveLength(1);
    expect(statuses.filter((o) => o.status === 'APROVACAO')).toHaveLength(5);
  });

  it('OS cancelada não recebe pagamento (sem conta a receber)', async () => {
    const os = await newOs(8020, 'CANCELADA');
    await expect(asCompany(() => serviceOrderService.registerPayment(os.id, fixture.companyId, 'CASH'))).rejects.toThrow();
    const receivables = await bypass<any[]>(() => db.accountsReceivable.findMany({ where: { companyId: fixture.companyId, referenceId: os.id } }));
    expect(receivables).toHaveLength(0);
  });
});
