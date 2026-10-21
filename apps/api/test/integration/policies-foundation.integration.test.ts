import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { policyService } from '../../src/services/policy.service';
import { businessHoursService } from '../../src/services/business-hours.service';
import { bearer, bypass, createWorld, destroyWorld, tokenFor, World } from './helpers/tenant-world';

/**
 * Fundação das políticas do CÓRTEX (2026-09-27) — prova REAL (HTTP + Postgres/RLS).
 * Política da empresa é o padrão; a filial sobrescreve só o que o catálogo permite; toda alteração tem motivo,
 * histórico (antes/depois/quem/quando) e auditoria; outra empresa nunca vê nem altera. Horário de funcionamento por
 * empresa/filial com intervalo, dia fechado, feriado e horário especial, no fuso da empresa. Cadastro da empresa.
 */
describe('Políticas por empresa/filial, horário de funcionamento e cadastro da empresa (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
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
  const admin = (co = A()) => bearer(tokenFor(co, null, 'COMPANY_ADMIN'));
  const manager = (branch: 1 | 2 = 1) => bearer(tokenFor(A(), branch, 'MANAGER'));
  const operator = (branch: 1 | 2 = 1) => bearer(tokenFor(A(), branch, 'OPERATOR'));

  describe('políticas', () => {
    it('sem nada gravado valem os padrões decididos: 5% em peças, 0% em serviço, orçamento com 5 dias', async () => {
      const res = await request(app).get('/api/policies/effective').set(operator());
      expect(res.status).toBe(200);
      expect(res.body.values['discount.productFreePercent']).toBe(5);
      expect(res.body.values['discount.serviceFreePercent']).toBe(0);
      expect(res.body.values['quote.expirationDays']).toBe(5);
      expect(res.body.values['employeeAgreement.enabled']).toBe(false);
      expect(res.body.sources['discount.productFreePercent']).toBe('DEFAULT');
    });

    it('empresa define o padrão; a filial 1 sobrescreve; a filial 2 segue a empresa', async () => {
      const co = await request(app).put('/api/policies/discount.productFreePercent').set(admin()).send({ value: 3, reason: 'Margem apertada nas peças' });
      expect(co.status).toBe(200);
      const br = await request(app)
        .put('/api/policies/discount.productFreePercent')
        .set(admin())
        .send({ value: 8, branchId: A().branches[1].branchId, reason: 'Filial 1 em campanha' });
      expect(br.status).toBe(200);

      const b1 = await request(app).get('/api/policies/effective').set(operator(1));
      const b2 = await request(app).get('/api/policies/effective').set(operator(2));
      expect([b1.body.values['discount.productFreePercent'], b1.body.sources['discount.productFreePercent']]).toEqual([8, 'BRANCH']);
      expect([b2.body.values['discount.productFreePercent'], b2.body.sources['discount.productFreePercent']]).toEqual([3, 'COMPANY']);
      // mesmo resultado lido pelo serviço, no contexto RLS da filial
      const fromService = await runWithRLSContext({ companyId: A().companyId, userType: 'OPERATOR', branchId: A().branches[2].branchId }, () =>
        policyService.get(A().companyId, A().branches[2].branchId, 'discount.productFreePercent')
      );
      expect(fromService).toBe(3);
    });

    it('regra de controle vale para a empresa inteira: filial não sobrescreve quem autoriza desconto', async () => {
      const res = await request(app)
        .put('/api/policies/discount.authorizerRoles')
        .set(admin())
        .send({ value: ['MANAGER'], branchId: A().branches[1].branchId, reason: 'tentativa por filial' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('POLICY_NOT_BRANCH_OVERRIDABLE');
    });

    it('valor inválido, sem motivo ou chave desconhecida são recusados em português', async () => {
      const bad = await request(app).put('/api/policies/discount.productFreePercent').set(admin()).send({ value: 150, reason: 'teste inválido' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/Máximo 100%/);
      const noReason = await request(app).put('/api/policies/quote.expirationDays').set(admin()).send({ value: 7 });
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe('REASON_REQUIRED');
      const unknown = await request(app).put('/api/policies/inventada.regra').set(admin()).send({ value: 1, reason: 'chave que não existe' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('UNKNOWN_POLICY');
    });

    it('só a administração altera; gerência lê o catálogo; operador não lê o catálogo nem consulta outra filial', async () => {
      expect((await request(app).put('/api/policies/quote.expirationDays').set(manager()).send({ value: 7, reason: 'gerente tentando' })).status).toBe(403);
      expect((await request(app).put('/api/policies/quote.expirationDays').set(operator()).send({ value: 7, reason: 'operador tentando' })).status).toBe(403);
      const catalog = await request(app).get('/api/policies').set(manager());
      expect(catalog.status).toBe(200);
      expect(catalog.body.policies.find((p: any) => p.key === 'quote.expirationDays').label).toMatch(/orçamento/);
      expect((await request(app).get('/api/policies').set(operator())).status).toBe(403);
      const other = await request(app).get(`/api/policies/effective?branchId=${A().branches[2].branchId}`).set(operator(1));
      expect(other.status).toBe(403);
    });

    it('histórico guarda antes, depois, motivo, quem e quando; a auditoria registra a alteração', async () => {
      auditSpy.mockClear();
      const res = await request(app).put('/api/policies/quote.expirationDays').set(admin()).send({ value: 10, reason: 'Clientes respondem devagar' });
      expect(res.status).toBe(200);
      const again = await request(app).put('/api/policies/quote.expirationDays').set(admin()).send({ value: 12, reason: 'Ajuste fino do prazo' });
      expect(again.body.oldValue).toBe(10);
      const hist = await request(app).get('/api/policies/history?key=quote.expirationDays').set(admin());
      expect(hist.body.changes.map((c: any) => [c.oldValue, c.newValue, c.reason])).toEqual([
        [10, 12, 'Ajuste fino do prazo'],
        [null, 10, 'Clientes respondem devagar'],
      ]);
      expect(hist.body.changes[0].changedBy).toBe(A().fixture.userId);
      const audit = auditCalls().find((a) => a.entity === 'Policy' && a.entityId === 'quote.expirationDays');
      expect(audit).toBeDefined();
      expect(JSON.parse(audit.newValue)).toMatchObject({ politica: 'quote.expirationDays', depois: 10, motivo: 'Clientes respondem devagar' });
    });

    it('restaurar: filial volta ao valor da empresa e a empresa volta ao padrão, com histórico', async () => {
      const b = A().branches[1].branchId;
      const res = await request(app).delete(`/api/policies/discount.productFreePercent?branchId=${b}`).set(admin()).send({ reason: 'Fim da campanha' });
      expect(res.status).toBe(200);
      expect((await request(app).get('/api/policies/effective').set(operator(1))).body.values['discount.productFreePercent']).toBe(3);
      await request(app).delete('/api/policies/discount.productFreePercent').set(admin()).send({ reason: 'Volta ao padrão do produto' });
      expect((await request(app).get('/api/policies/effective').set(operator(1))).body.values['discount.productFreePercent']).toBe(5);
    });

    it('outra empresa não vê nem é afetada pelas políticas desta', async () => {
      await request(app).put('/api/policies/cash.blockCloseWithOpenSales').set(admin()).send({ value: false, reason: 'teste de isolamento' });
      const bEff = await request(app).get('/api/policies/effective').set(bearer(tokenFor(B(), 1, 'OPERATOR')));
      expect(bEff.body.values['cash.blockCloseWithOpenSales']).toBe(true);
      const bHist = await request(app).get('/api/policies/history').set(admin(B()));
      expect(bHist.body.changes).toEqual([]);
      const rows = await runWithRLSContext({ companyId: B().companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        policyService.history(A().companyId)
      );
      expect(rows).toEqual([]);
    });

    it('alterações simultâneas da mesma política não duplicam a linha', async () => {
      const results = await Promise.all(
        [21, 22, 23, 24].map((v) => request(app).put('/api/policies/agenda.slotMinutes').set(admin()).send({ value: v, reason: `simultânea ${v}` }))
      );
      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      const rows = await bypass<any[]>(() => db.policySetting.findMany({ where: { companyId: A().companyId, key: 'agenda.slotMinutes', branchId: null } }));
      expect(rows).toHaveLength(1);
    });
  });

  describe('horário de funcionamento', () => {
    const week = [
      { weekday: 0, isClosed: true },
      ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, isClosed: false, opensAt: '08:00', closesAt: '18:00', breakStart: '12:00', breakEnd: '13:00' })),
      { weekday: 6, isClosed: false, opensAt: '08:00', closesAt: '12:00' },
    ];
    // 2026-10-05 é segunda-feira; horários em America/Sao_Paulo (UTC-3)
    const at = (isoLocal: string) => new Date(`${isoLocal}-03:00`).toISOString();
    const check = (iso: string, auth = operator()) => request(app).get(`/api/business-hours/check?at=${encodeURIComponent(iso)}`).set(auth);

    it('sem horário cadastrado nada é bloqueado (não configurado)', async () => {
      const res = await check(at('2026-10-05T03:00:00'));
      expect(res.body).toMatchObject({ configured: false, open: true });
    });

    it('semana da empresa: expediente, intervalo, sábado curto e domingo fechado', async () => {
      const put = await request(app).put('/api/business-hours').set(admin()).send({ days: week });
      expect(put.status).toBe(200);
      expect((await check(at('2026-10-05T09:30:00'))).body.open).toBe(true);
      const lunch = await check(at('2026-10-05T12:30:00'));
      expect(lunch.body).toMatchObject({ open: false });
      expect(lunch.body.reason).toMatch(/Intervalo/);
      expect((await check(at('2026-10-05T18:00:00'))).body.open).toBe(false);
      expect((await check(at('2026-10-10T11:59:00'))).body.open).toBe(true);
      const sunday = await check(at('2026-10-11T10:00:00'));
      expect(sunday.body.open).toBe(false);
      expect(sunday.body.reason).toMatch(/domingo/);
    });

    it('filial 2 com horário próprio; filial 1 segue a empresa', async () => {
      const b2 = A().branches[2].branchId;
      const own = week.map((d) => (d.weekday === 6 ? { weekday: 6, isClosed: true } : d));
      expect((await request(app).put('/api/business-hours').set(admin()).send({ branchId: b2, days: own })).status).toBe(200);
      expect((await check(at('2026-10-10T10:00:00'), operator(2))).body.open).toBe(false);
      expect((await check(at('2026-10-10T10:00:00'), operator(1))).body.open).toBe(true);
    });

    it('feriado fecha o dia; horário especial vale só naquela data', async () => {
      const holiday = await request(app).post('/api/business-hours/exceptions').set(admin()).send({ date: '2026-10-12', kind: 'HOLIDAY', description: 'Nossa Senhora Aparecida' });
      expect(holiday.status).toBe(201);
      const closed = await check(at('2026-10-12T10:00:00'));
      expect(closed.body.open).toBe(false);
      expect(closed.body.reason).toMatch(/Aparecida/);
      await request(app).post('/api/business-hours/exceptions').set(admin()).send({ date: '2026-10-11', kind: 'SPECIAL_HOURS', opensAt: '09:00', closesAt: '13:00', description: 'Domingo de feirão' });
      expect((await check(at('2026-10-11T10:00:00'))).body.open).toBe(true);
      const dup = await request(app).post('/api/business-hours/exceptions').set(admin()).send({ date: '2026-10-12', kind: 'CLOSED' });
      expect(dup.status).toBe(409);
    });

    it('semana inválida é recusada com a mensagem do dia; operador não altera', async () => {
      const bad = week.map((d) => (d.weekday === 1 ? { ...d, opensAt: '19:00' } : d));
      const res = await request(app).put('/api/business-hours').set(admin()).send({ days: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/segunda-feira: a abertura precisa ser antes do fechamento/);
      expect((await request(app).put('/api/business-hours').set(operator()).send({ days: week })).status).toBe(403);
    });

    it('o serviço respeita o fuso configurado da filial', async () => {
      const b1 = A().branches[1].branchId;
      await request(app).put('/api/policies/company.timezone').set(admin()).send({ value: 'America/Manaus', branchId: b1, reason: 'Filial no Amazonas' });
      // 08:30 em Manaus (UTC-4) = 12:30 UTC: aberto na filial 1; 07:30 em Manaus ainda fechado
      const openManaus = await runWithRLSContext({ companyId: A().companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        businessHoursService.isOpenAt(A().companyId, b1, new Date('2026-10-05T12:30:00Z'))
      );
      const closedManaus = await runWithRLSContext({ companyId: A().companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        businessHoursService.isOpenAt(A().companyId, b1, new Date('2026-10-05T11:30:00Z'))
      );
      expect([openManaus.open, closedManaus.open]).toEqual([true, false]);
    });
  });

  describe('cadastro da empresa', () => {
    it('administração lê e edita razão social, IE, regime, endereço e contatos; auditoria com antes e depois', async () => {
      auditSpy.mockClear();
      const res = await request(app).put('/api/company-profile').set(admin()).send({
        legalName: 'Motos Alfa Comércio de Peças Ltda',
        stateRegistration: '123.456.789.110',
        taxRegime: 'SIMPLES_NACIONAL',
        whatsapp: '(11) 98888-7777',
        zipCode: '01310-100',
        street: 'Av. Paulista',
        number: '1000',
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'sp',
      });
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ legalName: 'Motos Alfa Comércio de Peças Ltda', zipCode: '01310100', state: 'SP', taxRegime: 'SIMPLES_NACIONAL' });
      const audit = auditCalls().find((a) => a.entity === 'Company');
      expect(JSON.parse(audit.newValue).campos).toEqual(expect.arrayContaining(['legalName', 'taxRegime', 'zipCode']));
      expect((await request(app).get('/api/company-profile').set(manager())).body.legalName).toBe('Motos Alfa Comércio de Peças Ltda');
    });

    it('formulário com campos opcionais vazios salva (vazio = limpar), como a tela envia', async () => {
      // `name` fica de fora: o teardown só apaga empresa com nome sintético (destructive-guard).
      const res = await request(app).put('/api/company-profile').set(admin()).send({
        legalName: '',
        stateRegistration: '',
        municipalRegistration: '',
        taxRegime: null,
        phone: '',
        whatsapp: '',
        contactName: 'Responsável',
        zipCode: '',
        street: '',
        number: '',
        complement: '',
        district: '',
        city: '',
        state: '',
      });
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ contactName: 'Responsável', zipCode: null, state: null, legalName: null });
    });

    it('CEP/UF/regime inválidos recusados; CNPJ só o Super Admin altera; operador não lê', async () => {
      const bad = await request(app).put('/api/company-profile').set(admin()).send({ zipCode: '123', state: 'São Paulo', taxRegime: 'LUCRO_INVENTADO' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/CEP com 8 dígitos/);
      expect(bad.body.error).toMatch(/Regime tributário inválido/);
      expect(bad.body.error).not.toMatch(/Invalid enum|zipCode|taxRegime/);
      const long = await request(app).put('/api/company-profile').set(admin()).send({ legalName: 'x'.repeat(201), phone: 123 });
      expect(long.status).toBe(400);
      expect(long.body.error).toMatch(/Razão social: no máximo 200 caracteres/);
      expect(long.body.error).toMatch(/Telefone: formato inválido/);
      expect(long.body.error).not.toMatch(/String must|Expected string|legalName/);
      const doc = await request(app).put('/api/company-profile').set(admin()).send({ document: '11.222.333/0001-81' });
      expect(doc.status).toBe(403);
      expect((await request(app).get('/api/company-profile').set(operator())).status).toBe(403);
    });

    it('a elevação é estreita: ativação e id enviados no corpo são ignorados (empresa sempre a do token)', async () => {
      const res = await request(app).put('/api/company-profile').set(admin()).send({ isActive: false, id: B().companyId, contactName: 'Responsável Alfa' });
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ id: A().companyId, isActive: true, contactName: 'Responsável Alfa' });
      const other = await bypass<any>(() => db.company.findUnique({ where: { id: B().companyId }, select: { contactName: true, isActive: true } }));
      expect(other).toMatchObject({ isActive: true });
      expect(other.contactName).not.toBe('Responsável Alfa');
    });

    it('cada empresa só vê o próprio cadastro', async () => {
      const bView = await request(app).get('/api/company-profile').set(admin(B()));
      expect(bView.body.id).toBe(B().companyId);
      expect(bView.body.legalName).not.toBe('Motos Alfa Comércio de Peças Ltda');
    });
  });
});
