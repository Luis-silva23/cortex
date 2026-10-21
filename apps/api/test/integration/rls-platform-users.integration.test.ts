import { prismaUnsafeBypassRLS as db, prisma, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * A política de `users` deixava qualquer contexto de empresa ler os usuários da plataforma (companyId nulo: Super
 * Admins), com hash de senha e segredo de MFA. Agora só o Super Admin os lê; a empresa lê só os próprios usuários.
 */
describe('RLS de users: usuários da plataforma invisíveis para as empresas (integração real)', () => {
  let fixture: IntegrationFixture;
  let platformUserId: string;

  beforeAll(async () => {
    fixture = await createFixture('rlsplat');
    platformUserId = (
      await bypass<any>(() =>
        db.user.create({ data: { name: 'Plataforma RLS', email: `plat-${Date.now()}@test.local`, password: 'x', userType: 'SUPER_ADMIN', isActive: true } })
      )
    ).id;
  });
  afterAll(async () => {
    if (platformUserId) await bypass(() => db.user.deleteMany({ where: { id: platformUserId, companyId: null } }));
    if (fixture) await destroyFixture(fixture);
  });

  it.each(['COMPANY_ADMIN', 'MANAGER', 'OPERATOR'])('contexto %s da empresa: não enxerga o usuário da plataforma, enxerga os próprios', async (userType) => {
    const seen = await runWithRLSContext({ companyId: fixture.companyId, userType, branchId: fixture.branchId }, () =>
      prisma.user.findMany({ where: { OR: [{ id: platformUserId }, { id: fixture.userId }] }, select: { id: true } })
    );
    expect(seen.map((u) => u.id)).toEqual([fixture.userId]);
  });

  it('contexto SUPER_ADMIN (login, painel da plataforma): enxerga o usuário da plataforma', async () => {
    const seen = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
      prisma.user.findUnique({ where: { id: platformUserId }, select: { id: true } })
    );
    expect(seen?.id).toBe(platformUserId);
  });
});
