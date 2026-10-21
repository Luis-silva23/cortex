import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { policyService } from '../../src/services/policy.service';
import { bearer, bypass, createWorld, destroyWorld, tokenFor, World, CompanyData, BranchKey } from './helpers/tenant-world';

/**
 * Garantia de OS — regra oficial do CÓRTEX (docs/CORTEX/policies/GARANTIA.md), prova REAL (HTTP + Postgres/RLS).
 * Antes (commit 06ef69d) a OS era encerrada sem nenhuma decisão de garantia e não existia /api/warranties: todos os
 * casos abaixo falhariam (encerrar sem decisão respondia 200; consultas/ocorrências respondiam 404 de rota).
 */
describe('Garantia de OS: decisão no encerramento, vigência prazo/km e ocorrências (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let osSeq = 9000;
  const auditCalls = () => auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1]);

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) await destroyWorld(world);
  });

  const A = () => world.A;
  const B = () => world.B;
  const as = (userType: string, branch: BranchKey | null = 1, co: CompanyData = A()) => bearer(tokenFor(co, branch, userType));

  /** OS pronta para encerrar: ENTREGA, paga, com 1 serviço e 1 peça. */
  async function deliveredOs(opts: { co?: CompanyData; branch?: BranchKey; deliveryDate?: Date; entryKm?: number; items?: Array<'SERVICE' | 'PART'> } = {}) {
    const co = opts.co ?? A();
    const branchId = co.branches[opts.branch ?? 1].branchId;
    const os = await bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: co.companyId, branchId, osNumber: ++osSeq, customerId: co.customerId, motorcycleId: co.motorcycleId,
          entryDate: new Date(), entryKilometer: opts.entryKm ?? 42_000, status: 'ENTREGA', deliveryDate: opts.deliveryDate ?? new Date(),
          laborTotal: 100, partsTotal: 50, finalTotal: 150, isPaid: true, paidAt: new Date(), paymentMethod: 'CASH',
        },
      })
    );
    const items: any[] = [];
    for (const t of opts.items ?? ['SERVICE', 'PART']) {
      items.push(
        await bypass<any>(() =>
          db.serviceOrderItem.create({
            data: { serviceOrderId: os.id, itemType: t, description: t === 'SERVICE' ? 'Troca de kit relação' : 'Kit relação', quantity: 1, unitPrice: 50, totalPrice: 50 },
          })
        )
      );
    }
    return { os, items };
  }

  const close = (osId: string, body: Record<string, unknown>, headers = as('OPERATOR')) =>
    request(app).post(`/api/service-orders/${osId}/status`).set(headers).send({ toStatus: 'ENCERRADA', ...body });
  const warrantyRow = (osId: string) => bypass<any>(() => db.serviceOrderWarranty.findUnique({ where: { serviceOrderId: osId } }));
  const osRow = (osId: string) => bypass<any>(() => db.serviceOrder.findUnique({ where: { id: osId } }));
  const localDate = (d: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(d));

  const GRANTED = { decision: 'GRANTED', coverage: 'SERVICE_AND_PART', durationValue: 3, durationUnit: 'MONTHS', kmLimit: 3000 };

  describe('encerramento', () => {
    it('sem decisão de garantia é recusado (400 WARRANTY_DECISION_REQUIRED) e a OS continua em ENTREGA', async () => {
      const { os } = await deliveredOs();
      const res = await close(os.id, {});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WARRANTY_DECISION_REQUIRED');
      expect((await osRow(os.id)).status).toBe('ENTREGA');
      expect(await warrantyRow(os.id)).toBeNull();
    });

    it('"sem garantia" encerra e grava a decisão NONE, sem garantia', async () => {
      const { os } = await deliveredOs();
      const res = await close(os.id, { warranty: { decision: 'NONE' } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ENCERRADA');
      expect((await osRow(os.id)).warrantyDecision).toBe('NONE');
      expect(await warrantyRow(os.id)).toBeNull();
    });

    it('com garantia (3 meses OU 3.000 km): início na ENTREGA, validade no fim do dia, km inicial/limite, itens cobertos, auditoria', async () => {
      const delivered = new Date('2026-09-27T13:00:00Z');
      const { os, items } = await deliveredOs({ deliveryDate: delivered });
      const before = auditCalls().length;
      const res = await close(os.id, { warranty: { ...GRANTED, startKm: 42_350, conditions: 'Uso normal, sem competição' } });
      expect(res.status).toBe(200);
      expect(res.body.warrantyDecision).toBe('GRANTED');

      const w = await warrantyRow(os.id);
      expect(w).toMatchObject({ coverage: 'SERVICE_AND_PART', durationValue: 3, durationUnit: 'MONTHS', kmLimit: 3000, conditions: 'Uso normal, sem competição' });
      expect(new Date(w.startDate).toISOString()).toBe(delivered.toISOString());
      expect(localDate(w.validUntil)).toBe('2026-12-27');
      expect(Number(w.startKm)).toBe(42_350);
      expect(Number(w.kmUntil)).toBe(45_350);
      expect(w.coveredItems.map((i: any) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
      expect(w.createdBy).toBe(A().branches[1].userId);
      expect(w.branchId).toBe(A().branches[1].branchId);
      // km de saída informado no encerramento fica na OS
      expect(Number((await osRow(os.id)).exitKilometer)).toBe(42_350);

      const audit = auditCalls().slice(before).find((c) => c.entity === 'ServiceOrder' && c.entityId === os.id);
      expect(JSON.parse(audit.newValue)).toMatchObject({ toStatus: 'ENCERRADA', warrantyDecision: 'GRANTED', warranty: { id: w.id, kmUntil: 45_350 } });

      // uma garantia por OS: não há segundo encerramento
      const again = await close(os.id, { warranty: GRANTED });
      expect(again.status).toBe(400);
      expect(await bypass<number>(() => db.serviceOrderWarranty.count({ where: { serviceOrderId: os.id } }))).toBe(1);
    });

    it('fim de mês: entrega em 31/01 + 1 mês vale até 28/02 (não estoura para março)', async () => {
      const { os } = await deliveredOs({ deliveryDate: new Date('2026-01-31T15:00:00Z') });
      const res = await close(os.id, { warranty: { decision: 'GRANTED', coverage: 'SERVICE', durationValue: 1, durationUnit: 'MONTHS' } });
      expect(res.status).toBe(200);
      const w = await warrantyRow(os.id);
      expect(localDate(w.validUntil)).toBe('2026-02-28');
      expect(w.kmUntil).toBeNull();
      // só o serviço é coberto
      expect(w.coveredItems).toHaveLength(1);
      expect(w.coveredItems[0].itemType).toBe('SERVICE');
    });

    it('km inicial padrão = km de entrada; km inicial menor que a entrada é recusado', async () => {
      const { os } = await deliveredOs({ entryKm: 10_000 });
      const bad = await close(os.id, { warranty: { ...GRANTED, startKm: 9_000 } });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_START_KM');
      const ok = await close(os.id, { warranty: GRANTED });
      expect(ok.status).toBe(200);
      expect(Number((await warrantyRow(os.id)).startKm)).toBe(10_000);
    });

    it('tipo sem item correspondente e item de outra OS são recusados (400)', async () => {
      const { os } = await deliveredOs({ items: ['SERVICE'] });
      const noPart = await close(os.id, { warranty: { ...GRANTED, coverage: 'PART' } });
      expect(noPart.status).toBe(400);
      expect(noPart.body.code).toBe('WARRANTY_NO_COVERED_ITEMS');
      const other = await deliveredOs();
      const foreign = await close(os.id, { warranty: { ...GRANTED, coveredItemIds: [other.items[0].id] } });
      expect(foreign.status).toBe(400);
      expect(foreign.body.code).toBe('WARRANTY_ITEM_NOT_IN_OS');
      expect((await osRow(os.id)).status).toBe('ENTREGA');
    });

    it('decisão fora do encerramento é recusada; VIEWER não encerra (403)', async () => {
      const { os } = await deliveredOs();
      const viewer = await close(os.id, { warranty: { decision: 'NONE' } }, as('VIEWER'));
      expect(viewer.status).toBe(403);
      const res = await request(app).post(`/api/service-orders/${A().branches[1].serviceOrderId}/status`).set(as('OPERATOR')).send({ toStatus: 'DIAGNOSTICO', warranty: { decision: 'NONE' } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WARRANTY_ONLY_ON_CLOSE');
    });

    it('política: filial com garantia desabilitada não pede decisão e recusa garantia (409); sem exigência, encerra sem decisão', async () => {
      const b2 = A().branches[2].branchId;
      await runWithRLSContext({ companyId: A().companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        policyService.set({ companyId: A().companyId, branchId: b2, key: 'warranty.enabled', value: false, reason: 'Filial 2 sem garantia', userId: A().fixture.userId })
      );
      const { os: granted } = await deliveredOs({ branch: 2 });
      const refused = await close(granted.id, { warranty: GRANTED }, as('OPERATOR', 2));
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('WARRANTY_DISABLED');
      const noDecision = await close(granted.id, {}, as('OPERATOR', 2));
      expect(noDecision.status).toBe(200);
      expect((await osRow(granted.id)).warrantyDecision).toBeNull();

      await runWithRLSContext({ companyId: A().companyId, userType: 'COMPANY_ADMIN', branchId: null }, async () => {
        await policyService.reset({ companyId: A().companyId, branchId: b2, key: 'warranty.enabled', reason: 'Volta ao padrão', userId: A().fixture.userId });
        await policyService.set({ companyId: A().companyId, branchId: b2, key: 'warranty.requireDecisionOnClose', value: false, reason: 'Decisão opcional', userId: A().fixture.userId });
      });
      const { os: optional } = await deliveredOs({ branch: 2 });
      expect((await close(optional.id, {}, as('OPERATOR', 2))).status).toBe(200);
      await runWithRLSContext({ companyId: A().companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        policyService.reset({ companyId: A().companyId, branchId: b2, key: 'warranty.requireDecisionOnClose', reason: 'Volta ao padrão', userId: A().fixture.userId })
      );
    });
  });

  describe('consulta, vigência e ocorrências', () => {
    let active: any; // 3 meses OU 3.000 km a partir de agora
    let expiredByDate: any;

    beforeAll(async () => {
      const a = await deliveredOs({ entryKm: 42_000 });
      await close(a.os.id, { warranty: { ...GRANTED, startKm: 42_350 } });
      active = await warrantyRow(a.os.id);
      const e = await deliveredOs({ deliveryDate: new Date(Date.now() - 400 * 86_400_000) });
      await close(e.os.id, { warranty: { decision: 'GRANTED', coverage: 'SERVICE', durationValue: 6, durationUnit: 'MONTHS', kmLimit: 5000 } });
      expiredByDate = await warrantyRow(e.os.id);
    });

    it('GET /warranties por cliente/veículo e situação (vigente x expirada)', async () => {
      const act = await request(app).get('/api/warranties').query({ customerId: A().customerId, status: 'ACTIVE' }).set(as('OPERATOR'));
      expect(act.status).toBe(200);
      const ids = act.body.warranties.map((w: any) => w.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(expiredByDate.id);
      const found = act.body.warranties.find((w: any) => w.id === active.id);
      expect(found).toMatchObject({ status: 'ACTIVE', serviceOrder: { osNumber: expect.any(Number) }, durationLabel: '3 meses' });

      const exp = await request(app).get('/api/warranties').query({ motorcycleId: A().motorcycleId, status: 'EXPIRED' }).set(as('OPERATOR'));
      const e = exp.body.warranties.find((w: any) => w.id === expiredByDate.id);
      expect(e).toMatchObject({ status: 'EXPIRED', expiredBy: 'DATE' });
    });

    it('o que ocorrer primeiro: km informado no limite expira mesmo dentro do prazo', async () => {
      const byKm = await request(app).get(`/api/warranties/${active.id}`).query({ km: 45_350 }).set(as('OPERATOR'));
      expect(byKm.body).toMatchObject({ status: 'EXPIRED', expiredBy: 'KM' });
      const below = await request(app).get(`/api/warranties/${active.id}`).query({ km: 45_349 }).set(as('OPERATOR'));
      expect(below.body).toMatchObject({ status: 'ACTIVE', expiredBy: null });
    });

    it('ocorrência dentro da vigência é registrada (OPEN) e atualiza o odômetro do veículo', async () => {
      const res = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR')).send({ description: 'Ruído na corrente', kmAtClaim: 43_100 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'OPEN', serviceOrderId: active.serviceOrderId, warrantyId: active.id });
      const moto = await bypass<any>(() => db.motorcycle.findUnique({ where: { id: A().motorcycleId } }));
      expect(Number(moto.kilometerReading)).toBeGreaterThanOrEqual(43_100);
    });

    it('fora da vigência é recusada com WARRANTY_EXPIRED explicando prazo ou km', async () => {
      const byKm = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR')).send({ description: 'Quebrou de novo', kmAtClaim: 46_000 });
      expect(byKm.status).toBe(409);
      expect(byKm.body.code).toBe('WARRANTY_EXPIRED');
      expect(byKm.body.message).toMatch(/limite de 45\.350 km/);
      const byDate = await request(app).post(`/api/warranties/${expiredByDate.id}/claims`).set(as('OPERATOR')).send({ description: 'Quebrou de novo', kmAtClaim: 42_500 });
      expect(byDate.status).toBe(409);
      expect(byDate.body.code).toBe('WARRANTY_EXPIRED');
      expect(byDate.body.message).toMatch(/prazo terminou/);
    });

    it('com limite de km, a ocorrência exige o km; km abaixo do inicial é recusado', async () => {
      const noKm = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR')).send({ description: 'Sem km informado' });
      expect(noKm.status).toBe(400);
      expect(noKm.body.code).toBe('WARRANTY_KM_REQUIRED');
      const low = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR')).send({ description: 'Km menor', kmAtClaim: 1_000 });
      expect(low.status).toBe(400);
      expect(low.body.code).toBe('INVALID_KM');
    });

    it('decisão só por gerência+; transições guardadas; OS de retorno do mesmo veículo e da mesma empresa', async () => {
      const claim = (await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR')).send({ description: 'Vazamento', kmAtClaim: 43_200 })).body;

      const byOperator = await request(app).patch(`/api/warranties/claims/${claim.id}`).set(as('OPERATOR')).send({ status: 'ACCEPTED', decisionNotes: 'Aceito pelo balcão' });
      expect(byOperator.status).toBe(403);

      const skip = await request(app).patch(`/api/warranties/claims/${claim.id}`).set(as('MANAGER')).send({ status: 'RESOLVED', decisionNotes: 'Pulando a aceitação' });
      expect(skip.status).toBe(409);
      expect(skip.body.code).toBe('WARRANTY_CLAIM_INVALID_TRANSITION');

      const foreignOs = await request(app)
        .patch(`/api/warranties/claims/${claim.id}`)
        .set(as('MANAGER'))
        .send({ status: 'ACCEPTED', decisionNotes: 'OS de outra empresa', newServiceOrderId: B().branches[1].serviceOrderId });
      expect(foreignOs.status).toBe(404);

      const original = await request(app)
        .patch(`/api/warranties/claims/${claim.id}`)
        .set(as('MANAGER'))
        .send({ status: 'ACCEPTED', decisionNotes: 'Mesma OS', newServiceOrderId: active.serviceOrderId });
      expect(original.status).toBe(400);
      expect(original.body.code).toBe('RETURN_SERVICE_ORDER_IS_ORIGINAL');

      const before = auditCalls().length;
      const accepted = await request(app)
        .patch(`/api/warranties/claims/${claim.id}`)
        .set(as('MANAGER'))
        .send({ status: 'ACCEPTED', decisionNotes: 'Defeito de montagem confirmado', newServiceOrderId: A().branches[1].serviceOrderId });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ status: 'ACCEPTED', newServiceOrderId: A().branches[1].serviceOrderId, decidedBy: A().branches[1].userId });
      expect(auditCalls().slice(before).some((c) => c.entity === 'WarrantyClaim' && c.entityId === claim.id)).toBe(true);

      const reject = await request(app).patch(`/api/warranties/claims/${claim.id}`).set(as('MANAGER')).send({ status: 'REJECTED', decisionNotes: 'Mudou de ideia' });
      expect(reject.status).toBe(409);
      const resolved = await request(app).patch(`/api/warranties/claims/${claim.id}`).set(as('MANAGER')).send({ status: 'RESOLVED', decisionNotes: 'Corrente trocada na OS de retorno' });
      expect(resolved.status).toBe(200);
      expect(resolved.body.status).toBe('RESOLVED');

      const detail = await request(app).get(`/api/warranties/${active.id}`).set(as('OPERATOR'));
      expect(detail.body.claims.some((c: any) => c.id === claim.id && c.status === 'RESOLVED')).toBe(true);
      const os = await request(app).get(`/api/service-orders/${active.serviceOrderId}`).set(as('OPERATOR'));
      expect(os.body.warranty).toMatchObject({ id: active.id });
    });

    it('isolamento: outra empresa e outra filial não enxergam nem registram ocorrência', async () => {
      const otherCo = await request(app).get(`/api/warranties/${active.id}`).set(as('COMPANY_ADMIN', null, B()));
      expect(otherCo.status).toBe(404);
      const listB = await request(app).get('/api/warranties').set(as('COMPANY_ADMIN', null, B()));
      expect(listB.body.warranties.map((w: any) => w.id)).not.toContain(active.id);
      const claimB = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR', 1, B())).send({ description: 'Tentativa', kmAtClaim: 43_000 });
      expect(claimB.status).toBe(404);

      const otherBranch = await request(app).get(`/api/warranties/${active.id}`).set(as('OPERATOR', 2));
      expect(otherBranch.status).toBe(404);
      const claimBranch2 = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('OPERATOR', 2)).send({ description: 'Tentativa', kmAtClaim: 43_000 });
      expect(claimBranch2.status).toBe(404);
      // a empresa inteira (admin sem filial) enxerga
      expect((await request(app).get(`/api/warranties/${active.id}`).set(as('COMPANY_ADMIN', null))).status).toBe(200);
    });

    it('VIEWER consulta, mas não registra ocorrência (403)', async () => {
      expect((await request(app).get('/api/warranties').set(as('VIEWER'))).status).toBe(200);
      const res = await request(app).post(`/api/warranties/${active.id}/claims`).set(as('VIEWER')).send({ description: 'Viewer tenta', kmAtClaim: 43_000 });
      expect(res.status).toBe(403);
    });
  });
});
