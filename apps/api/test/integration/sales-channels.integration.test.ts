import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import salesChannelsRoutes from '../../src/routes/sales-channels.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import moduleSettingsService from '../../src/services/module-settings.service';
import salesChannelService from '../../src/services/sales-channels/sales-channel.service';
import { ingestExternalEvent } from '../../src/services/sales-channels/external-order.service';
import { providerRegistry } from '../../src/services/sales-channels/gateway';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Canais de venda — prova REAL (HTTP + Postgres + RLS + JWT): módulo CANAIS nasce desativado, canal sem conexão falsa,
 * credencial só cifrada, tipo imutável, pedido externo idempotente e SEM venda/pagamento/estoque, isolamento por empresa e filial.
 * Nenhum provedor real: onde um provedor é preciso, o teste registra um duplo de teste (e o remove).
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

// Leituras diretas sob FORCE RLS exigem o contexto de Super Admin na MESMA transação (senão voltam vazias).
const find = (model: string, where: any) => bypass<any>(() => (prismaUnsafeBypassRLS as any)[model].findFirst({ where }));
const count = (model: string, where: any) => bypass<number>(() => (prismaUnsafeBypassRLS as any)[model].count({ where }));

const SECRET = 'segredo-super-secreto-9876543210';
const db = prismaUnsafeBypassRLS;

