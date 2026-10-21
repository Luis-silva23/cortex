import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, PrismaTransactionClient } from '@ln-system/database';
import { ConflictError } from '@ln-system/shared';
import { isValidCPF } from '@ln-system/shared/utils/validation';
import { policyService } from './policy.service';
import {
  AgreementLimitError,
  COMPETENCE_RE,
  DISABLED_MESSAGE,
  NOT_ENABLED_FOR_BRANCH_MESSAGE,
  addCompetence,
  allowedBranchIdsSchema,
  assertBranchesOfCompany,
  availableAtBranch,
  badRequest,
  brl,
  competenceOf,
  formatCpf,
  maskCpf,
  notFound,
  onlyDigits,
  round2,
  splitInstallments,
} from './agreement-common';

/**
 * CONVÊNIO DE FUNCIONÁRIO (docs/CORTEX/policies/CONVENIOS.md). Não confundir com o "convênio/parceiro de desconto"
 * (`partners`), que só dá desconto na venda — aqui é compra do funcionário para desconto em folha.
 *
 * - Limite MENSAL por competência (YYYY-MM): valor fixo ou % do salário, da política da empresa ou próprio do funcionário.
 * - Disponível da competência = limite − parcelas SCHEDULED/DEDUCTED daquela competência.
 * - Cada compra (pagamento EMPLOYEE_AGREEMENT) gera uma utilização (`employee_agreement_charges`) e N parcelas em folha
 *   (`employee_payroll_deductions`), a partir da competência da compra; o limite é conferido em CADA competência.
 * - Concorrência: a linha do convênio é travada (FOR UPDATE) na transação do pagamento — duas compras simultâneas do
 *   mesmo funcionário serializam e a segunda enxerga o uso da primeira.
 * - Convênios, utilizações e parcelas são da EMPRESA inteira (branchId nulo): o limite vale em todas as filiais e a RLS
 *   de filial não esconde o uso feito em outra filial (o que esconderia uso e deixaria estourar o limite).
 * - O CÓRTEX não presume limite legal: a empresa deve respeitar a legislação trabalhista aplicável.
 */

type LimitType = 'FIXED' | 'SALARY_PERCENT';
const COUNTED = ['SCHEDULED', 'DEDUCTED'];

const money = z.number().min(0, 'Valor não pode ser negativo').max(10_000_000);
const baseSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome').max(120),
  cpf: z.string().refine((v) => isValidCPF(v), 'CPF inválido'),
  registration: z.string().trim().max(40).nullish(),
  salary: money.nullish(),
  limitType: z.enum(['FIXED', 'SALARY_PERCENT']).nullish(),
  limitValue: money.nullish(),
  userId: z.string().uuid().nullish(),
  customerId: z.string().uuid().nullish(),
  notes: z.string().trim().max(500).nullish(),
  /** Filiais em que o convênio pode ser usado; vazio = todas. */
  allowedBranchIds: allowedBranchIdsSchema.optional(),
});

function checkOwnLimit(d: { limitType?: LimitType | null; limitValue?: number | null }, ctx: z.RefinementCtx) {
  const hasType = d.limitType != null;
  const hasValue = d.limitValue != null;
  if (hasType !== hasValue) {
    ctx.addIssue({ code: 'custom', path: ['limitValue'], message: 'Limite próprio exige tipo e valor (ou nenhum dos dois para seguir a política)' });
  }
  if (d.limitType === 'SALARY_PERCENT' && d.limitValue != null && d.limitValue > 100) {
    ctx.addIssue({ code: 'custom', path: ['limitValue'], message: 'Percentual máximo 100%' });
  }
}

export const createEmployeeAgreementSchema = baseSchema.superRefine(checkOwnLimit);
export const updateEmployeeAgreementSchema = baseSchema
  .partial()
  .extend({ status: z.enum(['ACTIVE', 'SUSPENDED', 'ENDED']).optional() })
  .superRefine((d, ctx) => {
    if ('limitType' in d || 'limitValue' in d) checkOwnLimit(d, ctx);
  });

interface PolicyLimit {
  limitType: LimitType;
  limitValue: number;
  maxInstallments: number;
  enabled: boolean;
  timezone: string;
}

async function policyLimit(companyId: string, branchId: string | null = null): Promise<PolicyLimit> {
  const p = await policyService.effective(companyId, branchId);
  return {
    enabled: p['employeeAgreement.enabled'],
    limitType: p['employeeAgreement.limitType'],
    limitValue: Number(p['employeeAgreement.limitValue']),
    maxInstallments: p['employeeAgreement.maxInstallments'],
    timezone: p['company.timezone'],
  };
}

