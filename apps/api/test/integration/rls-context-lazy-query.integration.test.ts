import { prisma, runWithRLSContext, prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * A consulta do Prisma é preguiçosa: só executa no `.then`. `runWithRLSContext(ctx, () => prisma.x.findMany())`
 * devolvia a consulta ainda não executada e o `.then` acontecia FORA do contexto — a consulta rodava sem
 * `set_config`, a RLS (FORCE) negava tudo e o resultado vinha vazio, em silêncio. Era o caso de jobs de produção
 * (backup automático via `prisma.company.findMany`, licenças expirando) e da reconciliação de pagamentos.
 */
describe('runWithRLSContext com consulta devolvida sem await (integração real)', () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createFixture('lazyctx');
  });
  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  });

  it('consulta devolvida direto enxerga as linhas do contexto', async () => {
    const expected = await bypass<number>(() => db.customer.count({ where: { companyId: fixture.companyId } }));
    expect(expected).toBeGreaterThan(0);

    const asSuperAdmin = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
      prisma.customer.count({ where: { companyId: fixture.companyId } })
    );
    const asCompany = await runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
      prisma.company.findMany({ where: { id: fixture.companyId }, select: { id: true } })
    );
    expect(asSuperAdmin).toBe(expected);
    expect(asCompany).toHaveLength(1);
  });

  it('fora de contexto a RLS continua negando (falha fechada)', async () => {
    expect(await prisma.customer.count({ where: { companyId: fixture.companyId } })).toBe(0);
  });
});
