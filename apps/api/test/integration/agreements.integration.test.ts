import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db, runWithRLSContext, runInTransaction } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { hashPassword } from '@ln-system/shared/utils/password';
import saleService from '../../src/services/sale.service';
import agreementCompanyService from '../../src/services/agreement-company.service';
import financialService from '../../src/services/financial.service';
import { SCHEDULED_JOB_NAMES } from '../../src/config/scheduled-jobs';
import { addCompetence, competenceOf, formatLocalDate } from '../../src/services/agreement-common';
import { createFixture, destroyFixture, IntegrationFixture, purgeNewDomainData } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Convênios (funcionário e empresa externa), contas a receber de convênio, bloqueio e cobrança manual — Postgres real.
 * docs/CORTEX/policies/CONVENIOS.md, FINANCEIRO.md, COBRANCA.md.
 */
const TZ = 'America/Sao_Paulo';
const PASSWORD = 'Autoriza-123!';
// CPFs/CNPJs válidos (dígitos verificadores corretos)
const CPF1 = '52998224725';
const CPF2 = '11144477735';
const CPF3 = '39053344705';
const CPF4 = '15350946056';
const CNPJ1 = '11444777000161';
const CNPJ2 = '04252011000110';
const CNPJ3 = '33000167000101';

describe('Convênios + financeiro do convênio + cobrança manual (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let managerA: any;
  let branchA2: any;
  let operatorA2: any;
  let registerA2: any;
  let tokens: Record<string, string>;
  let seq = 5000 + Math.floor(Math.random() * 1000);
  const competence = competenceOf(new Date(), TZ);

  const tok = (userId: string, companyId: string, branchId: string | undefined, userType: string) =>
    generateAccessToken({ userId, email: `${userType.toLowerCase()}@test.local`, companyId, branchId: branchId as any, userType });
  const api = (method: 'get' | 'post' | 'patch', url: string, token: string, body?: object) => {
    const r = request(app)[method](`/api${url}`).set('Authorization', `Bearer ${token}`);
    return body ? r.send(body) : r;
  };

  async function setPolicy(companyId: string, key: string, value: unknown) {
    await bypass(() => db.policySetting.deleteMany({ where: { companyId, branchId: null, key } }));
    await bypass(() => db.policySetting.create({ data: { companyId, branchId: null, key, value: value as any, updatedBy: 'test' } }));
  }

  async function newSale(fx: IntegrationFixture, total: number, opts: { branchId?: string; registerId?: string; userId?: string } = {}) {
    return bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fx.companyId,
          branchId: opts.branchId ?? fx.branchId,
          saleNumber: ++seq,
          customerId: fx.customerId,
          userId: opts.userId ?? fx.userId,
          cashRegisterId: opts.registerId ?? fx.cashRegisterId,
          status: 'PENDING',
          subtotal: total,
          totalAmount: total,
          items: { create: [{ productId: fx.productId, productName: 'Óleo 10W30', productSku: `AG-${seq}`, quantity: 1, unitPrice: total, totalPrice: total }] },
        },
      })
    );
  }

  const newEmployee = (fx: IntegrationFixture, data: Record<string, unknown>) =>
    bypass<any>(() => db.employeeAgreement.create({ data: { companyId: fx.companyId, name: 'Funcionário', createdBy: 'test', ...data } as any }));
  const newCompany = (fx: IntegrationFixture, data: Record<string, unknown>) =>
    bypass<any>(() => db.agreementCompany.create({ data: { companyId: fx.companyId, legalName: 'Conveniada LTDA', createdBy: 'test', ...data } as any }));
  const payEmployee = (token: string, saleId: string, amount: number, employeeAgreementId?: string, installments = 1) =>
    api('post', '/payments', token, { saleId, paymentMethod: 'EMPLOYEE_AGREEMENT', amount, employeeAgreementId, installments });
  const payCompany = (token: string, saleId: string, amount: number, agreementCompanyId?: string) =>
    api('post', '/payments', token, { saleId, paymentMethod: 'COMPANY_AGREEMENT', amount, agreementCompanyId });

  beforeAll(async () => {
    A = await createFixture('agreeA');
    B = await createFixture('agreeB');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const hashed = await hashPassword(PASSWORD);
    managerA = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Gerente A', email: `mgr-agree-${Date.now()}@test.local`, password: hashed, userType: 'MANAGER', isActive: true } })
    );
    branchA2 = await bypass<any>(() => db.branch.create({ data: { companyId: A.companyId, name: 'Filial A2', isActive: true } }));
    operatorA2 = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: branchA2.id, name: 'Operador A2', email: `op-a2-${Date.now()}@test.local`, password: hashed, userType: 'OPERATOR', isActive: true } })
    );
    registerA2 = await bypass<any>(() => db.cashRegister.create({ data: { companyId: A.companyId, branchId: branchA2.id, userId: operatorA2.id, registerNumber: 2, status: 'OPEN', openingAmount: 0 } }));
    const managerB = await bypass<any>(() =>
      db.user.create({ data: { companyId: B.companyId, branchId: B.branchId, name: 'Gerente B', email: `mgr-b-${Date.now()}@test.local`, password: hashed, userType: 'MANAGER', isActive: true } })
    );
    tokens = {
      opA: tok(A.userId, A.companyId, A.branchId, 'OPERATOR'),
      opA2: tok(operatorA2.id, A.companyId, branchA2.id, 'OPERATOR'),
      mgrA: tok(managerA.id, A.companyId, A.branchId, 'MANAGER'),
      adminA: tok(managerA.id, A.companyId, undefined, 'COMPANY_ADMIN'),
      viewerA: tok(A.userId, A.companyId, A.branchId, 'VIEWER'),
      opB: tok(B.userId, B.companyId, B.branchId, 'OPERATOR'),
      mgrB: tok(managerB.id, B.companyId, B.branchId, 'MANAGER'),
    };
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    for (const fx of [A, B]) {
      if (!fx) continue;
      await purgeNewDomainData(fx.companyId); // tentativas de cobrança (append-only) e convênios antes das contas
      await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: fx.companyId } }));
      // auditoria direta do bloqueio automático (append-only: expurgo sinalizado na mesma transação)
      await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
        runInTransaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
          await tx.auditLog.deleteMany({ where: { companyId: fx.companyId } });
        })
      );
      await destroyFixture(fx);
    }
  });

  // ---------------------------------------------------------------- política desligada
  describe('política desligada', () => {
    it('pagamento por convênio de funcionário e de empresa → 400 AGREEMENT_DISABLED; lookup também', async () => {
      const emp = await newEmployee(A, { cpf: CPF4, name: 'Desligado' });
      const ac = await newCompany(A, { cnpj: CNPJ3 });
      const sale = await newSale(A, 50);
      const r1 = await payEmployee(tokens.opA, sale.id, 50, emp.id);
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('AGREEMENT_DISABLED');
      const r2 = await payCompany(tokens.opA, sale.id, 50, ac.id);
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('AGREEMENT_DISABLED');
      // mensagem humana (o que aconteceu + o que fazer), não o nome da política
      expect(r1.body.error).toMatch(/não habilitado para esta filial. Entre em contato com o administrador/);
      expect(r2.body.error).toMatch(/não habilitado para esta filial. Entre em contato com o administrador/);
      expect((await api('get', '/employee-agreements/lookup?q=', tokens.opA)).body.code).toBe('AGREEMENT_DISABLED');
      expect((await api('get', '/agreement-companies/lookup?q=', tokens.opA)).body.code).toBe('AGREEMENT_DISABLED');
      expect(await bypass<number>(() => db.payment.count({ where: { saleId: sale.id } }))).toBe(0);
    });
  });

  // ---------------------------------------------------------------- funcionário
  describe('convênio de funcionário', () => {
    let fixedEmp: any;
    beforeAll(async () => {
      await setPolicy(A.companyId, 'employeeAgreement.enabled', true);
      await setPolicy(A.companyId, 'employeeAgreement.limitType', 'FIXED');
      await setPolicy(A.companyId, 'employeeAgreement.limitValue', 300);
      await setPolicy(A.companyId, 'employeeAgreement.maxInstallments', 3);
    });

    it('cadastro pela administração (CPF validado, único); gerente não autoriza convênio; operador/VIEWER não acessam o cadastro com salário', async () => {
      const byManager = await api('post', '/employee-agreements', tokens.mgrA, { name: 'Pelo Gerente', cpf: CPF1 });
      expect(byManager.status).toBe(403);
      const bad = await api('post', '/employee-agreements', tokens.adminA, { name: 'Zé', cpf: '12345678900' });
      expect(bad.status).toBe(400);
      const ok = await api('post', '/employee-agreements', tokens.adminA, { name: 'João Fixo', cpf: CPF1, registration: 'M-001', salary: 2500 });
      expect(ok.status).toBe(201);
      fixedEmp = ok.body;
      expect(fixedEmp.limit).toBe(300);
      expect(fixedEmp.available).toBe(300);
      const dup = await api('post', '/employee-agreements', tokens.adminA, { name: 'Outro', cpf: CPF1 });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('CPF_ALREADY_REGISTERED');
      expect((await api('get', '/employee-agreements', tokens.opA)).status).toBe(403);
      expect((await api('get', `/employee-agreements/${fixedEmp.id}`, tokens.opA)).status).toBe(403);
      expect((await api('get', '/employee-agreements/lookup?q=Jo', tokens.viewerA)).status).toBe(403);
    });

    it('lookup do PDV (operador): só o contrato, sem salário; limite fixo R$ 300', async () => {
      const res = await api('get', '/employee-agreements/lookup?q=Jo%C3%A3o', tokens.opA);
      expect(res.status).toBe(200);
      const row = res.body.find((r: any) => r.id === fixedEmp.id);
      expect(Object.keys(row).sort()).toEqual(['available', 'availableHere', 'cpfMasked', 'id', 'limit', 'maxInstallments', 'name', 'registration', 'status', 'unavailableReason', 'used'].sort());
      expect(row).toMatchObject({ limit: 300, used: 0, available: 300, maxInstallments: 3, status: 'ACTIVE' });
      expect(row.cpfMasked).not.toContain(CPF1.slice(0, 3));
    });

    it('usou R$ 180 → disponível R$ 120; compra de R$ 150 estoura (409 com disponível) e nada é gravado', async () => {
      const sale = await newSale(A, 180);
      const before = await bypass<any>(() => db.cashRegister.findUnique({ where: { id: A.cashRegisterId } }));
      const ok = await payEmployee(tokens.opA, sale.id, 180, fixedEmp.id);
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: 'APPROVED', paymentMethod: 'EMPLOYEE_AGREEMENT', employeeAgreementId: fixedEmp.id });
      expect((await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }))).status).toBe('PAID');
      // caixa: regra atual — movimento com a forma de pagamento; soma ao esperado (não é dinheiro da gaveta)
      const mv = await bypass<any>(() => db.cashMovement.findFirst({ where: { referenceType: 'Payment', referenceId: ok.body.id } }));
      expect(mv.paymentMethod).toBe('EMPLOYEE_AGREEMENT');
      const after = await bypass<any>(() => db.cashRegister.findUnique({ where: { id: A.cashRegisterId } }));
      expect(Number(after.expectedAmount) - Number(before.expectedAmount)).toBe(180);

      const charge = await bypass<any>(() => db.employeeAgreementCharge.findUnique({ where: { paymentId: ok.body.id }, include: { deductions: true } }));
      expect(Number(charge.amount)).toBe(180);
      expect(charge.firstCompetence).toBe(competence);
      expect(charge.deductions).toHaveLength(1);
      expect(charge.deductions[0]).toMatchObject({ competence, status: 'SCHEDULED' });

      const look = (await api('get', '/employee-agreements/lookup?q=Jo%C3%A3o', tokens.opA)).body.find((r: any) => r.id === fixedEmp.id);
      expect([look.used, look.available]).toEqual([180, 120]);

      const sale2 = await newSale(A, 150);
      const over = await payEmployee(tokens.opA, sale2.id, 150, fixedEmp.id);
      expect(over.status).toBe(409);
      expect(over.body.code).toBe('AGREEMENT_LIMIT_EXCEEDED');
      expect(over.body.details).toMatchObject({ available: 120, limit: 300, competence });
      expect(await bypass<number>(() => db.payment.count({ where: { saleId: sale2.id } }))).toBe(0);
      expect((await bypass<any>(() => db.sale.findUnique({ where: { id: sale2.id } }))).status).toBe('PENDING');
    });

    it('limite em outra filial: a compra da filial A2 enxerga o uso da filial A1 (limite é da empresa)', async () => {
      const sale = await newSale(A, 150, { branchId: branchA2.id, registerId: registerA2.id, userId: operatorA2.id });
      const res = await payEmployee(tokens.opA2, sale.id, 150, fixedEmp.id);
      expect(res.status).toBe(409);
      expect(res.body.details.available).toBe(120);
      const ok = await payEmployee(tokens.opA2, sale.id, 120, fixedEmp.id);
      expect(ok.status).toBe(201);
    });

    it('% do salário: salário R$ 3.000 × 10% = R$ 300; limite próprio do funcionário sobrepõe a política', async () => {
      await setPolicy(A.companyId, 'employeeAgreement.limitType', 'SALARY_PERCENT');
      await setPolicy(A.companyId, 'employeeAgreement.limitValue', 10);
      const pct = await api('post', '/employee-agreements', tokens.adminA, { name: 'Maria Percentual', cpf: CPF2, salary: 3000 });
      expect(pct.status).toBe(201);
      expect(pct.body.limit).toBe(300);
      expect(pct.body.effectiveLimit).toMatchObject({ limitType: 'SALARY_PERCENT', source: 'POLICY' });
      const own = await api('patch', `/employee-agreements/${pct.body.id}`, tokens.adminA, { limitType: 'FIXED', limitValue: 500 });
      expect(own.status).toBe(200);
      expect(own.body.agreement.limit).toBe(500);
      const half = await api('patch', `/employee-agreements/${pct.body.id}`, tokens.adminA, { limitType: 'FIXED' });
      expect(half.status).toBe(400);
      await setPolicy(A.companyId, 'employeeAgreement.limitType', 'FIXED');
      await setPolicy(A.companyId, 'employeeAgreement.limitValue', 300);
    });

    it('parcelas por competência (3x de R$ 100 em M, M+1, M+2); 4x → INSTALLMENTS_INVALID; sem id → AGREEMENT_REQUIRED', async () => {
      const emp = await newEmployee(A, { cpf: CPF3, name: 'Parcelado' });
      const sale = await newSale(A, 300);
      const bad = await payEmployee(tokens.opA, sale.id, 300, emp.id, 4);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INSTALLMENTS_INVALID');
      const missing = await payEmployee(tokens.opA, sale.id, 300, undefined, 1);
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('AGREEMENT_REQUIRED');

      // Já há R$ 250 previstos para M+1 (outra compra): 3x de 100 estoura em M+1 (disponível 50)
      const prior = await bypass<any>(() =>
        db.employeeAgreementCharge.create({ data: { companyId: A.companyId, agreementId: emp.id, amount: 250, installments: 1, firstCompetence: addCompetence(competence, 1), createdBy: 'test' } })
      );
      await bypass(() =>
        db.employeePayrollDeduction.create({ data: { companyId: A.companyId, chargeId: prior.id, agreementId: emp.id, installmentNumber: 1, competence: addCompetence(competence, 1), amount: 250 } })
      );
      const over = await payEmployee(tokens.opA, sale.id, 300, emp.id, 3);
      expect(over.status).toBe(409);
      expect(over.body.details).toMatchObject({ competence: addCompetence(competence, 1), available: 50 });
      await bypass(() => db.employeePayrollDeduction.updateMany({ where: { companyId: A.companyId, chargeId: prior.id }, data: { status: 'CANCELLED' } }));

      const ok = await payEmployee(tokens.opA, sale.id, 300, emp.id, 3);
      expect(ok.status).toBe(201);
      const deds = await bypass<any[]>(() => db.employeePayrollDeduction.findMany({ where: { charge: { paymentId: ok.body.id } }, orderBy: { installmentNumber: 'asc' } }));
      expect(deds.map((d) => [d.installmentNumber, d.competence, Number(d.amount)])).toEqual([
        [1, competence, 100],
        [2, addCompetence(competence, 1), 100],
        [3, addCompetence(competence, 2), 100],
      ]);
    });

    it('funcionário suspenso → 409 AGREEMENT_INACTIVE', async () => {
      const emp = await newEmployee(A, { cpf: '71428793860', name: 'Suspenso', status: 'SUSPENDED' });
      const sale = await newSale(A, 10);
      const res = await payEmployee(tokens.opA, sale.id, 10, emp.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AGREEMENT_INACTIVE');
    });

    it('concorrência: duas compras simultâneas de R$ 200 com limite R$ 300 → só uma passa', async () => {
      const emp = await newEmployee(A, { cpf: '86288366757', name: 'Concorrente' });
      const [s1, s2] = [await newSale(A, 200), await newSale(A, 200)];
      const results = await Promise.all([payEmployee(tokens.opA, s1.id, 200, emp.id), payEmployee(tokens.opA, s2.id, 200, emp.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const used = await bypass<any>(() => db.employeePayrollDeduction.aggregate({ where: { agreementId: emp.id, competence, status: 'SCHEDULED' }, _sum: { amount: true } }));
      expect(Number(used._sum.amount)).toBe(200);
    });

    it('folha: lista por competência, baixa pela gerência (uma vez), operador não baixa, competência futura não baixa', async () => {
      const list = await api('get', `/employee-agreements/deductions?competence=${competence}`, tokens.mgrA);
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBeGreaterThan(0);
      const target = list.body.items.find((i: any) => i.status === 'SCHEDULED' && i.employee.id === fixedEmp.id);
      expect(target.employee.cpfMasked).toBeDefined();
      expect((await api('post', `/employee-agreements/deductions/${target.id}/process`, tokens.opA)).status).toBe(403);
      const done = await api('post', `/employee-agreements/deductions/${target.id}/process`, tokens.mgrA);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'DEDUCTED', processedBy: managerA.id });
      const again = await api('post', `/employee-agreements/deductions/${target.id}/process`, tokens.mgrA);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DEDUCTION_NOT_SCHEDULED');
      const future = await bypass<any>(() => db.employeePayrollDeduction.findFirst({ where: { companyId: A.companyId, competence: addCompetence(competence, 2), status: 'SCHEDULED' } }));
      const fut = await api('post', `/employee-agreements/deductions/${future.id}/process`, tokens.mgrA);
      expect(fut.status).toBe(409);
      expect(fut.body.code).toBe('DEDUCTION_FUTURE_COMPETENCE');
    });

    it('espelho do funcionário: compras, itens, parcelas, limite/utilizado/disponível; operador não vê o de outro', async () => {
      const res = await api('get', `/employee-agreements/${fixedEmp.id}/statement?competence=${competence}`, tokens.mgrA);
      expect(res.status).toBe(200);
      expect(res.body.employee).toMatchObject({ name: 'João Fixo', registration: 'M-001' });
      expect(res.body).toMatchObject({ competence, limit: 300, used: 300, available: 0 });
      expect(res.body.lines.length).toBe(2);
      expect(res.body.lines[0].items[0]).toMatchObject({ productName: 'Óleo 10W30', quantity: 1 });
      expect(res.body.legalNotice).toMatch(/legislação trabalhista/);
      expect((await api('get', `/employee-agreements/${fixedEmp.id}/statement`, tokens.opA)).status).toBe(403);
    });

    it('venda cancelada: parcela não processada → CANCELLED; a já descontada fica e aparece "a compensar"', async () => {
      const emp = await newEmployee(A, { cpf: '45317828791', name: 'Cancela' });
      const sale = await newSale(A, 200);
      const pay = await payEmployee(tokens.opA, sale.id, 200, emp.id, 2);
      expect(pay.status).toBe(201);
      const deds = await bypass<any[]>(() => db.employeePayrollDeduction.findMany({ where: { agreementId: emp.id }, orderBy: { installmentNumber: 'asc' } }));
      await api('post', `/employee-agreements/deductions/${deds[0].id}/process`, tokens.mgrA).expect(200);

      await runWithRLSContext({ companyId: A.companyId, userType: 'OPERATOR', branchId: A.branchId }, () =>
        saleService.cancelSale({ id: sale.id, companyId: A.companyId, requesterId: A.userId, reason: 'cliente desistiu', authorizerNumericId: managerA.numericId, authorizerPassword: PASSWORD })
      );
      const after = await bypass<any[]>(() => db.employeePayrollDeduction.findMany({ where: { agreementId: emp.id }, orderBy: { installmentNumber: 'asc' } }));
      expect(after.map((d) => d.status)).toEqual(['DEDUCTED', 'CANCELLED']);
      const detail = await api('get', `/employee-agreements/${emp.id}`, tokens.mgrA);
      expect(detail.body.charges[0].cancelledAt).not.toBeNull();
      expect(detail.body.charges[0].toCompensate).toBe(100);
      expect(detail.body.used).toBe(100); // a parcela descontada continua contando na competência
    });

    it('venda devolvida (total): parcelas não processadas → CANCELLED', async () => {
      const emp = await newEmployee(A, { cpf: '98765432100', name: 'Devolve' });
      const sale = await newSale(A, 90);
      await payEmployee(tokens.opA, sale.id, 90, emp.id).expect(201);
      await runWithRLSContext({ companyId: A.companyId, userType: 'OPERATOR', branchId: A.branchId }, () =>
        saleService.returnSale({ id: sale.id, companyId: A.companyId, requesterId: A.userId, reason: 'defeito', authorizerNumericId: managerA.numericId, authorizerPassword: PASSWORD })
      );
      const d = await bypass<any[]>(() => db.employeePayrollDeduction.findMany({ where: { agreementId: emp.id } }));
      expect(d.map((x) => x.status)).toEqual(['CANCELLED']);
    });
  });

  // ---------------------------------------------------------------- empresa conveniada
  describe('convênio com empresa externa', () => {
    let acId: string;
    beforeAll(async () => {
      await setPolicy(A.companyId, 'companyAgreement.enabled', true);
      await setPolicy(B.companyId, 'companyAgreement.enabled', true);
    });

    it('cadastro com CNPJ válido e prazo; lookup do PDV com disponível', async () => {
      const bad = await api('post', '/agreement-companies', tokens.adminA, { legalName: 'X', cnpj: '11111111111111' });
      expect(bad.status).toBe(400);
      const ok = await api('post', '/agreement-companies', tokens.adminA, {
        legalName: 'Transportes Rápidos LTDA',
        tradeName: 'Rápidos',
        cnpj: CNPJ1,
        contactName: 'Carla',
        whatsapp: '(11) 98888-7777',
        email: 'financeiro@rapidos.test',
        creditLimit: 1000,
        paymentTermDays: 15,
        finePercent: 2,
        interestPercentMonthly: 1,
      });
      expect(ok.status).toBe(201);
      acId = ok.body.id;
      expect(ok.body.paymentTermDays).toBe(15);
      expect((await api('get', '/agreement-companies', tokens.opA)).status).toBe(403);
      const look = await api('get', '/agreement-companies/lookup?q=R%C3%A1pidos', tokens.opA);
      expect(look.status).toBe(200);
      expect(Object.keys(look.body[0]).sort()).toEqual(['available', 'availableHere', 'cnpjMasked', 'id', 'legalName', 'paymentTermDays', 'status', 'tradeName', 'unavailableReason'].sort());
      expect(look.body[0]).toMatchObject({ id: acId, status: 'ACTIVE', available: 1000, paymentTermDays: 15 });
    });

    it('compra → conta a receber com vencimento = data + prazo; resumo com utilizado/disponível', async () => {
      const sale = await newSale(A, 400);
      const res = await payCompany(tokens.opA, sale.id, 400, acId);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'APPROVED', agreementCompanyId: acId });
      const rec = await bypass<any>(() => db.accountsReceivable.findFirst({ where: { referenceId: res.body.id } }));
      expect(rec).toMatchObject({ agreementCompanyId: acId, status: 'PENDING', referenceType: 'AgreementPayment', branchId: A.branchId });
      expect(Number(rec.amount)).toBe(400);
      expect(formatLocalDate(rec.dueDate, TZ)).toBe(formatLocalDate(new Date(Date.now() + 15 * 86_400_000), TZ));
      const sum = await api('get', `/agreement-companies/${acId}/summary`, tokens.mgrA);
      expect(sum.body.financials).toMatchObject({ openBalance: 400, available: 600, overdueAmount: 0, delinquent: false });
    });

    it('limite de crédito estourado → 409 AGREEMENT_LIMIT_EXCEEDED com disponível', async () => {
      const sale = await newSale(A, 700);
      const res = await payCompany(tokens.opA, sale.id, 700, acId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AGREEMENT_LIMIT_EXCEEDED');
      expect(res.body.details.available).toBe(600);
    });

    it('venda cancelada → conta a receber em aberto CANCELADA (não apagada)', async () => {
      const sale = await newSale(A, 100);
      const pay = await payCompany(tokens.opA, sale.id, 100, acId);
      expect(pay.status).toBe(201);
      await runWithRLSContext({ companyId: A.companyId, userType: 'OPERATOR', branchId: A.branchId }, () =>
        saleService.cancelSale({ id: sale.id, companyId: A.companyId, requesterId: A.userId, reason: 'erro de lançamento', authorizerNumericId: managerA.numericId, authorizerPassword: PASSWORD })
      );
      const rec = await bypass<any>(() => db.accountsReceivable.findFirst({ where: { referenceId: pay.body.id } }));
      expect(rec.status).toBe('CANCELLED');
      expect(rec.notes).toMatch(/cancelada/);
    });

    it('bloqueio manual (motivo obrigatório): bloqueada não compra (409), aparece BLOCKED no lookup; desbloqueio', async () => {
      expect((await api('post', `/agreement-companies/${acId}/block`, tokens.mgrA, { reason: 'x' })).status).toBe(400);
      expect((await api('post', `/agreement-companies/${acId}/block`, tokens.opA, { reason: 'inadimplente' })).status).toBe(403);
      const blk = await api('post', `/agreement-companies/${acId}/block`, tokens.mgrA, { reason: 'Inadimplente há 2 meses' });
      expect(blk.status).toBe(200);
      expect(blk.body).toMatchObject({ status: 'BLOCKED', blockedBy: managerA.id });
      const look = await api('get', '/agreement-companies/lookup?q=R%C3%A1pidos', tokens.opA);
      expect(look.body[0].status).toBe('BLOCKED');
      const sale = await newSale(A, 10);
      const res = await payCompany(tokens.opA, sale.id, 10, acId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AGREEMENT_BLOCKED');
      // bloquear protege (gerência pode); liberar crédito de novo é decisão da administração
      expect((await api('post', `/agreement-companies/${acId}/unblock`, tokens.mgrA, { reason: 'Acordo de pagamento' })).status).toBe(403);
      const unb = await api('post', `/agreement-companies/${acId}/unblock`, tokens.adminA, { reason: 'Acordo de pagamento' });
      expect(unb.status).toBe(200);
      expect(unb.body.agreement.status).toBe('ACTIVE');
    });

    it('conveniada inativa → 409 AGREEMENT_INACTIVE e fora do lookup', async () => {
      const ac = await newCompany(A, { cnpj: CNPJ2, legalName: 'Inativa SA', status: 'INACTIVE' });
      const sale = await newSale(A, 10);
      const res = await payCompany(tokens.opA, sale.id, 10, ac.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AGREEMENT_INACTIVE');
      const look = await api('get', '/agreement-companies/lookup?q=Inativa', tokens.opA);
      expect(look.body).toHaveLength(0);
    });

    it('rotina diária marca vencidas como OVERDUE (antes rodava sem contexto RLS e não marcava nada)', async () => {
      const rec = await bypass<any>(() =>
        db.accountsReceivable.create({ data: { companyId: A.companyId, description: 'Venc. job', amount: 10, dueDate: new Date(Date.now() - 2 * 86_400_000), agreementCompanyId: acId } })
      );
      await financialService.markOverdueAccounts();
      expect((await bypass<any>(() => db.accountsReceivable.findUnique({ where: { id: rec.id } }))).status).toBe('OVERDUE');
    });

    it('bloqueio automático após X dias (próprio ou padrão da política); vazio = só manual; não envia cobrança', async () => {
      const acAuto = await newCompany(A, { cnpj: '60701190000104', legalName: 'Auto Bloqueio', blockAfterDaysOverdue: 5 });
      const acPolicy = await newCompany(A, { cnpj: '00360305000104', legalName: 'Segue política' });
      const acNot = await newCompany(A, { cnpj: '60746948000112', legalName: 'Dentro do prazo', blockAfterDaysOverdue: 30 });
      for (const ac of [acAuto, acPolicy, acNot]) {
        await bypass(() => db.accountsReceivable.create({ data: { companyId: A.companyId, description: 'Atrasada', amount: 50, dueDate: new Date(Date.now() - 10 * 86_400_000), status: 'OVERDUE', agreementCompanyId: ac.id } }));
      }
      const attemptsBefore = await bypass<number>(() => db.collectionAttempt.count({ where: { companyId: A.companyId } }));
      // sem padrão na política: acPolicy não bloqueia
      await agreementCompanyService.autoBlockOverdue();
      const st = async (id: string) => (await bypass<any>(() => db.agreementCompany.findUnique({ where: { id } }))).status;
      expect(await st(acAuto.id)).toBe('BLOCKED');
      expect(await st(acPolicy.id)).toBe('ACTIVE');
      expect(await st(acNot.id)).toBe('ACTIVE');
      const blocked = await bypass<any>(() => db.agreementCompany.findUnique({ where: { id: acAuto.id } }));
      expect(blocked.blockedBy).toBe('SYSTEM');
      expect(blocked.blockedReason).toMatch(/10 dias/);
      // com padrão de 7 dias na política, a que segue a política também bloqueia
      await setPolicy(A.companyId, 'companyAgreement.defaultBlockAfterDaysOverdue', 7);
      await agreementCompanyService.autoBlockOverdue();
      expect(await st(acPolicy.id)).toBe('BLOCKED');
      expect(await st(acNot.id)).toBe('ACTIVE');
      // nenhuma mensagem sai sem ação humana
      expect(await bypass<number>(() => db.collectionAttempt.count({ where: { companyId: A.companyId } }))).toBe(attemptsBefore);
      await setPolicy(A.companyId, 'companyAgreement.defaultBlockAfterDaysOverdue', null);
    });
  });

  // ---------------------------------------------------------------- cobrança manual
  describe('cobrança manual', () => {
    let overdueId: string;
    let notDueId: string;
    beforeAll(async () => {
      const ac = await newCompany(A, { cnpj: '19131243000197', legalName: 'Devedora LTDA', tradeName: 'Devedora', contactName: 'Paulo', whatsapp: '11977776666', email: 'contas@devedora.test' });
      overdueId = (await bypass<any>(() => db.accountsReceivable.create({ data: { companyId: A.companyId, description: 'Convênio Devedora — venda #1', amount: 250, dueDate: new Date(Date.now() - 3 * 86_400_000), status: 'OVERDUE', agreementCompanyId: ac.id } }))).id;
      notDueId = (await bypass<any>(() => db.accountsReceivable.create({ data: { companyId: A.companyId, description: 'A vencer', amount: 10, dueDate: new Date(Date.now() + 3 * 86_400_000), agreementCompanyId: ac.id } }))).id;
    });

    it('só perfil permitido pela política envia (operador → 403 COLLECTION_FORBIDDEN)', async () => {
      const res = await api('post', `/receivables/${overdueId}/collections`, tokens.opA, { channels: ['WHATSAPP'] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('COLLECTION_FORBIDDEN');
      expect(await bypass<number>(() => db.collectionAttempt.count({ where: { receivableId: overdueId } }))).toBe(0);
    });

    it('WhatsApp + e-mail numa ação: uma tentativa por canal; WhatsApp LINK_GENERATED (wa.me), e-mail NOT_CONFIGURED', async () => {
      const res = await api('post', `/receivables/${overdueId}/collections`, tokens.mgrA, { channels: ['WHATSAPP', 'EMAIL'] });
      expect(res.status).toBe(201);
      expect(res.body.attempts).toHaveLength(2);
      const wa = res.body.attempts.find((a: any) => a.channel === 'WHATSAPP');
      const em = res.body.attempts.find((a: any) => a.channel === 'EMAIL');
      expect(wa).toMatchObject({ status: 'LINK_GENERATED', recipient: '5511977776666' });
      expect(wa.link).toMatch(/^https:\/\/wa\.me\/5511977776666\?text=/);
      expect(decodeURIComponent(wa.link.split('text=')[1])).toMatch(/R\$\s?250,00[\s\S]*3 dias de atraso/);
      expect(em).toMatchObject({ status: 'NOT_CONFIGURED', recipient: 'contas@devedora.test' });
      expect(em.status).not.toBe('SENT');
      const rows = await bypass<any[]>(() => db.collectionAttempt.findMany({ where: { receivableId: overdueId } }));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.sentBy === managerA.id && Number(r.amount) === 250)).toBe(true);
    });

    it('nova cobrança só com nova ação: segunda ação (só WhatsApp) grava mais 1; histórico com 3 tentativas', async () => {
      await api('post', `/receivables/${overdueId}/collections`, tokens.mgrA, { channels: ['WHATSAPP'] }).expect(201);
      const hist = await api('get', `/receivables/${overdueId}/collections`, tokens.mgrA);
      expect(hist.body.data).toHaveLength(3);
      expect(hist.body.data[0]).toMatchObject({ attempt: 3, channel: 'WHATSAPP', sentByName: 'Gerente A' });
      const detail = await api('get', `/receivables/${overdueId}`, tokens.mgrA);
      expect(detail.body).toMatchObject({ overdue: true, daysOverdue: 3 });
      expect(detail.body.debtor).toMatchObject({ kind: 'AGREEMENT_COMPANY', name: 'Devedora' });
    });

    it('conta não vencida → 409; canal desligado pela política → 400; canal inválido → 400', async () => {
      const r1 = await api('post', `/receivables/${notDueId}/collections`, tokens.mgrA, { channels: ['EMAIL'] });
      expect(r1.status).toBe(409);
      expect(r1.body.code).toBe('RECEIVABLE_NOT_OVERDUE');
      await setPolicy(A.companyId, 'collection.channels', ['WHATSAPP']);
      const r2 = await api('post', `/receivables/${overdueId}/collections`, tokens.mgrA, { channels: ['EMAIL'] });
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('CHANNEL_DISABLED');
      await setPolicy(A.companyId, 'collection.channels', ['WHATSAPP', 'EMAIL']);
      expect((await api('post', `/receivables/${overdueId}/collections`, tokens.mgrA, { channels: ['SMS'] })).status).toBe(400);
      expect((await api('post', `/receivables/${overdueId}/collections`, tokens.mgrA, { channels: [] })).status).toBe(400);
    });

    it('não existe job de cobrança (nenhum envio sem ação humana)', () => {
      expect(SCHEDULED_JOB_NAMES.some((n) => /collect|cobran/i.test(n))).toBe(false);
    });
  });

  // ---------------------------------------------------------------- filial (2026-09-28)
  describe('convênio por filial: empresa + filial + convênio + usuário + permissão', () => {
    const CPF_BRANCH = '28471936500';
    const CNPJ_BRANCH = '27461358000178';

    it('convênio restrito a outra filial: aparece indisponível no lookup com a mensagem; pagamento recusado; na filial liberada funciona', async () => {
      await setPolicy(A.companyId, 'employeeAgreement.enabled', true);
      await setPolicy(A.companyId, 'employeeAgreement.limitValue', 1000);
      await setPolicy(A.companyId, 'companyAgreement.enabled', true);
      const emp = await api('post', '/employee-agreements', tokens.adminA, { name: 'Só na A2', cpf: CPF_BRANCH, allowedBranchIds: [branchA2.id] });
      expect(emp.status).toBe(201);
      expect(emp.body.allowedBranchIds).toEqual([branchA2.id]);
      const ac = await api('post', '/agreement-companies', tokens.adminA, { legalName: 'Filial Restrita SA', cnpj: CNPJ_BRANCH, paymentTermDays: 30, allowedBranchIds: [branchA2.id] });
      expect(ac.status).toBe(201);

      // filial A (não liberada): aparece cinza, com o motivo
      const lookEmp = await api('get', '/employee-agreements/lookup?q=S%C3%B3%20na', tokens.opA);
      const rowEmp = lookEmp.body.find((r: any) => r.id === emp.body.id);
      expect(rowEmp).toMatchObject({ availableHere: false, unavailableReason: 'Convênio não habilitado para esta filial. Entre em contato com o administrador.' });
      const lookAc = await api('get', '/agreement-companies/lookup?q=Restrita', tokens.opA);
      expect(lookAc.body.find((r: any) => r.id === ac.body.id)).toMatchObject({ availableHere: false });

      const saleA = await newSale(A, 20);
      const p1 = await payEmployee(tokens.opA, saleA.id, 20, emp.body.id);
      expect(p1.status).toBe(409);
      expect(p1.body.code).toBe('AGREEMENT_NOT_ENABLED_FOR_BRANCH');
      expect(p1.body.error).toBe('Convênio não habilitado para esta filial. Entre em contato com o administrador.');
      const p2 = await payCompany(tokens.opA, saleA.id, 20, ac.body.id);
      expect(p2.status).toBe(409);
      expect(p2.body.code).toBe('AGREEMENT_NOT_ENABLED_FOR_BRANCH');
      expect(await bypass<number>(() => db.payment.count({ where: { saleId: saleA.id } }))).toBe(0);

      // filial A2 (liberada): disponível e aceita
      const lookA2 = await api('get', '/employee-agreements/lookup?q=S%C3%B3%20na', tokens.opA2);
      expect(lookA2.body.find((r: any) => r.id === emp.body.id)).toMatchObject({ availableHere: true, unavailableReason: null });
      const saleA2 = await newSale(A, 20, { branchId: branchA2.id, registerId: registerA2.id, userId: operatorA2.id });
      const ok = await payEmployee(tokens.opA2, saleA2.id, 20, emp.body.id);
      expect(ok.status).toBe(201);
    });

    it('política desligada só numa filial: lá o convênio fica indisponível com a mensagem; nas outras segue', async () => {
      await bypass(() =>
        db.policySetting.create({ data: { companyId: A.companyId, branchId: branchA2.id, key: 'companyAgreement.enabled', value: false as any, updatedBy: 'test' } })
      );
      try {
        const res = await api('get', '/agreement-companies/lookup?q=', tokens.opA2);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AGREEMENT_DISABLED');
        expect(res.body.error).toBe('Convênio com empresa não habilitado para esta filial. Entre em contato com o administrador.');
        expect((await api('get', '/agreement-companies/lookup?q=', tokens.opA)).status).toBe(200);
      } finally {
        await bypass(() => db.policySetting.deleteMany({ where: { companyId: A.companyId, branchId: branchA2.id, key: 'companyAgreement.enabled' } }));
      }
    });

    it('filial de outra empresa na lista de filiais: 400; gerente não altera filiais/limite (403); manipular o request não habilita', async () => {
      const bad = await api('post', '/employee-agreements', tokens.adminA, { name: 'Filial Errada', cpf: '61720458308', allowedBranchIds: [B.branchId] });
      expect(bad.status).toBe(400);
      const emp = await bypass<any>(() => db.employeeAgreement.findFirst({ where: { companyId: A.companyId, cpf: CPF_BRANCH } }));
      expect((await api('patch', `/employee-agreements/${emp.id}`, tokens.mgrA, { allowedBranchIds: [] })).status).toBe(403);
      expect((await api('patch', `/employee-agreements/${emp.id}`, tokens.mgrA, { limitType: 'FIXED', limitValue: 99999 })).status).toBe(403);
      // o operador da filial A não habilita o convênio mandando outra filial no corpo do pagamento
      const saleA = await newSale(A, 10);
      const forged = await api('post', '/payments', tokens.opA, { saleId: saleA.id, paymentMethod: 'EMPLOYEE_AGREEMENT', amount: 10, employeeAgreementId: emp.id, branchId: branchA2.id });
      expect(forged.status).toBe(409);
      expect(forged.body.code).toBe('AGREEMENT_NOT_ENABLED_FOR_BRANCH');
    });
  });

  // ---------------------------------------------------------------- isolamento
  describe('isolamento entre empresas', () => {
    it('empresa B não vê, não usa e não cobra convênios/contas da empresa A', async () => {
      await setPolicy(B.companyId, 'employeeAgreement.enabled', true);
      await setPolicy(B.companyId, 'employeeAgreement.limitValue', 1000);
      const empA = await bypass<any>(() => db.employeeAgreement.findFirst({ where: { companyId: A.companyId, cpf: CPF1 } }));
      const acA = await bypass<any>(() => db.agreementCompany.findFirst({ where: { companyId: A.companyId, cnpj: CNPJ1 } }));
      const recA = await bypass<any>(() => db.accountsReceivable.findFirst({ where: { companyId: A.companyId, status: 'OVERDUE' } }));

      expect((await api('get', `/employee-agreements/${empA.id}`, tokens.mgrB)).status).toBe(404);
      expect((await api('get', `/agreement-companies/${acA.id}`, tokens.mgrB)).status).toBe(404);
      expect((await api('get', '/employee-agreements/lookup?q=Jo%C3%A3o', tokens.opB)).body).toEqual([]);
      expect((await api('get', '/agreement-companies/lookup?q=R%C3%A1pidos', tokens.opB)).body).toEqual([]);

      const saleB = await newSale(B, 10);
      const p1 = await payEmployee(tokens.opB, saleB.id, 10, empA.id);
      expect(p1.status).toBe(404);
      const p2 = await payCompany(tokens.opB, saleB.id, 10, acA.id);
      expect(p2.status).toBe(404);
      expect(await bypass<number>(() => db.payment.count({ where: { saleId: saleB.id } }))).toBe(0);

      expect((await api('post', `/receivables/${recA.id}/collections`, tokens.mgrB, { channels: ['WHATSAPP'] })).status).toBe(404);
      expect((await api('post', `/agreement-companies/${acA.id}/block`, tokens.mgrB, { reason: 'tentativa cruzada' })).status).toBe(404);
    });
  });
});