export function resolveLimit(
  a: { limitType: string | null; limitValue: Prisma.Decimal | number | null; salary: Prisma.Decimal | number | null },
  policy: { limitType: LimitType; limitValue: number }
) {
  const own = a.limitType != null && a.limitValue != null;
  const limitType = (own ? a.limitType : policy.limitType) as LimitType;
  const limitValue = own ? Number(a.limitValue) : policy.limitValue;
  const salary = a.salary == null ? 0 : Number(a.salary);
  const limit = limitType === 'SALARY_PERCENT' ? round2((salary * limitValue) / 100) : round2(limitValue);
  return { limitType, limitValue, limit, source: own ? ('AGREEMENT' as const) : ('POLICY' as const) };
}

type Db = PrismaTransactionClient | typeof prisma;

async function usedByCompetence(db: Db, agreementIds: string[], competences: string[]) {
  if (agreementIds.length === 0 || competences.length === 0) return new Map<string, number>();
  const rows = await (db as any).employeePayrollDeduction.groupBy({
    by: ['agreementId', 'competence'],
    where: { agreementId: { in: agreementIds }, competence: { in: competences }, status: { in: COUNTED } },
    _sum: { amount: true },
  });
  const map = new Map<string, number>();
  for (const r of rows as any[]) map.set(`${r.agreementId}|${r.competence}`, round2(Number(r._sum.amount ?? 0)));
  return map;
}

function publicView(a: any, policy: PolicyLimit, used: number, competence: string) {
  const lim = resolveLimit(a, policy);
  return {
    id: a.id,
    name: a.name,
    cpf: formatCpf(a.cpf),
    cpfMasked: maskCpf(a.cpf),
    registration: a.registration,
    salary: a.salary == null ? null : Number(a.salary),
    limitType: a.limitType,
    limitValue: a.limitValue == null ? null : Number(a.limitValue),
    effectiveLimit: lim,
    status: a.status,
    allowedBranchIds: a.allowedBranchIds ?? [],
    userId: a.userId,
    customerId: a.customerId,
    notes: a.notes,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    competence,
    limit: lim.limit,
    used,
    available: round2(Math.max(0, lim.limit - used)),
  };
}

function translateUnique(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new ConflictError('Já existe um funcionário conveniado com este CPF nesta empresa', 'CPF_ALREADY_REGISTERED');
  }
  throw e;
}

export class EmployeeAgreementService {
  async currentCompetence(companyId: string, branchId: string | null = null) {
    const policy = await policyLimit(companyId, branchId);
    return { competence: competenceOf(new Date(), policy.timezone), policy };
  }

  private async assertLinks(companyId: string, data: { userId?: string | null; customerId?: string | null }) {
    if (data.userId) {
      const u = await prisma.user.findFirst({ where: { id: data.userId, companyId }, select: { id: true } });
      if (!u) throw badRequest('Usuário vinculado não encontrado nesta empresa', 'USER_NOT_FOUND');
    }
    if (data.customerId) {
      const c = await prisma.customer.findFirst({ where: { id: data.customerId, companyId }, select: { id: true } });
      if (!c) throw badRequest('Cliente vinculado não encontrado nesta empresa', 'CUSTOMER_NOT_FOUND');
    }
  }

  async create(companyId: string, userId: string, input: unknown) {
    const data = createEmployeeAgreementSchema.parse(input);
    await this.assertLinks(companyId, data);
    await assertBranchesOfCompany(companyId, data.allowedBranchIds);
    try {
      const created = await prisma.employeeAgreement.create({
        data: {
          companyId,
          branchId: null,
          name: data.name,
          cpf: onlyDigits(data.cpf),
          registration: data.registration || null,
          salary: data.salary ?? null,
          limitType: data.limitType ?? null,
          limitValue: data.limitValue ?? null,
          userId: data.userId ?? null,
          customerId: data.customerId ?? null,
          notes: data.notes ?? null,
          allowedBranchIds: data.allowedBranchIds ?? [],
          createdBy: userId,
        },
      });
      return this.get(companyId, created.id);
    } catch (e) {
      translateUnique(e);
    }
  }

