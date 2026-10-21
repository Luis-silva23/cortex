import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture, deleteAppointmentsOf } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Agenda pela API, banco real: horário de funcionamento (agenda.respectBusinessHours), capacidade por horário
 * (agenda.maxPerSlot / agenda.slotMinutes, sem corrida) e conclusão sem confirmação do cliente só com autorização de
 * responsável (agenda.requireCustomerConfirmation / agenda.completionAuthorizerRoles). docs/CORTEX/policies/AGENDA.md.
 */
describe('Agenda: funcionamento, capacidade por horário e conclusão autorizada (integração real)', () => {
  let fx: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  let manager: { id: string; numericId: number };
  let otherOperator: { id: string; numericId: number };
  let self: { numericId: number };
  const PASSWORD = 'Autoriza123!';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** Próxima segunda-feira (≥ 7 dias à frente), no horário local de São Paulo (UTC−3, sem horário de verão). */
  const baseMonday = (() => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const localAt = (hhmm: string, plusDays = 0) => {
    const d = new Date(`${baseMonday}T${hhmm}:00.000-03:00`);
    return new Date(d.getTime() + plusDays * 86_400_000).toISOString();
  };
  const propose = (scheduledAt: string) =>
    request(app).post('/api/appointments').set(auth()).send({ customerId: fx.customerId, motorcycleId: fx.motorcycleId, scheduledAt });
  const reschedule = (id: string, newScheduledAt: string) => request(app).post(`/api/appointments/${id}/reschedule`).set(auth()).send({ newScheduledAt });
  const complete = (id: string, body: object = {}, t = token) => request(app).post(`/api/appointments/${id}/complete`).set({ Authorization: `Bearer ${t}` }).send(body);
  /** Solicitante próprio por teste: o limitador de tentativas de autorizador é por solicitante (3 falhas / 5 min). */
  const newRequester = async () => {
    const u = await bypass<any>(() =>
      db.user.create({ data: { companyId: fx.companyId, branchId: fx.branchId, name: 'Mecânico', email: `mec-${Date.now()}-${Math.random()}@test.local`, password: 'x', userType: 'MECHANIC', isActive: true } })
    );
    return { id: u.id as string, numericId: u.numericId as number, token: generateAccessToken({ userId: u.id, email: 'mec@test.local', companyId: fx.companyId, branchId: fx.branchId, userType: 'MECHANIC' }) };
  };
  const row = (id: string) => bypass<any>(() => db.appointment.findUnique({ where: { id } }));
  const setPolicy = (key: string, value: unknown) => bypass(() => db.policySetting.create({ data: { companyId: fx.companyId, branchId: null, key, value: value as any } }));
  const clearPolicies = () => bypass(() => db.policySetting.deleteMany({ where: { companyId: fx.companyId } }));
  const clearAppointments = () => deleteAppointmentsOf(fx.companyId);
  const setWeek = () =>
    bypass(() =>
      db.businessHours.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          companyId: fx.companyId,
          branchId: null,
          weekday,
          isClosed: weekday === 0,
          opensAt: weekday === 0 ? null : '08:00',
          closesAt: weekday === 0 ? null : '18:00',
          breakStart: weekday === 0 ? null : '12:00',
          breakEnd: weekday === 0 ? null : '13:00',
        })),
      })
    );
  const clearWeek = () => bypass(() => db.businessHours.deleteMany({ where: { companyId: fx.companyId } }));

  beforeAll(async () => {
    fx = await createFixture('agenda-cap');
    token = generateAccessToken({ userId: fx.userId, email: 'op@test.local', companyId: fx.companyId, branchId: fx.branchId, userType: 'OPERATOR' });
    const hashed = await hashPassword(PASSWORD);
    const mk = (userType: string, name: string) =>
      bypass<any>(() =>
        db.user.create({ data: { companyId: fx.companyId, branchId: fx.branchId, name, email: `${name.toLowerCase()}-${Date.now()}@test.local`, password: hashed, userType: userType as any, isActive: true } })
      );
    manager = await mk('MANAGER', 'Gerente');
    otherOperator = await mk('OPERATOR', 'Balconista');
    await bypass(() => db.user.update({ where: { id: fx.userId }, data: { password: hashed } }));
    self = await bypass<any>(() => db.user.findUnique({ where: { id: fx.userId } }));
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterEach(async () => {
    await clearPolicies();
    await clearWeek();
    await clearAppointments();
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    if (fx) await destroyFixture(fx);
  });

  describe('horário de funcionamento', () => {
    it('com horário cadastrado: fora do expediente, no intervalo e no domingo fechado → 409 OUTSIDE_BUSINESS_HOURS com o motivo', async () => {
      await setWeek();
      const night = await propose(localAt('20:00'));
      expect(night.status).toBe(409);
      expect(night.body.code).toBe('OUTSIDE_BUSINESS_HOURS');
      expect(night.body.error).toMatch(/08:00–18:00/);
      const lunch = await propose(localAt('12:30'));
      expect(lunch.status).toBe(409);
      expect(lunch.body.error).toMatch(/Intervalo das 12:00 às 13:00/);

      const ok = await propose(localAt('10:00'));
      expect(ok.status).toBe(201);
      const sunday = await reschedule(ok.body.id, localAt('10:00', -1));
      expect(sunday.status).toBe(409);
      expect(sunday.body.code).toBe('OUTSIDE_BUSINESS_HOURS');
      expect(new Date((await row(ok.body.id)).scheduledAt).toISOString()).toBe(localAt('10:00'));
    });

    it('sem horário cadastrado nada bloqueia; com a política desligada também não', async () => {
      expect((await propose(localAt('20:00'))).status).toBe(201);
      await setWeek();
      await setPolicy('agenda.respectBusinessHours', false);
      expect((await propose(localAt('21:00'))).status).toBe(201);
    });
  });

  describe('capacidade por horário', () => {
    it('limite 2 por horário de 60 min: terceiro no mesmo horário → 409 SLOT_FULL; horário seguinte e vaga liberada aceitam', async () => {
      await setPolicy('agenda.maxPerSlot', 2);
      const a = await propose(localAt('10:00'));
      const b = await propose(localAt('10:30'));
      expect([a.status, b.status]).toEqual([201, 201]);
      const full = await propose(localAt('10:45'));
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('SLOT_FULL');
      expect(full.body.error).toMatch(/Horário lotado.*10:00 e 11:00.*limite 2/);
      expect((await propose(localAt('11:00'))).status).toBe(201);

      // remarcar para o horário lotado é recusado; dentro do próprio horário é aceito
      const c = (await propose(localAt('15:00'))).body;
      expect((await reschedule(c.id, localAt('10:15'))).body.code).toBe('SLOT_FULL');
      expect((await reschedule(a.body.id, localAt('10:50'))).status).toBe(200);

      // cancelado não ocupa vaga
      await request(app).post(`/api/appointments/${b.body.id}/cancel`).set(auth()).send({ reason: 'cliente desistiu' });
      expect((await propose(localAt('10:05'))).status).toBe(201);
    });

    it('cinco propostas simultâneas para as 2 últimas vagas: exatamente 2 passam', async () => {
      await setPolicy('agenda.maxPerSlot', 2);
      const results = await Promise.all(['14:00', '14:10', '14:20', '14:30', '14:40'].map((t) => propose(localAt(t))));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409]);
      const inSlot = await bypass<any[]>(() =>
        db.appointment.findMany({ where: { companyId: fx.companyId, scheduledAt: { gte: new Date(localAt('14:00')), lt: new Date(localAt('15:00')) } } })
      );
      expect(inSlot).toHaveLength(2);
    });

    it('slot de 30 min: 10:00 e 10:30 são horários diferentes', async () => {
      await setPolicy('agenda.maxPerSlot', 1);
      await setPolicy('agenda.slotMinutes', 30);
      expect((await propose(localAt('10:00'))).status).toBe(201);
      expect((await propose(localAt('10:29'))).status).toBe(409);
      expect((await propose(localAt('10:30'))).status).toBe(201);
    });
  });

  describe('concluir sem confirmação do cliente', () => {
    const authz = (numericId: number, extra: object = {}) => ({
      authorization: { authorizerNumericId: numericId, authorizerPassword: PASSWORD, reason: 'Cliente trouxe a moto sem confirmar pelo WhatsApp', ...extra },
    });

    it('sem autorização: 409 APPOINTMENT_NOT_CONFIRMED e continua PROPOSTO', async () => {
      const appt = (await propose(localAt('09:00'))).body;
      const res = await complete(appt.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPOINTMENT_NOT_CONFIRMED');
      expect((await row(appt.id)).status).toBe('PROPOSED');
    });

    it('autorização inválida não conclui: a própria pessoa, perfil sem permissão, senha errada (403); na 4ª tentativa, bloqueio (429)', async () => {
      const appt = (await propose(localAt('09:00'))).body;
      const own = await complete(appt.id, authz(self.numericId));
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('AUTHORIZATION_FAILED');
      expect(own.body.error).toMatch(/Quem solicita não pode autorizar/);
      const role = await complete(appt.id, authz(otherOperator.numericId));
      expect(role.status).toBe(403);
      expect(role.body.error).toMatch(/não tem (perfil|permissão)/);
      expect((await complete(appt.id, authz(manager.numericId, { authorizerPassword: 'errada' }))).status).toBe(403);
      // anti-força-bruta do autorizador (mesmo limitador de cancelar venda/sangria)
      expect((await complete(appt.id, authz(manager.numericId))).status).toBe(429);
      expect((await row(appt.id)).status).toBe('PROPOSED');
    });

    it('motivo curto: 400 e nada gravado', async () => {
      const requester = await newRequester();
      const appt = (await propose(localAt('09:00'))).body;
      const short = await complete(appt.id, authz(manager.numericId, { reason: 'curto' }), requester.token);
      expect(short.status).toBe(400);
      expect(short.body.error).toMatch(/mínimo 10/);
      expect((await row(appt.id)).status).toBe('PROPOSED');
    });

    it('autorizado por gerente: conclui, grava quem autorizou/motivo, evento e auditoria sem a senha', async () => {
      const requester = await newRequester();
      const appt = (await propose(localAt('09:00'))).body;
      auditSpy.mockClear();
      const res = await complete(appt.id, authz(manager.numericId), requester.token);
      expect(res.status).toBe(200);
      const saved = await row(appt.id);
      expect(saved).toMatchObject({
        status: 'COMPLETED',
        customerConfirmed: false,
        completedWithoutConfirmation: true,
        completionAuthorizedBy: manager.id,
        completionReason: 'Cliente trouxe a moto sem confirmar pelo WhatsApp',
      });
      const [ev] = await bypass<any[]>(() => db.appointmentEvent.findMany({ where: { appointmentId: appt.id, eventType: 'COMPLETED' } }));
      expect(ev).toMatchObject({ performedBy: requester.id });
      expect(ev.reason).toMatch(/SEM confirmação do cliente — autorizado por Gerente/);
      const audit = auditSpy.mock.calls.find((c) => c[0] === 'audit-log');
      expect(audit?.[1]).toMatchObject({ entity: 'Appointment', entityId: appt.id });
      expect(audit![1].newValue).toContain(manager.id);
      expect(audit![1].newValue).not.toContain(PASSWORD);
    });

    it('confirmado pelo cliente conclui sem autorização; com a política desligada, não confirmado também (registrado)', async () => {
      const appt = (await propose(localAt('09:00'))).body;
      await request(app).post(`/api/appointments/${appt.id}/confirm`).set(auth()).send({ channel: 'PHONE', confirmedByName: 'Carlos (dono)' });
      expect((await complete(appt.id)).status).toBe(200);
      expect((await row(appt.id))).toMatchObject({ status: 'COMPLETED', completedWithoutConfirmation: false });

      await setPolicy('agenda.requireCustomerConfirmation', false);
      const other = (await propose(localAt('09:30'))).body;
      expect((await complete(other.id)).status).toBe(200);
      expect(await row(other.id)).toMatchObject({ status: 'COMPLETED', completedWithoutConfirmation: true, completionAuthorizedBy: null });
    });

    it('remarcado no meio (volta a PROPOSTO): concluir pelo caminho "confirmado" não passa', async () => {
      const appt = (await propose(localAt('09:00'))).body;
      await request(app).post(`/api/appointments/${appt.id}/confirm`).set(auth()).send({ channel: 'PHONE', confirmedByName: 'Carlos (dono)' });
      const [done, moved] = await Promise.all([complete(appt.id), reschedule(appt.id, localAt('16:00'))]);
      const final = await row(appt.id);
      if (done.status === 200) {
        expect(moved.status).toBe(409);
        expect(final.status).toBe('COMPLETED');
      } else {
        expect(done.status).toBe(409);
        expect(final).toMatchObject({ status: 'PROPOSED', customerConfirmed: false });
      }
      expect(final.completedWithoutConfirmation).toBe(false);
    });
  });
});
