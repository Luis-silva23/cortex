import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import saleService from '../../src/services/sale.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Estorno de venda nunca devolve mais do que foi vendido/pago (Postgres real):
 *  - cancelar DEPOIS de uma devolução parcial repunha a quantidade ORIGINAL de todos os itens e estornava o
 *    total aprovado inteiro: o que já tinha voltado ao estoque/caixa na devolução voltava de novo;
 *  - duas devoluções parciais seguidas limitavam cada uma ao total aprovado, não ao que RESTAVA dele: numa venda
 *    com desconto, a soma dos estornos passava do valor pago.
 */
describe('Devolução e cancelamento não estornam em dobro (integração real)', () => {
  let fixture: IntegrationFixture;
  let managerNumericId: number;
  let registerId: string;
  let product2Id: string;
  const stamp = `rev-${Date.now()}`;
  const PASSWORD = 'Autoriza-123!';

  const asCompany = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
  const auth = () => ({ authorizerNumericId: managerNumericId, authorizerPassword: PASSWORD });

  async function newSale(saleNumber: number) {
    return bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          saleNumber,
          customerId: fixture.customerId,
          userId: fixture.userId,
          cashRegisterId: registerId,
          status: 'PAID',
          subtotal: 40,
          discountAmount: 10,
          totalAmount: 30,
          items: {
            create: [
              { productId: fixture.productId, productName: 'P1', productSku: `${stamp}-1`, quantity: 2, unitPrice: 10, totalPrice: 20 },
              { productId: product2Id, productName: 'P2', productSku: `${stamp}-2`, quantity: 2, unitPrice: 10, totalPrice: 20 },
            ],
          },
          payments: { create: [{ paymentMethod: 'CASH', status: 'APPROVED', amount: 30 }] },
        },
        include: { items: true },
      })
    );
  }

  const refunded = async (saleId: string) => {
    const rows = await bypass<any[]>(() => db.cashMovement.findMany({ where: { cashRegisterId: registerId, referenceId: saleId } }));
    return rows.reduce((s, r) => s + Number(r.amount), 0);
  };
  const restocked = async (saleId: string) => {
    const rows = await bypass<any[]>(() => db.stockMovement.findMany({ where: { companyId: fixture.companyId, referenceId: saleId } }));
    return rows.reduce((s, r) => s + Number(r.quantity), 0);
  };

  beforeAll(async () => {
    fixture = await createFixture('reversal');
    const hashed = await hashPassword(PASSWORD);
    const manager = await bypass<any>(() =>
      db.user.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          name: 'Gerente autorizador',
          email: `${stamp}-mgr@test.local`,
          password: hashed,
          userType: 'MANAGER',
          isActive: true,
        },
      })
    );
    managerNumericId = manager.numericId;
    registerId = (
      await bypass<any>(() =>
        db.cashRegister.create({
          // no nome do gerente: a fixture já tem um caixa aberto do operador (índice "1 caixa aberto por usuário")
          data: { companyId: fixture.companyId, branchId: fixture.branchId, userId: manager.id, registerNumber: 700 + Math.floor(Math.random() * 200), status: 'OPEN', openingAmount: 0, expectedAmount: 60 },
        })
      )
    ).id;
    product2Id = (
      await bypass<any>(() =>
        db.product.create({ data: { companyId: fixture.companyId, branchId: fixture.branchId, sku: `${stamp}-p2`, name: 'P2', costPrice: 5, salePrice: 10, isActive: true } })
      )
    ).id;
  });

  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  });

  it('cancelar depois de devolução parcial repõe e estorna só o que restava', async () => {
    const sale = await newSale(9001);
    await asCompany(() =>
      saleService.returnSale({
        id: sale.id, companyId: fixture.companyId, requesterId: fixture.userId, reason: 'devolução parcial',
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }], ...auth(),
      })
    );
    expect(await refunded(sale.id)).toBe(7.5); // 1 de 2 unidades de uma linha de 20, rateio pago/líquido = 30/40
    expect(await restocked(sale.id)).toBe(1);

    await asCompany(() =>
      saleService.cancelSale({ id: sale.id, companyId: fixture.companyId, requesterId: fixture.userId, reason: 'cancelamento', ...auth() })
    );

    expect(await restocked(sale.id)).toBe(4); // 4 vendidas, nunca 5
    expect(await refunded(sale.id)).toBe(30); // pago 30, nunca 40
  });

  it('duas devoluções parciais numa venda com desconto não estornam mais que o pago', async () => {
    const sale = await newSale(9002);
    for (const item of sale.items) {
      await asCompany(() =>
        saleService.returnSale({
          id: sale.id, companyId: fixture.companyId, requesterId: fixture.userId, reason: 'devolução',
          items: [{ saleItemId: item.id, quantity: 2 }], ...auth(),
        })
      );
    }
    expect(await restocked(sale.id)).toBe(4);
    expect(await refunded(sale.id)).toBe(30); // pago 30 (40 - desconto 10), nunca 40
  });
});
