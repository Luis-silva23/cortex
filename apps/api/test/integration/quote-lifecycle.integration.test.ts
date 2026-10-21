import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import quoteService from '../../src/services/quote.service';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Orçamento: ORÇAMENTO → AGUARDANDO APROVAÇÃO → APROVADO → OS, com encerramento em lote dos vencidos (sem resposta há
 * `quote.expirationDays` dias), reabertura, orçamentos existentes para o mesmo veículo, bloqueio de duplicado e a rotina
 * de expiração automática. Banco real (RLS), pela API. docs/CORTEX/policies/ORCAMENTO.md.
 */
describe('Orçamento: vencidos, encerramento em lote, reabertura e duplicidade (integração real)', () => {
  let fx: IntegrationFixture;
  let other: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  let viewerToken: string;
  let otherToken: string;
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const DAY = 86_400_000;
  const item = { itemType: 'SERVICE', description: 'Revisão completa', quantity: 1, unitPrice: 250 };

  const newMoto = async (f: IntegrationFixture = fx) =>
    (await bypass<any>(() => db.motorcycle.create({ data: { companyId: f.companyId, customerId: f.customerId, brand: 'Yamaha', model: 'Fazer 250', kilometerReading: 5000, isActive: true } }))).id as string;
  const create = (motorcycleId: string, extra: object = {}, t = token, f: IntegrationFixture = fx) =>
    request(app).post('/api/quotes').set(auth(t)).send({ branchId: f.branchId, customerId: f.customerId, motorcycleId, items: [item], ...extra });
  const send = (id: string) => request(app).post(`/api/quotes/${id}/send`).set(auth()).send({ versionNumber: 1 });
  const close = (ids: string[], reason = 'Cliente não respondeu no prazo', t = token) => request(app).post('/api/quotes/close').set(auth(t)).send({ ids, reason });
  const reopen = (id: string, reason = 'Cliente voltou com a moto') => request(app).post(`/api/quotes/${id}/reopen`).set(auth()).send({ reason });
  const quoteRow = (id: string) => bypass<any>(() => db.quote.findUnique({ where: { id } }));
  const events = (id: string) => bypass<any[]>(() => db.quoteEvent.findMany({ where: { quoteId: id }, orderBy: { createdAt: 'asc' } }));
  /** Simula o envio há N dias (o prazo conta do envio da versão vigente). */
  const sentDaysAgo = (id: string, days: number) => bypass(() => db.quoteVersion.updateMany({ where: { quoteId: id }, data: { sentAt: new Date(Date.now() - days * DAY) } }));
  const setPolicy = (key: string, value: unknown, f: IntegrationFixture = fx) =>
    bypass(() => db.policySetting.create({ data: { companyId: f.companyId, branchId: null, key, value: value as any } }));
  const clearPolicy = (key: string, f: IntegrationFixture = fx) => bypass(() => db.policySetting.deleteMany({ where: { companyId: f.companyId, key } }));
  const sentOverdueQuote = async () => {
    const q = (await create(await newMoto())).body;
    expect((await send(q.id)).status).toBe(200);
    await sentDaysAgo(q.id, 6); // padrão: 5 dias
    return q.id as string;
  };

  beforeAll(async () => {
    fx = await createFixture('quote-life');
    other = await createFixture('quote-life-other');
    token = generateAccessToken({ userId: fx.userId, email: 'q@test.local', companyId: fx.companyId, branchId: fx.branchId, userType: 'OPERATOR' });
    viewerToken = generateAccessToken({ userId: fx.userId, email: 'v@test.local', companyId: fx.companyId, branchId: fx.branchId, userType: 'VIEWER' });
    otherToken = generateAccessToken({ userId: other.userId, email: 'o@test.local', companyId: other.companyId, branchId: other.branchId, userType: 'OPERATOR' });
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    for (const f of [fx, other]) {
      if (!f) continue;
      // OS nascidas da conversão, orçamentos e históricos saem no destroyFixture (expurgo por empresa guiado pelas FKs).
      await destroyFixture(f);
    }
  });

  it('novo orçamento para veículo com orçamento em aberto: 409 OPEN_QUOTE_EXISTS com o existente; com confirmNew cria', async () => {
    const moto = await newMoto();
    const first = await create(moto);
    expect(first.status).toBe(201);
    const dup = await create(moto);
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'OPEN_QUOTE_EXISTS', existingQuoteId: first.body.id, existingQuoteNumber: first.body.quoteNumber });
    expect(dup.body.error).toMatch(/Já existe um orçamento em aberto para este veículo/);
    // "true" em texto não confirma
    expect((await create(moto, { confirmNew: 'true' })).status).toBe(409);
    expect((await create(moto, { confirmNew: true })).status).toBe(201);
  });

  it('duas criações simultâneas para o mesmo veículo: só uma passa', async () => {
    const moto = await newMoto();
    const results = await Promise.all([create(moto), create(moto), create(moto)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const open = await bypass<any[]>(() => db.quote.findMany({ where: { companyId: fx.companyId, motorcycleId: moto } }));
    expect(open).toHaveLength(1);
  });

  it('lista marca e filtra os vencidos (SENT sem resposta há ≥ 5 dias); rascunho e enviado recente não são vencidos', async () => {
    const overdue = await sentOverdueQuote();
    const recent = (await create(await newMoto())).body.id;
    await send(recent);
    const draft = (await create(await newMoto())).body.id;

    const all = await request(app).get('/api/quotes').set(auth()).query({ limit: 100 });
    const byId = new Map(all.body.quotes.map((q: any) => [q.id, q]));
    expect(byId.get(overdue)).toMatchObject({ overdue: true, daysWithoutResponse: 6 });
    expect(byId.get(recent)).toMatchObject({ overdue: false });
    expect(byId.get(draft)).toMatchObject({ overdue: false, respondBy: null });

    const onlyOverdue = await request(app).get('/api/quotes').set(auth()).query({ overdue: 'true', limit: 100 });
    const ids = onlyOverdue.body.quotes.map((q: any) => q.id);
    expect(ids).toContain(overdue);
    expect(ids).not.toContain(recent);
    expect(ids).not.toContain(draft);
  });

  it('encerrar em lote: resultado por item (encerrado / já encerrado / não permitido / não encontrado), evento CLOSED e auditoria', async () => {
    const overdue = await sentOverdueQuote();
    const draft = (await create(await newMoto())).body.id;
    const recent = (await create(await newMoto())).body.id;
    await send(recent);
    const approved = (await create(await newMoto())).body.id;
    await send(approved);
    await request(app).post(`/api/quotes/${approved}/decide`).set(auth()).send({ versionNumber: 1, approved: true });
    const foreign = (await create(await newMoto(other), {}, otherToken, other)).body.id; // outra empresa

    auditSpy.mockClear();
    const res = await close([overdue, draft, recent, approved, foreign, 'nao-existe']);
    expect(res.status).toBe(200);
    const outcome = Object.fromEntries(res.body.results.map((r: any) => [r.id, r.outcome]));
    expect(outcome).toEqual({ [overdue]: 'CLOSED', [draft]: 'CLOSED', [recent]: 'NOT_ALLOWED', [approved]: 'NOT_ALLOWED', [foreign]: 'NOT_FOUND', 'nao-existe': 'NOT_FOUND' });
    expect(res.body.summary).toEqual({ closed: 2, alreadyClosed: 0, notAllowed: 2, notFound: 2 });
    expect(res.body.results.find((r: any) => r.id === recent).message).toMatch(/prazo de resposta/);

    const row = await quoteRow(overdue);
    expect(row).toMatchObject({ status: 'EXPIRED', closedBy: fx.userId, closeReason: 'Cliente não respondeu no prazo' });
    expect(row.closedAt).not.toBeNull();
    expect(await events(overdue)).toEqual([expect.objectContaining({ eventType: 'CLOSED', fromStatus: 'SENT', toStatus: 'EXPIRED', performedBy: fx.userId, companyId: fx.companyId, branchId: fx.branchId })]);
    expect((await events(draft))[0]).toMatchObject({ eventType: 'CLOSED', fromStatus: 'DRAFT' });
    expect((await quoteRow(recent)).status).toBe('SENT');
    expect((await quoteRow(approved)).status).toBe('APPROVED');
    expect((await quoteRow(foreign)).status).toBe('DRAFT'); // RLS: outra empresa intocada

    const audit = auditSpy.mock.calls.find((c) => c[0] === 'audit-log');
    expect(audit?.[1]).toMatchObject({ action: 'UPDATE', entity: 'Quote', companyId: fx.companyId, userId: fx.userId });
    expect(JSON.parse(audit![1].newValue)).toMatchObject({ action: 'CLOSE_QUOTES', reason: 'Cliente não respondeu no prazo', summary: { closed: 2 } });

    // repetir não gera outro evento
    const again = await close([overdue]);
    expect(again.body.results[0].outcome).toBe('ALREADY_CLOSED');
    expect(await events(overdue)).toHaveLength(1);
  });

  it('dois encerramentos simultâneos do mesmo orçamento: um único evento', async () => {
    const id = await sentOverdueQuote();
    const [a, b] = await Promise.all([close([id]), close([id])]);
    const outcomes = [a.body.results[0].outcome, b.body.results[0].outcome].sort();
    expect(outcomes).toEqual(['ALREADY_CLOSED', 'CLOSED']);
    expect(await events(id)).toHaveLength(1);
  });

  it('entrada inválida e permissão: sem motivo 400, sem ids 400, VIEWER 403', async () => {
    const id = await sentOverdueQuote();
    expect((await close([id], '')).status).toBe(400);
    expect((await close([id], '')).body.code).toBe('REASON_REQUIRED');
    expect((await request(app).post('/api/quotes/close').set(auth()).send({ ids: [], reason: 'motivo válido' })).body.code).toBe('QUOTE_IDS_REQUIRED');
    expect((await close([id], 'Cliente sumiu', viewerToken)).status).toBe(403);
    expect((await quoteRow(id)).status).toBe('SENT');
  });

  it('encerrado não volta por reenvio nem por decisão (409 QUOTE_CLOSED); reabrir → aguardando aprovação → aprovado → OS', async () => {
    const id = await sentOverdueQuote();
    await close([id]);
    const resend = await send(id);
    expect(resend.status).toBe(409);
    expect(resend.body.code).toBe('QUOTE_CLOSED');
    const decideClosed = await request(app).post(`/api/quotes/${id}/decide`).set(auth()).send({ versionNumber: 1, approved: true });
    expect(decideClosed.status).toBe(409);
    expect((await quoteRow(id)).status).toBe('EXPIRED');

    expect((await reopen(id, '')).status).toBe(400);
    const reopened = await reopen(id);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'SENT', overdue: false }); // prazo reinicia na reabertura
    const evs = await events(id);
    expect(evs.map((e) => e.eventType)).toEqual(['CLOSED', 'REOPENED']);
    expect(evs[1]).toMatchObject({ fromStatus: 'EXPIRED', toStatus: 'SENT', reason: 'Cliente voltou com a moto', performedBy: fx.userId });
    // o registro do encerramento anterior não é apagado
    expect((await quoteRow(id)).closeReason).toBe('Cliente não respondeu no prazo');

    // a rotina automática não expira de novo logo em seguida (prazo conta da reabertura)
    await setPolicy('quote.autoExpire', true);
    try {
      await quoteService.expireOverdue({ companyId: fx.companyId });
      expect((await quoteRow(id)).status).toBe('SENT');
    } finally {
      await clearPolicy('quote.autoExpire');
    }

    expect((await request(app).post(`/api/quotes/${id}/decide`).set(auth()).send({ versionNumber: 1, approved: true })).status).toBe(200);
    const os = await request(app).post(`/api/quotes/${id}/convert`).set(auth()).send({ branchId: fx.branchId, entryKilometer: 5100 });
    expect(os.status).toBe(201);
    expect((await quoteRow(id)).status).toBe('CONVERTED');
  });

  it('reabertura: política desligada 409; recusado não reabre (nova versão); outro aberto para o veículo 409 OPEN_QUOTE_EXISTS', async () => {
    const id = await sentOverdueQuote();
    await close([id]);
    await setPolicy('quote.allowReopen', false);
    try {
      const off = await reopen(id);
      expect(off.status).toBe(409);
      expect(off.body.code).toBe('QUOTE_REOPEN_DISABLED');
      expect((await request(app).get(`/api/quotes/${id}`).set(auth())).body.reopenAllowed).toBe(false);
    } finally {
      await clearPolicy('quote.allowReopen');
    }

    const moto = (await quoteRow(id)).motorcycleId;
    const newer = await create(moto); // o encerrado não conta como aberto
    expect(newer.status).toBe(201);
    const blocked = await reopen(id);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'OPEN_QUOTE_EXISTS', existingQuoteId: newer.body.id });
    expect((await quoteRow(id)).status).toBe('EXPIRED');

    const rejected = (await create(await newMoto())).body.id;
    await send(rejected);
    await request(app).post(`/api/quotes/${rejected}/decide`).set(auth()).send({ versionNumber: 1, approved: false });
    const r = await reopen(rejected);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('QUOTE_NOT_REOPENABLE');
    expect(r.body.error).toMatch(/nova versão/);
  });

  it('orçamentos existentes para o veículo: abertos e encerrados recentes, com "pode reabrir"', async () => {
    const moto = await newMoto();
    const closed = (await create(moto)).body.id;
    await send(closed);
    await sentDaysAgo(closed, 7);
    await close([closed]);
    const open = (await create(moto)).body.id;

    const res = await request(app).get('/api/quotes/related').set(auth()).query({ customerId: fx.customerId, motorcycleId: moto });
    expect(res.status).toBe(200);
    expect(res.body.open.map((q: any) => q.id)).toEqual([open]);
    expect(res.body.closed).toEqual([expect.objectContaining({ id: closed, status: 'EXPIRED', canReopen: true, closeReason: 'Cliente não respondeu no prazo' })]);
    expect((await request(app).get('/api/quotes/related').set(auth()).query({ customerId: fx.customerId })).status).toBe(400);
    // outra empresa não enxerga
    const foreign = await request(app).get('/api/quotes/related').set(auth(otherToken)).query({ customerId: fx.customerId, motorcycleId: moto });
    expect(foreign.body).toEqual({ open: [], closed: [] });
  });

  it('rotina automática: desligada não encerra nada; ligada encerra os vencidos com evento EXPIRED por SYSTEM', async () => {
    const overdue = await sentOverdueQuote();
    const recent = (await create(await newMoto())).body.id;
    await send(recent);

    expect((await quoteService.expireOverdue({ companyId: fx.companyId })).expired).toBe(0);
    expect((await quoteRow(overdue)).status).toBe('SENT');

    await setPolicy('quote.autoExpire', true);
    try {
      const result = await quoteService.expireOverdue({ companyId: fx.companyId });
      expect(result.expired).toBeGreaterThanOrEqual(1);
    } finally {
      await clearPolicy('quote.autoExpire');
    }
    expect(await quoteRow(overdue)).toMatchObject({ status: 'EXPIRED', closedBy: 'SYSTEM' });
    expect(await events(overdue)).toEqual([expect.objectContaining({ eventType: 'EXPIRED', fromStatus: 'SENT', toStatus: 'EXPIRED', performedBy: 'SYSTEM' })]);
    expect((await quoteRow(recent)).status).toBe('SENT');

    // prazo da política: com 10 dias, 6 dias sem resposta ainda não vence
    const notYet = await sentOverdueQuote();
    await setPolicy('quote.expirationDays', 10);
    try {
      const listed = await request(app).get(`/api/quotes/${notYet}`).set(auth());
      expect(listed.body).toMatchObject({ overdue: false, expirationDays: 10 });
      expect((await close([notYet])).body.results[0].outcome).toBe('NOT_ALLOWED');
    } finally {
      await clearPolicy('quote.expirationDays');
    }
  });
});
