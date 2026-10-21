import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import dashboardRoutes from '../../src/routes/dashboard.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import dashboardManagementService from '../../src/services/dashboard-management.service';
import moduleSettingsService from '../../src/services/module-settings.service';
import salesChannelService from '../../src/services/sales-channels/sales-channel.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Dashboard gerencial — prova REAL (Postgres + RLS + JWT): período único em Brasília (virada de dia, de mês e de ano), KPIs com
 * comparação, ticket por vendas distintas, formas de pagamento sem dupla contagem, origem só com canais ativos, séries que somam
 * o mesmo que os KPIs, e isolamento por empresa, filial e perfil. Datas escolhidas na fronteira da meia-noite de Brasília
 * (03:00Z): 02:59:59Z ainda é o dia anterior.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}
const db = prismaUnsafeBypassRLS;
const NOW = new Date('2026-10-15T15:00:00Z'); // 15/10/2026, 12:00 em Brasília

describe('Dashboard gerencial — integração real', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let branchA2: string;
  let whatsappId: string;
  let marketplaceId: string;
  let app: express.Express;
  let saleNumber = 9000;

  const token = (fx: IntegrationFixture, userType: string, branchId: string | null) =>
    generateAccessToken({ userId: fx.userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: (branchId ?? undefined) as any, userType });
  const as = (fx: IntegrationFixture, userType: string, branchId: string | null = fx.branchId) => ({ Authorization: `Bearer ${token(fx, userType, userType === 'COMPANY_ADMIN' ? null : branchId)}` });
  const adminCtx = <T>(fx: IntegrationFixture, fn: () => Promise<T>) => runWithRLSContext({ companyId: fx.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
  const managerCtx = <T>(fx: IntegrationFixture, branchId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId: fx.companyId, userType: 'MANAGER', branchId }, fn);

  const sale = (fx: IntegrationFixture, o: { at: string; total: number; subtotal?: number; discount?: number; status?: string; branchId?: string; channelId?: string; cancelledAt?: string }) =>
    bypass<{ id: string }>(() =>
      db.sale.create({
        data: {
          companyId: fx.companyId,
          branchId: o.branchId ?? fx.branchId,
          saleNumber: ++saleNumber,
          userId: fx.userId,
          cashRegisterId: fx.cashRegisterId,
          status: (o.status ?? 'PAID') as any,
          subtotal: o.subtotal ?? o.total,
          discountAmount: o.discount ?? 0,
          totalAmount: o.total,
          saleDate: new Date(o.at),
          ...(o.cancelledAt ? { cancelledAt: new Date(o.cancelledAt) } : {}),
          ...(o.channelId ? { channelId: o.channelId } : {}),
        },
      })
    );
  const pay = (fx: IntegrationFixture, saleId: string, method: string, amount: number, status = 'APPROVED') =>
    bypass(() => db.payment.create({ data: { companyId: fx.companyId, saleId, paymentMethod: method as any, status: status as any, amount } }));
  const movement = (type: 'WITHDRAWAL' | 'DEPOSIT', at: string, amount: number) =>
    bypass(() => db.cashMovement.create({ data: { cashRegisterId: A.cashRegisterId, movementType: type, amount, userId: A.userId, notes: 'teste', createdAt: new Date(at) } }));

  const summary = (scope: { companyId: string; branchId: string | null }, input: any, now = NOW) => dashboardManagementService.summary(scope, input, now);
  const series = (scope: { companyId: string; branchId: string | null }, input: any, now = NOW) => dashboardManagementService.timeseries(scope, input, now);

  beforeAll(async () => {
    [A, B] = await Promise.all([createFixture('dashA'), createFixture('dashB')]);
    branchA2 = (await bypass<{ id: string }>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial A2', isHeadquarter: false, isActive: true } }))).id;

    // módulo de canais ligado para A, um canal ativo (origem manual) e um desativado
    await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'CANAIS', isEnabled: true, actorId: A.userId }));
    const wa = await adminCtx(A, () => salesChannelService.create({ companyId: A.companyId, type: 'OUTRO', displayName: 'Vendas WhatsApp', actorId: A.userId }));
    await adminCtx(A, () => salesChannelService.update({ companyId: A.companyId, id: wa.id, actorId: A.userId, isActive: true }));
    whatsappId = wa.id;
    marketplaceId = (await adminCtx(A, () => salesChannelService.create({ companyId: A.companyId, type: 'MARKETPLACE', displayName: 'Marketplace X', actorId: A.userId }))).id;

    // ---- período anterior (mês atual × 1..15 do mês anterior = 01/09..15/09) ----
    await sale(A, { at: '2026-09-01T02:59:59Z', total: 999 }); // 31/08 23:59:59 em Brasília: FORA
    const p2 = await sale(A, { at: '2026-09-01T03:00:00Z', total: 80 }); // 01/09 00:00: dentro
    await pay(A, p2.id, 'PIX', 80);
    const p3 = await sale(A, { at: '2026-09-16T02:59:59Z', total: 20 }); // 15/09 23:59:59: dentro
    await pay(A, p3.id, 'CASH', 20);
    await sale(A, { at: '2026-09-16T03:00:00Z', total: 777 }); // 16/09 00:00: FORA
    await sale(A, { at: '2026-09-02T12:00:00Z', total: 55, status: 'CANCELLED', cancelledAt: '2026-09-05T15:00:00Z' });
    await movement('WITHDRAWAL', '2026-09-05T15:00:00Z', 40);

    // ---- período atual (01/10..15/10) ----
    await sale(A, { at: '2026-10-01T02:59:59Z', total: 100 }); // 30/09 23:59:59: fora dos dois
    const c1 = await sale(A, { at: '2026-10-01T03:00:00Z', total: 50 });
    await pay(A, c1.id, 'CASH', 50);
    const c2 = await sale(A, { at: '2026-10-15T02:59:59Z', total: 200, subtotal: 210, discount: 10, status: 'PARTIALLY_PAID' }); // 14/10 23:59:59 em Brasília
    await pay(A, c2.id, 'PIX', 100);
    await pay(A, c2.id, 'DEBIT_CARD', 100);
    await pay(A, c2.id, 'PIX', 5, 'PENDING'); // pendente não conta
    const c3 = await sale(A, { at: '2026-10-05T12:00:00Z', total: 300, channelId: whatsappId });
    await pay(A, c3.id, 'CREDIT_CARD', 300);
    const c4 = await sale(A, { at: '2026-10-06T12:00:00Z', total: 70, channelId: marketplaceId }); // canal desativado
    await pay(A, c4.id, 'CASH', 70);
    await sale(A, { at: '2026-10-07T12:00:00Z', total: 999, status: 'PENDING' }); // pendente não é venda realizada
    await sale(A, { at: '2026-10-03T12:00:00Z', total: 400, status: 'CANCELLED', cancelledAt: '2026-10-10T15:00:00Z' });
    await sale(A, { at: '2026-10-04T12:00:00Z', total: 60, status: 'RETURNED', cancelledAt: '2026-10-12T15:00:00Z' });
    const c8 = await sale(A, { at: '2026-10-06T12:00:00Z', total: 1000, branchId: branchA2 });
    await pay(A, c8.id, 'CASH', 1000);
    await movement('WITHDRAWAL', '2026-10-01T02:59:59Z', 77); // 30/09: fora
    await movement('WITHDRAWAL', '2026-10-02T15:00:00Z', 30);
    await movement('WITHDRAWAL', '2026-10-15T02:59:59Z', 20); // 14/10 23:59:59 em Brasília
    await movement('DEPOSIT', '2026-10-03T15:00:00Z', 999); // reforço não é saque
    await bypass(() =>
      db.cashRegister.create({
        data: { companyId: A.companyId, branchId: branchA2, userId: A.userId, registerNumber: 2, status: 'CLOSED', openingAmount: 0, expectedAmount: 100, actualAmount: 90, difference: -10, closedAt: new Date('2026-10-10T15:00:00Z'), closeType: 'FORCED' },
      })
    );

    // ---- virada de ano: 01..31/12/2026 ----
    await sale(A, { at: '2026-12-01T02:59:59Z', total: 33 }); // 30/11: fora
    await sale(A, { at: '2026-12-01T03:00:00Z', total: 11 });
    await sale(A, { at: '2027-01-01T02:59:59Z', total: 40 }); // 31/12 23:59:59: dentro
    await sale(A, { at: '2027-01-01T03:00:00Z', total: 60 }); // 01/01/2027: fora

    // empresa B: nunca aparece em A
    const b1 = await sale(B, { at: '2026-10-06T12:00:00Z', total: 5000 });
    await pay(B, b1.id, 'PIX', 5000);

    // operação: contas vencidas e uma OS em aberto sem prazo prometido e entrada há 10 dias (atrasada pela regra de 7 dias)
    const day = 86_400_000;
    await bypass(() => db.accountsPayable.create({ data: { companyId: A.companyId, branchId: A.branchId, description: 'Conta vencida', amount: 120, dueDate: new Date(Date.now() - 5 * day), status: 'PENDING' } }));
    await bypass(() => db.accountsReceivable.create({ data: { companyId: A.companyId, branchId: A.branchId, description: 'Recebível vencido', amount: 80, dueDate: new Date(Date.now() - 3 * day), status: 'PENDING' } }));
    await bypass(() => db.accountsReceivable.create({ data: { companyId: A.companyId, branchId: A.branchId, description: 'Recebível futuro', amount: 999, dueDate: new Date(Date.now() + 3 * day), status: 'PENDING' } }));
    await bypass(() =>
      db.serviceOrder.create({
        data: { companyId: A.companyId, branchId: A.branchId, osNumber: 7001, customerId: A.customerId, motorcycleId: A.motorcycleId, status: 'ENTRADA', entryDate: new Date(Date.now() - 10 * day), entryKilometer: 100, finalTotal: 0 },
      })
    );

    app = express();
    app.use(express.json());
    app.use('/dashboard', dashboardRoutes);
    app.use(errorHandler);
  }, 60000);

  afterAll(async () => {
    await bypass(() => db.accountsPayable.deleteMany({ where: { companyId: A.companyId } }));
    await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: A.companyId } }));
    await Promise.all([destroyFixture(A), destroyFixture(B)]);
  }, 60000);

  const A1 = () => ({ companyId: A.companyId, branchId: A.branchId });
  const ALL = () => ({ companyId: A.companyId, branchId: null });

  describe('KPIs e comparação (mês atual × mesmo período do mês anterior)', () => {
    it('resolve o período em Brasília e devolve o anterior equivalente', async () => {
      const r = await adminCtx(A, () => summary(A1(), { period: 'month' }));
      expect(r.period).toMatchObject({ preset: 'month', startDay: '2026-10-01', endDay: '2026-10-15', granularity: 'day', timeZone: 'America/Sao_Paulo' });
      expect(r.period.start).toBe('2026-10-01T03:00:00.000Z');
      expect(r.period.previous).toMatchObject({ startDay: '2026-09-01', endDay: '2026-09-15', label: 'mesmo período do mês anterior' });
    });

    it('receita = valor das vendas realizadas (pagas e parcialmente pagas); pendente, cancelada e fora da meia-noite de Brasília ficam de fora', async () => {
      const k = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).kpis;
      expect(k.revenue).toMatchObject({ current: 620, previous: 100, diff: 520, percent: 520, trend: 'up', outcome: 'better' });
      expect(k.sales).toMatchObject({ current: 4, previous: 2, diff: 2, percent: 100, outcome: 'better' });
    });

    it('ticket médio = receita ÷ vendas distintas (5 pagamentos aprovados NÃO viram divisor)', async () => {
      const k = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).kpis;
      expect(k.avgTicket.current).toBe(155); // 620 ÷ 4 vendas (e não ÷ 5 pagamentos aprovados)
      expect(k.avgTicket.previous).toBe(50); // 100 ÷ 2
      expect(k.avgTicket).toMatchObject({ diff: 105, percent: 210, outcome: 'better' });
    });

    it('saques: só retirada de caixa, no dia de Brasília (23:59:59 conta no dia 14); reforço e fora da janela não entram', async () => {
      const k = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).kpis;
      expect(k.withdrawals.count).toMatchObject({ current: 2, previous: 1, outcome: 'neutral' });
      expect(k.withdrawals.amount).toMatchObject({ current: 50, previous: 40, diff: 10, percent: 25 });
    });

    it('cancelamentos e devoluções totais pela data em que aconteceram (só quantidade)', async () => {
      const c = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).kpis.cancellations;
      expect(c.cancelled).toMatchObject({ current: 1, previous: 1, trend: 'flat' });
      expect(c.returned).toMatchObject({ current: 1, previous: 0, percent: null, trend: 'up', outcome: 'worse' });
      expect(c.total).toMatchObject({ current: 2, previous: 1, percent: 100, outcome: 'worse' });
    });

    it('descontos: valor, vendas com desconto e % sobre o valor bruto', async () => {
      const d = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).kpis.discounts;
      expect(d.amount).toMatchObject({ current: 10, previous: 0, percent: null });
      expect(d.salesWithDiscount.current).toBe(1);
      expect(d.percentOfGross.current).toBe(1.59); // 10 ÷ 630
    });

    it('anterior zero não gera percentual inválido: hoje com venda × ontem sem venda → null; sem nada → 0%', async () => {
      const today = await adminCtx(A, () => summary(A1(), { period: 'today' }, new Date('2026-10-05T18:00:00Z')));
      expect(today.kpis.revenue).toMatchObject({ current: 300, previous: 0, percent: null });
      expect(today.period.previous.label).toBe('ontem até 15:00');
      const empty = await adminCtx(A, () => summary(A1(), { period: 'today' }, new Date('2026-10-20T18:00:00Z')));
      expect(empty.kpis.revenue).toMatchObject({ current: 0, previous: 0, percent: 0, trend: 'flat' });
      expect(empty.kpis.avgTicket).toMatchObject({ current: null, previous: null, diff: null, percent: null });
    });
  });

  describe('formas de pagamento: vendas distintas, sem dupla contagem', () => {
    it('cartão agrega débito + crédito com detalhe; venda paga em duas formas conta uma vez em cada forma', async () => {
      const groups = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).paymentMethods.groups;
      const g = (key: string) => groups.find((x) => x.key === key)!;
      expect(g('CARD').current).toMatchObject({ sales: 2, amount: 400, avgTicket: 200, share: 64.52 });
      expect(g('CARD').details).toEqual([
        { key: 'DEBIT_CARD', label: 'Débito', sales: 1, amount: 100, avgTicket: 100 },
        { key: 'CREDIT_CARD', label: 'Crédito', sales: 1, amount: 300, avgTicket: 300 },
      ]);
      expect(g('PIX').current).toMatchObject({ sales: 1, amount: 100, avgTicket: 100, share: 16.13 }); // o PIX pendente não conta
      expect(g('CASH').current).toMatchObject({ sales: 2, amount: 120, avgTicket: 60, share: 19.35 });
      expect(g('PIX').previous).toMatchObject({ sales: 1, amount: 80 });
      expect(g('CASH').previous).toMatchObject({ sales: 1, amount: 20 });
      expect(g('EMPLOYEE_AGREEMENT').current).toMatchObject({ sales: 0, amount: 0, avgTicket: null });
      expect(groups.find((x) => x.key === 'OTHER')).toBeUndefined(); // "outras formas" só aparece com uso
    });
  });

  describe('origem das vendas: só canais ativos', () => {
    it('com o módulo ligado: loja física + canal ativo; o canal desativado fica fora da composição (e é avisado)', async () => {
      const o = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).origins;
      expect(o.moduleEnabled).toBe(true);
      expect(o.items.map((i) => [i.name, i.revenue, i.sales, i.share])).toEqual([
        ['Loja física', 250, 2, 45.45],
        ['Vendas WhatsApp', 300, 1, 54.55],
      ]);
      expect(o.items.find((i) => i.name === 'Marketplace X')).toBeUndefined(); // nada de "Marketplace 0%"
      expect(o.totalRevenue).toBe(550);
      expect(o.excluded).toEqual({ revenue: 70, sales: 1 });
    });

    it('com o módulo desligado: só a loja física, e a receita dos canais vira "fora da composição"', async () => {
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'CANAIS', isEnabled: false, actorId: A.userId }));
      const o = (await adminCtx(A, () => summary(A1(), { period: 'month' }))).origins;
      expect(o.moduleEnabled).toBe(false);
      expect(o.items.map((i) => i.name)).toEqual(['Loja física']);
      expect(o.excluded).toEqual({ revenue: 370, sales: 2 });
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'CANAIS', isEnabled: true, actorId: A.userId }));
    });

    it('empresa sem nenhum canal funciona só com a loja física', async () => {
      const o = (await adminCtx(B, () => summary({ companyId: B.companyId, branchId: null }, { period: 'month' }))).origins;
      expect(o.items.map((i) => i.name)).toEqual(['Loja física']);
      expect(o.items[0]).toMatchObject({ revenue: 5000, share: 100 });
    });
  });

  describe('séries: mesma regra de período, mesmo total dos KPIs, dia de Brasília', () => {
    it('dia a dia, com zero onde não houve venda, e a venda das 23:59:59 no dia 14 (não no 15)', async () => {
      const s = await adminCtx(A, () => series(A1(), { period: 'month' }));
      expect(s.granularity).toBe('day');
      expect(s.points).toHaveLength(15);
      const at = (key: string) => s.points.find((p) => p.key === key)!;
      expect(at('2026-10-14')).toMatchObject({ revenue: 200, sales: 1 });
      expect(at('2026-10-15')).toMatchObject({ revenue: 0, sales: 0, avgTicket: null }); // sem venda: zero em vendas, ticket indefinido
      expect(at('2026-10-01')).toMatchObject({ revenue: 50, sales: 1, avgTicket: 50 });
      expect(at('2026-10-02').revenue).toBe(0);
      expect(at('2026-10-14').withdrawals).toEqual({ count: 1, amount: 20 }); // o saque das 23:59:59 também é do dia 14
      expect(at('2026-10-02').withdrawals).toEqual({ count: 1, amount: 30 });
    });

    it('as séries somam exatamente o que os KPIs mostram (um só período para tudo)', async () => {
      const [k, s] = await adminCtx(A, async () => [await summary(A1(), { period: 'month' }), await series(A1(), { period: 'month' })] as const);
      expect(s.points.reduce((a, p) => a + p.revenue, 0)).toBeCloseTo(k.kpis.revenue.current!, 2);
      expect(s.points.reduce((a, p) => a + p.sales, 0)).toBe(k.kpis.sales.current);
      expect(s.points.reduce((a, p) => a + p.withdrawals.amount, 0)).toBeCloseTo(k.kpis.withdrawals.amount.current!, 2);
      expect(s.previousPoints.reduce((a, p) => a + p.revenue, 0)).toBeCloseTo(k.kpis.revenue.previous!, 2);
      expect(s.previousPoints).toHaveLength(15);
      expect(s.previousPoints[0]).toMatchObject({ key: '2026-09-01', revenue: 80 });
      expect(s.previousPoints[14]).toMatchObject({ key: '2026-09-15', revenue: 20 });
    });

    it('detalhe por forma (tooltip) e por canal em cada ponto', async () => {
      const s = await adminCtx(A, () => series(A1(), { period: 'month' }));
      const p14 = s.points.find((p) => p.key === '2026-10-14')!;
      expect(p14.byMethod).toEqual({ PIX: { sales: 1, amount: 100 }, CARD: { sales: 1, amount: 100 } });
      const p5 = s.points.find((p) => p.key === '2026-10-05')!;
      expect(p5.byChannel).toEqual({ LOJA_FISICA: { sales: 0, revenue: 0 }, [whatsappId]: { sales: 1, revenue: 300 } });
      expect(s.channels.map((c) => c.name)).toEqual(['Loja física', 'Vendas WhatsApp']);
    });

    it('hoje por hora (09:00 de Brasília = 12:00Z); só até a hora atual', async () => {
      const s = await adminCtx(A, () => series(A1(), { period: 'today' }, new Date('2026-10-05T18:00:00Z')));
      expect(s.granularity).toBe('hour');
      expect(s.points).toHaveLength(16);
      expect(s.points.find((p) => p.key === '2026-10-05T09')).toMatchObject({ revenue: 300, sales: 1 });
      expect(s.points.find((p) => p.key === '2026-10-05T10')).toMatchObject({ revenue: 0 });
      expect(s.previousPoints).toHaveLength(16);
    });

    it('virada de ano: 31/12 23:59:59 é dezembro de 2026; 01/01 00:00 já é 2027', async () => {
      const input = { period: 'custom', start: '2026-12-01', end: '2026-12-31' };
      const [k, s] = await adminCtx(A, async () => [await summary(A1(), input), await series(A1(), input)] as const);
      expect(k.kpis.revenue.current).toBe(51); // 11 (01/12 00:00) + 40 (31/12 23:59:59); 33 e 60 ficam fora
      expect(k.kpis.sales.current).toBe(2);
      expect(s.points).toHaveLength(31);
      expect(s.points.find((p) => p.key === '2026-12-31')).toMatchObject({ revenue: 40 });
      expect(s.points.find((p) => p.key === '2026-12-01')).toMatchObject({ revenue: 11 });
    });

    it('período longo agrupa por mês de Brasília (a venda de 30/09 23:59:59 é de setembro)', async () => {
      const s = await adminCtx(A, () => series(A1(), { period: 'custom', start: '2026-08-01', end: '2026-10-31' }));
      expect(s.granularity).toBe('month');
      expect(s.points.map((p) => p.key)).toEqual(['2026-08', '2026-09', '2026-10']);
      const rev = (key: string) => s.points.find((p) => p.key === key)!.revenue;
      expect(rev('2026-08')).toBe(999); // 01/09 02:59:59Z = 31/08 em Brasília
      expect(rev('2026-09')).toBe(80 + 20 + 777 + 100); // inclui a venda de 30/09 23:59:59 (01/10 02:59:59Z)
      expect(rev('2026-10')).toBe(620);
    });
  });

  describe('operação no mesmo resumo (sem chamadas extras), com a mesma regra dos painéis antigos e o gate de módulo', () => {
    it('contas vencidas e OS em aberto/atrasadas iguais às dos painéis /financial e /workshop', async () => {
      const ops = (await adminCtx(A, () => summary(A1(), { period: '30d' }, new Date()))).operations;
      expect(ops).toEqual({ payablesOverdue: 120, receivablesOverdue: 80, openOrders: 1, overdueOrders: 1 });
      const fin = await request(app).get('/dashboard/financial').set(as(A, 'COMPANY_ADMIN'));
      const ws = await request(app).get('/dashboard/workshop').set(as(A, 'COMPANY_ADMIN'));
      expect(fin.body.payables.overdue).toBe(ops.payablesOverdue);
      expect(fin.body.receivables.overdue).toBe(ops.receivablesOverdue);
      expect(ws.body.overdueCount).toBe(ops.overdueOrders);
      expect(ws.body.openByStatus.reduce((a: number, s: any) => a + s.count, 0)).toBe(ops.openOrders);
    });

    it('módulo Financeiro ou Oficina desligado: o número não é entregue (nulo), e o outro segue', async () => {
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'FINANCEIRO', isEnabled: false, actorId: A.userId, reason: 'teste' }));
      const off = (await adminCtx(A, () => summary(A1(), { period: '30d' }, new Date()))).operations;
      expect(off).toEqual({ payablesOverdue: null, receivablesOverdue: null, openOrders: 1, overdueOrders: 1 });
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'FINANCEIRO', isEnabled: true, actorId: A.userId }));
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'OFICINA', isEnabled: false, actorId: A.userId, reason: 'teste' }));
      const ws = (await adminCtx(A, () => summary(A1(), { period: '30d' }, new Date()))).operations;
      expect(ws).toMatchObject({ payablesOverdue: 120, openOrders: null, overdueOrders: null });
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'OFICINA', isEnabled: true, actorId: A.userId }));
    });

    it('a filial B2 (outra) não vê as contas e a OS da filial A1 (RLS)', async () => {
      const seen = await managerCtx(A, branchA2, () => summary({ companyId: A.companyId, branchId: null }, { period: '30d' }, new Date()));
      expect(seen.operations).toEqual({ payablesOverdue: 0, receivablesOverdue: 0, openOrders: 0, overdueOrders: 0 });
    });
  });

  describe('segurança: empresa, filial (RLS) e perfil', () => {
    it('administrador vê a empresa toda; com branchId vê só a filial; gerente SEMPRE só a própria (pedir outra é 403)', async () => {
      const range = 'period=custom&start=2026-10-01&end=2026-10-15';
      const admin = await request(app).get(`/dashboard/management/summary?${range}`).set(as(A, 'COMPANY_ADMIN'));
      expect(admin.status).toBe(200);
      expect(admin.body.kpis.revenue.current).toBe(1620);
      expect(admin.body.byBranch.map((b: any) => b.revenue)).toEqual([1000, 620]);
      const onlyA2 = await request(app).get(`/dashboard/management/summary?${range}&branchId=${branchA2}`).set(as(A, 'COMPANY_ADMIN'));
      expect(onlyA2.body.kpis.revenue.current).toBe(1000);
      // gerente pedindo OUTRA filial: recusado (403 BRANCH_FORBIDDEN, regra de acesso por filial de 2026-10-15) — antes devolvia a própria filial em silêncio
      const forbidden = await request(app).get(`/dashboard/management/summary?${range}&branchId=${branchA2}`).set(as(A, 'MANAGER'));
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('BRANCH_FORBIDDEN');
      const manager = await request(app).get(`/dashboard/management/summary?${range}`).set(as(A, 'MANAGER'));
      expect(manager.status).toBe(200);
      expect(manager.body.kpis.revenue.current).toBe(620);
      expect(manager.body.byBranch).toHaveLength(1);
      expect(manager.body.cash.divergentClosings).toBe(0); // o fechamento divergente é da filial A2
      expect(admin.body.cash).toMatchObject({ divergentClosings: 1, forcedClosings: 1, differenceSum: -10 });
    });

    it('a RLS isola mesmo sem o filtro da consulta: gerente da filial A1 com escopo "empresa toda" só enxerga a A1; empresa B não enxerga A', async () => {
      const viaRls = await managerCtx(A, A.branchId, () => summary(ALL(), { period: 'month' }));
      expect(viaRls.kpis.revenue.current).toBe(620);
      const otherCompany = await adminCtx(B, () => summary({ companyId: B.companyId, branchId: null }, { period: 'month' }));
      expect(otherCompany.kpis.revenue.current).toBe(5000); // o contexto de B só vê B
      const crossing = await adminCtx(B, () => summary({ companyId: A.companyId, branchId: null }, { period: 'month' }));
      expect(crossing.kpis.revenue.current).toBe(0); // pedir a empresa A dentro do contexto de B não devolve nada
      expect(crossing.origins.items[0].revenue).toBe(0);
    });

    it('perfis: só ADM e GER entram nos dashboards de gestão; OPERATOR, VIEWER e MECHANIC recebem 403 (inclusive /sales, /stock e /ceo)', async () => {
      const paths = ['/dashboard/management/summary', '/dashboard/management/timeseries', '/dashboard/sales', '/dashboard/stock', '/dashboard/ceo'];
      for (const path of paths) {
        for (const t of ['COMPANY_ADMIN', 'MANAGER']) expect((await request(app).get(path).set(as(A, t))).status).toBe(200);
        for (const t of ['OPERATOR', 'VIEWER', 'MECHANIC']) expect({ path, t, status: (await request(app).get(path).set(as(A, t))).status }).toEqual({ path, t, status: 403 });
      }
    });

    it('o que o operador e o mecânico precisam continua aberto: PDV do dia (operador, visualizador) e oficina (mecânico)', async () => {
      expect((await request(app).get('/dashboard/pdv').set(as(A, 'OPERATOR'))).status).toBe(200);
      expect((await request(app).get('/dashboard/pdv').set(as(A, 'VIEWER'))).status).toBe(200);
      expect((await request(app).get('/dashboard/pdv').set(as(A, 'MECHANIC'))).status).toBe(403);
      expect((await request(app).get('/dashboard/workshop').set(as(A, 'MECHANIC'))).status).toBe(200);
    });

    it('entradas inválidas: período, datas e filial', async () => {
      const bad = async (qs: string) => request(app).get(`/dashboard/management/summary?${qs}`).set(as(A, 'COMPANY_ADMIN'));
      expect((await bad('period=semana')).status).toBe(400);
      expect((await bad('period=custom&start=2026-02-30&end=2026-03-01')).status).toBe(400);
      expect((await bad('period=custom&start=2026-03-02&end=2026-03-01')).status).toBe(400);
      expect((await bad('period=custom&start=2024-01-01&end=2026-03-01')).status).toBe(400);
      expect((await bad('period=custom&start=2026-01-01')).status).toBe(400);
      const invalidBranch = await bad('branchId=nao-e-uuid');
      expect(invalidBranch.status).toBe(400);
      expect((await bad('')).body.period.preset).toBe('30d'); // sem nada: últimos 30 dias
    });

    it('os painéis antigos aceitam o MESMO período (period=...) que o gerencial', async () => {
      const r = await request(app).get('/dashboard/sales?period=custom&start=2026-10-01&end=2026-10-15').set(as(A, 'COMPANY_ADMIN'));
      expect(r.status).toBe(200);
      expect(r.body.totalRevenue).toBe(1620);
      expect(r.body.totalSales).toBe(5);
    });
  });
});
