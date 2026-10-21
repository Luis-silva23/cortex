import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, runWithRLSContext, PrismaTransactionClient, AuditAction } from '@ln-system/database';
import { ConflictError } from '@ln-system/shared';
import { isValidCNPJ } from '@ln-system/shared/utils/validation';
import { policyService } from './policy.service';
import { Logger } from './logger.service';
import {
  AgreementLimitError,
  DAY_MS,
  DISABLED_MESSAGE,
  NOT_ENABLED_FOR_BRANCH_MESSAGE,
  allowedBranchIdsSchema,
  assertBranchesOfCompany,
  availableAtBranch,
  badRequest,
  brl,
  daysOverdue,
  dueDateAfterDays,
  formatCnpj,
  maskCnpj,
  notFound,
  onlyDigits,
  round2,
  startOfLocalMonth,
} from './agreement-common';

/**
 * CONVÊNIO COM EMPRESA EXTERNA (docs/CORTEX/policies/CONVENIOS.md e FINANCEIRO.md).
 *
 * VENDA/CONSUMO → CONTA A RECEBER (agreementCompanyId; vencimento = data + prazo) → VENCIMENTO → COBRANÇA (manual) →
 * PAGAMENTO → BAIXA (fluxo existente de contas a receber, POST /financial/receivables/:id/receive).
 *
 * - Utilizado = contas em aberto (PENDING/OVERDUE) da conveniada; disponível = menor entre (limite de crédito − utilizado)
 *   e (limite mensal − compras do mês). Limite vazio = sem limite naquela dimensão.
 * - Juros/multa: só INFORMATIVOS (calculados sobre o atraso quando as taxas estão cadastradas). Nada é lançado na conta
 *   automaticamente — [DECISÃO NECESSÁRIA].
 * - Bloqueio: automático (job diário, `blockAfterDaysOverdue` próprio ou padrão da política) ou manual com motivo.
 *   Bloqueada não compra (409 AGREEMENT_BLOCKED); histórico, dívida e cobrança continuam. Nada é apagado.
 * - Conveniada é da EMPRESA inteira (branchId nulo): todas as filiais veem a mesma situação e o mesmo limite.
 */

const OPEN = ['PENDING', 'OVERDUE'] as const;
export const AGREEMENT_RECEIVABLE_REF = 'AgreementPayment';

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const optMoney = z.number().min(0, 'Valor não pode ser negativo').max(100_000_000).nullish();
const optPercent = z.number().min(0, 'Mínimo 0%').max(100, 'Máximo 100%').nullish();

const baseSchema = z.object({
  legalName: z.string().trim().min(2, 'Informe a razão social').max(200),
  tradeName: optText(200),
  cnpj: z.string().refine((v) => isValidCNPJ(v), 'CNPJ inválido'),
  contactName: optText(120),
  phone: optText(30),
  whatsapp: optText(30),
  email: z.string().trim().email('E-mail inválido').max(200).nullish().or(z.literal('')).transform((v) => (v ? v : null)),
  zipCode: optText(12),
  street: optText(200),
  number: optText(20),
  complement: optText(100),
  district: optText(100),
  city: optText(100),
  state: optText(2),
  commercialTerms: optText(2000),
  creditLimit: optMoney,
  monthlyLimit: optMoney,
  paymentTermDays: z.number().int('Use um número inteiro').min(1, 'Mínimo 1 dia').max(365, 'Máximo 365 dias').optional(),
  interestPercentMonthly: optPercent,
  finePercent: optPercent,
  blockAfterDaysOverdue: z.number().int().min(1).max(365).nullish(),
  notes: optText(1000),
  /** Filiais em que a conveniada pode comprar; vazio = todas. */
  allowedBranchIds: allowedBranchIdsSchema.optional(),
});

export const createAgreementCompanySchema = baseSchema;
export const updateAgreementCompanySchema = baseSchema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });

type Db = PrismaTransactionClient | typeof prisma;

