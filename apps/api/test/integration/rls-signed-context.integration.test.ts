import { createHmac, randomBytes } from 'crypto';
import { prismaUnsafeBypassRLS as db, contextGucs, CONTEXT_SET_CONFIG_SQL, type ContextGucs } from '@ln-system/database';
import { bypass, createWorld, destroyWorld, World } from './helpers/tenant-world';
import { contextSecretHex } from '../../scripts/lib/rls-context-secret';

/**
 * CONTEXTO DE RLS ASSINADO (decisão 151) — a semântica do verificador no banco de teste (papel dono; o teste como papel SEM posse, que prova que ele
 * não lê o cofre nem desliga a exigência, está em `npm run db:role-split-check`). Aqui: o que o banco aceita e o que recusa quando alguém grava as
 * variáveis de sessão por SQL cru.
 */
describe('contexto de RLS assinado — falsificação por SQL cru', () => {
  let world: World;

  const apply = (g: ContextGucs) =>
    db.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, g['app.current_company_id'], g['app.current_branch_id'], g['app.current_branch_ids'], g['app.user_type'], g['app.user_id'], g['app.ctx_iat'], g['app.ctx_sig']);
  /** linhas de empresas + clientes que o contexto enxerga (0 = nada). */
  const seen = async (g: ContextGucs | null) => {
    const r = (await db.$transaction([g ? apply(g) : db.$executeRawUnsafe('SELECT 1'), db.$queryRawUnsafe('SELECT (SELECT count(*) FROM companies) + (SELECT count(*) FROM customers) AS n')])) as [number, Array<{ n: bigint }>];
    return Number(r[1][0].n);
  };
  const scalar = async (g: ContextGucs, fn: string) => {
    const r = (await db.$transaction([apply(g), db.$queryRawUnsafe(`SELECT ${fn} AS v`)])) as [number, Array<{ v: unknown }>];
    return r[1][0].v;
  };

  beforeAll(async () => {
    world = await createWorld();
    await bypass(() => db.customer.create({ data: { companyId: world.A.companyId, name: 'Cliente sintético A (contexto assinado)' } }));
  }, 60_000);
  afterAll(async () => destroyWorld(world));

  const adminA = () => contextGucs({ companyId: world.A.companyId, userType: 'COMPANY_ADMIN', branchId: null });

  it('o banco de teste EXIGE o contexto assinado (a suíte inteira roda assim)', async () => {
    const rows = (await db.$queryRawUnsafe('SELECT enforced, secret_slots FROM app_ctx.status()')) as Array<{ enforced: boolean; secret_slots: number }>;
    expect(rows[0].enforced).toBe(true);
    expect(Number(rows[0].secret_slots)).toBeGreaterThanOrEqual(1);
  });

  it('contexto legítimo assinado: administrador da empresa A enxerga a empresa A e só ela', async () => {
    expect(await seen(adminA())).toBeGreaterThanOrEqual(1);
    expect(await scalar(adminA(), 'app_ctx.company_id()')).toBe(world.A.companyId);
    expect(await scalar(adminA(), 'app_ctx.is_company_wide()')).toBe(true);
    expect(await scalar(adminA(), 'app_ctx.is_super_admin()')).toBe(false);
    const withB = await db.$transaction([apply(adminA()), db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM companies WHERE id = '${world.B.companyId}'`)]);
    expect((withB[1] as Array<{ n: number }>)[0].n).toBe(0);
  });

  it('SQL cru sem assinatura: virar SUPER_ADMIN não enxerga nada', async () => {
    expect(await seen({ ...adminA(), 'app.user_type': 'SUPER_ADMIN', 'app.ctx_sig': '' })).toBe(0);
    expect(await seen(null)).toBe(0);
  });

  it('assinatura de COMPANY_ADMIN reaproveitada com papel promovido, empresa trocada ou filiais acrescentadas não vale', async () => {
    expect(await seen({ ...adminA(), 'app.user_type': 'SUPER_ADMIN' })).toBe(0);
    expect(await seen({ ...adminA(), 'app.current_company_id': world.B.companyId })).toBe(0);
    expect(await seen({ ...adminA(), 'app.current_branch_ids': 'x,y' })).toBe(0);
    expect(await seen({ ...adminA(), 'app.current_branch_id': 'x' })).toBe(0);
    expect(await seen({ ...adminA(), 'app.user_id': 'outro-usuario' })).toBe(0);
    expect(await scalar({ ...adminA(), 'app.user_type': 'SUPER_ADMIN' }, 'app_ctx.is_super_admin()')).toBe(false);
  });

  it('assinatura com chave errada, lixo, vazia, expirada ou do futuro não vale', async () => {
    const wrongKey = createHmac('sha256', randomBytes(32)).update('v1|qualquer').digest('hex');
    expect(await seen({ ...adminA(), 'app.ctx_sig': wrongKey })).toBe(0);
    expect(await seen({ ...adminA(), 'app.ctx_sig': 'zzzz' })).toBe(0);
    expect(await seen({ ...adminA(), 'app.ctx_iat': 'abc' })).toBe(0);
    expect(await seen(contextGucs({ companyId: world.A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, Date.now() - 10 * 60_000))).toBe(0);
    expect(await seen(contextGucs({ companyId: world.A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, Date.now() + 10 * 60_000))).toBe(0);
    // dentro da janela (±120 s) vale
    expect(await seen(contextGucs({ companyId: world.A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, Date.now() - 60_000))).toBeGreaterThanOrEqual(1);
  });

  it('gerente de duas filiais: a lista ASSINADA vira o conjunto autorizado; lista adulterada não vale', async () => {
    const a1 = world.A.branches[1].branchId;
    const a2 = world.A.branches[2].branchId;
    const manager = contextGucs({ companyId: world.A.companyId, userType: 'MANAGER', branchId: a1, branchIds: [a1, a2] });
    expect(await scalar(manager, 'app_ctx.branch_ids()::text')).toBe(`{${[a1, a2].sort().join(',')}}`);
    expect(await scalar(manager, 'app_ctx.is_company_wide()')).toBe(false);
    expect(await scalar({ ...manager, 'app.current_branch_ids': [a1, a2, 'invasor'].join(',') }, 'app_ctx.branch_ids()::text')).toBeNull();
    // sem lista: só a filial ativa (comportamento anterior)
    const single = contextGucs({ companyId: world.A.companyId, userType: 'MANAGER', branchId: a1 });
    expect(await scalar(single, 'app_ctx.branch_ids()::text')).toBe(`{${a1}}`);
  });

  it('rotação do segredo: o novo vale, o anterior vale até ser aposentado e depois não vale mais; o estado é restaurado', async () => {
    const original = contextSecretHex();
    const novo = randomBytes(32).toString('hex');
    const assinadoComOriginal = adminA();
    // Com o papel SEM posse (suíte do `db:role-split-check`) a rotação é privilégio do DONO: o papel de execução tem que ser NEGADO e nada pode mudar.
    const podeProvisionar = ((await db.$queryRawUnsafe(`SELECT has_function_privilege(current_user, 'app_ctx.provision(bytea)', 'EXECUTE') AS ok`)) as Array<{ ok: boolean }>)[0].ok;
    if (!podeProvisionar) {
      await expect(db.$executeRawUnsafe(`SELECT app_ctx.provision(decode($1, 'hex'))`, novo)).rejects.toThrow();
      await expect(db.$executeRawUnsafe('SELECT app_ctx.retire_previous()')).rejects.toThrow();
      expect(await seen(assinadoComOriginal)).toBeGreaterThanOrEqual(1); // o segredo vigente continua valendo
      return;
    }
    try {
      await db.$executeRawUnsafe(`SELECT app_ctx.provision(decode($1, 'hex'))`, novo);
      expect(Number(((await db.$queryRawUnsafe('SELECT secret_slots FROM app_ctx.status()')) as Array<{ secret_slots: number }>)[0].secret_slots)).toBe(2);
      expect(await seen(assinadoComOriginal)).toBeGreaterThanOrEqual(1); // o anterior segue valendo (as instâncias da API ainda não trocaram)
      await db.$executeRawUnsafe('SELECT app_ctx.retire_previous()');
      expect(await seen(assinadoComOriginal)).toBe(0); // aposentado
      // provisionar o MESMO segredo de novo é idempotente (não gira os slots)
      await db.$executeRawUnsafe(`SELECT app_ctx.provision(decode($1, 'hex'))`, novo);
      expect(Number(((await db.$queryRawUnsafe('SELECT secret_slots FROM app_ctx.status()')) as Array<{ secret_slots: number }>)[0].secret_slots)).toBe(1);
    } finally {
      await db.$executeRawUnsafe(`SELECT app_ctx.provision(decode($1, 'hex'))`, original);
      await db.$executeRawUnsafe('SELECT app_ctx.retire_previous()');
    }
    expect(await seen(adminA())).toBeGreaterThanOrEqual(1);
  });
});
