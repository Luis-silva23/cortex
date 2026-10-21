import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { World, BranchKey, CoKey, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * REGRAS DE ACESSO POR EMPRESA E FILIAL (decisão de negócio, 2026-10-15) — rotas reais + middlewares + RLS com o papel real da aplicação.
 *
 *   • Usuário com acesso EMPRESARIAL (COMPANY_ADMIN): todas as filiais da PRÓPRIA empresa e o dashboard consolidado; nunca outra empresa.
 *   • GERENTE de filial (MANAGER) e demais papéis de filial: EXCLUSIVAMENTE a filial a que estão vinculados; nenhuma outra, nem da mesma empresa, por API,
 *     id forjado, parâmetro ou SQL direto; não ampliam o próprio acesso (tipo, filial, perfis, módulos).
 *   • Módulos desativados (ex.: FINANCEIRO/recebíveis, OFICINA/ordens) continuam bloqueados NO BACKEND para quem não tem permissão — e um papel de filial não os religa.
 *
 * Mundo: EMPRESA A → filiais A1, A2 (+ A3 criada aqui) · EMPRESA B → B1, B2. As 9 tabelas auditadas (users, user_roles, partners, installment_policies, devices,
 * monitoring_thresholds, monitoring_threshold_changes, request_logs, system_logs) + audit_logs e transfers são exercitadas por HTTP e por SQL direto.
 */
describe('Acesso por empresa e filial: empresarial × gerente de filial (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const A1 = 1 as BranchKey;
  const A2 = 2 as BranchKey;

  const ids: Record<string, string> = {};
  let branchA3 = '';
  let userA3 = '';
  let adminUserId = '';
  let managerNoBranchId = '';

  const tok = (co: CoKey, branch: BranchKey | null, type: string) => bearer(tokenFor(world[co], branch, type));
  const get = (t: ReturnType<typeof tok>, path: string) => request(app).get(path).set(t);
  const send = (method: 'post' | 'put' | 'delete', t: ReturnType<typeof tok>, path: string, body?: object) => request(app)[method](path).set(t).send(body ?? {});
  const br = (co: CoKey, b: BranchKey) => world[co].branches[b].branchId;
  /** Contexto de banco IGUAL ao de uma requisição: o papel real da aplicação, com a RLS ligada. */
  const ctx = <T>(co: CoKey, branch: BranchKey | null, userType: string, fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: world[co].companyId, branchId: branch ? br(co, branch) : null, userType }, fn);
  const text = (res: request.Response) => JSON.stringify(res.body);

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const A = world.A;
    const b3 = await bypass<any>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial A3', isActive: true } }));
    branchA3 = b3.id;
    userA3 = (
      await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: branchA3, name: 'Operador A3', email: `op-a3-${stamp}@test.local`, password: 'not-a-real-hash', userType: 'OPERATOR', isActive: true } })
      )
    ).id;
    adminUserId = (
      await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: null, name: 'Administrador A', email: `adm-a-${stamp}@test.local`, password: 'not-a-real-hash', userType: 'COMPANY_ADMIN', isActive: true } })
      )
    ).id;

    // gerente SEM nenhuma filial vinculada (o escopo vem do banco, não do token): users.branchId nulo e nenhum vínculo
    managerNoBranchId = (
      await bypass<any>(() =>
        db.user.create({ data: { companyId: A.companyId, branchId: null, name: 'Gerente sem filial', email: `mgr-sem-filial-${stamp}@test.local`, password: 'not-a-real-hash', userType: 'MANAGER', isActive: true } })
      )
    ).id;

    // convênios: da A1, da A2 e o da empresa toda (world.A.partnerId, sem filial)
    ids.partnerA1 = (await bypass<any>(() => db.partner.create({ data: { companyId: A.companyId, branchId: br('A', A1), name: `Convenio A1 ${stamp}`, discountValue: 5 } }))).id;
    ids.partnerA2 = (await bypass<any>(() => db.partner.create({ data: { companyId: A.companyId, branchId: br('A', A2), name: `Convenio A2 ${stamp}`, discountValue: 5 } }))).id;
    // políticas de parcelamento: A1, A2 e todas as filiais
    ids.policyA1 = (await bypass<any>(() => db.installmentPolicy.create({ data: { companyId: A.companyId, branchId: br('A', A1), paymentMethod: 'CREDIT_CARD', maxInstallments: 3 } }))).id;
    ids.policyA2 = (await bypass<any>(() => db.installmentPolicy.create({ data: { companyId: A.companyId, branchId: br('A', A2), paymentMethod: 'CREDIT_CARD', maxInstallments: 6 } }))).id;
    ids.policyAll = (await bypass<any>(() => db.installmentPolicy.create({ data: { companyId: A.companyId, branchId: null, paymentMethod: 'DEBIT_CARD', maxInstallments: 1 } }))).id;
    // licença e equipamentos: um por filial e um sem filial
    ids.license = (await bypass<any>(() => db.license.create({ data: { companyId: A.companyId, licenseType: 'BASIC', status: 'ACTIVE', maxDevices: 10 } }))).id;
    const mkDevice = async (name: string, branchId: string | null) =>
      (await bypass<any>(() => db.device.create({ data: { licenseId: ids.license, branchId, deviceName: name, deviceType: 'POS', status: 'ACTIVE' } }))).id;
    ids.deviceA1 = await mkDevice(`PDV A1 ${stamp}`, br('A', A1));
    ids.deviceA2 = await mkDevice(`PDV A2 ${stamp}`, br('A', A2));
    ids.deviceAll = await mkDevice(`PDV sem filial ${stamp}`, null);
    // monitoramento
    ids.thresholdCo = (await bypass<any>(() => db.monitoringThreshold.create({ data: { companyId: A.companyId, branchId: null, metric: 'cpu', attention: 70, critical: 90, updatedBy: 'teste' } }))).id;
    ids.thresholdA1 = (await bypass<any>(() => db.monitoringThreshold.create({ data: { companyId: A.companyId, branchId: br('A', A1), metric: 'memory', attention: 60, critical: 80, updatedBy: 'teste' } }))).id;
    // logs
    for (const [k, b] of [['A1', A1], ['A2', A2]] as const) {
      ids[`sys${k}`] = (await bypass<any>(() => db.systemLog.create({ data: { level: 'INFO', category: 'teste', service: 'teste', event: `E_${k}_${stamp}`, message: 'sintetico', companyId: A.companyId, branchId: br('A', b) } }))).id;
      ids[`req${k}`] = (await bypass<any>(() => db.requestLog.create({ data: { requestId: `bsa-${k}-${stamp}`, method: 'GET', route: '/teste', statusCode: 200, durationMs: 1, companyId: A.companyId, branchId: br('A', b) } }))).id;
    }
    // auditoria: uma ação de cada usuário de filial
    for (const [k, userId] of [['A1', world.A.branches[A1].userId], ['A2', world.A.branches[A2].userId]] as const) {
      ids[`audit${k}`] = (await bypass<any>(() => db.auditLog.create({ data: { companyId: A.companyId, userId, action: 'UPDATE', entity: 'BranchScopeTeste', entityId: `x-${k}`, newValue: JSON.stringify({ k }) } }))).id;
    }
    // transferências: A1→A2 e A2→A3 (a segunda não pertence à A1)
    const mkTransfer = async (n: number, from: string, to: string) =>
      (await bypass<any>(() => db.transfer.create({ data: { companyId: A.companyId, fromBranchId: from, toBranchId: to, transferNumber: n, requestedBy: world.A.fixture.userId } }))).id;
    ids.transfer12 = await mkTransfer(9101, br('A', A1), br('A', A2));
    ids.transfer23 = await mkTransfer(9102, br('A', A2), branchA3);
  }, 180000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await destroyWorld(world);
  }, 180000);

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('1. dashboard: o empresarial consolida; o gerente vê só a própria filial', () => {
    const summary = (t: ReturnType<typeof tok>, q = '') => get(t, `/api/dashboard/management/summary?period=30d${q}`);

    it('COMPANY_ADMIN: o dashboard consolidado funciona (soma das filiais da própria empresa) e ele escolhe UMA filial', async () => {
      const all = await summary(tok('A', null, 'COMPANY_ADMIN'));
      expect(all.status).toBe(200);
      expect(all.body.kpis.revenue.current).toBe(20); // A1 (10) + A2 (10)
      const onlyA2 = await summary(tok('A', null, 'COMPANY_ADMIN'), `&branchId=${br('A', A2)}`);
      expect(onlyA2.status).toBe(200);
      expect(onlyA2.body.kpis.revenue.current).toBe(10);
    });

    it('GERENTE: vê só a própria filial — A1 e A2 recebem cada um o seu valor, nunca a soma', async () => {
      expect((await summary(tok('A', A1, 'MANAGER'))).body.kpis.revenue.current).toBe(10);
      expect((await summary(tok('A', A2, 'MANAGER'))).body.kpis.revenue.current).toBe(10);
      const series = await get(tok('A', A1, 'MANAGER'), '/api/dashboard/management/timeseries?period=30d');
      expect(series.status).toBe(200);
    });

    it('GERENTE pedindo OUTRA filial (mesma empresa) é recusado com 403 em todos os dashboards — não é filtro silencioso', async () => {
      const m = tok('A', A1, 'MANAGER');
      for (const path of ['management/summary', 'management/timeseries', 'sales', 'financial', 'stock', 'workshop', 'pdv']) {
        const res = await get(m, `/api/dashboard/${path}?period=30d&branchId=${br('A', A2)}`);
        expect({ path, status: res.status, code: res.body.code }).toEqual({ path, status: 403, code: 'BRANCH_FORBIDDEN' });
        expect(text(res)).not.toContain(world.A.branches[A2].saleId);
      }
    });

    it('GERENTE pedindo filial de OUTRA empresa: 403; o empresarial pedindo filial de outra empresa: 404; branchId inválido: 400', async () => {
      expect((await get(tok('A', A1, 'MANAGER'), `/api/dashboard/sales?branchId=${br('B', A1)}`)).status).toBe(403);
      expect((await get(tok('B', A1, 'MANAGER'), `/api/dashboard/sales?branchId=${br('A', A1)}`)).status).toBe(403);
      const cross = await get(tok('A', null, 'COMPANY_ADMIN'), `/api/dashboard/sales?branchId=${br('B', A1)}`);
      expect({ status: cross.status, code: cross.body.code }).toEqual({ status: 404, code: 'BRANCH_NOT_FOUND' });
      expect((await get(tok('A', null, 'COMPANY_ADMIN'), '/api/dashboard/sales?branchId=nao-e-uuid')).status).toBe(400);
    });

    it('usuário de filial SEM filial no token não consulta nada de filial (403), e o empresarial segue funcionando', async () => {
      const noBranchToken = bearer(generateAccessToken({ userId: managerNoBranchId, email: 'sem-filial@test.local', companyId: world.A.companyId, userType: 'MANAGER' } as any));
      const noBranch = await get(noBranchToken, '/api/dashboard/sales?period=30d');
      expect({ status: noBranch.status, code: noBranch.body.code }).toEqual({ status: 403, code: 'BRANCH_REQUIRED' });
      expect((await get(tok('A', null, 'COMPANY_ADMIN'), '/api/dashboard/sales?period=30d')).status).toBe(200);
    });

    it('visão por filial (/ceo): o empresarial enxerga as filiais com venda; o gerente só a própria', async () => {
      const adm = await get(tok('A', null, 'COMPANY_ADMIN'), '/api/dashboard/ceo?period=30d');
      expect(adm.status).toBe(200);
      expect(text(adm)).toContain(br('A', A1));
      expect(text(adm)).toContain(br('A', A2));
      const mgr = await get(tok('A', A1, 'MANAGER'), '/api/dashboard/ceo?period=30d');
      expect(mgr.status).toBe(200);
      expect(text(mgr)).toContain(br('A', A1));
      expect(text(mgr)).not.toContain(br('A', A2));
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('2. usuários e perfis (users, user_roles)', () => {
    it('API: o gerente da A1 lista só a A1 (+ administradores e usuários sem filial); o empresarial lista todos da empresa; ninguém lista outra empresa', async () => {
      const mgr = await get(tok('A', A1, 'MANAGER'), '/api/users?limit=100');
      expect(mgr.status).toBe(200);
      const mgrIds = (mgr.body.data as Array<{ id: string }>).map((u) => u.id);
      expect(mgrIds).toContain(world.A.branches[A1].userId);
      expect(mgrIds).toContain(adminUserId); // COMPANY_ADMIN é autorizador da empresa
      expect(mgrIds).not.toContain(world.A.branches[A2].userId);
      expect(mgrIds).not.toContain(userA3);
      expect(mgrIds).not.toContain(world.B.branches[A1].userId);
      const adm = await get(tok('A', null, 'COMPANY_ADMIN'), '/api/users?limit=100');
      const admIds = (adm.body.data as Array<{ id: string }>).map((u) => u.id);
      expect(admIds).toEqual(expect.arrayContaining([world.A.branches[A1].userId, world.A.branches[A2].userId, userA3, adminUserId]));
      expect(admIds).not.toContain(world.B.branches[A1].userId);
    });

    it('API (IDOR): id de usuário de outra filial ou de outra empresa → 404 em detalhe, perfis e permissões, para o gerente; o empresarial só alcança a própria empresa', async () => {
      const m = tok('A', A1, 'MANAGER');
      for (const target of [world.A.branches[A2].userId, userA3, world.B.branches[A1].userId]) {
        for (const suffix of ['', '/roles', '/permissions']) {
          const res = await get(m, `/api/users/${target}${suffix}`);
          expect({ target, suffix, status: res.status }).toEqual({ target, suffix, status: 404 });
        }
      }
      expect((await get(tok('A', null, 'COMPANY_ADMIN'), `/api/users/${world.A.branches[A2].userId}`)).status).toBe(200);
      expect((await get(tok('A', null, 'COMPANY_ADMIN'), `/api/users/${world.B.branches[A1].userId}`)).status).toBe(404);
    });

    it('API: o gerente não cria, edita, desativa nem atribui perfil (403), com o id de qualquer filial', async () => {
      const m = tok('A', A1, 'MANAGER');
      expect((await send('post', m, '/api/users', { name: 'x', email: `x-${stamp}@test.local`, password: 'Senha-Forte-1!', userType: 'COMPANY_ADMIN' })).status).toBe(403);
      expect((await send('put', m, `/api/users/${world.A.branches[A1].userId}`, { userType: 'COMPANY_ADMIN' })).status).toBe(403);
      expect((await send('post', m, `/api/users/${world.A.branches[A2].userId}/toggle-active`)).status).toBe(403);
      expect((await send('post', m, `/api/users/${world.A.branches[A1].userId}/roles`, { roleId: 'qualquer' })).status).toBe(403);
    });

    it('SQL direto (papel real, gerente da A1): enxerga só a A1; não altera nem apaga usuário de outra filial; não muda o próprio tipo/filial; não cria usuário na A2', async () => {
      const visible = await ctx('A', A1, 'MANAGER', () => prisma.user.findMany({ where: { companyId: world.A.companyId }, select: { id: true } }));
      const seen = visible.map((u) => u.id);
      expect(seen).toContain(world.A.branches[A1].userId);
      expect(seen).not.toContain(world.A.branches[A2].userId);
      expect(seen).not.toContain(userA3);

      const upd = await ctx('A', A1, 'MANAGER', () => prisma.user.updateMany({ where: { id: world.A.branches[A2].userId }, data: { name: 'invadido' } }));
      expect(upd.count).toBe(0);
      const del = await ctx('A', A1, 'MANAGER', () => prisma.user.deleteMany({ where: { id: world.A.branches[A2].userId } }));
      expect(del.count).toBe(0);
      expect((await bypass<any>(() => db.user.findUnique({ where: { id: world.A.branches[A2].userId } })))!.name).not.toBe('invadido');

      // elevação de privilégio: tipo, filial e situação do próprio registro
      const self = world.A.branches[A1].userId;
      await expect(ctx('A', A1, 'MANAGER', () => prisma.user.update({ where: { id: self }, data: { userType: 'COMPANY_ADMIN' } }))).rejects.toThrow(/papel de filial/);
      await expect(ctx('A', A1, 'MANAGER', () => prisma.user.update({ where: { id: self }, data: { branchId: br('A', A2) } }))).rejects.toThrow();
      await expect(ctx('A', A1, 'MANAGER', () => prisma.user.update({ where: { id: self }, data: { isActive: false } }))).rejects.toThrow(/papel de filial/);
      const after = await bypass<any>(() => db.user.findUnique({ where: { id: self } }));
      expect({ type: after.userType, branch: after.branchId, active: after.isActive }).toEqual({ type: 'OPERATOR', branch: br('A', A1), active: true });

      await expect(
        ctx('A', A1, 'MANAGER', () =>
          prisma.user.create({ data: { companyId: world.A.companyId, branchId: br('A', A2), name: 'novo', email: `novo-${stamp}@test.local`, password: 'x', userType: 'OPERATOR' } })
        )
      ).rejects.toThrow();
      expect(await bypass<number>(() => db.user.count({ where: { email: `novo-${stamp}@test.local` } }))).toBe(0);
    });

    it('SQL direto: o gerente não vincula perfil a si nem cria perfil/permissão (user_roles, roles, permissions, role_permissions); o empresarial pode', async () => {
      const role = await ctx('A', null, 'COMPANY_ADMIN', () => prisma.role.create({ data: { companyId: world.A.companyId, name: `perfil-${stamp}`, isSystem: false } }));
      const perm = await ctx('A', null, 'COMPANY_ADMIN', () => prisma.permission.create({ data: { companyId: world.A.companyId, name: `perm:${stamp}` } }));
      await expect(ctx('A', A1, 'MANAGER', () => prisma.userRole.create({ data: { userId: world.A.branches[A1].userId, roleId: role.id } }))).rejects.toThrow();
      await expect(ctx('A', A1, 'MANAGER', () => prisma.role.create({ data: { companyId: world.A.companyId, name: `perfil-m-${stamp}`, isSystem: false } }))).rejects.toThrow();
      await expect(ctx('A', A1, 'MANAGER', () => prisma.permission.create({ data: { companyId: world.A.companyId, name: `perm-m:${stamp}` } }))).rejects.toThrow();
      await expect(ctx('A', A1, 'MANAGER', () => prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } }))).rejects.toThrow();
      // o empresarial vincula normalmente
      const ur = await ctx('A', null, 'COMPANY_ADMIN', () => prisma.userRole.create({ data: { userId: world.A.branches[A1].userId, roleId: role.id } }));
      expect(ur.roleId).toBe(role.id);
      expect(await bypass<number>(() => db.userRole.count({ where: { roleId: role.id } }))).toBe(1);
      // limpeza deste teste (o destroyWorld expurga o resto por empresa)
      await bypass(() => db.userRole.deleteMany({ where: { id: ur.id } }));
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('3. convênios (partners)', () => {
    it('API: o gerente da A1 vê o convênio da A1 e o da empresa toda, nunca o da A2; id da A2 → 404', async () => {
      const list = await get(tok('A', A1, 'MANAGER'), '/api/partners');
      const got = (list.body.data as Array<{ id: string }>).map((p) => p.id);
      expect(got).toEqual(expect.arrayContaining([ids.partnerA1, world.A.partnerId]));
      expect(got).not.toContain(ids.partnerA2);
      expect((await get(tok('A', A1, 'MANAGER'), `/api/partners/${ids.partnerA2}`)).status).toBe(404);
      const adm = (await get(tok('A', null, 'COMPANY_ADMIN'), '/api/partners')).body.data.map((p: { id: string }) => p.id);
      expect(adm).toEqual(expect.arrayContaining([ids.partnerA1, ids.partnerA2, world.A.partnerId]));
    });

    it('API: o gerente cria convênio só na própria filial (omitir = a própria; outra = 403) e não altera/ativa/apaga o da empresa toda nem o de outra filial', async () => {
      const m = tok('A', A1, 'MANAGER');
      const other = await send('post', m, '/api/partners', { name: `Invasor ${stamp}`, discountValue: 3, branchId: br('A', A2) });
      expect({ status: other.status, code: other.body.code }).toEqual({ status: 403, code: 'BRANCH_FORBIDDEN' });
      const own = await send('post', m, '/api/partners', { name: `Meu convenio ${stamp}`, discountValue: 3 });
      expect(own.status).toBe(201);
      expect(own.body.data.branchId).toBe(br('A', A1)); // não nasce "da empresa toda"
      expect((await send('put', m, `/api/partners/${world.A.partnerId}`, { name: 'alterado' })).status).toBe(403); // empresa toda: só a administração
      expect((await send('post', m, `/api/partners/${world.A.partnerId}/toggle-active`)).status).toBe(403);
      expect((await send('delete', m, `/api/partners/${world.A.partnerId}`)).status).toBe(403);
      expect((await send('put', m, `/api/partners/${ids.partnerA2}`, { name: 'alterado' })).status).toBe(404);
      expect((await send('delete', m, `/api/partners/${ids.partnerA2}`)).status).toBe(404);
      expect((await send('put', m, `/api/partners/${ids.partnerA1}`, { branchId: br('A', A2) })).status).toBe(403); // não "empurra" o convênio para outra filial
      expect((await send('put', m, `/api/partners/${ids.partnerA1}`, { description: 'ok' })).status).toBe(200);
      const after = await bypass<any>(() => db.partner.findMany({ where: { id: { in: [world.A.partnerId, ids.partnerA2] } }, select: { id: true, name: true, isActive: true } }));
      expect(after.some((p: any) => p.name === 'alterado' || p.name.startsWith('Invasor'))).toBe(false);
      // administração mantém tudo
      expect((await send('put', tok('A', null, 'COMPANY_ADMIN'), `/api/partners/${world.A.partnerId}`, { description: 'adm' })).status).toBe(200);
      expect((await send('post', tok('A', null, 'COMPANY_ADMIN'), '/api/partners', { name: `Da empresa ${stamp}`, discountValue: 2 })).status).toBe(201);
    });

    it('SQL direto: o gerente não grava convênio da empresa toda nem de outra filial', async () => {
      await expect(ctx('A', A1, 'MANAGER', () => prisma.partner.create({ data: { companyId: world.A.companyId, branchId: null, name: `sql-null-${stamp}`, discountValue: 1 } }))).rejects.toThrow();
      await expect(ctx('A', A1, 'MANAGER', () => prisma.partner.create({ data: { companyId: world.A.companyId, branchId: br('A', A2), name: `sql-a2-${stamp}`, discountValue: 1 } }))).rejects.toThrow();
      expect((await ctx('A', A1, 'MANAGER', () => prisma.partner.updateMany({ where: { id: ids.partnerA2 }, data: { name: 'x' } }))).count).toBe(0);
      // convênio da empresa toda é VISÍVEL ao gerente, mas não gravável: o UPDATE é recusado (WITH CHECK), nunca aplicado
      await expect(ctx('A', A1, 'MANAGER', () => prisma.partner.updateMany({ where: { id: world.A.partnerId }, data: { name: 'x' } }))).rejects.toThrow();
      expect(await bypass<number>(() => db.partner.count({ where: { name: { startsWith: 'sql-' } } }))).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('4. políticas de parcelamento', () => {
    it('API e SQL: o gerente lê a da própria filial e a de todas as filiais, nunca a da A2, e não escreve (nem pela API, nem pelo banco)', async () => {
      const list = await get(tok('A', A1, 'MANAGER'), '/api/installment-policies');
      const got = (list.body.data as Array<{ id: string }>).map((p) => p.id);
      expect(got).toEqual(expect.arrayContaining([ids.policyA1, ids.policyAll]));
      expect(got).not.toContain(ids.policyA2);
      const adm = (await get(tok('A', null, 'COMPANY_ADMIN'), '/api/installment-policies')).body.data.map((p: { id: string }) => p.id);
      expect(adm).toEqual(expect.arrayContaining([ids.policyA1, ids.policyA2, ids.policyAll]));

      expect((await send('post', tok('A', A1, 'MANAGER'), '/api/installment-policies', { paymentMethod: 'PIX', maxInstallments: 1 })).status).toBe(403);
      await expect(ctx('A', A1, 'MANAGER', () => prisma.installmentPolicy.create({ data: { companyId: world.A.companyId, branchId: br('A', A1), paymentMethod: 'PIX', maxInstallments: 1 } }))).rejects.toThrow();
      await expect(ctx('A', A1, 'MANAGER', () => prisma.installmentPolicy.updateMany({ where: { id: ids.policyA1 }, data: { maxInstallments: 99 } }))).rejects.toThrow();
      expect((await ctx('A', A1, 'MANAGER', () => prisma.installmentPolicy.updateMany({ where: { id: ids.policyA2 }, data: { maxInstallments: 99 } }))).count).toBe(0);
      expect((await bypass<any>(() => db.installmentPolicy.findUnique({ where: { id: ids.policyA1 } }))).maxInstallments).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('5. equipamentos (devices)', () => {
    it('API: o gerente da A1 vê os equipamentos da A1 e os sem filial, nunca os da A2; o empresarial vê todos; operador e outra empresa não listam', async () => {
      const mgr = await get(tok('A', A1, 'MANAGER'), `/api/activations/devices/${ids.license}`);
      expect(mgr.status).toBe(200);
      const got = (mgr.body.data as Array<{ id: string }>).map((d) => d.id);
      expect(got).toEqual(expect.arrayContaining([ids.deviceA1, ids.deviceAll]));
      expect(got).not.toContain(ids.deviceA2);
      const adm = (await get(tok('A', null, 'COMPANY_ADMIN'), `/api/activations/devices/${ids.license}`)).body.data.map((d: { id: string }) => d.id);
      expect(adm).toEqual(expect.arrayContaining([ids.deviceA1, ids.deviceA2, ids.deviceAll]));
      expect((await get(tok('A', A1, 'OPERATOR'), `/api/activations/devices/${ids.license}`)).status).toBe(403);
      expect((await get(tok('B', A1, 'MANAGER'), `/api/activations/devices/${ids.license}`)).status).toBe(403);
    });

    it('API: o gerente da A1 não encerra a sessão de equipamento da A2 (404) nem de equipamento inexistente; na própria filial a recusa não é de escopo', async () => {
      const m = tok('A', A1, 'MANAGER');
      const other = await send('post', m, `/api/activations/devices/${ids.deviceA2}/force-end-session`, { reason: 'teste de escopo' });
      expect(other.status).toBe(404);
      const own = await send('post', m, `/api/activations/devices/${ids.deviceA1}/force-end-session`, { reason: 'teste de escopo' });
      expect([200, 400]).toContain(own.status); // 400 = "nenhuma sessão ativa" (não há sessão aberta no teste), nunca 403/404
      expect(own.status === 400 ? own.body.error : '').not.toMatch(/filial/i);
    });

    it('SQL direto: o gerente não vê nem altera equipamento de outra filial', async () => {
      const seen = (await ctx('A', A1, 'MANAGER', () => prisma.device.findMany({ where: { licenseId: ids.license }, select: { id: true } }))).map((d) => d.id);
      expect(seen).toEqual(expect.arrayContaining([ids.deviceA1, ids.deviceAll]));
      expect(seen).not.toContain(ids.deviceA2);
      expect((await ctx('A', A1, 'MANAGER', () => prisma.device.updateMany({ where: { id: ids.deviceA2 }, data: { deviceName: 'x' } }))).count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('6. monitoramento, logs e auditoria', () => {
    it('monitoramento: o gerente recebe 403 pela API e 0 linhas por SQL (limites e histórico); o empresarial lê', async () => {
      expect((await get(tok('A', A1, 'MANAGER'), '/api/monitoring/thresholds')).status).toBe(403);
      expect((await get(tok('A', A1, 'MANAGER'), '/api/monitoring/thresholds/history')).status).toBe(403);
      expect(await ctx('A', A1, 'MANAGER', () => prisma.monitoringThreshold.count({ where: { companyId: world.A.companyId } }))).toBe(0);
      expect(await ctx('A', A1, 'MANAGER', () => prisma.monitoringThresholdChange.count({ where: { companyId: world.A.companyId } }))).toBe(0);
      expect(await ctx('A', null, 'COMPANY_ADMIN', () => prisma.monitoringThreshold.count({ where: { companyId: world.A.companyId } }))).toBeGreaterThanOrEqual(2);
      await expect(ctx('A', A1, 'MANAGER', () => prisma.monitoringThreshold.create({ data: { companyId: world.A.companyId, metric: 'x', attention: 1, critical: 2, updatedBy: 'm' } }))).rejects.toThrow();
    });

    it('logs de sistema e de requisição: o gerente não lê, não altera e não apaga; grava só na própria filial; o empresarial lê e não altera', async () => {
      expect(await ctx('A', A1, 'MANAGER', () => prisma.systemLog.count({ where: { companyId: world.A.companyId } }))).toBe(0);
      expect(await ctx('A', A1, 'MANAGER', () => prisma.requestLog.count({ where: { companyId: world.A.companyId } }))).toBe(0);
      expect(await ctx('A', null, 'COMPANY_ADMIN', () => prisma.systemLog.count({ where: { companyId: world.A.companyId, id: { in: [ids.sysA1, ids.sysA2] } } }))).toBe(2);
      expect((await ctx('A', A1, 'MANAGER', () => prisma.systemLog.updateMany({ where: { id: ids.sysA1 }, data: { message: 'x' } }))).count).toBe(0);
      expect((await ctx('A', A1, 'MANAGER', () => prisma.systemLog.deleteMany({ where: { id: ids.sysA1 } }))).count).toBe(0);
      expect((await ctx('A', null, 'COMPANY_ADMIN', () => prisma.requestLog.deleteMany({ where: { id: ids.reqA1 } }))).count).toBe(0);
      await expect(ctx('A', A1, 'MANAGER', () => prisma.systemLog.create({ data: { level: 'INFO', category: 't', service: 't', event: 'e', message: 'm', companyId: world.A.companyId, branchId: br('A', A2) } }))).rejects.toThrow();
      // grava na própria filial (sem RETURNING: o gerente não LÊ logs); quem grava de verdade é o worker, em contexto de plataforma
      await ctx('A', A1, 'MANAGER', () => prisma.systemLog.createMany({ data: [{ level: 'INFO', category: 't', service: 't', event: `e-ok-${stamp}`, message: 'm', companyId: world.A.companyId, branchId: br('A', A1) }] }));
      expect(await bypass<number>(() => db.systemLog.count({ where: { event: `e-ok-${stamp}` } }))).toBe(1);
    });

    it('auditoria (API): o gerente lê só as ações de usuários da própria filial; o empresarial lê as de todas as filiais', async () => {
      const q = '/api/audit-logs?entity=BranchScopeTeste&limit=50';
      const mgr = await get(tok('A', A1, 'MANAGER'), q);
      expect(mgr.status).toBe(200);
      const mgrIds = (mgr.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(mgrIds).toContain(ids.auditA1);
      expect(mgrIds).not.toContain(ids.auditA2);
      const adm = await get(tok('A', null, 'COMPANY_ADMIN'), q);
      const admIds = (adm.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(admIds).toEqual(expect.arrayContaining([ids.auditA1, ids.auditA2]));
      expect((await get(tok('A', A1, 'MANAGER'), `/api/audit-logs/${ids.auditA2}`)).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('7. transferências entre filiais', () => {
    it('o gerente só vê as transferências em que a própria filial é origem ou destino; id de transferência alheia → 404', async () => {
      const a1 = text(await get(tok('A', A1, 'MANAGER'), '/api/transfers'));
      expect(a1).toContain(ids.transfer12);
      expect(a1).not.toContain(ids.transfer23);
      expect((await get(tok('A', A1, 'MANAGER'), `/api/transfers/${ids.transfer23}`)).status).toBe(404);
      const a2 = text(await get(tok('A', A2, 'MANAGER'), '/api/transfers'));
      expect(a2).toContain(ids.transfer12);
      expect(a2).toContain(ids.transfer23);
      const adm = text(await get(tok('A', null, 'COMPANY_ADMIN'), '/api/transfers'));
      expect(adm).toContain(ids.transfer12);
      expect(adm).toContain(ids.transfer23);
      expect(text(await get(tok('B', A1, 'MANAGER'), '/api/transfers'))).not.toContain(ids.transfer12);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('8. outra empresa e id forjado em documentos de filial (chamadas diretas)', () => {
    it('gerente da A1: documentos da A2 e da empresa B → 404; listas com ?branchId=A2 não devolvem nada da A2', async () => {
      const m = tok('A', A1, 'MANAGER');
      const paths = (co: CoKey, b: BranchKey) => [
        `/api/sales/${world[co].branches[b].saleId}`,
        `/api/quotes/${world[co].branches[b].quoteId}`,
        `/api/purchase-orders/${world[co].branches[b].purchaseOrderId}`,
        `/api/cash-register/${world[co].branches[b].cashRegisterId}`,
        `/api/products/${world[co].branches[b].productId}`,
      ];
      for (const path of [...paths('A', A2), ...paths('B', A1)]) {
        const res = await get(m, path);
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }
      const sales = await get(m, `/api/sales?branchId=${br('A', A2)}`);
      expect(sales.status).toBe(200);
      expect(text(sales)).not.toContain(world.A.branches[A2].saleId);
      const fin = await get(tok('A', A2, 'VIEWER'), `/api/financial/receivables?branchId=${br('A', A1)}`);
      expect(text(fin)).not.toContain(world.A.branches[A1].receivableId);
    });

    it('empresarial da A: nunca alcança documentos da empresa B, mesmo com o id certo', async () => {
      const adm = tok('A', null, 'COMPANY_ADMIN');
      for (const path of [`/api/sales/${world.B.branches[A1].saleId}`, `/api/service-orders/${world.B.branches[A1].serviceOrderId}`, `/api/receivables/${world.B.branches[A1].receivableId}`]) {
        expect([403, 404]).toContain((await get(adm, path)).status);
      }
      expect((await get(adm, `/api/sales/${world.A.branches[A2].saleId}`)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('9. módulos desativados continuam desativados e protegidos no backend (roda por último: desativa módulos da A1)', () => {
    const disable = (module: string, branch: BranchKey | null) =>
      send('post', tok('A', null, 'COMPANY_ADMIN'), `/api/module-settings/${module}`, { isEnabled: false, reason: 'teste de escopo', ...(branch ? { branchId: br('A', branch) } : {}) });

    it('recebíveis (FINANCEIRO) e ordens (OFICINA) desativados para a filial A1: o gerente da A1 recebe 403 MODULE_DISABLED por chamada direta; a A2 (ativa) vê só os próprios dados', async () => {
      expect((await disable('FINANCEIRO', A1)).status).toBe(200);
      expect((await disable('OFICINA', A1)).status).toBe(200);
      const m = tok('A', A1, 'MANAGER');
      const blocked = [
        `/api/financial/receivables`,
        `/api/financial/payables`,
        `/api/receivables/${world.A.branches[A1].receivableId}`,
        `/api/dashboard/financial?period=30d`,
        `/api/service-orders`,
        `/api/service-orders/${world.A.branches[A1].serviceOrderId}`,
        `/api/dashboard/workshop?period=30d`,
        `/api/quotes`,
      ];
      for (const path of blocked) {
        const res = await get(m, path);
        expect({ path, status: res.status, code: res.body.code }).toEqual({ path, status: 403, code: 'MODULE_DISABLED' });
      }
      // outra filial (módulo ativo) continua funcionando, restrita à própria filial
      const a2 = await get(tok('A', A2, 'MANAGER'), '/api/financial/receivables');
      expect(a2.status).toBe(200);
      expect(text(a2)).toContain(world.A.branches[A2].receivableId);
      expect(text(a2)).not.toContain(world.A.branches[A1].receivableId);
      const os2 = await get(tok('A', A2, 'MANAGER'), '/api/service-orders');
      expect(os2.status).toBe(200);
      expect(text(os2)).not.toContain(world.A.branches[A1].serviceOrderId);
    });

    it('o gerente NÃO religa o módulo: nem pela API (403), nem por SQL direto — e o módulo segue desativado', async () => {
      const m = tok('A', A1, 'MANAGER');
      expect((await send('post', m, '/api/module-settings/FINANCEIRO', { isEnabled: true, branchId: br('A', A1) })).status).toBe(403);
      await expect(ctx('A', A1, 'MANAGER', () => prisma.companyModuleSetting.updateMany({ where: { companyId: world.A.companyId, module: 'FINANCEIRO' }, data: { isEnabled: true } }))).resolves.toEqual({ count: 0 });
      await expect(
        ctx('A', A1, 'MANAGER', () => prisma.companyModuleSetting.create({ data: { companyId: world.A.companyId, branchId: br('A', A1), module: 'OFICINA', isEnabled: true } }))
      ).rejects.toThrow();
      const rows = await bypass<any[]>(() => db.companyModuleSetting.findMany({ where: { companyId: world.A.companyId, branchId: br('A', A1) }, select: { module: true, isEnabled: true } }));
      expect(rows.filter((r) => !r.isEnabled).map((r) => r.module).sort()).toEqual(['FINANCEIRO', 'OFICINA']);
      expect(rows.some((r) => r.isEnabled)).toBe(false);
      // continua bloqueado depois das tentativas
      expect((await get(m, '/api/financial/receivables')).status).toBe(403);
    });

    it('módulo ATIVO mas sem autorização do perfil: o gerente sem a permissão não cria nem paga conta (403 INSUFFICIENT_PERMISSIONS); o MECHANIC não entra no financeiro', async () => {
      const m = tok('A', A2, 'MANAGER');
      const create = await send('post', m, '/api/financial/receivables', { description: 'x', amount: 10, dueDate: new Date().toISOString() });
      expect({ status: create.status, code: create.body.code }).toEqual({ status: 403, code: 'INSUFFICIENT_PERMISSIONS' });
      expect((await get(tok('A', A2, 'MECHANIC'), '/api/financial/receivables')).status).toBe(403);
      expect((await get(tok('A', A2, 'VIEWER'), '/api/financial/receivables')).status).toBe(200); // somente leitura da própria filial
    });

    it('o empresarial segue operando o consolidado com o módulo desativado só numa filial (o gate é do token de filial)', async () => {
      const adm = tok('A', null, 'COMPANY_ADMIN');
      expect((await get(adm, '/api/dashboard/management/summary?period=30d')).status).toBe(200);
      expect((await get(adm, '/api/dashboard/financial?period=30d')).status).toBe(200);
    });
  });
});
