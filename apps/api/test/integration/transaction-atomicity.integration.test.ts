import { runInTransaction, prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Suíte de integração REAL (PostgreSQL, nenhum mock) que trava em código o
 * achado CRÍTICO de 2026-09-14: `prisma.$transaction(async (tx) => ...)` no
 * client estendido (RLS) NUNCA foi realmente atômico nem serializava locks
 * — cada `tx.algumModelo.xxx()` dentro do callback reabria sua própria
 * mini-transação independente via `$allOperations` (ver comentário longo em
 * packages/database/src/index.ts), commitando na hora, sem relação com o
 * `tx` "externo". Um `tx.customer.create()` seguido de um erro mais adiante
 * NÃO desfazia o create; e `tx.$queryRaw ... FOR UPDATE` nem passava pelo
 * `$allOperations` (só cobre operações de MODELO), rodando sem nenhum
 * `set_config` aplicado — como RLS é FORCE em todas as tabelas, o lock
 * travava ZERO linhas, silenciosamente.
 *
 * `runInTransaction` (packages/database/src/index.ts) corrige isso abrindo
 * a transação real direto em `basePrisma` (nunca no client estendido) e
 * aplicando `set_config(..., true)` UMA vez, como a 1ª instrução — o
 * `is_local=true` do Postgres faz esse valor persistir pela transação
 * inteira, então toda chamada seguinte em `tx` (modelo OU raw) já enxerga o
 * contexto certo sem reabrir nada. Esta suíte prova as duas garantias que a
 * versão anterior não tinha: rollback de verdade, e lock que realmente
 * serializa.
 */

describe('runInTransaction — atomicidade e lock reais (Postgres real)', () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createFixture('txatomic');
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it('um erro lançado DEPOIS de um create() dentro da transação desfaz o create (rollback real)', async () => {
    let createdCustomerId: string | undefined;

    await expect(
      runWithRLSContext({ companyId: fixture.companyId, userType: 'OPERATOR', branchId: fixture.branchId }, () =>
        runInTransaction(async (tx) => {
          const customer = await tx.customer.create({
            data: { companyId: fixture.companyId, name: 'Deveria sumir se a transação for atômica', isActive: true },
          });
          createdCustomerId = customer.id;
          throw new Error('erro deliberado depois do create, para forçar rollback');
        })
      )
    ).rejects.toThrow('erro deliberado depois do create, para forçar rollback');

    expect(createdCustomerId).toBeDefined();

    // Verificação direta no banco, com bypass total de RLS (mesmo padrão
    // usado em rbac.integration.test.ts) — se a transação for de verdade
    // atômica, este cliente NUNCA deveria ter sido persistido.
    const [, found] = await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.customer.findUnique({ where: { id: createdCustomerId! } }) as any,
    ]);

    expect(found).toBeNull();
  }, 30000);

  it('SELECT ... FOR UPDATE dentro da transação realmente serializa duas transações concorrentes na mesma linha', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const log: string[] = [];

    async function worker(label: string) {
      return runWithRLSContext({ companyId: fixture.companyId, userType: 'OPERATOR', branchId: fixture.branchId }, () =>
        runInTransaction(async (tx) => {
          log.push(`${label}:before-lock:${Date.now()}`);
          await tx.$queryRaw`SELECT id FROM products WHERE id = ${fixture.productId} FOR UPDATE`;
          log.push(`${label}:acquired-lock:${Date.now()}`);
          await sleep(500);
          log.push(`${label}:commit:${Date.now()}`);
          return label;
        })
      );
    }

    const start = Date.now();
    await Promise.all([worker('A'), worker('B')]);
    const elapsed = Date.now() - start;

    // Se o lock realmente serializa, a 2ª transação só consegue "adquirir o
    // lock" DEPOIS que a 1ª já "commitou" — nunca as duas de posse do lock
    // ao mesmo tempo. Checamos isso diretamente no log de timestamps, não
    // só no tempo total (mais robusto que só medir `elapsed`).
    const acquiredA = log.find((l) => l.startsWith('A:acquired-lock'))!.split(':')[2];
    const acquiredB = log.find((l) => l.startsWith('B:acquired-lock'))!.split(':')[2];
    const commitA = log.find((l) => l.startsWith('A:commit'))!.split(':')[2];
    const commitB = log.find((l) => l.startsWith('B:commit'))!.split(':')[2];

    const [firstAcquired, firstCommit, secondAcquired] =
      Number(acquiredA) < Number(acquiredB)
        ? [Number(acquiredA), Number(commitA), Number(acquiredB)]
        : [Number(acquiredB), Number(commitB), Number(acquiredA)];

    expect(firstAcquired).toBeLessThanOrEqual(firstCommit);
    // A prova central: quem adquiriu o lock por último só conseguiu DEPOIS
    // que quem tinha o lock primeiro terminou (commit), não antes.
    expect(secondAcquired).toBeGreaterThanOrEqual(firstCommit);
    expect(elapsed).toBeGreaterThan(900);
  }, 30000);
});
