/**
 * Mock manual de stock-ledger para testes de unidade: o saldo vem do mock de `stockMovement.findMany` (do `tx` recebido
 * ou do `prisma` mockado) dobrado pela regra de referência em memória. O SQL real é conferido contra essa mesma regra
 * em test/integration/stock-ledger.integration.test.ts.
 */
const actual = jest.requireActual('../stock-ledger');

type Scope = { productId: string; companyId: string; branchId?: string | null };

function source(client?: any) {
  return client ?? require('@ln-system/database').prisma;
}

async function read(scope: Scope, opts: { client?: any; withHistory?: boolean } = {}) {
  const movements = await source(opts.client).stockMovement.findMany({
    where: { productId: scope.productId, companyId: scope.companyId, ...(scope.branchId && { branchId: scope.branchId }) },
    orderBy: { createdAt: 'asc' },
  });
  const ledger = actual.foldMovements(movements ?? []);
  return opts.withHistory ? ledger : { ...ledger, history: [] };
}

async function balances(scope: { companyId: string; branchId?: string | null; productIds: string[] }, client?: any) {
  const entries = await Promise.all(
    scope.productIds.map(async (productId) => {
      const { balance, count } = await read({ ...scope, productId }, { client });
      return [productId, { balance, count }] as const;
    })
  );
  return new Map(entries);
}

module.exports = { ...actual, stockLedger: { read: jest.fn(read), balances: jest.fn(balances) } };
