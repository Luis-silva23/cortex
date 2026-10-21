import { prismaUnsafeBypassRLS, runWithRLSContext, runInTransaction, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { stockLedger, foldMovements } from '../../src/services/stock-ledger';
import stockService from '../../src/services/stock.service';
import customerService from '../../src/services/customer.service';
import { createFixture, destroyFixture, IntegrationFixture, purgeStockMovements } from './helpers/fixture';

/**
 * Saldo de estoque calculado no banco — prova REAL (Postgres/RLS).
 *
 * ACHADO DE PERFORMANCE: cada consulta de saldo trazia TODAS as movimentações do produto para o Node (em cada item de
 * venda, baixa de peça, ajuste, transferência) e relatório/painel/alerta faziam isso produto a produto (N+1). Agora o
 * Postgres agrega. Aqui se confere, sobre um livro gerado com todos os tipos, ajustes negativos, vários inventários,
 * empates de horário e duas filiais, que o SQL dá exatamente o mesmo saldo e histórico da regra em memória.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

// SUPPLIER_RETURN (devolução ao fornecedor, 2026-09-28): saída. Sem ele no livro gerado, um SQL que ignorasse o tipo
// (ELSE 0) passaria despercebido.
const TYPES = ['PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'PRODUCTION', 'LOSS', 'INVENTORY', 'SUPPLIER_RETURN'] as const;

// Gerador determinístico (a mesma sequência a cada execução).
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe('Saldo de estoque no banco = regra do livro (integração real)', () => {
  let A: IntegrationFixture;
  let branch2: string;
  let product2: string;
  const asAdmin = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

  const ordered = (where: object) =>
    bypass<any[]>(() =>
      prismaUnsafeBypassRLS.stockMovement.findMany({ where: { companyId: A.companyId, ...where }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    );

  beforeAll(async () => {
    A = await createFixture('stock-ledger');
    branch2 = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.branch.create({ data: { companyId: A.companyId, name: 'Filial 2', isActive: true }, select: { id: true } })
      )
    ).id;
    product2 = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.product.create({
          data: { companyId: A.companyId, branchId: A.branchId, sku: `LEDGER-2-${Date.now()}`, name: 'Produto 2', costPrice: 1, salePrice: 2, isActive: true },
          select: { id: true },
        })
      )
    ).id;
    // Livro controlado pelo teste (o fixture semeia estoque inicial) — escopo explícito por empresa.
    await purgeStockMovements(A.companyId);

    const next = rng(42);
    const base = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: 400 }, (_, i) => {
      const t = TYPES[Math.floor(next() * TYPES.length)];
      const mag = Math.round(next() * 5000) / 1000 + 0.001; // decimais de 3 casas
      const quantity = t === 'ADJUSTMENT' && next() < 0.5 ? -mag : t === 'SALE' && next() < 0.2 ? -mag : mag;
      return {
        companyId: A.companyId,
        branchId: next() < 0.7 ? A.branchId : branch2,
        productId: next() < 0.8 ? A.productId : product2,
        movementType: t,
        quantity,
        userId: A.userId,
        // Blocos de 3 no mesmo milissegundo: empates de horário (desempate por id, igual ao SQL).
        createdAt: new Date(base + Math.floor(i / 3) * 60_000),
      };
    });
    await bypass(() => prismaUnsafeBypassRLS.stockMovement.createMany({ data: rows as any }));
  });

  afterAll(async () => {
    await destroyFixture(A);
  });

  it.each([
    ['empresa toda', undefined],
    ['filial 1', 'b1'],
    ['filial 2', 'b2'],
  ])('saldo e histórico (%s) iguais aos da regra em memória', async (_label, which) => {
    const branchId = which === 'b1' ? A.branchId : which === 'b2' ? branch2 : undefined;
    for (const productId of [A.productId, product2]) {
      const expected = foldMovements(await ordered({ productId, ...(branchId && { branchId }) }));
      const got = await asAdmin(() => stockLedger.read({ productId, companyId: A.companyId, branchId }, { withHistory: true }));
      expect(got.count).toBe(expected.count);
      expect(got.count).toBeGreaterThan(0);
      expect(got.balance).toBeCloseTo(expected.balance, 6);
      expect(got.history.map((h) => [h.type, h.quantity, Number(h.balance.toFixed(6))])).toEqual(
        expected.history.map((h) => [h.type, h.quantity, Number(h.balance.toFixed(6))])
      );
    }
  });

  it('o livro gerado exercita inventário, ajuste negativo e saída com sinal', async () => {
    const all = await ordered({});
    expect(all.filter((m) => m.movementType === 'INVENTORY').length).toBeGreaterThan(5);
    expect(all.some((m) => m.movementType === 'ADJUSTMENT' && Number(m.quantity) < 0)).toBe(true);
    expect(all.some((m) => m.movementType === 'SALE' && Number(m.quantity) < 0)).toBe(true);
    expect(all.filter((m) => m.movementType === 'SUPPLIER_RETURN').length).toBeGreaterThan(5);
  });

  it('devolução ao fornecedor (SUPPLIER_RETURN) é SAÍDA no saldo do banco', async () => {
    const product = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.product.create({
          data: { companyId: A.companyId, branchId: A.branchId, sku: `LEDGER-SR-${Date.now()}`, name: 'Devolvido', costPrice: 1, salePrice: 2, isActive: true },
          select: { id: true },
        })
      )
    ).id;
    await bypass(() =>
      prismaUnsafeBypassRLS.stockMovement.createMany({
        data: [
          { companyId: A.companyId, branchId: A.branchId, productId: product, movementType: 'PURCHASE', quantity: 10, userId: A.userId, createdAt: new Date(Date.UTC(2026, 5, 1)) },
          { companyId: A.companyId, branchId: A.branchId, productId: product, movementType: 'SUPPLIER_RETURN', quantity: 3, userId: A.userId, createdAt: new Date(Date.UTC(2026, 5, 2)) },
        ] as any,
      })
    );
    const got = await asAdmin(() => stockLedger.read({ productId: product, companyId: A.companyId, branchId: A.branchId }));
    expect(got.balance).toBe(7);
  });

  it('vários produtos numa consulta: mesmo saldo da leitura individual; produto sem movimento = 0', async () => {
    const empty = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.product.create({
          data: { companyId: A.companyId, branchId: A.branchId, sku: `LEDGER-0-${Date.now()}`, name: 'Sem movimento', costPrice: 1, salePrice: 2, isActive: true },
          select: { id: true },
        })
      )
    ).id;
    const many = await asAdmin(() =>
      stockLedger.balances({ companyId: A.companyId, branchId: A.branchId, productIds: [A.productId, product2, empty] })
    );
    for (const id of [A.productId, product2]) {
      const one = await asAdmin(() => stockLedger.read({ productId: id, companyId: A.companyId, branchId: A.branchId }));
      expect(many.get(id)).toEqual({ balance: one.balance, count: one.count });
    }
    expect(many.get(empty)).toEqual({ balance: 0, count: 0 });
  });

  it('dentro da transação do chamador enxerga o que ela acabou de gravar (mesma conexão do lock)', async () => {
    const before = (await asAdmin(() => stockService.getBalance(A.productId, A.companyId, A.branchId))).balance;
    const inside = await asAdmin(() =>
      runInTransaction(async (tx) => {
        await tx.stockMovement.create({
          data: { companyId: A.companyId, branchId: A.branchId, productId: A.productId, movementType: 'PURCHASE', quantity: 7, userId: A.userId },
        });
        const b = (await stockService.getBalance(A.productId, A.companyId, A.branchId, tx)).balance;
        throw Object.assign(new Error('rollback'), { balance: b });
      }).catch((e) => e.balance as number)
    );
    expect(inside).toBeCloseTo(before + 7, 6);
    const after = (await asAdmin(() => stockService.getBalance(A.productId, A.companyId, A.branchId))).balance;
    expect(after).toBeCloseTo(before, 6);
  });

  it('RLS: outra empresa não lê o saldo (produto não encontrado) e o agregado não vaza movimentos', async () => {
    const otherCompany = { companyId: '00000000-0000-0000-0000-000000000000', userType: 'COMPANY_ADMIN' as const, branchId: null };
    await expect(runWithRLSContext(otherCompany, () => stockService.getBalance(A.productId, A.companyId))).rejects.toThrow();
    const leaked = await runWithRLSContext(otherCompany, () =>
      stockLedger.balances({ companyId: A.companyId, productIds: [A.productId] })
    );
    expect(leaked.get(A.productId)).toEqual({ balance: 0, count: 0 });
  });

  it('relatório de estoque usa o mesmo saldo (sem consulta por produto)', async () => {
    const report = await asAdmin(() => stockService.getStockReport({ companyId: A.companyId, branchId: A.branchId }));
    const row = report.find((r: any) => r.product.id === A.productId)!;
    const one = await asAdmin(() => stockLedger.read({ productId: A.productId, companyId: A.companyId, branchId: A.branchId }));
    expect(row.stock.balance).toBe(one.balance);
    expect(row.stock.hasMovements).toBe(true);
  });

  it('estatística do cliente: "última compra" é a venda mais recente (antes: uma venda qualquer)', async () => {
    const mk = (n: number, date: string, total: number) =>
      bypass(() =>
        prismaUnsafeBypassRLS.sale.create({
          data: {
            companyId: A.companyId, branchId: A.branchId, saleNumber: 7700 + n, customerId: A.customerId, userId: A.userId,
            cashRegisterId: A.cashRegisterId, status: 'PAID', subtotal: total, totalAmount: total, paidAmount: total, saleDate: new Date(date),
          },
        })
      );
    // Criadas fora de ordem: a mais recente não é a primeira nem a última inserida.
    await mk(1, '2026-03-01T12:00:00Z', 100);
    await mk(2, '2026-05-10T12:00:00Z', 50);
    await mk(3, '2026-01-15T12:00:00Z', 30);
    const { stats } = await asAdmin(() => customerService.getCustomerStats(A.customerId, A.companyId));
    expect(stats.totalSales).toBe(3);
    expect(stats.totalPurchases).toBe(180);
    expect(stats.avgTicket).toBe(60);
    expect(new Date(stats.lastPurchase as Date).toISOString()).toBe('2026-05-10T12:00:00.000Z');
  });
});