export interface AgreementFinancials {
  openBalance: number;
  openCount: number;
  overdueAmount: number;
  overdueCount: number;
  maxDaysOverdue: number;
  monthUsed: number;
  creditLimit: number | null;
  monthlyLimit: number | null;
  creditAvailable: number | null;
  monthlyAvailable: number | null;
  /** null = sem limite cadastrado */
  available: number | null;
  delinquent: boolean;
}

async function financialsFor(db: Db, ac: { id: string; creditLimit: any; monthlyLimit: any }, monthStart: Date, now = new Date()): Promise<AgreementFinancials> {
  const open = await (db as any).accountsReceivable.findMany({
    where: { agreementCompanyId: ac.id, status: { in: OPEN } },
    select: { amount: true, dueDate: true },
  });
  const month = await (db as any).accountsReceivable.aggregate({
    where: { agreementCompanyId: ac.id, status: { not: 'CANCELLED' }, createdAt: { gte: monthStart }, amount: { gt: 0 } },
    _sum: { amount: true },
  });
  const openBalance = round2(open.reduce((s: number, r: any) => s + Number(r.amount), 0));
  const overdue = open.filter((r: any) => new Date(r.dueDate).getTime() < now.getTime());
  const overdueAmount = round2(overdue.reduce((s: number, r: any) => s + Number(r.amount), 0));
  const maxDaysOverdue = overdue.reduce((m: number, r: any) => Math.max(m, daysOverdue(r.dueDate, now)), 0);
  const monthUsed = round2(Number(month._sum.amount ?? 0));
  const creditLimit = ac.creditLimit == null ? null : Number(ac.creditLimit);
  const monthlyLimit = ac.monthlyLimit == null ? null : Number(ac.monthlyLimit);
  const creditAvailable = creditLimit == null ? null : round2(Math.max(0, creditLimit - openBalance));
  const monthlyAvailable = monthlyLimit == null ? null : round2(Math.max(0, monthlyLimit - monthUsed));
  const candidates = [creditAvailable, monthlyAvailable].filter((v): v is number => v != null);
  return {
    openBalance,
    openCount: open.length,
    overdueAmount,
    overdueCount: overdue.length,
    maxDaysOverdue,
    monthUsed,
    creditLimit,
    monthlyLimit,
    creditAvailable,
    monthlyAvailable,
    available: candidates.length ? Math.min(...candidates) : null,
    delinquent: overdue.length > 0,
  };
}

/** Juros/multa sobre atraso — SÓ informação (não lançado na conta). */
export function lateChargesInfo(amount: number, days: number, ac: { interestPercentMonthly: any; finePercent: any }) {
  if (days <= 0 || (ac.interestPercentMonthly == null && ac.finePercent == null)) return null;
  const fine = ac.finePercent == null ? 0 : round2((amount * Number(ac.finePercent)) / 100);
  const interest = ac.interestPercentMonthly == null ? 0 : round2((amount * Number(ac.interestPercentMonthly) * days) / 100 / 30);
  return {
    fine,
    interest,
    total: round2(amount + fine + interest),
    basis: 'Informativo: multa sobre o valor + juros simples pro rata dia (mês de 30 dias). Não lançado na conta.',
  };
}

function view(ac: any) {
  return {
    id: ac.id,
    legalName: ac.legalName,
    tradeName: ac.tradeName,
    cnpj: formatCnpj(ac.cnpj),
    cnpjMasked: maskCnpj(ac.cnpj),
    contactName: ac.contactName,
    phone: ac.phone,
    whatsapp: ac.whatsapp,
    email: ac.email,
    zipCode: ac.zipCode,
    street: ac.street,
    number: ac.number,
    complement: ac.complement,
    district: ac.district,
    city: ac.city,
    state: ac.state,
    commercialTerms: ac.commercialTerms,
    creditLimit: ac.creditLimit == null ? null : Number(ac.creditLimit),
    monthlyLimit: ac.monthlyLimit == null ? null : Number(ac.monthlyLimit),
    paymentTermDays: ac.paymentTermDays,
    interestPercentMonthly: ac.interestPercentMonthly == null ? null : Number(ac.interestPercentMonthly),
    finePercent: ac.finePercent == null ? null : Number(ac.finePercent),
    blockAfterDaysOverdue: ac.blockAfterDaysOverdue,
    status: ac.status,
    blockedAt: ac.blockedAt,
    blockedBy: ac.blockedBy,
    blockedReason: ac.blockedReason,
    allowedBranchIds: ac.allowedBranchIds ?? [],
    notes: ac.notes,
    createdAt: ac.createdAt,
    updatedAt: ac.updatedAt,
  };
}

