import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import serviceOrdersRoutes from '../../src/routes/service-orders.routes';
import mechanicsRoutes from '../../src/routes/mechanics.routes';
import fiscalRoutes from '../../src/routes/fiscal.routes';
import { jobQueue } from '../../src/config/queue';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Oficina × autorização — prova REAL (HTTP + Postgres/RLS, JWT real).
 *
 * ACHADOS DE AUDITORIA (relatório de mapeamento do papel MECHANIC, cada um
 * reverificado no código):
 * 1) POST /service-orders/:id/items aceitava quantidade e preço livres (`z.number()`):
 *    preço NEGATIVO em serviço = desconto arbitrário e mão de obra escolhida por quem
 *    ganha comissão sobre ela; quantidade NEGATIVA de peça já consumida gerava entrada
 *    de estoque fantasma (`quantity: -(-n)`). Rota sem auditoria.
 * 2) POST /service-orders/:id/mechanic deixava qualquer MECHANIC reatribuir qualquer OS
 *    (a si ou a outro) antes do pagamento — a comissão vai para o mecânico vigente
 *    no pagamento: desvio de comissão. Rota sem auditoria.
 * 3) GET /mechanics/commissions (com ?mechanicId= livre) e /:id/commissions/pending-summary
 *    devolviam as comissões de QUALQUER mecânico a qualquer usuário do tenant.
 * 4) POST /fiscal/documents (emitir) e /:id/cancel (cancelar) sem trava de papel:
 *    VIEWER e MECHANIC emitiam/cancelavam documento fiscal.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Oficina — autorização e validação (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let mechA: string;
  let mechB: string;

  const tokenFor = (userId: string, userType: string) =>
    generateAccessToken({
      userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType,
    });
  const as = (userId: string, userType: string) => ({ Authorization: `Bearer ${tokenFor(userId, userType)}` });
  const operator = () => as(fixture.userId, 'OPERATOR');

  const createMechanic = (name: string) =>
    bypass<{ id: string }>(() =>
      prismaUnsafeBypassRLS.user.create({
        data: {
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          name,
          email: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@test.local`,
          password: 'not-a-real-hash',
          userType: 'MECHANIC',
          isActive: true,
        },
        select: { id: true },
      })
    );

  const newOrder = async () => {
    const res = await request(app)
      .post('/api/service-orders')
      .set(operator())
      .send({ branchId: fixture.branchId, customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, entryKilometer: 1000 });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const order = (id: string) => bypass<any>(() => prismaUnsafeBypassRLS.serviceOrder.findFirst({ where: { id } }));
  const itemCount = (id: string) => bypass<number>(() => prismaUnsafeBypassRLS.serviceOrderItem.count({ where: { serviceOrderId: id } }));

  beforeAll(async () => {
    fixture = await createFixture('workshop-authz');
    app = express();
    app.use(express.json());
    app.use('/api/service-orders', serviceOrdersRoutes);
    app.use('/api/mechanics', mechanicsRoutes);
    app.use('/api/fiscal', fiscalRoutes);
    app.use(errorHandler);
    mechA = (await createMechanic('Mecanico A')).id;
    mechB = (await createMechanic('Mecanico B')).id;
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 30000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await bypass(() => prismaUnsafeBypassRLS.mechanicCommission.deleteMany({ where: { companyId: fixture.companyId } }));
    await bypass(() => prismaUnsafeBypassRLS.fiscalDocument.deleteMany({ where: { companyId: fixture.companyId } }));
    await destroyFixture(fixture);
  }, 30000);

  beforeEach(() => auditSpy.mockClear());

  describe('itens da OS: quantidade e preço válidos', () => {
    it.each([
      ['preço negativo em serviço (desconto arbitrário)', { itemType: 'SERVICE', description: 'Mão de obra', quantity: 1, unitPrice: -50 }],
      ['quantidade negativa', { itemType: 'SERVICE', description: 'Mão de obra', quantity: -1, unitPrice: 50 }],
      ['quantidade zero', { itemType: 'SERVICE', description: 'Mão de obra', quantity: 0, unitPrice: 50 }],
      ['peça avulsa com quantidade negativa', { itemType: 'PART', description: 'Peça', quantity: -3, unitPrice: 10 }],
    ])('%s → 400 e nada muda na OS', async (_label, body) => {
      const id = await newOrder();
      const before = await order(id);

      const res = await request(app).post(`/api/service-orders/${id}/items`).set(operator()).send(body);

      expect(res.status).toBe(400);
      expect(await itemCount(id)).toBe(0);
      const after = await order(id);
      expect(String(after.finalTotal)).toBe(String(before.finalTotal));
    });

    it('item válido continua entrando (201), soma no total e é auditado com o que foi cobrado', async () => {
      const id = await newOrder();
      const res = await request(app)
        .post(`/api/service-orders/${id}/items`)
        .set(as(mechA, 'MECHANIC'))
        .send({ itemType: 'SERVICE', description: 'Revisão completa', quantity: 2, unitPrice: 30 });

      expect(res.status).toBe(201);
      expect(Number((await order(id)).finalTotal)).toBe(60);

      const audit = auditSpy.mock.calls.map((c) => c[1]).find((p) => p.entity === 'ServiceOrder' && /ADD_ITEM/.test(p.newValue));
      expect(audit).toBeDefined();
      expect(audit.entityId).toBe(id);
      expect(JSON.parse(audit.newValue)).toMatchObject({ action: 'ADD_ITEM', itemType: 'SERVICE', description: 'Revisão completa', quantity: 2, unitPrice: 30 });
    });
  });

  describe('atribuição de mecânico', () => {
    it('MECHANIC não atribui a OS a OUTRO mecânico (403) e nada muda', async () => {
      const id = await newOrder();
      const res = await request(app).post(`/api/service-orders/${id}/mechanic`).set(as(mechA, 'MECHANIC')).send({ mechanicId: mechB });
      expect(res.status).toBe(403);
      expect((await order(id)).mechanicId).toBeNull();
    });

    it('MECHANIC assume para si uma OS ainda sem mecânico (fluxo legítimo) — e é auditado', async () => {
      const id = await newOrder();
      const res = await request(app).post(`/api/service-orders/${id}/mechanic`).set(as(mechA, 'MECHANIC')).send({ mechanicId: mechA });
      expect(res.status).toBe(200);
      expect((await order(id)).mechanicId).toBe(mechA);

      const audit = auditSpy.mock.calls.map((c) => c[1]).find((p) => p.entity === 'ServiceOrder' && /ASSIGN_MECHANIC/.test(p.newValue));
      expect(audit).toBeDefined();
      expect(JSON.parse(audit.newValue)).toMatchObject({ action: 'ASSIGN_MECHANIC', mechanicId: mechA });
    });

    it('MECHANIC NÃO toma para si a OS que já é de outro mecânico (desvio de comissão) — 403', async () => {
      const id = await newOrder();
      await request(app).post(`/api/service-orders/${id}/mechanic`).set(operator()).send({ mechanicId: mechB });

      const res = await request(app).post(`/api/service-orders/${id}/mechanic`).set(as(mechA, 'MECHANIC')).send({ mechanicId: mechA });

      expect(res.status).toBe(403);
      expect((await order(id)).mechanicId).toBe(mechB);
    });

    it('OPERATOR e MANAGER seguem atribuindo/reatribuindo qualquer mecânico', async () => {
      const id = await newOrder();
      const first = await request(app).post(`/api/service-orders/${id}/mechanic`).set(operator()).send({ mechanicId: mechA });
      expect(first.status).toBe(200);
      const second = await request(app).post(`/api/service-orders/${id}/mechanic`).set(as(fixture.userId, 'MANAGER')).send({ mechanicId: mechB });
      expect(second.status).toBe(200);
      expect((await order(id)).mechanicId).toBe(mechB);
    });
  });

  describe('comissões: cada mecânico vê só as próprias', () => {
    let osId: string;

    beforeAll(async () => {
      osId = await newOrder();
      for (const [mechanicId, amount] of [[mechA, 10], [mechB, 20]] as const) {
        await bypass(() =>
          prismaUnsafeBypassRLS.mechanicCommission.create({
            data: { companyId: fixture.companyId, serviceOrderId: osId, mechanicId, ruleSnapshot: {}, baseAmount: 100, percentage: 10, commissionAmount: amount },
          })
        );
      }
    });

    const mechanicIds = (res: request.Response) => (res.body.commissions as any[]).map((c) => c.mechanicId);

    it('MECHANIC lista só as próprias, mesmo pedindo ?mechanicId= de outro', async () => {
      const own = await request(app).get('/api/mechanics/commissions').set(as(mechA, 'MECHANIC'));
      expect(own.status).toBe(200);
      expect(new Set(mechanicIds(own))).toEqual(new Set([mechA]));

      const spoof = await request(app).get(`/api/mechanics/commissions?mechanicId=${mechB}`).set(as(mechA, 'MECHANIC'));
      expect(spoof.status).toBe(200);
      expect(new Set(mechanicIds(spoof))).toEqual(new Set([mechA]));
    });

    it('MECHANIC lê o resumo pendente dele, e o dos outros é 403', async () => {
      const own = await request(app).get(`/api/mechanics/${mechA}/commissions/pending-summary`).set(as(mechA, 'MECHANIC'));
      expect(own.status).toBe(200);
      expect(own.body.pendingAmount).toBe(10);

      const other = await request(app).get(`/api/mechanics/${mechB}/commissions/pending-summary`).set(as(mechA, 'MECHANIC'));
      expect(other.status).toBe(403);
    });

    it('MANAGER continua vendo todas e filtrando por qualquer mecânico', async () => {
      const all = await request(app).get('/api/mechanics/commissions').set(as(fixture.userId, 'MANAGER'));
      expect(new Set(mechanicIds(all))).toEqual(new Set([mechA, mechB]));

      const onlyB = await request(app).get(`/api/mechanics/commissions?mechanicId=${mechB}`).set(as(fixture.userId, 'MANAGER'));
      expect(new Set(mechanicIds(onlyB))).toEqual(new Set([mechB]));

      const summary = await request(app).get(`/api/mechanics/${mechB}/commissions/pending-summary`).set(as(fixture.userId, 'MANAGER'));
      expect(summary.status).toBe(200);
      expect(summary.body.pendingAmount).toBe(20);
    });
  });

  describe('fiscal: emitir e cancelar documento exigem papel operacional', () => {
    const docCount = () => bypass<number>(() => prismaUnsafeBypassRLS.fiscalDocument.count({ where: { companyId: fixture.companyId } }));

    it.each(['VIEWER', 'MECHANIC'])('%s não emite nem cancela (403) e nenhum documento é criado', async (userType) => {
      const before = await docCount();

      const emit = await request(app)
        .post('/api/fiscal/documents')
        .set(as(fixture.userId, userType))
        .send({ saleId: '00000000-0000-4000-8000-000000000000', branchId: fixture.branchId });
      expect(emit.status).toBe(403);

      const cancel = await request(app)
        .post('/api/fiscal/documents/00000000-0000-4000-8000-000000000000/cancel')
        .set(as(fixture.userId, userType))
        .send({ reason: 'tentativa' });
      expect(cancel.status).toBe(403);

      expect(await docCount()).toBe(before);
    });

    it('OPERATOR passa pelo gate (a resposta é do serviço — venda inexistente —, não 403)', async () => {
      const res = await request(app)
        .post('/api/fiscal/documents')
        .set(operator())
        .send({ saleId: '00000000-0000-4000-8000-000000000000', branchId: fixture.branchId });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Sale not found/);
    });
  });
});
