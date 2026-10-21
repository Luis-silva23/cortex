import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import purchaseOrderService from '../../src/services/purchase-order.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Suíte de integração REAL (PostgreSQL + RLS reais, nenhum mock) para dois
 * achados de auditoria em compras:
 *
 * 1) receive(): o mesmo itemId repetido em `items` passava na checagem de
 *    "quanto falta receber" (calculada de um snapshot lido uma vez antes do
 *    laço) em cada entrada e recebia em dobro — estoque inflado no ledger.
 * 2) returnToSupplier(): não validava que o produto pertence ao pedido nem
 *    limitava a quantidade ao recebido menos o já devolvido, e checagem e
 *    escrita não estavam sob o mesmo lock — devoluções concorrentes
 *    passavam juntas pelo mesmo saldo devolvível.
 */

async function runInRLSContext<T>(companyId: string, branchId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId }, fn);
}

// Leitura/escrita de verificação com bypass total de RLS — mesmo padrão e
// mesma razão de rbac.integration.test.ts (runWithRLSContext sequencial
// logo após várias chamadas anteriores é instável neste ambiente).
async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Compras — integridade de recebimento e devolução (Postgres real)', () => {
  let fixture: IntegrationFixture;
  let otherProductId: string;

  beforeAll(async () => {
    fixture = await createFixture('po-integrity');
    const other = await bypass<any>(() =>
      prismaUnsafeBypassRLS.product.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          sku: `INT-po-other-${Date.now()}`,
          name: 'Produto fora do pedido',
          costPrice: 1,
          salePrice: 2,
          isActive: true,
        },
      })
    );
    otherProductId = other.id;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  async function newConfirmedPo(quantity: number) {
    const po = await runInRLSContext(fixture.companyId, fixture.branchId, () =>
      purchaseOrderService.create({
        companyId: fixture.companyId,
        branchId: fixture.branchId,
        supplierId: fixture.supplierId,
        items: [{ productId: fixture.productId, quantity, unitCost: 5 }],
      })
    );
    await runInRLSContext(fixture.companyId, fixture.branchId, () =>
      purchaseOrderService.approve(po.id, fixture.companyId, fixture.userId)
    );
    return po;
  }

  function receive(poId: string, items: Array<{ itemId: string; receivedQuantity: number }>) {
    return runInRLSContext(fixture.companyId, fixture.branchId, () =>
      purchaseOrderService.receive(poId, fixture.companyId, { branchId: fixture.branchId, userId: fixture.userId, items })
    );
  }

  function returnToSupplier(poId: string, productId: string, quantity: number) {
    return runInRLSContext(fixture.companyId, fixture.branchId, () =>
      purchaseOrderService.returnToSupplier(poId, fixture.companyId, {
        branchId: fixture.branchId,
        userId: fixture.userId,
        productId,
        quantity,
        reason: 'teste de integração',
      })
    );
  }

  async function movementsOf(poId: string, referenceType: string) {
    return bypass<Array<{ quantity: any; movementType: string }>>(() =>
      prismaUnsafeBypassRLS.stockMovement.findMany({ where: { referenceType, referenceId: poId } })
    );
  }

  it('itemId repetido: [{A,10},{A,10}] num item com 10 restantes é rejeitado e NADA é gravado (antes recebia 20)', async () => {
    const po = await newConfirmedPo(10);
    const itemId = po.items[0].id;

    await expect(
      receive(po.id, [
        { itemId, receivedQuantity: 10 },
        { itemId, receivedQuantity: 10 },
      ])
    ).rejects.toThrow('Cannot receive 20 of item');

    const item = await bypass<any>(() => prismaUnsafeBypassRLS.purchaseOrderItem.findUnique({ where: { id: itemId } }));
    expect(Number(item.receivedQuantity)).toBe(0);
    expect(await movementsOf(po.id, 'PurchaseOrder')).toHaveLength(0);
  });

  it('itemId repetido que soma dentro do restante grava UMA movimentação com o total e fecha o pedido', async () => {
    const po = await newConfirmedPo(10);
    const itemId = po.items[0].id;

    const result = await receive(po.id, [
      { itemId, receivedQuantity: 4 },
      { itemId, receivedQuantity: 6 },
    ]);

    expect(result!.status).toBe('RECEIVED');
    const movements = await movementsOf(po.id, 'PurchaseOrder');
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].quantity)).toBe(10);
  });

  it('devolução: produto fora do pedido, acima do recebido e acima do saldo devolvível são rejeitados', async () => {
    const po = await newConfirmedPo(10);
    await receive(po.id, [{ itemId: po.items[0].id, receivedQuantity: 10 }]);

    await expect(returnToSupplier(po.id, otherProductId, 1)).rejects.toThrow('Product is not part of this purchase order');
    await expect(returnToSupplier(po.id, fixture.productId, 11)).rejects.toThrow('only 10 returnable');
    await expect(returnToSupplier(po.id, fixture.productId, 0)).rejects.toThrow('greater than zero');

    await returnToSupplier(po.id, fixture.productId, 3);
    await expect(returnToSupplier(po.id, fixture.productId, 8)).rejects.toThrow(
      'only 7 returnable from this purchase order (received 10, already returned 3)'
    );

    const returns = await movementsOf(po.id, 'PurchaseReturn');
    expect(returns).toHaveLength(1);
    expect(Number(returns[0].quantity)).toBe(-3);
  });

  it('5 devoluções concorrentes de 4 sobre 10 recebidas: só 2 passam (total 8) — nunca excede o recebido', async () => {
    const po = await newConfirmedPo(10);
    await receive(po.id, [{ itemId: po.items[0].id, receivedQuantity: 10 }]);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => returnToSupplier(po.id, fixture.productId, 4))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(String(r.reason.message)).toMatch(/returnable from this purchase order/);
    }

    const returns = await movementsOf(po.id, 'PurchaseReturn');
    const totalReturned = returns.reduce((sum, m) => sum + Math.abs(Number(m.quantity)), 0);
    expect(totalReturned).toBe(8);
  });
});
