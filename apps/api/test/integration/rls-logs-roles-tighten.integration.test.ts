import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * RLS DE LOGS E DE PERFIS/PERMISSÕES GLOBAIS (Postgres real, papel da aplicação).
 * Achado da revisão do banco: (1) `request_logs` e `system_logs` tinham `WITH CHECK true` — uma sessão de empresa gravava log com o
 * companyId de OUTRA empresa — e `USING (… OR companyId IS NULL)`, então enxergava os logs de PLATAFORMA (eventos de segurança de outros
 * usuários); (2) `roles` e `permissions` usavam `USING (… OR companyId IS NULL)` em comando ALL: o DELETE/UPDATE de uma sessão de empresa
 * alcançava os perfis e permissões GLOBAIS (de sistema). Agora: logs só da própria empresa (ou plataforma); globais legíveis por todos,
 * mas só o Super Admin escreve neles.
 */
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
const asPlatform = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, fn);

describe('RLS: logs de plataforma e perfis/permissões globais não são alcançáveis por uma empresa (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  const stamp = Date.now();
  let platformSystemLogId: string;
  let platformRequestLogId: string;
  let globalRoleId: string;
  let globalPermissionId: string;
  const createdLogIds: { system: string[]; request: string[] } = { system: [], request: [] };

  beforeAll(async () => {
    A = await createFixture('rlsloA');
    B = await createFixture('rlsloB');
    const sys = await asPlatform(() =>
      prisma.systemLog.create({ data: { level: 'WARN', category: 'security', service: 'teste', event: `PLATFORM_EVENT_${stamp}`, message: 'evento de plataforma sintético', companyId: null } })
    );
    platformSystemLogId = sys.id;
    const req = await asPlatform(() =>
      prisma.requestLog.create({ data: { requestId: `rl-${stamp}`, method: 'GET', route: '/teste', statusCode: 200, durationMs: 1, companyId: null } })
    );
    platformRequestLogId = req.id;
    const role = await asPlatform(() => prisma.role.create({ data: { name: `global-${stamp}`, companyId: null, isSystem: false } }));
    globalRoleId = role.id;
    const perm = await asPlatform(() => prisma.permission.create({ data: { name: `global:perm:${stamp}`, companyId: null } }));
    globalPermissionId = perm.id;
  });

  afterAll(async () => {
    const sysIds = [platformSystemLogId, ...createdLogIds.system].filter(Boolean);
    const reqIds = [platformRequestLogId, ...createdLogIds.request].filter(Boolean);
    if (sysIds.length) await asPlatform(() => prisma.systemLog.deleteMany({ where: { id: { in: sysIds } } }));
    if (reqIds.length) await asPlatform(() => prisma.requestLog.deleteMany({ where: { id: { in: reqIds } } }));
    if (globalRoleId) await asPlatform(() => prisma.role.deleteMany({ where: { id: globalRoleId } }));
    if (globalPermissionId) await asPlatform(() => prisma.permission.deleteMany({ where: { id: globalPermissionId } }));
    if (A) await destroyFixture(A);
    if (B) await destroyFixture(B);
  });

  it('LEITURA: a empresa não enxerga log de plataforma (companyId nulo) nem log de outra empresa', async () => {
    expect(await asCompany(A.companyId, () => prisma.systemLog.findMany({ where: { id: platformSystemLogId } }))).toHaveLength(0);
    expect(await asCompany(A.companyId, () => prisma.requestLog.findMany({ where: { id: platformRequestLogId } }))).toHaveLength(0);
    // e o Super Admin continua enxergando
    expect(await asPlatform(() => prisma.systemLog.findMany({ where: { id: platformSystemLogId } }))).toHaveLength(1);
    expect(await asPlatform(() => prisma.requestLog.findMany({ where: { id: platformRequestLogId } }))).toHaveLength(1);
  });

  it('LEITURA: o log da própria empresa continua visível para ela e invisível para a outra', async () => {
    const mine = await asPlatform(() =>
      prisma.systemLog.create({ data: { level: 'INFO', category: 'application', service: 'teste', event: `OWN_${stamp}`, message: 'log da empresa A', companyId: A.companyId } })
    );
    createdLogIds.system.push(mine.id);
    expect(await asCompany(A.companyId, () => prisma.systemLog.findMany({ where: { id: mine.id } }))).toHaveLength(1);
    expect(await asCompany(B.companyId, () => prisma.systemLog.findMany({ where: { id: mine.id } }))).toHaveLength(0);
  });

  it('ESCRITA: a empresa A não consegue gravar log em nome da empresa B nem log de plataforma', async () => {
    await expect(
      asCompany(A.companyId, () => prisma.systemLog.create({ data: { level: 'INFO', category: 'application', service: 'teste', event: `SPOOF_${stamp}`, message: 'falso', companyId: B.companyId } }))
    ).rejects.toBeTruthy();
    await expect(
      asCompany(A.companyId, () => prisma.requestLog.create({ data: { requestId: `spoof-${stamp}`, method: 'GET', route: '/x', statusCode: 200, durationMs: 1, companyId: B.companyId } }))
    ).rejects.toBeTruthy();
    await expect(
      asCompany(A.companyId, () => prisma.systemLog.create({ data: { level: 'INFO', category: 'application', service: 'teste', event: `NULLCO_${stamp}`, message: 'sem empresa', companyId: null } }))
    ).rejects.toBeTruthy();
    const leaked = await bypass<any[]>(() => db.systemLog.findMany({ where: { event: { in: [`SPOOF_${stamp}`, `NULLCO_${stamp}`] } } }));
    leaked.forEach((l) => createdLogIds.system.push(l.id)); // se vazou, o afterAll limpa por id
    expect(leaked).toHaveLength(0);
  });

  it('PERFIL/PERMISSÃO GLOBAIS: a empresa LÊ (precisa para listar) mas NÃO altera nem apaga', async () => {
    expect(await asCompany(A.companyId, () => prisma.role.findMany({ where: { id: globalRoleId } }))).toHaveLength(1);
    expect(await asCompany(A.companyId, () => prisma.permission.findMany({ where: { id: globalPermissionId } }))).toHaveLength(1);

    const upd = await asCompany(A.companyId, () => prisma.role.updateMany({ where: { id: globalRoleId }, data: { description: 'alterado pela empresa' } })).catch(() => ({ count: 0 }));
    expect(upd.count).toBe(0);
    const del = await asCompany(A.companyId, () => prisma.role.deleteMany({ where: { id: globalRoleId } })).catch(() => ({ count: 0 }));
    expect(del.count).toBe(0);
    const delP = await asCompany(A.companyId, () => prisma.permission.deleteMany({ where: { id: globalPermissionId } })).catch(() => ({ count: 0 }));
    expect(delP.count).toBe(0);
    const still = await bypass<any>(() => db.role.findUnique({ where: { id: globalRoleId } }));
    expect(still).toBeTruthy();
    expect(still.description).not.toBe('alterado pela empresa');
    expect(await bypass<any>(() => db.permission.findUnique({ where: { id: globalPermissionId } }))).toBeTruthy();
  });

  it('PERFIL/PERMISSÃO GLOBAIS: a empresa não cria perfil global; cria e gerencia os PRÓPRIOS normalmente', async () => {
    await expect(asCompany(A.companyId, () => prisma.role.create({ data: { name: `forjado-${stamp}`, companyId: null, isSystem: false } }))).rejects.toBeTruthy();
    await expect(asCompany(A.companyId, () => prisma.permission.create({ data: { name: `forjada:${stamp}`, companyId: null } }))).rejects.toBeTruthy();

    const own = await asCompany(A.companyId, () => prisma.role.create({ data: { name: `proprio-${stamp}`, companyId: A.companyId, isSystem: false } }));
    const upd = await asCompany(A.companyId, () => prisma.role.updateMany({ where: { id: own.id }, data: { description: 'ok' } }));
    expect(upd.count).toBe(1);
    // outra empresa não toca no perfil da A
    const otherDel = await asCompany(B.companyId, () => prisma.role.deleteMany({ where: { id: own.id } })).catch(() => ({ count: 0 }));
    expect(otherDel.count).toBe(0);
    const del = await asCompany(A.companyId, () => prisma.role.deleteMany({ where: { id: own.id } }));
    expect(del.count).toBe(1);
  });

  it('PLATAFORMA: o Super Admin escreve nos globais e nos logs sem restrição', async () => {
    const upd = await asPlatform(() => prisma.role.updateMany({ where: { id: globalRoleId }, data: { description: 'alterado pela plataforma' } }));
    expect(upd.count).toBe(1);
  });
});
