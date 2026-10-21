import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { World, BranchKey, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * GERENTE DE UMA OU DE VÁRIAS FILIAIS (decisão 153) — rotas reais + middlewares + RLS com o contexto ASSINADO.
 *
 *   • gerente da filial A: só A · gerente das filiais A e B: A e B, e nenhuma outra · administrador da empresa: todas da PRÓPRIA empresa · outra empresa: nada;
 *   • a autorização vem dos vínculos gravados (users.branchId + user_branches), recalculados a CADA requisição — nunca de token, parâmetro, cabeçalho ou corpo;
 *   • remover o vínculo revoga o acesso na requisição seguinte; só SUPER_ADMIN/COMPANY_ADMIN concedem; tudo é auditado.
 */
describe('Gerente de várias filiais: vínculos, escopo e revogação (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const A1 = 1 as BranchKey;
  const A2 = 2 as BranchKey;

  let a1 = '';
  let a2 = '';
  let a3 = '';
  let managerId = '';
  let operatorA2 = '';
  let managerC = '';
  let adminUserId = '';
  const ids: Record<string, string> = {};

  const admin = () => bearer(tokenFor(world.A, null, 'COMPANY_ADMIN'));
  const adminB = () => bearer(tokenFor(world.B, null, 'COMPANY_ADMIN'));
  const managerToken = (userId = managerId, branchId = a1, extra: Record<string, unknown> = {}) =>
    bearer(generateAccessToken({ userId, email: 'gerente@test.local', companyId: world.A.companyId, branchId, userType: 'MANAGER', ...extra } as any));
  const get = (t: ReturnType<typeof admin>, path: string) => request(app).get(path).set(t);
  const put = (t: ReturnType<typeof admin>, path: string, body?: object) => request(app).put(path).set(t).send(body ?? {});
  const post = (t: ReturnType<typeof admin>, path: string, body?: object) => request(app).post(path).set(t).send(body ?? {});
  const setLinks = (branchIds: string[], t = admin()) => put(t, `/api/users/${managerId}/branches`, { branchIds });
  const summary = (t: ReturnType<typeof admin>, q = '') => get(t, `/api/dashboard/management/summary?period=30d${q}`);
  const revenue = (res: request.Response) => res.body.kpis.revenue.current as number;
  const text = (res: request.Response) => JSON.stringify(res.body);
  /** Contexto de banco IGUAL ao de uma requisição do gerente: assinado, com a lista de filiais. */
  const asManager = <T>(branchIds: string[], fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: world.A.companyId, userType: 'MANAGER', branchId: branchIds[0] ?? null, branchIds, userId: managerId }, fn);

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const A = world.A;
    a1 = world.A.branches[A1].branchId;
    a2 = world.A.branches[A2].branchId;
    a3 = (await bypass<any>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial A3', isActive: true } }))).id;
    const mkUser = async (name: string, branchId: string | null, userType: 'MANAGER' | 'OPERATOR' | 'COMPANY_ADMIN') =>
      (await bypass<any>(() => db.user.create({ data: { companyId: A.companyId, branchId, name, email: `${name.toLowerCase().replace(/\s+/g, '-')}-${stamp}@test.local`, password: 'not-a-real-hash', userType, isActive: true } }))).id as string;
    managerId = await mkUser('Gerente AB', a1, 'MANAGER');
    managerC = await mkUser('Gerente C', a3, 'MANAGER');
    operatorA2 = await mkUser('Operador A2 vinculo', a2, 'OPERATOR');
    adminUserId = await mkUser('Administrador A vinculo', null, 'COMPANY_ADMIN');

    // convênios: A1, A2, A3 e o da empresa toda (world.A.partnerId, sem filial)
    for (const [k, b] of [['A1', a1], ['A2', a2], ['A3', a3]] as const) {
      ids[`partner${k}`] = (await bypass<any>(() => db.partner.create({ data: { companyId: A.companyId, branchId: b, name: `Convenio ${k} ${stamp}`, discountValue: 5 } }))).id;
    }
    // auditoria: uma ação de cada usuário de filial (A1 = usuário do mundo, A2 = operador do mundo, A3 = gerente C)
    for (const [k, userId] of [['A1', world.A.branches[A1].userId], ['A2', world.A.branches[A2].userId], ['A3', managerC]] as const) {
      ids[`audit${k}`] = (await bypass<any>(() => db.auditLog.create({ data: { companyId: A.companyId, userId, action: 'UPDATE', entity: 'MultiBranchTeste', entityId: `mb-${k}`, newValue: JSON.stringify({ k }) } }))).id;
    }
  }, 180000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await destroyWorld(world);
  }, 180000);

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('1. concessão: quem pode, o que é validado, o que fica auditado', () => {
    it('COMPANY_ADMIN concede a filial A2 ao gerente da A1; o conjunto autorizado passa a ser A1 + A2', async () => {
      const res = await setLinks([a2]);
      expect(res.status).toBe(200);
      expect(res.body.data.primaryBranchId).toBe(a1);
      expect(res.body.data.extraBranchIds).toEqual([a2]);
      expect(res.body.data.branchIds).toEqual([a1, a2].sort());
      expect(res.body.data.added).toEqual([a2]);
      const read = await get(admin(), `/api/users/${managerId}/branches`);
      expect(read.status).toBe(200);
      expect(read.body.data.branches.map((b: any) => [b.id, b.primary])).toEqual(expect.arrayContaining([[a1, true], [a2, false]]));
    });

    it('a concessão é auditada (quem, o usuário e as filiais acrescentadas)', async () => {
      const calls = auditSpy.mock.calls.map((c) => c[1] as any).filter((d) => d?.entity === 'User' && d?.entityId === managerId);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const last = calls[calls.length - 1];
      expect(JSON.stringify(last.newValue)).toContain(a2);
      expect(JSON.stringify(last.newValue)).toContain('vinculosDeFilial');
    });

    it('repetir a mesma lista é idempotente; a filial principal na lista não vira vínculo duplicado', async () => {
      const again = await setLinks([a2, a1]);
      expect(again.status).toBe(200);
      expect(again.body.data.extraBranchIds).toEqual([a2]);
      expect(again.body.data.added).toEqual([]);
      expect(again.body.data.removed).toEqual([]);
    });

    it('SÓ administração concede: gerente, operador e gerente de várias filiais recebem 403; ninguém se concede filial', async () => {
      for (const t of [managerToken(), managerToken(managerId, a2), bearer(tokenFor(world.A, A2, 'OPERATOR')), bearer(tokenFor(world.A, A1, 'VIEWER'))]) {
        const res = await put(t, `/api/users/${managerId}/branches`, { branchIds: [a1, a2, a3] });
        expect(res.status).toBe(403);
      }
      // continua só A1 + A2
      expect((await get(admin(), `/api/users/${managerId}/branches`)).body.data.branchIds).toEqual([a1, a2].sort());
    });

    it('o gerente lê os PRÓPRIOS vínculos, mas não os de um colega; o administrador lê os de qualquer um da empresa', async () => {
      expect((await get(managerToken(), `/api/users/${managerId}/branches`)).status).toBe(200);
      expect((await get(managerToken(), `/api/users/${operatorA2}/branches`)).status).toBe(403);
      expect((await get(admin(), `/api/users/${operatorA2}/branches`)).status).toBe(200);
    });

    it('validações: filial de outra empresa, usuário de outra empresa, usuário de empresa inteira, corpo inválido, excesso de filiais', async () => {
      const foreign = await setLinks([world.B.branches[A1].branchId]);
      expect({ status: foreign.status, code: foreign.body.code }).toEqual({ status: 400, code: 'BRANCH_NOT_FOUND' });
      const otherCompany = await put(adminB(), `/api/users/${managerId}/branches`, { branchIds: [world.B.branches[A1].branchId] });
      expect({ status: otherCompany.status, code: otherCompany.body.code }).toEqual({ status: 404, code: 'USER_NOT_FOUND' });
      expect((await get(adminB(), `/api/users/${managerId}/branches`)).status).toBe(404);
      const wide = await put(admin(), `/api/users/${adminUserId}/branches`, { branchIds: [a2] });
      expect({ status: wide.status, code: wide.body.code }).toEqual({ status: 400, code: 'USER_COMPANY_WIDE' });
      expect((await setLinks('x' as any)).status).toBe(400);
      expect((await put(admin(), `/api/users/${managerId}/branches`, { branchIds: [123] })).status).toBe(400);
      expect((await setLinks(Array.from({ length: 51 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`))).status).toBe(400);
      // nada disso mudou o conjunto
      expect((await get(admin(), `/api/users/${managerId}/branches`)).body.data.branchIds).toEqual([a1, a2].sort());
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('2. dashboard: o gerente de A1+A2 vê as duas e nenhuma outra', () => {
    it('sem filial pedida: o CONSOLIDADO de A1 + A2 (soma das duas); com filial pedida: só aquela', async () => {
      expect(revenue(await summary(managerToken()))).toBe(20);
      expect(revenue(await summary(managerToken(), `&branchId=${a1}`))).toBe(10);
      expect(revenue(await summary(managerToken(), `&branchId=${a2}`))).toBe(10);
    });

    it('filial FORA do conjunto (A3, da mesma empresa) ou de outra empresa: 403 BRANCH_FORBIDDEN em todos os dashboards, sem vazar dado', async () => {
      for (const path of ['management/summary', 'management/timeseries', 'sales', 'financial', 'stock', 'workshop', 'pdv']) {
        for (const forbidden of [a3, world.B.branches[A1].branchId]) {
          const res = await get(managerToken(), `/api/dashboard/${path}?period=30d&branchId=${forbidden}`);
          expect({ path, status: res.status, code: res.body.code }).toEqual({ path, status: 403, code: 'BRANCH_FORBIDDEN' });
        }
      }
    });

    it('o administrador continua vendo o consolidado da empresa e qualquer filial dela; filial de outra empresa é 404', async () => {
      expect(revenue(await summary(admin()))).toBe(20);
      expect((await summary(admin(), `&branchId=${a3}`)).status).toBe(200);
      const cross = await summary(admin(), `&branchId=${world.B.branches[A1].branchId}`);
      expect({ status: cross.status, code: cross.body.code }).toEqual({ status: 404, code: 'BRANCH_NOT_FOUND' });
    });

    it('gerente de A1 + A3 (sem A2): o consolidado dele NÃO inclui a A2 — 10, não 20 — e a A2 é 403', async () => {
      expect((await setLinks([a3])).status).toBe(200);
      expect(revenue(await summary(managerToken()))).toBe(10);
      expect((await summary(managerToken(), `&branchId=${a2}`)).status).toBe(403);
      expect((await summary(managerToken(), `&branchId=${a3}`)).status).toBe(200);
      expect((await setLinks([a2])).status).toBe(200); // volta ao A1 + A2
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('3. convênios: só os das filiais autorizadas (e os da empresa toda), por consulta, detalhe e escrita', () => {
    const names = (res: request.Response) => (res.body.data as Array<{ name: string }>).map((p) => p.name);

    it('lista: A1, A2 e o da empresa toda aparecem; o da A3 NÃO', async () => {
      const res = await get(managerToken(), '/api/partners');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual(expect.arrayContaining([`Convenio A1 ${stamp}`, `Convenio A2 ${stamp}`]));
      expect(names(res)).not.toContain(`Convenio A3 ${stamp}`);
      expect(text(res)).not.toContain(ids.partnerA3);
    });

    it('filtro por filial: as autorizadas respondem; a A3 e a de outra empresa dão 403 (não "lista vazia")', async () => {
      expect((await get(managerToken(), `/api/partners?branchId=${a2}`)).status).toBe(200);
      for (const forbidden of [a3, world.B.branches[A1].branchId]) {
        const res = await get(managerToken(), `/api/partners?branchId=${forbidden}`);
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'BRANCH_FORBIDDEN' });
      }
    });

    it('detalhe por id: o da A2 abre; o da A3 (id conhecido) é invisível — 404', async () => {
      expect((await get(managerToken(), `/api/partners/${ids.partnerA2}`)).status).toBe(200);
      expect((await get(managerToken(), `/api/partners/${ids.partnerA3}`)).status).toBe(404);
    });

    it('escrita: edita o da A2 (autorizada); o da A3 é 404; o da empresa toda é 403; mover para a A3 é 403; criar na A3 é 403, na A2 é 201', async () => {
      expect((await put(managerToken(), `/api/partners/${ids.partnerA2}`, { name: `Convenio A2 ${stamp} (editado)` })).status).toBe(200);
      expect((await put(managerToken(), `/api/partners/${ids.partnerA3}`, { name: 'invasao' })).status).toBe(404);
      const wide = await put(managerToken(), `/api/partners/${world.A.partnerId}`, { name: 'invasao' });
      expect({ status: wide.status, code: wide.body.code }).toEqual({ status: 403, code: 'BRANCH_FORBIDDEN' });
      const move = await put(managerToken(), `/api/partners/${ids.partnerA2}`, { branchId: a3 });
      expect({ status: move.status, code: move.body.code }).toEqual({ status: 403, code: 'BRANCH_FORBIDDEN' });
      const toA3 = await post(managerToken(), '/api/partners', { name: 'novo A3', discountValue: 3, branchId: a3 });
      expect({ status: toA3.status, code: toA3.body.code }).toEqual({ status: 403, code: 'BRANCH_FORBIDDEN' });
      const toA2 = await post(managerToken(), '/api/partners', { name: `novo A2 ${stamp}`, discountValue: 3, branchId: a2 });
      expect(toA2.status).toBe(201);
      expect(await bypass<number>(() => db.partner.count({ where: { id: ids.partnerA3, name: 'invasao' } }))).toBe(0);
    });

    it('o administrador vê os convênios das TRÊS filiais e o da empresa toda; o gerente da A3 vê só o da A3 (e o da empresa toda)', async () => {
      expect(names(await get(admin(), '/api/partners'))).toEqual(expect.arrayContaining([`Convenio A1 ${stamp}`, `Convenio A3 ${stamp}`]));
      const c = names(await get(managerToken(managerC, a3), '/api/partners'));
      expect(c).toContain(`Convenio A3 ${stamp}`);
      expect(c).not.toContain(`Convenio A1 ${stamp}`);
      expect(c).not.toContain(`Convenio A2 ${stamp}`);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('4. REVOGAÇÃO: remover o vínculo corta o acesso na requisição seguinte', () => {
    it('com o vínculo da A2: dashboard e convênios da A2 respondem', async () => {
      expect((await summary(managerToken(), `&branchId=${a2}`)).status).toBe(200);
      expect((await get(managerToken(), `/api/partners/${ids.partnerA2}`)).status).toBe(200);
    });

    it('depois de remover o vínculo (o MESMO token): A2 vira 403 no dashboard, some dos convênios e o consolidado volta a ser só A1', async () => {
      const token = managerToken();
      const removed = await setLinks([]);
      expect(removed.status).toBe(200);
      expect(removed.body.data.removed).toEqual([a2]);
      const res = await summary(token, `&branchId=${a2}`);
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'BRANCH_FORBIDDEN' });
      expect((await get(token, `/api/partners/${ids.partnerA2}`)).status).toBe(404);
      expect(revenue(await summary(token))).toBe(10);
      expect((await get(token, '/api/partners')).body.data.map((p: any) => p.name)).not.toContain(`Convenio A2 ${stamp}`);
    });

    it('trocar a filial PRINCIPAL do usuário também revoga: o token antigo (A1) deixa de valer e a ativa passa a ser a nova', async () => {
      const token = managerToken(); // token ainda diz A1
      await bypass(() => db.user.update({ where: { id: managerId }, data: { branchId: a2 } }));
      try {
        expect((await summary(token, `&branchId=${a1}`)).status).toBe(403);
        expect((await summary(token, `&branchId=${a2}`)).status).toBe(200);
        expect(revenue(await summary(token))).toBe(10);
      } finally {
        await bypass(() => db.user.update({ where: { id: managerId }, data: { branchId: a1 } }));
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('5. parâmetros, cabeçalhos, corpo e claims forjados NÃO ampliam o acesso', () => {
    beforeAll(async () => {
      expect((await setLinks([a2])).status).toBe(200); // A1 + A2
    });

    it('claim `branchIds` dentro do token é ignorada: o servidor decide pelos vínculos gravados', async () => {
      const forged = managerToken(managerId, a1, { branchIds: [a1, a2, a3] });
      expect((await summary(forged, `&branchId=${a3}`)).status).toBe(403);
      expect((await get(forged, `/api/partners/${ids.partnerA3}`)).status).toBe(404);
    });

    it('token com a filial A3 no `branchId` de um usuário que não é da A3: a filial ativa volta para a dele', async () => {
      const wrongBranch = managerToken(managerId, a3);
      expect((await summary(wrongBranch, `&branchId=${a3}`)).status).toBe(403);
      expect(revenue(await summary(wrongBranch))).toBe(20); // continua A1 + A2
    });

    it('parâmetros e cabeçalhos de escopo (branchIds, X-Branch-Id(s), X-Company-Id, companyId) não mudam nada', async () => {
      const base = revenue(await summary(managerToken()));
      const res = await request(app)
        .get(`/api/dashboard/management/summary?period=30d&branchIds=${a3}&companyId=${world.B.companyId}`)
        .set(managerToken())
        .set('X-Branch-Id', a3)
        .set('X-Branch-Ids', `${a1},${a2},${a3}`)
        .set('X-Company-Id', world.B.companyId);
      expect(res.status).toBe(200);
      expect(revenue(res)).toBe(base);
    });

    it('corpo com companyId/branchIds ao criar convênio não grava em outra empresa/filial', async () => {
      const res = await post(managerToken(), '/api/partners', { name: `forjado ${stamp}`, discountValue: 1, branchId: a2, companyId: world.B.companyId, branchIds: [a3] });
      expect([201, 400]).toContain(res.status);
      const row = await bypass<any>(() => db.partner.findFirst({ where: { name: `forjado ${stamp}` } }));
      if (row) {
        expect(row.companyId).toBe(world.A.companyId);
        expect(row.branchId).toBe(a2);
      }
    });

    it('gerente de A1+A2 não ganha poder administrativo: não promove, não concede perfil, não liga módulo', async () => {
      expect((await put(managerToken(), `/api/users/${managerId}`, { userType: 'COMPANY_ADMIN' })).status).toBe(403);
      expect((await put(managerToken(), `/api/users/${managerId}/branches`, { branchIds: [a1, a2, a3] })).status).toBe(403);
      const sets = await get(managerToken(), '/api/module-settings');
      expect([200, 403]).toContain(sets.status);
      const toggle = await post(managerToken(), '/api/module-settings', { module: 'CANAIS', isEnabled: true });
      expect([403, 404, 405]).toContain(toggle.status);
      const stillManager = await bypass<any>(() => db.user.findUnique({ where: { id: managerId }, select: { userType: true } }));
      expect(stillManager.userType).toBe('MANAGER');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('6. banco (RLS com o contexto assinado): o conjunto autorizado vale por SQL direto', () => {
    it('usuários: o gerente de A1+A2 enxerga A1, A2, sem filial e administradores; NÃO enxerga o da A3', async () => {
      const rows = await asManager([a1, a2], () => prisma.user.findMany({ select: { id: true, branchId: true, userType: true } }));
      const seenIds = rows.map((r) => r.id);
      expect(seenIds).toContain(operatorA2);
      expect(seenIds).toContain(world.A.branches[A1].userId);
      expect(seenIds).toContain(adminUserId);
      expect(seenIds).not.toContain(managerC);
      expect(rows.every((r) => r.branchId === null || [a1, a2].includes(r.branchId) || r.userType === 'COMPANY_ADMIN')).toBe(true);
    });

    it('auditoria: ações de usuários da A1 e da A2 aparecem; as da A3 não', async () => {
      const rows = await asManager([a1, a2], () => prisma.auditLog.findMany({ where: { entity: 'MultiBranchTeste' }, select: { entityId: true } }));
      expect(rows.map((r) => r.entityId).sort()).toEqual(['mb-A1', 'mb-A2']);
    });

    it('vínculos: o gerente lê só os PRÓPRIOS; o do colega e o de outra empresa são invisíveis; não consegue gravar nem apagar', async () => {
      await setLinks([a2]);
      await bypass(() => db.userBranch.upsert({ where: { userId_branchId: { userId: operatorA2, branchId: a1 } }, create: { companyId: world.A.companyId, userId: operatorA2, branchId: a1 }, update: {} }));
      const own = await asManager([a1, a2], () => prisma.userBranch.findMany());
      expect(own.map((l) => l.userId)).toEqual([managerId]);
      await expect(asManager([a1, a2], () => prisma.userBranch.create({ data: { companyId: world.A.companyId, userId: managerId, branchId: a3 } }))).rejects.toThrow();
      const del = await asManager([a1, a2], () => prisma.userBranch.deleteMany({ where: { companyId: world.A.companyId, userId: managerId } }));
      expect(del.count).toBe(0);
      expect(await bypass<number>(() => db.userBranch.count({ where: { userId: managerId } }))).toBe(1);
    });

    it('o banco recusa vínculo entre empresas (FK composta) e vínculo para usuário de empresa inteira (gatilho)', async () => {
      await expect(bypass(() => db.userBranch.create({ data: { companyId: world.A.companyId, userId: managerId, branchId: world.B.branches[A1].branchId } }))).rejects.toThrow();
      await expect(bypass(() => db.userBranch.create({ data: { companyId: world.A.companyId, userId: adminUserId, branchId: a2 } }))).rejects.toThrow();
    });

    it('SQL cru com SUPER_ADMIN forjado (sem assinatura) não lê os vínculos de ninguém', async () => {
      const rows = (await db.$transaction([
        db.$executeRawUnsafe(`SELECT set_config('app.user_type','SUPER_ADMIN',true), set_config('app.current_company_id','',true)`),
        db.$queryRawUnsafe('SELECT count(*)::int AS n FROM user_branches'),
      ])) as [number, Array<{ n: number }>];
      expect(rows[1][0].n).toBe(0);
    });
  });
});