describe('Canais de venda — integração real', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let branchA2: string;
  let app: express.Express;

  const token = (fx: IntegrationFixture, userType: string, branchId: string | null = null) =>
    generateAccessToken({ userId: fx.userId, email: `${userType.toLowerCase()}@test.local`, companyId: fx.companyId, branchId: (branchId ?? undefined) as any, userType });
  const as = (fx: IntegrationFixture, userType: string) => ({ Authorization: `Bearer ${token(fx, userType, userType === 'COMPANY_ADMIN' ? null : fx.branchId)}` });
  const adminCtx = <T>(fx: IntegrationFixture, fn: () => Promise<T>) => runWithRLSContext({ companyId: fx.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

  const enable = (fx: IntegrationFixture) =>
    adminCtx(fx, () => moduleSettingsService.setEnabled({ companyId: fx.companyId, module: 'CANAIS', isEnabled: true, actorId: fx.userId }));
  const counts = async (fx: IntegrationFixture) => [await count('sale', { companyId: fx.companyId }), await count('payment', { companyId: fx.companyId }), await count('stockMovement', { companyId: fx.companyId })];

  beforeAll(async () => {
    [A, B] = await Promise.all([createFixture('chanA'), createFixture('chanB')]);
    const b2 = await bypass<{ id: string }>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial A2', isHeadquarter: false, isActive: true } }));
    branchA2 = b2.id;
    app = express();
    app.use(express.json());
    app.use('/sales-channels', salesChannelsRoutes);
    app.use(errorHandler);
  }, 40000);

  afterAll(async () => {
    providerRegistry.clear();
    await bypass(() => db.channelEvent.deleteMany({ where: { companyId: { in: [A.companyId, B.companyId] } } }));
    await bypass(() => db.channelInboundEvent.deleteMany({ where: { companyId: { in: [A.companyId, B.companyId] } } }));
    await bypass(() => db.externalOrder.deleteMany({ where: { companyId: { in: [A.companyId, B.companyId] } } }));
    await bypass(() => db.salesChannel.deleteMany({ where: { companyId: { in: [A.companyId, B.companyId] } } }));
    await bypass(() => db.branch.delete({ where: { id: branchA2 } }));
    await Promise.all([destroyFixture(A), destroyFixture(B)]);
  }, 40000);

  describe('módulo CANAIS nasce desativado', () => {
    it('sem nenhuma configuração está desligado (único módulo opt-in) e os demais seguem ligados', async () => {
      expect(await adminCtx(A, () => moduleSettingsService.isModuleEnabled(A.companyId, A.branchId, 'CANAIS'))).toBe(false);
      expect(await adminCtx(A, () => moduleSettingsService.isModuleEnabled(A.companyId, A.branchId, 'FISCAL'))).toBe(true);
      const listed = await adminCtx(A, () => moduleSettingsService.listEffective(A.companyId));
      expect(listed.find((m) => m.module === 'CANAIS')).toMatchObject({ isEnabled: false, source: 'DEFAULT' });
    });

    it('desligado: toda rota de canais responde 403 MODULE_DISABLED, nem para o administrador', async () => {
      const res = await request(app).get('/sales-channels').set(as(A, 'COMPANY_ADMIN'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MODULE_DISABLED');
      expect((await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'OUTRO', displayName: 'Teste' })).status).toBe(403);
    });

    it('ligar o módulo da empresa A não liga o da empresa B', async () => {
      await enable(A);
      expect(await adminCtx(A, () => moduleSettingsService.isModuleEnabled(A.companyId, A.branchId, 'CANAIS'))).toBe(true);
      expect(await adminCtx(B, () => moduleSettingsService.isModuleEnabled(B.companyId, B.branchId, 'CANAIS'))).toBe(false);
      expect((await request(app).get('/sales-channels').set(as(B, 'COMPANY_ADMIN'))).status).toBe(403);
    });
  });

  describe('administração do canal (módulo ligado)', () => {
    let ifoodLike: string;
    let manual: string;

    it('só administrador da empresa acessa: gerente, operador e visualizador recebem 403', async () => {
      for (const t of ['MANAGER', 'OPERATOR', 'VIEWER', 'MECHANIC']) {
        expect((await request(app).get('/sales-channels').set(as(A, t))).status).toBe(403);
      }
      expect((await request(app).get('/sales-channels').set(as(A, 'COMPANY_ADMIN'))).status).toBe(200);
    });

    it('cria canal desativado, sem conexão e sem credencial; o tipo vira identificador estável', async () => {
      const res = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'IFOOD', displayName: 'Delivery' });
      expect(res.status).toBe(201);
      ifoodLike = res.body.id;
      expect(res.body).toMatchObject({ type: 'IFOOD', displayName: 'Delivery', isActive: false, connectionStatus: 'NOT_CONFIGURED', hasCredentials: false, provider: 'ifood' });
      expect(res.body).not.toHaveProperty('credentialsEncrypted');
      const m = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'OUTRO', displayName: 'Vendas por WhatsApp' });
      manual = m.body.id;
      expect(m.body.provider).toBeNull();
    });

    it('recusa nome duplicado do mesmo tipo e filial de outra empresa', async () => {
      const dup = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'IFOOD', displayName: 'delivery' });
      expect(dup.status).toBe(409);
      const foreign = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'OUTRO', displayName: 'Outra', branchId: '00000000-0000-4000-8000-000000000000' });
      expect(foreign.status).toBe(404);
    });

    it('nome exibido é configurável; o tipo técnico NÃO muda (campo recusado)', async () => {
      const renamed = await request(app).patch(`/sales-channels/${ifoodLike}`).set(as(A, 'COMPANY_ADMIN')).send({ displayName: 'Vendas Online' });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ displayName: 'Vendas Online', type: 'IFOOD' });
      const retype = await request(app).patch(`/sales-channels/${ifoodLike}`).set(as(A, 'COMPANY_ADMIN')).send({ type: 'SITE_PROPRIO' });
      expect(retype.status).toBe(400);
      expect((await find('salesChannel', { id: ifoodLike }))!.type).toBe('IFOOD');
    });

    it('canal com integração NÃO ativa sem conexão validada; canal sem integração (origem manual) ativa', async () => {
      const blocked = await request(app).patch(`/sales-channels/${ifoodLike}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: true });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CHANNEL_NOT_VALIDATED');
      const ok = await request(app).patch(`/sales-channels/${manual}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: true });
      expect(ok.status).toBe(200);
      expect(ok.body.isActive).toBe(true);
    });

    it('credencial: gravada só cifrada, nunca devolvida, e o canal passa a "não validado"', async () => {
      const res = await request(app).put(`/sales-channels/${ifoodLike}/credentials`).set(as(A, 'COMPANY_ADMIN')).send({ credentials: { clientId: 'cli-123', clientSecret: SECRET } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hasCredentials: true, connectionStatus: 'UNVALIDATED' });
      expect(res.body.credentialsHint).toBe('••••3210');
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      const row = await find('salesChannel', { id: ifoodLike });
      expect(row!.credentialsEncrypted).toMatch(/^enc:v1:/);
      expect(row!.credentialsEncrypted).not.toContain(SECRET);
      const events = await request(app).get(`/sales-channels/${ifoodLike}/events`).set(as(A, 'COMPANY_ADMIN'));
      expect(JSON.stringify(events.body)).not.toContain(SECRET);
      const bad = await request(app).put(`/sales-channels/${ifoodLike}/credentials`).set(as(A, 'COMPANY_ADMIN')).send({ credentials: { 'campo inválido': 'x' } });
      expect(bad.status).toBe(400);
    });

    it('teste de conexão sem provedor instalado: NÃO conecta, não chama nada, registra o motivo', async () => {
      const res = await request(app).post(`/sales-channels/${ifoodLike}/test-connection`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, reason: 'NO_PROVIDER' });
      expect(res.body.channel.connectionStatus).toBe('UNVALIDATED');
      const ev = await find('channelEvent', { channelId: ifoodLike, type: 'CONNECTION_TEST' });
      expect(ev).toMatchObject({ level: 'WARN' });
    });

    it('com um provedor (duplo de teste): falha → ERROR e desativado; sucesso → CONNECTED e aí pode ativar; troca de credencial exige novo teste', async () => {
      let received: Record<string, string> | null = null;
      providerRegistry.register({
        key: 'ifood',
        testConnection: async (ctx) => {
          received = ctx.credentials;
          if (ctx.credentials?.clientSecret === 'ruim') throw new Error('401 token=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
          return { ok: true, message: 'ok' };
        },
      });
      await request(app).put(`/sales-channels/${ifoodLike}/credentials`).set(as(A, 'COMPANY_ADMIN')).send({ credentials: { clientSecret: 'ruim' } });
      const failed = await request(app).post(`/sales-channels/${ifoodLike}/test-connection`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(failed.body).toMatchObject({ ok: false, reason: 'PROVIDER_ERROR' });
      expect(failed.body.channel).toMatchObject({ connectionStatus: 'ERROR', isActive: false });
      expect(failed.body.message).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');

      await request(app).put(`/sales-channels/${ifoodLike}/credentials`).set(as(A, 'COMPANY_ADMIN')).send({ credentials: { clientSecret: SECRET } });
      const good = await request(app).post(`/sales-channels/${ifoodLike}/test-connection`).set(as(A, 'COMPANY_ADMIN')).send({});
      expect(good.body).toMatchObject({ ok: true, reason: 'OK' });
      expect(received).toEqual({ clientSecret: SECRET }); // o provedor recebe a credencial aberta, só em memória
      expect(good.body.channel.connectionStatus).toBe('CONNECTED');
      const active = await request(app).patch(`/sales-channels/${ifoodLike}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: true });
      expect(active.status).toBe(200);
      const changed = await request(app).put(`/sales-channels/${ifoodLike}/credentials`).set(as(A, 'COMPANY_ADMIN')).send({ credentials: { clientSecret: 'nova-credencial-1' } });
      expect(changed.body).toMatchObject({ connectionStatus: 'UNVALIDATED', isActive: false });
      providerRegistry.clear();
    });

    it('a loja física existe sempre: o registro só personaliza o nome e não desativa', async () => {
      const store = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'LOJA_FISICA', displayName: 'Loja Centro' });
      expect(store.body).toMatchObject({ isActive: true, provider: null });
      const off = await request(app).patch(`/sales-channels/${store.body.id}`).set(as(A, 'COMPANY_ADMIN')).send({ isActive: false });
      expect(off.status).toBe(409);
    });
  });

  describe('isolamento por empresa e filial (RLS)', () => {
    it('a empresa B não enxerga nem altera canal da empresa A', async () => {
      await enable(B);
      const mine = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'MARKETPLACE', displayName: 'Mercado A' });
      const listB = await request(app).get('/sales-channels').set(as(B, 'COMPANY_ADMIN'));
      expect(listB.status).toBe(200);
      expect(listB.body.data.find((c: any) => c.id === mine.body.id)).toBeUndefined();
      expect((await request(app).get(`/sales-channels/${mine.body.id}`).set(as(B, 'COMPANY_ADMIN'))).status).toBe(404);
      expect((await request(app).patch(`/sales-channels/${mine.body.id}`).set(as(B, 'COMPANY_ADMIN')).send({ displayName: 'Invadido' })).status).toBe(404);
      expect((await find('salesChannel', { id: mine.body.id }))!.displayName).toBe('Mercado A');
    });

    it('canal de UMA filial não aparece para usuário de outra filial; canal da empresa inteira aparece para todos', async () => {
      const own = await request(app).post('/sales-channels').set(as(A, 'COMPANY_ADMIN')).send({ type: 'OUTRO', displayName: 'Só filial 2', branchId: branchA2 });
      expect(own.status).toBe(201);
      const seenFromBranch1 = await runWithRLSContext({ companyId: A.companyId, userType: 'MANAGER', branchId: A.branchId }, () => salesChannelService.list(A.companyId));
      expect(seenFromBranch1.find((c) => c.id === own.body.id)).toBeUndefined();
      expect(seenFromBranch1.find((c) => c.branchId === null)).toBeDefined();
      const seenFromBranch2 = await runWithRLSContext({ companyId: A.companyId, userType: 'MANAGER', branchId: branchA2 }, () => salesChannelService.list(A.companyId));
      expect(seenFromBranch2.find((c) => c.id === own.body.id)).toBeDefined();
    });
  });

  describe('pedido externo: idempotente e SEM venda, pagamento ou baixa de estoque', () => {
    let channelId: string;
    const payload = { items: [{ sku: 'SKU-1', name: 'Pastilha', quantity: 2, unitPrice: 35.5 }], total: 71 };
    const ingest = (over: Record<string, unknown>) =>
      adminCtx(A, () => ingestExternalEvent({ companyId: A.companyId, channelId, externalEventId: 'EV-1', operation: 'ORDER_CREATED', externalOrderId: 'PED-1', payload, ...over } as any));

    beforeAll(async () => {
      const c = await adminCtx(A, () => salesChannelService.create({ companyId: A.companyId, type: 'OUTRO', displayName: 'Canal de pedidos', actorId: A.userId }));
      await adminCtx(A, () => salesChannelService.update({ companyId: A.companyId, id: c.id, actorId: A.userId, isActive: true }));
      channelId = c.id;
    });

    it('recebe o pedido sem criar venda, pagamento nem movimento de estoque', async () => {
      const before = await counts(A);
      const r = await ingest({});
      expect(r.outcome).toBe('CREATED');
      expect(await counts(A)).toEqual(before);
      const order = await find('externalOrder', { channelId, externalOrderId: 'PED-1' });
      expect(order).toMatchObject({ status: 'RECEIVED', paymentStatus: 'UNKNOWN', saleId: null });
    });

    it('o MESMO evento recebido de novo não faz nada; o mesmo pedido em outro evento não duplica', async () => {
      expect((await ingest({})).outcome).toBe('DUPLICATE');
      expect((await ingest({ externalEventId: 'EV-2' })).outcome).toBe('IGNORED');
      expect(await count('externalOrder', { channelId, externalOrderId: 'PED-1' })).toBe(1);
      expect(await count('channelInboundEvent', { channelId, externalEventId: 'EV-1' })).toBe(1);
    });

    it('evento duplicado enviado ao mesmo tempo cria uma única vez', async () => {
      const results = await Promise.all([1, 2, 3].map(() => ingest({ externalEventId: 'EV-RACE', externalOrderId: 'PED-RACE' })));
      expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'DUPLICATE')).toHaveLength(2);
      expect(await count('externalOrder', { channelId, externalOrderId: 'PED-RACE' })).toBe(1);
    });

    it('pagamento do canal só atualiza o estado do pedido (nunca cria pagamento) e REFUNDED é final', async () => {
      expect((await ingest({ externalEventId: 'EV-P1', operation: 'PAYMENT_UPDATED', paymentStatus: 'PENDING' })).outcome).toBe('UPDATED');
      expect((await ingest({ externalEventId: 'EV-P2', operation: 'PAYMENT_UPDATED', paymentStatus: 'CONFIRMED' })).outcome).toBe('UPDATED');
      expect((await ingest({ externalEventId: 'EV-P3', operation: 'PAYMENT_UPDATED', paymentStatus: 'REFUNDED' })).outcome).toBe('UPDATED');
      expect((await ingest({ externalEventId: 'EV-P4', operation: 'PAYMENT_UPDATED', paymentStatus: 'CONFIRMED' })).outcome).toBe('IGNORED');
      const [sales, payments] = await counts(A);
      expect(payments).toBe(0);
      expect(sales).toBe(0);
    });

    it('cancelamento: cancela o pedido; se o pedido já virou venda, NÃO cancela a venda e pede revisão', async () => {
      expect((await ingest({ externalEventId: 'EV-C1', operation: 'ORDER_CANCELLED' })).outcome).toBe('UPDATED');
      expect((await ingest({ externalEventId: 'EV-C2', operation: 'ORDER_CANCELLED' })).outcome).toBe('IGNORED');
      await ingest({ externalEventId: 'EV-N1', externalOrderId: 'PED-2' });
      await bypass(() => db.externalOrder.updateMany({ where: { companyId: A.companyId, channelId, externalOrderId: 'PED-2' }, data: { status: 'CONVERTED' } }));
      const r = await ingest({ externalEventId: 'EV-N2', externalOrderId: 'PED-2', operation: 'ORDER_CANCELLED' });
      expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'ORDER_ALREADY_SALE' });
      expect((await find('externalOrder', { channelId, externalOrderId: 'PED-2' }))!.status).toBe('CONVERTED');
    });

    it('recusa: pedido desconhecido, corpo inválido (campo extra, total negativo, sem itens) e identificação vazia', async () => {
      expect(await ingest({ externalEventId: 'EV-X1', externalOrderId: 'NAO-EXISTE', operation: 'PAYMENT_UPDATED', paymentStatus: 'CONFIRMED' })).toMatchObject({ outcome: 'REJECTED', reason: 'ORDER_UNKNOWN' });
      // o evento rejeitado por pedido desconhecido pode ser reenviado depois: não ficou reivindicado
      expect(await count('channelInboundEvent', { channelId, externalEventId: 'EV-X1' })).toBe(0);
      let n = 0;
      for (const bad of [{ ...payload, cartao: '4111111111111111' }, { ...payload, total: -1 }, { items: [], total: 0 }, null]) {
        expect(await ingest({ externalEventId: `EV-BAD-${++n}`, externalOrderId: 'PED-BAD', payload: bad })).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_INPUT' });
      }
      expect(await ingest({ externalEventId: '', externalOrderId: 'PED-BAD' })).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_INPUT' });
      expect(await count('externalOrder', { channelId, externalOrderId: 'PED-BAD' })).toBe(0);
    });

    it('canal desativado, módulo desligado e canal de outra empresa: nada é processado', async () => {
      await adminCtx(A, () => salesChannelService.update({ companyId: A.companyId, id: channelId, actorId: A.userId, isActive: false }));
      expect(await ingest({ externalEventId: 'EV-OFF', externalOrderId: 'PED-OFF' })).toMatchObject({ outcome: 'REJECTED', reason: 'CHANNEL_INACTIVE' });
      await adminCtx(A, () => salesChannelService.update({ companyId: A.companyId, id: channelId, actorId: A.userId, isActive: true }));
      await adminCtx(A, () => moduleSettingsService.setEnabled({ companyId: A.companyId, module: 'CANAIS', isEnabled: false, actorId: A.userId }));
      expect(await ingest({ externalEventId: 'EV-MOD', externalOrderId: 'PED-MOD' })).toMatchObject({ outcome: 'REJECTED', reason: 'MODULE_DISABLED' });
      await enable(A);
      const foreign = await runWithRLSContext({ companyId: B.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        ingestExternalEvent({ companyId: B.companyId, channelId, externalEventId: 'EV-F', operation: 'ORDER_CREATED', externalOrderId: 'PED-F', payload } as any)
      );
      expect(foreign).toMatchObject({ outcome: 'REJECTED', reason: 'CHANNEL_NOT_FOUND' });
      expect(await count('externalOrder', { externalOrderId: { in: ['PED-OFF', 'PED-MOD', 'PED-F'] } })).toBe(0);
    });
  });
});