  async update(companyId: string, id: string, input: unknown) {
    const data = updateEmployeeAgreementSchema.parse(input);
    const current = await prisma.employeeAgreement.findFirst({ where: { id, companyId } });
    if (!current) throw notFound('Funcionário conveniado não encontrado', 'AGREEMENT_NOT_FOUND');
    await this.assertLinks(companyId, data);
    const patch: Prisma.EmployeeAgreementUncheckedUpdateInput = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.cpf !== undefined) patch.cpf = onlyDigits(data.cpf);
    if (data.registration !== undefined) patch.registration = data.registration || null;
    if (data.salary !== undefined) patch.salary = data.salary;
    if (data.limitType !== undefined) patch.limitType = data.limitType;
    if (data.limitValue !== undefined) patch.limitValue = data.limitValue;
    if (data.userId !== undefined) patch.userId = data.userId;
    if (data.customerId !== undefined) patch.customerId = data.customerId;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.status !== undefined) patch.status = data.status;
    if (data.allowedBranchIds !== undefined) {
      await assertBranchesOfCompany(companyId, data.allowedBranchIds);
      patch.allowedBranchIds = data.allowedBranchIds;
    }
    try {
      await prisma.employeeAgreement.update({ where: { id: current.id }, data: patch });
    } catch (e) {
      translateUnique(e);
    }
    return { before: { status: current.status, limitType: current.limitType, limitValue: current.limitValue }, agreement: await this.get(companyId, id) };
  }

  async list(companyId: string, filters: { q?: string; status?: string } = {}) {
    const { competence, policy } = await this.currentCompetence(companyId);
    const q = (filters.q ?? '').trim();
    const digits = onlyDigits(q);
    const rows = await prisma.employeeAgreement.findMany({
      where: {
        companyId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { registration: { contains: q, mode: 'insensitive' } },
                ...(digits.length >= 3 ? [{ cpf: { contains: digits } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
    const used = await usedByCompetence(prisma, rows.map((r) => r.id), [competence]);
    return {
      competence,
      policy: { enabled: policy.enabled, limitType: policy.limitType, limitValue: policy.limitValue, maxInstallments: policy.maxInstallments },
      data: rows.map((r) => publicView(r, policy, used.get(`${r.id}|${competence}`) ?? 0, competence)),
    };
  }

  /** PDV: só ativos, mínimo necessário (sem salário). Contrato: docs/CORTEX/policies/CONVENIOS.md. */
  async lookup(companyId: string, branchId: string | null, q: string) {
    const policy = await policyLimit(companyId, branchId);
    if (!policy.enabled) throw badRequest(DISABLED_MESSAGE.employee, 'AGREEMENT_DISABLED');
    const competence = competenceOf(new Date(), policy.timezone);
    const term = (q ?? '').trim();
    const digits = onlyDigits(term);
    const rows = await prisma.employeeAgreement.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { registration: { contains: term, mode: 'insensitive' } },
                ...(digits.length >= 3 ? [{ cpf: { contains: digits } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 20,
    });
    const used = await usedByCompetence(prisma, rows.map((r) => r.id), [competence]);
    return rows.map((r) => {
      const v = publicView(r, policy, used.get(`${r.id}|${competence}`) ?? 0, competence);
      return {
        id: v.id,
        name: v.name,
        cpfMasked: v.cpfMasked,
        registration: v.registration,
        status: v.status,
        limit: v.limit,
        used: v.used,
        available: v.available,
        maxInstallments: policy.maxInstallments,
        // Existe, mas não nesta filial: o PDV mostra cinza com o motivo (não esconde).
        availableHere: availableAtBranch(r.allowedBranchIds, branchId),
        unavailableReason: availableAtBranch(r.allowedBranchIds, branchId) ? null : NOT_ENABLED_FOR_BRANCH_MESSAGE,
      };
    });
  }

  async get(companyId: string, id: string) {
    const a = await prisma.employeeAgreement.findFirst({ where: { id, companyId } });
    if (!a) throw notFound('Funcionário conveniado não encontrado', 'AGREEMENT_NOT_FOUND');
    const { competence, policy } = await this.currentCompetence(companyId);
    const used = await usedByCompetence(prisma, [a.id], [competence]);
    const charges = await prisma.employeeAgreementCharge.findMany({
      where: { agreementId: a.id },
      include: { deductions: { orderBy: { installmentNumber: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const saleIds = charges.map((c) => c.saleId).filter(Boolean) as string[];
    const sales = saleIds.length
      ? await prisma.sale.findMany({ where: { id: { in: saleIds }, companyId }, select: { id: true, saleNumber: true, createdAt: true, status: true } })
      : [];
    const pending = await prisma.employeePayrollDeduction.aggregate({
      where: { agreementId: a.id, status: 'SCHEDULED' },
      _sum: { amount: true },
    });
    return {
      ...publicView(a, policy, used.get(`${a.id}|${competence}`) ?? 0, competence),
      maxInstallments: policy.maxInstallments,
      scheduledBalance: round2(Number(pending._sum.amount ?? 0)),
      charges: charges.map((c) => this.chargeView(c, sales.find((s) => s.id === c.saleId))),
    };
  }

  private chargeView(c: any, sale?: { saleNumber: number; createdAt: Date; status: string } | null) {
    const deducted = c.deductions.filter((d: any) => d.status === 'DEDUCTED');
    return {
      id: c.id,
      saleId: c.saleId,
      saleNumber: sale?.saleNumber ?? null,
      saleStatus: sale?.status ?? null,
      paymentId: c.paymentId,
      amount: Number(c.amount),
      installments: c.installments,
      firstCompetence: c.firstCompetence,
      authorizedBy: c.authorizedBy,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      cancelledAt: c.cancelledAt,
      // Venda cancelada/devolvida depois de parcela já descontada: fica registrada "a compensar" (DECISÃO NECESSÁRIA).
      toCompensate: c.cancelledAt ? round2(deducted.reduce((s: number, d: any) => s + Number(d.amount), 0)) : 0,
      deductions: c.deductions.map((d: any) => ({
        id: d.id,
        installmentNumber: d.installmentNumber,
        competence: d.competence,
        amount: Number(d.amount),
        status: d.status,
        processedAt: d.processedAt,
        processedBy: d.processedBy,
      })),
    };
  }

  async isOwnAgreement(companyId: string, id: string, userId: string) {
    const a = await prisma.employeeAgreement.findFirst({ where: { id, companyId, userId }, select: { id: true } });
    return !!a;
  }

  /** Espelho/comprovante do convênio do funcionário numa competência (tela imprimível). */
  async statement(companyId: string, id: string, competence?: string) {
    const a = await prisma.employeeAgreement.findFirst({ where: { id, companyId } });
    if (!a) throw notFound('Funcionário conveniado não encontrado', 'AGREEMENT_NOT_FOUND');
    const { competence: current, policy } = await this.currentCompetence(companyId);
    const comp = competence || current;
    if (!COMPETENCE_RE.test(comp)) throw badRequest('Competência inválida (use AAAA-MM)', 'INVALID_COMPETENCE');
    const used = await usedByCompetence(prisma, [a.id], [comp]);
    const deductions = await prisma.employeePayrollDeduction.findMany({
      where: { agreementId: a.id, competence: comp },
      include: { charge: true },
      orderBy: [{ createdAt: 'asc' }, { installmentNumber: 'asc' }],
    });
    const saleIds = [...new Set(deductions.map((d) => d.charge.saleId).filter(Boolean) as string[])];
    const sales = saleIds.length
      ? await prisma.sale.findMany({
          where: { id: { in: saleIds }, companyId },
          select: { id: true, saleNumber: true, createdAt: true, status: true, items: { select: { productName: true, quantity: true, unitPrice: true, totalPrice: true } } },
        })
      : [];
    const futureScheduled = await prisma.employeePayrollDeduction.aggregate({
      where: { agreementId: a.id, status: 'SCHEDULED', competence: { gt: comp } },
      _sum: { amount: true },
    });
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true, legalName: true, document: true } });
    const lim = resolveLimit(a, policy);
    const usedValue = used.get(`${a.id}|${comp}`) ?? 0;
    const lines = deductions.map((d) => {
      const sale = sales.find((s) => s.id === d.charge.saleId);
      return {
        deductionId: d.id,
        chargeId: d.chargeId,
        saleNumber: sale?.saleNumber ?? null,
        purchaseDate: sale?.createdAt ?? d.charge.createdAt,
        items: (sale?.items ?? []).map((i) => ({ productName: i.productName, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), totalPrice: Number(i.totalPrice) })),
        purchaseAmount: Number(d.charge.amount),
        installmentNumber: d.installmentNumber,
        installments: d.charge.installments,
        amount: Number(d.amount),
        status: d.status,
        chargeCancelled: !!d.charge.cancelledAt,
        authorizedBy: d.charge.authorizedBy,
        processedAt: d.processedAt,
      };
    });
    return {
      company: company ? { name: company.name, legalName: company.legalName, document: company.document } : null,
      employee: { id: a.id, name: a.name, cpf: formatCpf(a.cpf), registration: a.registration, status: a.status },
      competence: comp,
      limit: lim.limit,
      limitType: lim.limitType,
      limitSource: lim.source,
      used: usedValue,
      available: round2(Math.max(0, lim.limit - usedValue)),
      totals: {
        scheduled: round2(lines.filter((l) => l.status === 'SCHEDULED').reduce((s, l) => s + l.amount, 0)),
        deducted: round2(lines.filter((l) => l.status === 'DEDUCTED').reduce((s, l) => s + l.amount, 0)),
        cancelled: round2(lines.filter((l) => l.status === 'CANCELLED').reduce((s, l) => s + l.amount, 0)),
      },
      futureScheduled: round2(Number(futureScheduled._sum.amount ?? 0)),
      lines,
      legalNotice: 'Desconto em folha conforme autorização do funcionário. A empresa deve respeitar a legislação trabalhista aplicável.',
      generatedAt: new Date(),
    };
  }

  /** Folha: parcelas de uma competência, para a empresa lançar no sistema de folha e dar baixa aqui. */
  async listDeductions(companyId: string, competence: string | undefined, status?: string) {
    const { competence: current } = await this.currentCompetence(companyId);
    const comp = competence || current;
    if (!COMPETENCE_RE.test(comp)) throw badRequest('Competência inválida (use AAAA-MM)', 'INVALID_COMPETENCE');
    const rows = await prisma.employeePayrollDeduction.findMany({
      where: { companyId, competence: comp, ...(status ? { status } : {}) },
      include: { charge: { include: { agreement: { select: { id: true, name: true, cpf: true, registration: true } } } } },
      orderBy: [{ createdAt: 'asc' }],
    });
    const saleIds = [...new Set(rows.map((r) => r.charge.saleId).filter(Boolean) as string[])];
    const sales = saleIds.length ? await prisma.sale.findMany({ where: { id: { in: saleIds }, companyId }, select: { id: true, saleNumber: true } }) : [];
    const items = rows.map((r) => ({
      id: r.id,
      competence: r.competence,
      installmentNumber: r.installmentNumber,
      installments: r.charge.installments,
      amount: Number(r.amount),
      status: r.status,
      processedAt: r.processedAt,
      processedBy: r.processedBy,
      chargeId: r.chargeId,
      chargeCancelled: !!r.charge.cancelledAt,
      saleNumber: sales.find((s) => s.id === r.charge.saleId)?.saleNumber ?? null,
      employee: { id: r.charge.agreement.id, name: r.charge.agreement.name, cpfMasked: maskCpf(r.charge.agreement.cpf), registration: r.charge.agreement.registration },
    }));
    const sum = (st: string) => round2(items.filter((i) => i.status === st).reduce((s, i) => s + i.amount, 0));
    const byEmployee = new Map<string, { employee: any; scheduled: number; deducted: number }>();
    for (const i of items) {
      const e = byEmployee.get(i.employee.id) ?? { employee: i.employee, scheduled: 0, deducted: 0 };
      if (i.status === 'SCHEDULED') e.scheduled = round2(e.scheduled + i.amount);
      if (i.status === 'DEDUCTED') e.deducted = round2(e.deducted + i.amount);
      byEmployee.set(i.employee.id, e);
    }
    return {
      competence: comp,
      currentCompetence: current,
      totals: { scheduled: sum('SCHEDULED'), deducted: sum('DEDUCTED'), cancelled: sum('CANCELLED') },
      byEmployee: [...byEmployee.values()].sort((x, y) => x.employee.name.localeCompare(y.employee.name)),
      items,
    };
  }

  /** Baixa de uma parcela processada na folha (gerência+). Guarda atômica: só SCHEDULED vira DEDUCTED, uma vez. */
  async processDeduction(companyId: string, id: string, userId: string) {
    const d = await prisma.employeePayrollDeduction.findFirst({ where: { id, companyId }, include: { charge: { select: { cancelledAt: true } } } });
    if (!d) throw notFound('Parcela de folha não encontrada', 'DEDUCTION_NOT_FOUND');
    const { competence: current } = await this.currentCompetence(companyId);
    if (d.competence > current) {
      throw new ConflictError(`Parcela da competência ${d.competence} ainda não pode ser baixada (competência atual ${current})`, 'DEDUCTION_FUTURE_COMPETENCE');
    }
    const done = await prisma.employeePayrollDeduction.updateMany({
      where: { id, companyId, status: 'SCHEDULED' },
      data: { status: 'DEDUCTED', processedAt: new Date(), processedBy: userId },
    });
    if (done.count === 0) {
      const now = await prisma.employeePayrollDeduction.findFirst({ where: { id }, select: { status: true } });
      throw new ConflictError(
        now?.status === 'DEDUCTED' ? 'Esta parcela já foi baixada' : 'Parcela cancelada (venda cancelada/devolvida) não pode ser baixada',
        'DEDUCTION_NOT_SCHEDULED'
      );
    }
    return prisma.employeePayrollDeduction.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Na transação do pagamento (venda já travada): trava o convênio, confere situação e limite em cada competência e
   * cria a utilização + parcelas. Qualquer recusa desfaz o pagamento inteiro.
   */
  /**
   * Trava a linha do convênio ANTES de gravar o pagamento. A FK composta payments → employee_agreements faz o INSERT do
   * pagamento tomar FOR KEY SHARE na linha; travar FOR UPDATE só depois, com dois pagamentos simultâneos, é impasse
   * (cada transação segura o KEY SHARE e espera o UPDATE da outra). Também devolve o erro humano para convênio de outra
   * empresa/inexistente em vez de deixar a FK recusar o INSERT.
   */
  async lockForPayment(tx: PrismaTransactionClient, companyId: string, agreementId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM employee_agreements WHERE id = ${agreementId} AND "companyId" = ${companyId} FOR UPDATE`;
    if (locked.length === 0) throw notFound('Funcionário conveniado não encontrado', 'AGREEMENT_NOT_FOUND');
  }

  async createChargeForPayment(
    tx: PrismaTransactionClient,
    input: { companyId: string; branchId: string | null; agreementId: string; saleId: string; paymentId: string; amount: number; installments: number; userId?: string | null; timezone: string; policy: { limitType: LimitType; limitValue: number } }
  ) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM employee_agreements WHERE id = ${input.agreementId} AND "companyId" = ${input.companyId} FOR UPDATE`;
    if (locked.length === 0) throw notFound('Funcionário conveniado não encontrado', 'AGREEMENT_NOT_FOUND');
    const a = await tx.employeeAgreement.findUniqueOrThrow({ where: { id: input.agreementId } });
    if (a.status !== 'ACTIVE') {
      throw new ConflictError(`Convênio de ${a.name} está ${a.status === 'SUSPENDED' ? 'suspenso' : 'encerrado'}: não aceita compras`, 'AGREEMENT_INACTIVE');
    }
    // Filial da VENDA (não do corpo do pedido): empresa + filial + convênio.
    if (!availableAtBranch(a.allowedBranchIds, input.branchId)) {
      throw new ConflictError(NOT_ENABLED_FOR_BRANCH_MESSAGE, 'AGREEMENT_NOT_ENABLED_FOR_BRANCH');
    }
    const { limit } = resolveLimit(a, input.policy);
    const first = competenceOf(new Date(), input.timezone);
    const parts = splitInstallments(input.amount, input.installments);
    const comps = parts.map((_, i) => addCompetence(first, i));
    const used = await usedByCompetence(tx, [a.id], comps);
    for (let i = 0; i < parts.length; i++) {
      const u = used.get(`${a.id}|${comps[i]}`) ?? 0;
      const available = round2(Math.max(0, limit - u));
      if (parts[i] > available + 0.001) {
        throw new AgreementLimitError(
          `Limite do convênio excedido na competência ${comps[i]}: disponível ${brl(available)}, parcela ${brl(parts[i])}`,
          { competence: comps[i], limit, used: u, available, requested: parts[i], installments: input.installments }
        );
      }
    }
    const charge = await tx.employeeAgreementCharge.create({
      data: {
        companyId: input.companyId,
        branchId: null,
        agreementId: a.id,
        saleId: input.saleId,
        paymentId: input.paymentId,
        amount: input.amount,
        installments: input.installments,
        firstCompetence: first,
        authorizedBy: input.userId ?? null,
        createdBy: input.userId ?? 'SYSTEM',
      },
    });
    await tx.employeePayrollDeduction.createMany({
      data: parts.map((amount, i) => ({
        companyId: input.companyId,
        branchId: null,
        chargeId: charge.id,
        agreementId: a.id,
        installmentNumber: i + 1,
        competence: comps[i],
        amount,
        status: 'SCHEDULED',
      })),
    });
    return charge;
  }
}

export const employeeAgreementService = new EmployeeAgreementService();
export default employeeAgreementService;
