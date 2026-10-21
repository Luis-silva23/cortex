import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Perfis granulares (requirePermission) — HTTP + Postgres reais:
 *  - requirePermission não olhava o userType: um VIEWER (papel só-leitura) que recebesse um perfil com
 *    `finance:pay` recebia/pagava/estornava;
 *  - getUserPermissions ignorava UserRole.branchId: um perfil atribuído só na filial A1 valia em toda a empresa.
 * Regra aplicada: VIEWER nunca passa em requirePermission (só protege escrita); perfil com filial só vale quando o
 * token opera naquela filial; perfil sem filial vale na empresa.
 */
describe('requirePermission respeita papel só-leitura e escopo de filial do perfil (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = `prs-${Date.now()}`;
  let roleId: string;
  const receivables: Record<string, string> = {};

  const A = () => world.A;
  const receive = (id: string, token: string) =>
    request(app).post(`/api/financial/receivables/${id}/receive`).set(bearer(token));

  async function grant(userId: string, branchId: string | null) {
    await bypass(() => db.userRole.create({ data: { userId, roleId, branchId } }));
  }

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const permission = await bypass<any>(() => db.permission.create({ data: { companyId: A().companyId, name: 'finance:pay' } }));
    roleId = (await bypass<any>(() => db.role.create({ data: { companyId: A().companyId, name: `${stamp}-caixa` } }))).id;
    await bypass(() => db.rolePermission.create({ data: { roleId, permissionId: permission.id } }));

    for (const [key, branch] of [['viewer', 1], ['a2', 2], ['a2ok', 2]] as const) {
      receivables[key] = (
        await bypass<any>(() =>
          db.accountsReceivable.create({
            data: {
              companyId: A().companyId, branchId: A().branches[branch].branchId, description: `${stamp}-${key}`,
              amount: 10, dueDate: new Date(Date.now() + 86_400_000),
            },
          })
        )
      ).id;
    }
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) {
      await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: A().companyId, description: { startsWith: stamp } } }));
      await bypass(() => db.role.deleteMany({ where: { companyId: A().companyId, name: { startsWith: stamp } } }));
      await bypass(() => db.permission.deleteMany({ where: { companyId: A().companyId, name: 'finance:pay' } }));
      await destroyWorld(world);
    }
  });

  it('VIEWER com perfil que concede finance:pay continua sem poder receber (403) — conta intacta', async () => {
    await grant(A().branches[1].userId, null);
    const res = await receive(receivables.viewer, tokenFor(A(), 1, 'VIEWER'));
    expect(res.status).toBe(403);
    const r = await bypass<any>(() => db.accountsReceivable.findUnique({ where: { id: receivables.viewer } }));
    expect(r.status).not.toBe('PAID');
  });

  it('perfil atribuído só na filial A1 não vale para usuário de empresa inteira (A2 recusada)', async () => {
    // usuário de empresa inteira cujo ÚNICO perfil é o da filial A1
    const manager = await bypass<any>(() =>
      db.user.create({
        data: { companyId: A().companyId, name: 'Gerente empresa', email: `${stamp}-mgr@test.local`, password: 'x', userType: 'MANAGER', isActive: true },
      })
    );
    await grant(manager.id, A().branches[1].branchId);
    const token = generateAccessToken({ userId: manager.id, email: manager.email, companyId: A().companyId, branchId: undefined as any, userType: 'MANAGER' });
    const res = await receive(receivables.a2, token);
    expect(res.status).toBe(403);
  });

  it('perfil da filial A2 vale para quem opera na A2 (controle positivo)', async () => {
    await grant(A().branches[2].userId, A().branches[2].branchId);
    const res = await receive(receivables.a2ok, tokenFor(A(), 2, 'MANAGER'));
    expect(res.status).toBe(200);
  });
});
