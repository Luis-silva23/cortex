import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Agenda e pós-venda pela API, banco real. Regra: a loja PROPÕE; a confirmação definitiva é do CLIENTE/responsável
 * pelo veículo — o funcionário registra quem confirmou e por qual canal. Transições com guarda (concorrência),
 * pós-venda do mesmo cliente, pós-venda não fica preso após cancelar o agendamento, cancelar o pós-venda cancela o
 * agendamento ativo, "não compareceu" só depois do horário, mensagens em português.
 */
describe('Agenda: proposta, confirmação do cliente e consistência com o pós-venda (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  let otherCustomerId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const newFollowUp = async () =>
    (await request(app).post('/api/follow-ups').set(auth()).send({ customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, dueDate: inDays(10) })).body;
  const propose = (body: object) => request(app).post('/api/appointments').set(auth()).send({ customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, scheduledAt: inDays(3), ...body });
  const confirm = (id: string, body: object = { channel: 'PHONE', confirmedByName: 'Carlos, dono da moto' }) =>
    request(app).post(`/api/appointments/${id}/confirm`).set(auth()).send(body);
  const appointmentRow = (id: string) => bypass<any>(() => db.appointment.findUnique({ where: { id } }));
  const followUpRow = (id: string) => bypass<any>(() => db.followUp.findUnique({ where: { id } }));

  beforeAll(async () => {
    fixture = await createFixture('agenda');
    token = generateAccessToken({ userId: fixture.userId, email: 'agenda@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'MANAGER' });
    otherCustomerId = (await bypass<any>(() => db.customer.create({ data: { companyId: fixture.companyId, name: 'Outro cliente', isActive: true } }))).id;
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) await destroyFixture(fixture);
  });

  it('confirmação exige quem confirmou e o canal (mensagem em português); com eles grava a prova e o evento', async () => {
    const appt = (await propose({})).body;
    const missing = await confirm(appt.id, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/canal em que o cliente confirmou|quem confirmou/);
    expect((await appointmentRow(appt.id)).customerConfirmed).toBe(false);

    const ok = await confirm(appt.id);
    expect(ok.status).toBe(200);
    const row = await appointmentRow(appt.id);
    expect(row).toMatchObject({ status: 'CONFIRMED', customerConfirmed: true, confirmationChannel: 'PHONE', confirmedByName: 'Carlos, dono da moto' });
    expect(row.confirmedAt).not.toBeNull();
    const events = await bypass<any[]>(() => db.appointmentEvent.findMany({ where: { appointmentId: appt.id, eventType: 'CONFIRMED' } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ performedBy: fixture.userId });

    // confirmar de novo não reescreve a confirmação
    expect((await confirm(appt.id, { channel: 'SMS', confirmedByName: 'Outra pessoa' })).status).toBe(409);
    expect((await appointmentRow(appt.id)).confirmedByName).toBe('Carlos, dono da moto');
  });

  it('duas confirmações ao mesmo tempo: só uma vale (a outra 409), um único evento', async () => {
    const appt = (await propose({})).body;
    const results = await Promise.all([confirm(appt.id), confirm(appt.id, { channel: 'SMS', confirmedByName: 'Outra pessoa' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const events = await bypass<any[]>(() => db.appointmentEvent.findMany({ where: { appointmentId: appt.id, eventType: 'CONFIRMED' } }));
    expect(events).toHaveLength(1);
  });

  it('confirmar × cancelar ao mesmo tempo: termina cancelado e nunca há confirmação depois do cancelamento', async () => {
    const appt = (await propose({})).body;
    const [c, x] = await Promise.all([confirm(appt.id), request(app).post(`/api/appointments/${appt.id}/cancel`).set(auth()).send({ reason: 'cliente desistiu' })]);
    expect(x.status).toBe(200); // cancelar vale a partir de PROPOSTO ou CONFIRMADO
    expect([200, 409]).toContain(c.status); // confirmar só vale se chegou antes do cancelamento
    expect((await appointmentRow(appt.id)).status).toBe('CANCELLED');
    const events = await bypass<any[]>(() =>
      db.appointmentEvent.findMany({ where: { appointmentId: appt.id, eventType: { in: ['CONFIRMED', 'CANCELLED'] } }, orderBy: { createdAt: 'asc' } })
    );
    expect(events.map((e) => e.eventType)).toEqual(c.status === 200 ? ['CONFIRMED', 'CANCELLED'] : ['CANCELLED']);
  });

  it('agendamento ligado a pós-venda de OUTRO cliente é recusado', async () => {
    const fu = await newFollowUp();
    const res = await request(app).post('/api/appointments').set(auth()).send({ customerId: otherCustomerId, followUpId: fu.id, scheduledAt: inDays(2) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outro cliente/);
    expect((await followUpRow(fu.id)).status).toBe('PENDING');
  });

  it('cancelar o agendamento devolve o pós-venda e uma NOVA proposta é aceita (antes o pós-venda ficava preso)', async () => {
    const fu = await newFollowUp();
    const first = (await propose({ followUpId: fu.id })).body;
    expect((await followUpRow(fu.id)).status).toBe('SCHEDULED');
    expect((await request(app).post(`/api/appointments/${first.id}/cancel`).set(auth()).send({ reason: 'cliente viajou' })).status).toBe(200);
    expect((await followUpRow(fu.id)).status).toBe('PENDING');

    const second = await propose({ followUpId: fu.id, scheduledAt: inDays(8) });
    expect(second.status).toBe(201);
    expect((await followUpRow(fu.id)).status).toBe('SCHEDULED');
    expect((await appointmentRow(first.id)).followUpId).toBeNull();
    const [proposed] = await bypass<any[]>(() => db.appointmentEvent.findMany({ where: { appointmentId: second.body.id, eventType: 'PROPOSED' } }));
    expect(proposed.reason).toContain(first.id);
  });

  it('com agendamento ATIVO, não aceita duplicar (remarque o existente)', async () => {
    const fu = await newFollowUp();
    await propose({ followUpId: fu.id });
    const dup = await propose({ followUpId: fu.id, scheduledAt: inDays(9) });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/remarque o existente/);
  });

  it('cancelar o pós-venda cancela o agendamento ativo ligado a ele', async () => {
    const fu = await newFollowUp();
    const appt = (await propose({ followUpId: fu.id })).body;
    const res = await request(app).post(`/api/follow-ups/${fu.id}/cancel`).set(auth()).send({ reason: 'vendeu a moto' });
    expect(res.status).toBe(200);
    expect((await appointmentRow(appt.id)).status).toBe('CANCELLED');
  });

  it('"não compareceu" antes do horário é recusado; data inválida na proposta é recusada', async () => {
    const appt = (await propose({})).body;
    const early = await request(app).post(`/api/appointments/${appt.id}/no-show`).set(auth()).send({});
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/depois do horário agendado/);
    const bad = await propose({ scheduledAt: 'amanhã às 10' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Data e hora inválidas/);
  });

  it('revisão: grava a recomendação, próxima data sem transbordar o mês (31/01 + 1 = 28/02) e recusa data futura', async () => {
    const res = await request(app).post('/api/revisions').set(auth()).send({
      customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, performedAt: '2026-01-31T12:00:00.000Z',
      kilometerAtService: 12000, servicesPerformed: 'Troca de óleo', recommendations: 'Trocar a relação na próxima', intervalMonths: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.recommendations).toBe('Trocar a relação na próxima');
    expect(new Date(res.body.nextDueDate).toISOString()).toBe('2026-02-28T12:00:00.000Z');

    const future = await request(app).post('/api/revisions').set(auth()).send({
      customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, performedAt: inDays(10), kilometerAtService: 13000, servicesPerformed: 'x', intervalMonths: 3,
    });
    expect(future.status).toBe(400);
    expect(future.body.error).toMatch(/não pode estar no futuro/);
  });

  it('VIEWER não propõe nem confirma', async () => {
    const viewer = { Authorization: `Bearer ${generateAccessToken({ userId: fixture.userId, email: 'v@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'VIEWER' })}` };
    const appt = (await propose({})).body;
    expect((await request(app).post('/api/appointments').set(viewer).send({ customerId: fixture.customerId, scheduledAt: inDays(4) })).status).toBe(403);
    expect((await request(app).post(`/api/appointments/${appt.id}/confirm`).set(viewer).send({ channel: 'PHONE', confirmedByName: 'X X' })).status).toBe(403);
  });
});
