import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture, deleteAppointmentsOf } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Capacidade CONFIGURÁVEL da agenda pela API, banco real (docs/CORTEX/policies/AGENDA.md): duração (janela), boxes,
 * limite por dia/mês no fuso da empresa, mecânico (conflito, validação, outra filial), indisponibilidade da filial e do
 * mecânico, disponibilidade por horário para as telas, corrida sob a trava por filial, permissões e isolamento.
 */
describe('Agenda: capacidade configurável — duração, boxes, dia/mês, mecânico e indisponibilidade (integração real)', () => {
  let fx: IntegrationFixture;
  let other: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let branchB: string;
  let mechanic: { id: string };
  let wideMechanic: { id: string };
  let inactiveMechanic: { id: string };
  let otherCompanyMechanic: { id: string };
  let operatorToken: string;
  let managerToken: string;
  let adminToken: string;
  let otherManagerToken: string;
  let branchBManagerToken: string;

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const token = (u: { id: string }, userType: string, companyId: string, branchId: string | null) =>
    generateAccessToken({ userId: u.id, email: `${userType.toLowerCase()}@test.local`, companyId, branchId, userType } as any);

  /** Próxima segunda-feira (≥ 7 dias à frente). */
  const baseMonday = (() => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  /** Hora local de São Paulo (UTC−3) na segunda-feira base. */
  const localAt = (hhmm: string, plusDays = 0, offset = '-03:00') => {
    const d = new Date(`${baseMonday}T${hhmm}:00.000${offset}`);
    return new Date(d.getTime() + plusDays * 86_400_000).toISOString();
  };
  const propose = (scheduledAt: string, extra: object = {}, t = operatorToken) =>
    request(app).post('/api/appointments').set(bearer(t)).send({ customerId: fx.customerId, motorcycleId: fx.motorcycleId, scheduledAt, ...extra });
  const reschedule = (id: string, newScheduledAt: string, extra: object = {}) =>
    request(app).post(`/api/appointments/${id}/reschedule`).set(bearer(operatorToken)).send({ newScheduledAt, ...extra });
  const addUnavailability = (body: object, t = managerToken) => request(app).post('/api/appointments/unavailabilities').set(bearer(t)).send(body);
  const availability = (query: Record<string, string | number>, t = operatorToken) =>
    request(app).get('/api/appointments/availability').query(query).set(bearer(t));

  const row = (id: string) => bypass<any>(() => db.appointment.findUnique({ where: { id } }));
  const setPolicy = (key: string, value: unknown, branchId: string | null = null) =>
    bypass(() => db.policySetting.create({ data: { companyId: fx.companyId, branchId, key, value: value as any } }));
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

  beforeAll(async () => {
    fx = await createFixture('agenda-res');
    other = await createFixture('agenda-res-b');
    const mkUser = (companyId: string, branchId: string | null, userType: string, name: string, isActive = true) =>
      bypass<any>(() =>
        db.user.create({
          data: { companyId, branchId, name, email: `${name.toLowerCase().replace(/\W/g, '')}-${Date.now()}-${Math.random()}@test.local`, password: 'x', userType: userType as any, isActive },
        })
      );
    branchB = (await bypass<any>(() => db.branch.create({ data: { companyId: fx.companyId, name: 'Filial B', isHeadquarter: false, isActive: true } }))).id;
    mechanic = await mkUser(fx.companyId, fx.branchId, 'MECHANIC', 'Mecanico Matriz');
    wideMechanic = await mkUser(fx.companyId, null, 'MECHANIC', 'Mecanico Volante');
    inactiveMechanic = await mkUser(fx.companyId, fx.branchId, 'MECHANIC', 'Mecanico Inativo', false);
    otherCompanyMechanic = await mkUser(other.companyId, other.branchId, 'MECHANIC', 'Mecanico Outra Empresa');
    const manager = await mkUser(fx.companyId, fx.branchId, 'MANAGER', 'Gerente Matriz');
    const admin = await mkUser(fx.companyId, null, 'COMPANY_ADMIN', 'Admin Empresa');
    const managerB = await mkUser(fx.companyId, branchB, 'MANAGER', 'Gerente Filial B');
    const otherManager = await mkUser(other.companyId, other.branchId, 'MANAGER', 'Gerente Outra');
    operatorToken = token({ id: fx.userId }, 'OPERATOR', fx.companyId, fx.branchId);
    managerToken = token(manager, 'MANAGER', fx.companyId, fx.branchId);
    adminToken = token(admin, 'COMPANY_ADMIN', fx.companyId, null);
    branchBManagerToken = token(managerB, 'MANAGER', fx.companyId, branchB);
    otherManagerToken = token(otherManager, 'MANAGER', other.companyId, other.branchId);
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterEach(async () => {
    await bypass(() => db.policySetting.deleteMany({ where: { companyId: fx.companyId } }));
    await bypass(() => db.businessHours.deleteMany({ where: { companyId: fx.companyId } }));
    await bypass(() => db.agendaUnavailability.deleteMany({ where: { companyId: fx.companyId } }));
    await deleteAppointmentsOf(fx.companyId);
    await bypass(() => db.agendaUnavailability.deleteMany({ where: { companyId: other.companyId } }));
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    if (fx) await destroyFixture(fx);
    if (other) await destroyFixture(other);
  });

  describe('duração e boxes', () => {
    it('90 min ocupa dois horários de 60: com 1 box, 11:00 é recusado (NO_BOX_AVAILABLE) e 11:30 aceito; a duração fica gravada', async () => {
      await setPolicy('agenda.boxCount', 1);
      const a = await propose(localAt('10:00'), { durationMinutes: 90 });
      expect(a.status).toBe(201);
      expect((await row(a.body.id)).durationMinutes).toBe(90);
      const busy = await propose(localAt('11:00'));
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('NO_BOX_AVAILABLE');
      expect(busy.body.error).toMatch(/Não há box livre.*o único box está ocupado.*11:00 e 12:00.*fale com a gerência/);
      expect((await propose(localAt('11:30'))).status).toBe(201);
      // antes de 10:00 também colide se a janela alcança 10:00
      expect((await propose(localAt('09:30'))).body.code).toBe('NO_BOX_AVAILABLE');
      expect((await propose(localAt('09:00'))).status).toBe(201);
    });

    it('sem duração no pedido vale agenda.defaultDurationMinutes; sem ela, um horário (agenda.slotMinutes)', async () => {
      await setPolicy('agenda.boxCount', 1);
      await setPolicy('agenda.defaultDurationMinutes', 120);
      const a = await propose(localAt('10:00'));
      expect(a.status).toBe(201);
      expect((await row(a.body.id)).durationMinutes).toBeNull();
      expect((await propose(localAt('11:30'), { durationMinutes: 30 })).body.code).toBe('NO_BOX_AVAILABLE');
      expect((await propose(localAt('12:00'), { durationMinutes: 30 })).status).toBe(201);
    });

    it('boxes contam atendimentos SIMULTÂNEOS: 10:00–10:30 e 10:30–11:00 cabem com um de 10:00–11:00 em 2 boxes; o terceiro no mesmo trecho não', async () => {
      await setPolicy('agenda.boxCount', 2);
      expect((await propose(localAt('10:00'), { durationMinutes: 30 })).status).toBe(201);
      expect((await propose(localAt('10:30'), { durationMinutes: 30 })).status).toBe(201);
      expect((await propose(localAt('10:00'), { durationMinutes: 60 })).status).toBe(201);
      expect((await propose(localAt('10:15'), { durationMinutes: 30 })).body.code).toBe('NO_BOX_AVAILABLE');
      // cancelado libera o box
      const list = await bypass<any[]>(() => db.appointment.findMany({ where: { companyId: fx.companyId, durationMinutes: 60 } }));
      await request(app).post(`/api/appointments/${list[0].id}/cancel`).set(bearer(operatorToken)).send({ reason: 'cliente desistiu' });
      expect((await propose(localAt('10:15'), { durationMinutes: 30 })).status).toBe(201);
    });

    it('remarcar aumentando a duração para cima de outro atendimento é recusado e nada muda; o próprio agendamento não conta', async () => {
      await setPolicy('agenda.boxCount', 1);
      const a = (await propose(localAt('10:00'))).body;
      expect((await propose(localAt('11:00'))).status).toBe(201);
      const longer = await reschedule(a.id, localAt('10:00'), { durationMinutes: 90 });
      expect(longer.status).toBe(409);
      expect(longer.body.code).toBe('NO_BOX_AVAILABLE');
      expect((await row(a.id)).durationMinutes).toBeNull();
      const same = await reschedule(a.id, localAt('10:00'), { durationMinutes: 60 });
      expect(same.status).toBe(200);
      expect((await row(a.id)).durationMinutes).toBe(60);
    });

    it('duração fora de 5..1440 é recusada com mensagem do campo (400)', async () => {
      const res = await propose(localAt('10:00'), { durationMinutes: 2 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/duração mínima é de 5 minutos/);
    });
  });

  describe('horário de funcionamento: a janela inteira precisa caber', () => {
    it('passar do fechamento ou atravessar o intervalo → 409 OUTSIDE_BUSINESS_HOURS com o motivo; caber exatamente é aceito', async () => {
      await setWeek();
      const late = await propose(localAt('17:30'));
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('OUTSIDE_BUSINESS_HOURS');
      expect(late.body.error).toMatch(/60 min \(17:30–18:30\) termina depois do fechamento \(18:00\)/);
      const lunch = await propose(localAt('11:30'));
      expect(lunch.body.code).toBe('OUTSIDE_BUSINESS_HOURS');
      expect(lunch.body.error).toMatch(/passa pelo intervalo das 12:00 às 13:00/);
      expect((await propose(localAt('17:00'))).status).toBe(201);
      expect((await propose(localAt('11:30'), { durationMinutes: 30 })).status).toBe(201);
      expect((await propose(localAt('13:00'), { durationMinutes: 300 })).status).toBe(201);
    });
  });

  describe('limite por dia e por mês no fuso da empresa', () => {
    it('dia: 23:30 de segunda em Manaus é terça em São Paulo — com Manaus o dia lota, com São Paulo não', async () => {
      await setPolicy('company.timezone', 'America/Manaus');
      await setPolicy('agenda.maxPerDay', 1);
      expect((await propose(localAt('23:30', 0, '-04:00'))).status).toBe(201);
      const full = await propose(localAt('10:00', 0, '-04:00'));
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('DAY_FULL');
      expect(full.body.error).toMatch(/está lotada.*limite 1 por dia.*Escolha outro dia/);

      await bypass(() => db.policySetting.deleteMany({ where: { companyId: fx.companyId, key: 'company.timezone' } }));
      expect((await propose(localAt('10:00', 0, '-04:00'))).status).toBe(201);
      // remarcar para um dia lotado também é recusado: terça (São Paulo) já tem o das 00:30
      const monday = (await bypass<any[]>(() => db.appointment.findMany({ where: { companyId: fx.companyId }, orderBy: { scheduledAt: 'asc' } })))[0];
      expect((await reschedule(monday.id, localAt('15:00', 1))).body.code).toBe('DAY_FULL');
      expect((await reschedule(monday.id, localAt('15:00'))).status).toBe(200);
    });

    it('mês: 23:30 do último dia em Manaus é dia 1 em São Paulo — MONTH_FULL só no fuso em que cai no mesmo mês', async () => {
      const now = new Date();
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
      const firstDay = first.toISOString().slice(0, 10);
      const lastDayPrev = new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10);
      await setPolicy('agenda.maxPerMonth', 1);
      await setPolicy('company.timezone', 'America/Manaus');
      expect((await propose(new Date(`${lastDayPrev}T23:30:00.000-04:00`).toISOString())).status).toBe(201);
      expect((await propose(new Date(`${firstDay}T10:00:00.000-04:00`).toISOString())).status).toBe(201);
      await deleteAppointmentsOf(fx.companyId, new Date(`${firstDay}T05:00:00.000Z`));

      await bypass(() => db.policySetting.deleteMany({ where: { companyId: fx.companyId, key: 'company.timezone' } }));
      const full = await propose(new Date(`${firstDay}T10:00:00.000-04:00`).toISOString());
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('MONTH_FULL');
      expect(full.body.error).toMatch(/limite 1\)\. Escolha outro mês/);
    });
  });

  describe('corrida: trava por filial', () => {
    it('6 propostas simultâneas em horários DIFERENTES para 2 vagas no dia: exatamente 2 passam', async () => {
      await setPolicy('agenda.maxPerDay', 2);
      const results = await Promise.all(['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'].map((t) => propose(localAt(t))));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'DAY_FULL')).toBe(true);
      expect(await bypass(() => db.appointment.count({ where: { companyId: fx.companyId } }))).toBe(2);
    });

    it('5 propostas simultâneas que se sobrepõem por duração, em horários (slots) diferentes, para 1 box: exatamente 1 passa', async () => {
      await setPolicy('agenda.boxCount', 1);
      const results = await Promise.all([
        propose(localAt('10:30'), { durationMinutes: 90 }),
        propose(localAt('11:00')),
        propose(localAt('11:15')),
        propose(localAt('11:30')),
        propose(localAt('10:45'), { durationMinutes: 60 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(await bypass(() => db.appointment.count({ where: { companyId: fx.companyId } }))).toBe(1);
    });

    it('mesmo mecânico disputado por 4 pedidos simultâneos: só 1 fica com ele', async () => {
      const results = await Promise.all(['09:00', '09:15', '09:30', '09:45'].map((t) => propose(localAt(t), { mechanicId: mechanic.id })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'MECHANIC_CONFLICT')).toBe(true);
    });
  });

  describe('mecânico', () => {
    it('conflito com o mesmo mecânico → 409 MECHANIC_CONFLICT; outro horário ou sem mecânico passam; o mecânico fica gravado', async () => {
      const a = await propose(localAt('10:00'), { mechanicId: mechanic.id, durationMinutes: 60 });
      expect(a.status).toBe(201);
      expect((await row(a.body.id)).mechanicId).toBe(mechanic.id);
      const clash = await propose(localAt('10:30'), { mechanicId: mechanic.id });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('MECHANIC_CONFLICT');
      expect(clash.body.error).toMatch(/já tem um atendimento em \d{2}\/\d{2}\/\d{4} das 10:00 às 11:00.*outro mecânico/);
      expect((await propose(localAt('10:30'))).status).toBe(201);
      expect((await propose(localAt('11:00'), { mechanicId: mechanic.id })).status).toBe(201);
      // remarcar trocando de mecânico também confere
      const b = (await propose(localAt('15:00'))).body;
      expect((await reschedule(b.id, localAt('10:15'), { mechanicId: mechanic.id })).body.code).toBe('MECHANIC_CONFLICT');
      expect((await row(b.id)).mechanicId).toBeNull();
    });

    it('mecânico de outra empresa, inativo, de outra filial ou que não é mecânico → 400 INVALID_MECHANIC e nada gravado', async () => {
      const foreign = await propose(localAt('10:00'), { mechanicId: otherCompanyMechanic.id });
      expect(foreign.status).toBe(400);
      expect(foreign.body.code).toBe('INVALID_MECHANIC');
      expect((await propose(localAt('10:00'), { mechanicId: inactiveMechanic.id })).body.code).toBe('INVALID_MECHANIC');
      expect((await propose(localAt('10:00'), { mechanicId: fx.userId })).body.code).toBe('INVALID_MECHANIC');
      const otherBranch = await propose(localAt('10:00'), { mechanicId: mechanic.id, branchId: branchB }, adminToken);
      expect(otherBranch.status).toBe(400);
      expect(otherBranch.body.error).toMatch(/outra filial/);
      expect(await bypass(() => db.appointment.count({ where: { companyId: fx.companyId } }))).toBe(0);
    });

    it('mecânico da empresa toda com atendimento em OUTRA filial: o usuário da filial vê o conflito (sem ver o atendimento)', async () => {
      const inB = await propose(localAt('14:00'), { mechanicId: wideMechanic.id, branchId: branchB }, adminToken);
      expect(inB.status).toBe(201);
      expect(inB.body.branchId).toBe(branchB);
      const clash = await propose(localAt('14:30'), { mechanicId: wideMechanic.id });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('MECHANIC_CONFLICT');
      expect(clash.body.error).not.toMatch(/Cliente/);
      expect((await propose(localAt('15:00'), { mechanicId: wideMechanic.id })).status).toBe(201);
    });
  });

  describe('indisponibilidade', () => {
    it('da filial inteira: bloqueia a janela com o motivo (AGENDA_UNAVAILABLE); remover libera; tudo auditado', async () => {
      expect((await propose(localAt('14:30'))).status).toBe(201);
      auditSpy.mockClear();
      const created = await addUnavailability({ startsAt: localAt('13:00'), endsAt: localAt('15:00'), reason: 'Treinamento da equipe' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ branchId: fx.branchId, mechanicId: null, reason: 'Treinamento da equipe', overlappingAppointments: 1 });
      const audit = auditSpy.mock.calls.find((c) => c[0] === 'audit-log' && c[1].entity === 'AgendaUnavailability');
      expect(audit?.[1]).toMatchObject({ action: 'CREATE', entityId: created.body.id });
      expect(audit![1].newValue).toContain('Treinamento da equipe');

      const blocked = await propose(localAt('12:30'), { durationMinutes: 60 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('AGENDA_UNAVAILABLE');
      expect(blocked.body.error).toMatch(/indisponível em \d{2}\/\d{2}\/\d{4} das 13:00 às 15:00 \(Treinamento da equipe\)\. Escolha outro horário/);
      expect((await propose(localAt('15:00'))).status).toBe(201);

      auditSpy.mockClear();
      const removed = await request(app).delete(`/api/appointments/unavailabilities/${created.body.id}`).set(bearer(managerToken));
      expect(removed.status).toBe(200);
      const delAudit = auditSpy.mock.calls.find((c) => c[0] === 'audit-log' && c[1].entity === 'AgendaUnavailability');
      expect(delAudit?.[1]).toMatchObject({ action: 'DELETE', entityId: created.body.id });
      expect((await propose(localAt('13:30'), { durationMinutes: 30 })).status).toBe(201);
    });

    it('do mecânico: bloqueia só quem usa aquele mecânico (MECHANIC_UNAVAILABLE)', async () => {
      expect((await addUnavailability({ mechanicId: mechanic.id, startsAt: localAt('08:00'), endsAt: localAt('12:00'), reason: 'Consulta médica' })).status).toBe(201);
      const res = await propose(localAt('09:00'), { mechanicId: mechanic.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MECHANIC_UNAVAILABLE');
      expect(res.body.error).toMatch(/Consulta médica.*outro mecânico/);
      expect((await propose(localAt('09:00'))).status).toBe(201);
      expect((await propose(localAt('09:00'), { mechanicId: wideMechanic.id })).status).toBe(201);
    });

    it('permissões e validação: operador não cria nem remove (403); sem motivo ou fim antes do início (400); mecânico de outra empresa (400)', async () => {
      const window = { startsAt: localAt('08:00'), endsAt: localAt('09:00') };
      expect((await addUnavailability({ ...window, reason: 'Manutenção' }, operatorToken)).status).toBe(403);
      const noReason = await addUnavailability(window);
      expect(noReason.status).toBe(400);
      expect(noReason.body.error).toMatch(/motivo/);
      expect((await addUnavailability({ startsAt: localAt('09:00'), endsAt: localAt('08:00'), reason: 'Manutenção' })).body.error).toMatch(/fim precisa ser depois do início/);
      expect((await addUnavailability({ ...window, reason: 'Manutenção', mechanicId: otherCompanyMechanic.id })).body.code).toBe('INVALID_MECHANIC');
      const ok = await addUnavailability({ ...window, reason: 'Manutenção do elevador' });
      expect((await request(app).delete(`/api/appointments/unavailabilities/${ok.body.id}`).set(bearer(operatorToken))).status).toBe(403);
      expect(await bypass(() => db.agendaUnavailability.count({ where: { companyId: fx.companyId } }))).toBe(1);
    });

    it('isolamento: gerente de filial não grava em outra filial (403); outra empresa não vê nem remove (404); filial de outra empresa é recusada', async () => {
      const window = { startsAt: localAt('08:00'), endsAt: localAt('09:00'), reason: 'Inventário' };
      expect((await addUnavailability({ ...window, branchId: branchB })).status).toBe(403);
      expect((await addUnavailability({ ...window, branchId: other.branchId }, adminToken)).body.code).toBe('BRANCH_NOT_FOUND');
      const mine = await addUnavailability(window);
      expect(mine.status).toBe(201);
      const inB = await addUnavailability({ ...window, reason: 'Dedetização' }, branchBManagerToken);
      expect(inB.body.branchId).toBe(branchB);

      const otherList = await request(app).get('/api/appointments/unavailabilities').set(bearer(otherManagerToken));
      expect(otherList.status).toBe(200);
      expect(otherList.body.unavailabilities).toHaveLength(0);
      expect((await request(app).delete(`/api/appointments/unavailabilities/${mine.body.id}`).set(bearer(otherManagerToken))).status).toBe(404);
      // gerente da filial B não remove a da matriz
      expect((await request(app).delete(`/api/appointments/unavailabilities/${mine.body.id}`).set(bearer(branchBManagerToken))).status).toBe(404);
      // cada filial lista a sua; a empresa toda vê as duas
      const matrixList = (await request(app).get('/api/appointments/unavailabilities').set(bearer(operatorToken))).body.unavailabilities;
      expect(matrixList.map((u: any) => u.id)).toEqual([mine.body.id]);
      const adminList = (await request(app).get('/api/appointments/unavailabilities').set(bearer(adminToken))).body.unavailabilities;
      expect(adminList.map((u: any) => u.id).sort()).toEqual([mine.body.id, inB.body.id].sort());
    });
  });

  describe('disponibilidade por horário (telas)', () => {
    it('cada horário do dia: livre ou ocupado com o código e o motivo', async () => {
      await setWeek();
      await setPolicy('agenda.boxCount', 1);
      expect((await propose(localAt('10:00'), { durationMinutes: 90 })).status).toBe(201);
      await addUnavailability({ startsAt: localAt('15:00'), endsAt: localAt('16:00'), reason: 'Reunião geral' });
      const res = await availability({ date: baseMonday });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: baseMonday, branchId: fx.branchId, timezone: 'America/Sao_Paulo', slotMinutes: 60, durationMinutes: 60 });
      const at = (time: string) => res.body.slots.find((s: any) => s.time === time);
      expect(res.body.slots).toHaveLength(24);
      expect(at('07:00')).toMatchObject({ available: false, code: 'OUTSIDE_BUSINESS_HOURS' });
      expect(at('09:00')).toMatchObject({ available: true }); // 09:00–10:00 termina quando o outro começa
      expect(at('10:00')).toMatchObject({ available: false, code: 'NO_BOX_AVAILABLE', booked: 1 });
      expect(at('11:00')).toMatchObject({ available: false, code: 'NO_BOX_AVAILABLE' });
      expect(at('11:00').reason).toMatch(/Não há box livre/);
      expect(at('12:00')).toMatchObject({ available: false, code: 'OUTSIDE_BUSINESS_HOURS' });
      expect(at('13:00')).toMatchObject({ available: true, code: null, reason: null });
      expect(at('15:00')).toMatchObject({ available: false, code: 'AGENDA_UNAVAILABLE' });
      expect(at('15:00').reason).toMatch(/Reunião geral/);
      expect(at('17:00')).toMatchObject({ available: true });

      // 120 min: 13:00–15:00 cabe; 14:00–16:00 esbarra na indisponibilidade; 16:00–18:00 cabe; 17:00–19:00 passa do fechamento
      const long = await availability({ date: baseMonday, durationMinutes: 120 });
      expect(long.body.durationMinutes).toBe(120);
      const lat = (time: string) => long.body.slots.find((s: any) => s.time === time);
      expect(lat('13:00').available).toBe(true);
      expect(lat('14:00')).toMatchObject({ available: false, code: 'AGENDA_UNAVAILABLE' });
      expect(lat('16:00').available).toBe(true);
      expect(lat('17:00')).toMatchObject({ available: false, code: 'OUTSIDE_BUSINESS_HOURS' });
    });

    it('com mecânico: horários em que ele está ocupado aparecem com MECHANIC_CONFLICT; mecânico inválido 400; outra filial para usuário de filial 403', async () => {
      expect((await propose(localAt('10:00'), { mechanicId: mechanic.id })).status).toBe(201);
      const res = await availability({ date: baseMonday, mechanicId: mechanic.id });
      expect(res.body.slots.find((s: any) => s.time === '10:00')).toMatchObject({ available: false, code: 'MECHANIC_CONFLICT' });
      expect(res.body.slots.find((s: any) => s.time === '11:00')).toMatchObject({ available: true });
      expect((await availability({ date: baseMonday, mechanicId: otherCompanyMechanic.id })).status).toBe(400);
      expect((await availability({ date: baseMonday, branchId: branchB })).status).toBe(403);
      expect((await availability({ date: 'amanhã' })).status).toBe(400);
    });
  });
});