function translateUnique(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new ConflictError('Já existe uma empresa conveniada com este CNPJ nesta empresa', 'CNPJ_ALREADY_REGISTERED');
  }
  throw e;
}

export class AgreementCompanyService {
  private async timezone(companyId: string, branchId: string | null = null) {
    return policyService.get(companyId, branchId, 'company.timezone');
  }

  async create(companyId: string, userId: string, input: unknown) {
    const data = createAgreementCompanySchema.parse(input);
    await assertBranchesOfCompany(companyId, data.allowedBranchIds);
    const defaultTerm = await policyService.get(companyId, null, 'companyAgreement.defaultPaymentTermDays');
    try {
      const created = await prisma.agreementCompany.create({
        data: {
          ...data,
          companyId,
          branchId: null,
          cnpj: onlyDigits(data.cnpj),
          paymentTermDays: data.paymentTermDays ?? defaultTerm,
          creditLimit: data.creditLimit ?? null,
          monthlyLimit: data.monthlyLimit ?? null,
          interestPercentMonthly: data.interestPercentMonthly ?? null,
          finePercent: data.finePercent ?? null,
          blockAfterDaysOverdue: data.blockAfterDaysOverdue ?? null,
          createdBy: userId,
        },
      });
      return view(created);
    } catch (e) {
      translateUnique(e);
    }
  }

  async update(companyId: string, id: string, input: unknown) {
    const data = updateAgreementCompanySchema.parse(input);
    const current = await prisma.agreementCompany.findFirst({ where: { id, companyId } });
    if (!current) throw notFound('Empresa conveniada não encontrada', 'AGREEMENT_NOT_FOUND');
    if (data.status && current.status === 'BLOCKED') {
      throw new ConflictError('Empresa bloqueada: use Desbloquear (com motivo) antes de mudar a situação', 'AGREEMENT_BLOCKED');
    }
    await assertBranchesOfCompany(companyId, data.allowedBranchIds);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = k === 'cnpj' ? onlyDigits(v as string) : v;
    try {
      const updated = await prisma.agreementCompany.update({ where: { id: current.id }, data: patch });
      return { before: view(current), agreement: view(updated) };
    } catch (e) {
      translateUnique(e);
    }
  }

  async list(companyId: string, filters: { q?: string; status?: string } = {}) {
    const tz = await this.timezone(companyId);
    const monthStart = startOfLocalMonth(new Date(), tz);
    const q = (filters.q ?? '').trim();
    const digits = onlyDigits(q);
    const rows = await prisma.agreementCompany.findMany({
      where: {
        companyId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(q
          ? {
              OR: [
                { legalName: { contains: q, mode: 'insensitive' } },
                { tradeName: { contains: q, mode: 'insensitive' } },
                ...(digits.length >= 3 ? [{ cnpj: { contains: digits } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { legalName: 'asc' },
      take: 200,
    });
    const data = [];
    for (const r of rows) data.push({ ...view(r), financials: await financialsFor(prisma, r, monthStart) });
    return { data };
  }

  /** PDV: ativas e bloqueadas (o caixa precisa saber que está bloqueada); inativas ficam fora. */
  async lookup(companyId: string, branchId: string | null, q: string) {
    const policies = await policyService.effective(companyId, branchId);
    if (!policies['companyAgreement.enabled']) throw badRequest(DISABLED_MESSAGE.company, 'AGREEMENT_DISABLED');
    const monthStart = startOfLocalMonth(new Date(), policies['company.timezone']);
    const term = (q ?? '').trim();
    const digits = onlyDigits(term);
    const rows = await prisma.agreementCompany.findMany({
      where: {
        companyId,
        status: { in: ['ACTIVE', 'BLOCKED'] },
        ...(term
          ? {
              OR: [
                { legalName: { contains: term, mode: 'insensitive' } },
                { tradeName: { contains: term, mode: 'insensitive' } },
                ...(digits.length >= 3 ? [{ cnpj: { contains: digits } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { legalName: 'asc' },
      take: 20,
    });
    const out = [];
    for (const r of rows) {
      const f = await financialsFor(prisma, r, monthStart);
      out.push({
        id: r.id,
        legalName: r.legalName,
        tradeName: r.tradeName,
        cnpjMasked: maskCnpj(r.cnpj),
        status: r.status,
        available: f.available,
        paymentTermDays: r.paymentTermDays,
        // Existe, mas não nesta filial: o PDV mostra cinza com o motivo (não esconde).
        availableHere: availableAtBranch(r.allowedBranchIds, branchId),
        unavailableReason: availableAtBranch(r.allowedBranchIds, branchId) ? null : NOT_ENABLED_FOR_BRANCH_MESSAGE,
      });
    }
    return out;
  }

  async summary(companyId: string, id: string) {
    const ac = await prisma.agreementCompany.findFirst({ where: { id, companyId } });
    if (!ac) throw notFound('Empresa conveniada não encontrada', 'AGREEMENT_NOT_FOUND');
    const tz = await this.timezone(companyId);
    const now = new Date();
    const financials = await financialsFor(prisma, ac, startOfLocalMonth(now, tz), now);
    const effectiveBlockAfter = ac.blockAfterDaysOverdue ?? (await policyService.get(companyId, null, 'companyAgreement.defaultBlockAfterDaysOverdue'));
    return { ...view(ac), financials, effectiveBlockAfterDaysOverdue: effectiveBlockAfter };
  }

  async detail(companyId: string, id: string) {
    const summary = await this.summary(companyId, id);
    const now = new Date();
    const receivables = await prisma.accountsReceivable.findMany({
      where: { companyId, agreementCompanyId: id },
      orderBy: { dueDate: 'desc' },
      take: 200,
      include: { _count: { select: { collectionAttempts: true } } },
    });
    const history = await prisma.auditLog.findMany({
      where: { companyId, entity: { in: ['AgreementCompany', 'AgreementCompanyBlock'] }, entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, entity: true, newValue: true, userId: true, createdAt: true },
    });
    return {
      ...summary,
      receivables: receivables.map((r) => {
        const open = (OPEN as readonly string[]).includes(r.status);
        const days = open ? daysOverdue(r.dueDate, now) : 0;
        return {
          id: r.id,
          description: r.description,
          amount: Number(r.amount),
          dueDate: r.dueDate,
          paidDate: r.paidDate,
          status: r.status,
          createdAt: r.createdAt,
          overdue: open && days > 0,
          daysOverdue: days,
          lateCharges: open ? lateChargesInfo(Number(r.amount), days, summary) : null,
          collectionAttempts: r._count.collectionAttempts,
        };
      }),
      history: history.map((h) => {
        let value: unknown = h.newValue;
        try {
          value = h.newValue ? JSON.parse(h.newValue) : null;
        } catch {
          /* texto livre */
        }
        return { id: h.id, action: h.action, entity: h.entity, userId: h.userId, createdAt: h.createdAt, value };
      }),
    };
  }

  async block(companyId: string, id: string, userId: string, reason: string) {
    const text = (reason ?? '').trim();
    if (text.length < 5) throw badRequest('Informe o motivo do bloqueio (mínimo 5 caracteres)', 'REASON_REQUIRED');
    const done = await prisma.agreementCompany.updateMany({
      where: { id, companyId, status: 'ACTIVE' },
      data: { status: 'BLOCKED', blockedAt: new Date(), blockedBy: userId, blockedReason: text },
    });
    if (done.count === 0) {
      const now = await prisma.agreementCompany.findFirst({ where: { id, companyId }, select: { status: true } });
      if (!now) throw notFound('Empresa conveniada não encontrada', 'AGREEMENT_NOT_FOUND');
      throw new ConflictError(now.status === 'BLOCKED' ? 'Empresa já está bloqueada' : 'Só uma conveniada ativa pode ser bloqueada', 'AGREEMENT_STATUS_CONFLICT');
    }
    return view(await prisma.agreementCompany.findUniqueOrThrow({ where: { id } }));
  }

  async unblock(companyId: string, id: string, userId: string, reason: string) {
    const text = (reason ?? '').trim();
    if (text.length < 5) throw badRequest('Informe o motivo do desbloqueio (mínimo 5 caracteres)', 'REASON_REQUIRED');
    const before = await prisma.agreementCompany.findFirst({ where: { id, companyId } });
    if (!before) throw notFound('Empresa conveniada não encontrada', 'AGREEMENT_NOT_FOUND');
    const done = await prisma.agreementCompany.updateMany({
      where: { id, companyId, status: 'BLOCKED' },
      data: { status: 'ACTIVE', blockedAt: null, blockedBy: null, blockedReason: null },
    });
    if (done.count === 0) throw new ConflictError('Empresa não está bloqueada', 'AGREEMENT_STATUS_CONFLICT');
    return { previousBlock: { blockedAt: before.blockedAt, blockedBy: before.blockedBy, blockedReason: before.blockedReason }, unblockedBy: userId, agreement: view(await prisma.agreementCompany.findUniqueOrThrow({ where: { id } })) };
  }

  /**
   * Na transação do pagamento (venda já travada): trava a conveniada, confere situação e limite e cria a conta a
   * receber com vencimento = data + prazo. Qualquer recusa desfaz o pagamento inteiro.
   */
  /** Mesma razão de `employeeAgreementService.lockForPayment`: trava a conveniada antes do INSERT do pagamento (FK composta). */
  async lockForPayment(tx: PrismaTransactionClient, companyId: string, agreementCompanyId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agreement_companies WHERE id = ${agreementCompanyId} AND "companyId" = ${companyId} FOR UPDATE`;
    if (locked.length === 0) throw notFound('Empresa conveniada não encontrada', 'AGREEMENT_NOT_FOUND');
  }

  async createReceivableForPayment(
    tx: PrismaTransactionClient,
    input: { companyId: string; agreementCompanyId: string; sale: { id: string; saleNumber: number; branchId: string | null }; paymentId: string; amount: number; timezone: string }
  ) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agreement_companies WHERE id = ${input.agreementCompanyId} AND "companyId" = ${input.companyId} FOR UPDATE`;
    if (locked.length === 0) throw notFound('Empresa conveniada não encontrada', 'AGREEMENT_NOT_FOUND');
    const ac = await tx.agreementCompany.findUniqueOrThrow({ where: { id: input.agreementCompanyId } });
    const name = ac.tradeName || ac.legalName;
    if (ac.status === 'BLOCKED') {
      throw new ConflictError(`${name} está bloqueada${ac.blockedReason ? ` (${ac.blockedReason})` : ''}: compra pelo convênio não permitida`, 'AGREEMENT_BLOCKED');
    }
    if (ac.status !== 'ACTIVE') throw new ConflictError(`${name} está inativa: compra pelo convênio não permitida`, 'AGREEMENT_INACTIVE');
    // Filial da VENDA (não do corpo do pedido): empresa + filial + convênio.
    if (!availableAtBranch(ac.allowedBranchIds, input.sale.branchId)) {
      throw new ConflictError(NOT_ENABLED_FOR_BRANCH_MESSAGE, 'AGREEMENT_NOT_ENABLED_FOR_BRANCH');
    }
    const now = new Date();
    const f = await financialsFor(tx, ac, startOfLocalMonth(now, input.timezone), now);
    if (f.available != null && input.amount > f.available + 0.001) {
      throw new AgreementLimitError(`Limite da conveniada excedido: disponível ${brl(f.available)}, compra ${brl(input.amount)}`, {
        available: f.available,
        creditAvailable: f.creditAvailable,
        monthlyAvailable: f.monthlyAvailable,
        requested: input.amount,
      });
    }
    return tx.accountsReceivable.create({
      data: {
        companyId: input.companyId,
        branchId: input.sale.branchId,
        description: `Convênio ${name} — venda #${input.sale.saleNumber}`,
        amount: input.amount,
        dueDate: dueDateAfterDays(now, ac.paymentTermDays, input.timezone),
        status: 'PENDING',
        referenceType: AGREEMENT_RECEIVABLE_REF,
        referenceId: input.paymentId,
        agreementCompanyId: ac.id,
        notes: `Prazo de ${ac.paymentTermDays} dias (venda ${input.sale.id})`,
      },
    });
  }

  /**
   * Job diário: conveniada ATIVA com conta vencida há MAIS de X dias (X = próprio ou padrão da política; vazio = só
   * manual) → BLOCKED (blockedBy 'SYSTEM', motivo com os dias). Roda para todas as empresas, cada uma com a própria
   * política. Não envia nada a ninguém (cobrança é sempre manual).
   */
  async autoBlockOverdue(now: Date = new Date()) {
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const overdue = await prisma.accountsReceivable.groupBy({
        by: ['agreementCompanyId'],
        where: { agreementCompanyId: { not: null }, status: { in: [...OPEN] }, dueDate: { lt: now } },
        _min: { dueDate: true },
      });
      let checked = 0;
      let blocked = 0;
      const policyCache = new Map<string, number | null>();
      for (const row of overdue) {
        if (!row.agreementCompanyId || !row._min.dueDate) continue;
        const ac = await prisma.agreementCompany.findFirst({ where: { id: row.agreementCompanyId, status: 'ACTIVE' } });
        if (!ac) continue;
        checked++;
        if (!policyCache.has(ac.companyId)) {
          policyCache.set(ac.companyId, await policyService.get(ac.companyId, null, 'companyAgreement.defaultBlockAfterDaysOverdue'));
        }
        const threshold = ac.blockAfterDaysOverdue ?? policyCache.get(ac.companyId) ?? null;
        if (threshold == null) continue;
        const days = Math.floor((now.getTime() - row._min.dueDate.getTime()) / DAY_MS);
        if (days <= threshold) continue;
        const reason = `Bloqueio automático: conta vencida há ${days} dias (limite da política: ${threshold} dias)`;
        const done = await prisma.agreementCompany.updateMany({
          where: { id: ac.id, status: 'ACTIVE' },
          data: { status: 'BLOCKED', blockedAt: now, blockedBy: 'SYSTEM', blockedReason: reason },
        });
        if (done.count === 1) {
          blocked++;
          await prisma.auditLog.create({
            data: {
              companyId: ac.companyId,
              userId: null,
              action: AuditAction.UPDATE,
              entity: 'AgreementCompanyBlock',
              entityId: ac.id,
              newValue: JSON.stringify({ acao: 'BLOQUEIO_AUTOMATICO', motivo: reason, diasAtraso: days, limiteDias: threshold, por: 'SYSTEM' }),
            },
          });
          Logger.info('Agreement company auto-blocked', { companyId: ac.companyId, agreementCompanyId: ac.id, days, threshold });
        }
      }
      return { checked, blocked };
    });
  }
}

export const agreementCompanyService = new AgreementCompanyService();
export default agreementCompanyService;
