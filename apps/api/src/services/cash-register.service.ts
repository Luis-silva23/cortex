import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { Prisma, PaymentMethod } from '@prisma/client';
import { AppError, ConflictError } from '@ln-system/shared';
import { Logger } from './logger.service';
import { verifyDualAuthorization } from './dual-authorization.service';
import { policyService } from './policy.service';

// Perfis autorizados a aprovar uma retirada de caixa — mesmo critério usado
// em outras ações sensíveis de dinheiro/estoque físico no LN System
// (gerência para cima), não um valor arbitrário.
const WITHDRAWAL_AUTHORIZER_ROLES = ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];

/**
 * Pendências de um caixa (docs/CORTEX/policies/CAIXA.md): pagamentos ainda não confirmados (PENDING) de vendas deste
 * caixa e vendas deste caixa em aberto (PENDING / PARTIALLY_PAID). Nada disso é alterado pelo fechamento — nem normal
 * nem forçado: a venda continua em aberto, o pagamento continua pendente (a reconciliação segue valendo), e o
 * fechamento forçado guarda a fotografia do momento em `pendingSnapshot`.
 */
export interface CashRegisterPendencies {
  pendingPayments: Array<{ paymentId: string; saleId: string; saleNumber: number; paymentMethod: string; amount: number; createdAt: Date }>;
  openSales: Array<{ saleId: string; saleNumber: number; status: string; totalAmount: number; paidAmount: number; balance: number; saleDate: Date }>;
  totals: { pendingPaymentsCount: number; pendingPaymentsAmount: number; openSalesCount: number; openSalesBalance: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const FORCE_CLOSE_REASON_MIN = 10;

export async function listRegisterPendencies(db: PrismaTransactionClient, cashRegisterId: string): Promise<CashRegisterPendencies> {
  const [payments, sales] = await Promise.all([
    db.payment.findMany({
      where: { status: 'PENDING', sale: { cashRegisterId } },
      select: { id: true, saleId: true, paymentMethod: true, amount: true, createdAt: true, sale: { select: { saleNumber: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.sale.findMany({
      where: { cashRegisterId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      select: { id: true, saleNumber: true, status: true, totalAmount: true, paidAmount: true, saleDate: true },
      orderBy: { saleNumber: 'asc' },
    }),
  ]);
  const pendingPayments = payments.map((p) => ({
    paymentId: p.id,
    saleId: p.saleId,
    saleNumber: p.sale?.saleNumber ?? 0,
    paymentMethod: String(p.paymentMethod),
    amount: Number(p.amount),
    createdAt: p.createdAt,
  }));
  const openSales = sales.map((s) => ({
    saleId: s.id,
    saleNumber: s.saleNumber,
    status: String(s.status),
    totalAmount: Number(s.totalAmount),
    paidAmount: Number(s.paidAmount),
    balance: r2(Number(s.totalAmount) - Number(s.paidAmount)),
    saleDate: s.saleDate,
  }));
  return {
    pendingPayments,
    openSales,
    totals: {
      pendingPaymentsCount: pendingPayments.length,
      pendingPaymentsAmount: r2(pendingPayments.reduce((sum, p) => sum + p.amount, 0)),
      openSalesCount: openSales.length,
      openSalesBalance: r2(openSales.reduce((sum, s) => sum + s.balance, 0)),
    },
  };
}

/**
 * Esperado por forma de pagamento (regra do dono, 2026-09-28 — docs/CORTEX/policies/CAIXA.md): o fechamento considera
 * TODO o movimento do caixa. Cada forma = vendas recebidas nela − estornos dela; o dinheiro soma ainda fundo de troco e
 * reforços e desconta sangrias. Estorno sem forma no movimento (cancelamento/devolução de venda) é rateado pelo que a
 * venda pagou NESTE caixa em cada forma; sem como identificar, vai para `NAO_IDENTIFICADO` (nunca some).
 */
export const UNATTRIBUTED_METHOD = 'NAO_IDENTIFICADO';
export interface ExpectedMethodRow {
  method: string;
  sales: number;
  refunds: number;
  opening: number;
  deposits: number;
  withdrawals: number;
  expected: number;
}
export interface ExpectedBreakdown {
  total: number;
  byMethod: ExpectedMethodRow[];
}
type LedgerMovement = { movementType: string; amount: unknown; paymentMethod?: unknown; referenceType?: string | null; referenceId?: string | null };

function prorate(amount: number, entries: Map<string, number>): Array<[string, number]> {
  const list = [...entries];
  const base = list.reduce((sum, [, v]) => sum + v, 0);
  let allocated = 0;
  return list.map(([method, value], i) => {
    const share = i === list.length - 1 ? r2(amount - allocated) : r2((amount * value) / base);
    allocated = r2(allocated + share);
    return [method, share];
  });
}

export async function expectedByMethod(db: PrismaTransactionClient, companyId: string, movements: LedgerMovement[]) {
  const rows = new Map<string, ExpectedMethodRow>();
  const row = (method: string) => {
    if (!rows.has(method)) rows.set(method, { method, sales: 0, refunds: 0, opening: 0, deposits: 0, withdrawals: 0, expected: 0 });
    return rows.get(method)!;
  };
  const ids = new Set<string>();
  for (const m of movements) {
    if (m.referenceId && ((m.movementType === 'SALE' && m.referenceType === 'Payment') || m.referenceType === 'PaymentReversal')) ids.add(m.referenceId);
  }
  const payments = ids.size
    ? await db.payment.findMany({ where: { companyId, id: { in: [...ids] } }, select: { id: true, saleId: true, paymentMethod: true } })
    : [];
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  // O que cada venda pagou NESTE caixa, por forma — base do rateio dos estornos de venda.
  const paidBySale = new Map<string, Map<string, number>>();
  for (const m of movements) {
    if (m.movementType !== 'SALE' || !m.paymentMethod || !m.referenceId) continue;
    const p = paymentById.get(m.referenceId);
    if (!p) continue;
    const bySale = paidBySale.get(p.saleId) ?? new Map<string, number>();
    bySale.set(String(m.paymentMethod), (bySale.get(String(m.paymentMethod)) ?? 0) + Number(m.amount));
    paidBySale.set(p.saleId, bySale);
  }
  for (const m of movements) {
    const amount = Number(m.amount);
    switch (m.movementType) {
      case 'OPENING':
        row('CASH').opening += amount;
        break;
      case 'DEPOSIT':
        row('CASH').deposits += amount;
        break;
      case 'WITHDRAWAL':
        row('CASH').withdrawals += amount;
        break;
      case 'SALE':
        row(m.paymentMethod ? String(m.paymentMethod) : UNATTRIBUTED_METHOD).sales += amount;
        break;
      case 'CANCELLATION':
      case 'RETURN': {
        if (m.paymentMethod) {
          row(String(m.paymentMethod)).refunds += amount;
        } else if (m.referenceType === 'PaymentReversal') {
          const p = m.referenceId ? paymentById.get(m.referenceId) : undefined;
          row(p ? String(p.paymentMethod) : UNATTRIBUTED_METHOD).refunds += amount;
        } else {
          const paid = m.referenceId ? paidBySale.get(m.referenceId) : undefined;
          if (!paid || paid.size === 0) row(UNATTRIBUTED_METHOD).refunds += amount;
          else for (const [method, share] of prorate(amount, paid)) row(method).refunds += share;
        }
        break;
      }
      default:
        break;
    }
  }
  const order = (m: string) => (m === 'CASH' ? 0 : m === UNATTRIBUTED_METHOD ? 2 : 1);
  const byMethod = [...rows.values()]
    .map((r) => ({
      method: r.method,
      sales: r2(r.sales),
      refunds: r2(r.refunds),
      opening: r2(r.opening),
      deposits: r2(r.deposits),
      withdrawals: r2(r.withdrawals),
      expected: r2(r.opening + r.deposits - r.withdrawals + r.sales - r.refunds),
    }))
    .sort((a, b) => order(a.method) - order(b.method) || b.expected - a.expected);
  return { total: r2(byMethod.reduce((sum, r) => sum + r.expected, 0)), byMethod } satisfies ExpectedBreakdown;
}

const PAYMENT_METHODS = new Set(Object.values(PaymentMethod ?? {}) as string[]);
export const DIFFERENCE_REASON_MIN = 5;

/** Informado por forma (opcional): formas conhecidas, valores ≥ 0 e soma = total informado. */
function validateDeclared(actualAmount: number, declared?: Record<string, number> | null) {
  if (!declared) return null;
  const entries = Object.entries(declared);
  for (const [method, value] of entries) {
    if (PAYMENT_METHODS.size && !PAYMENT_METHODS.has(method)) {
      throw new AppError(`Forma de pagamento desconhecida no fechamento: ${method}. Confira os valores informados.`, 400, 'INVALID_PAYMENT_METHOD');
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new AppError(`Valor informado inválido para ${method}. Use um valor maior ou igual a zero.`, 400, 'INVALID_AMOUNT');
    }
  }
  const sum = r2(entries.reduce((acc, [, v]) => acc + v, 0));
  if (Math.abs(sum - actualAmount) >= 0.01) {
    throw new AppError(
      `A soma informada por forma de pagamento (R$ ${sum.toFixed(2)}) não bate com o total informado (R$ ${actualAmount.toFixed(2)}). Confira os valores.`,
      400,
      'DECLARED_TOTAL_MISMATCH'
    );
  }
  return Object.fromEntries(entries.map(([m, v]) => [m, r2(v)]));
}

function differenceByMethod(expected: ExpectedBreakdown, declared: Record<string, number> | null) {
  if (!declared) return null;
  const methods = new Set([...expected.byMethod.map((r) => r.method), ...Object.keys(declared)]);
  const exp = new Map(expected.byMethod.map((r) => [r.method, r.expected]));
  return Object.fromEntries([...methods].map((m) => [m, r2((declared[m] ?? 0) - (exp.get(m) ?? 0))]));
}

/** 400 do fechamento com diferença sem motivo (política cash.requireDifferenceReason): leva os valores para a tela. */
export class CashDifferenceReasonRequiredError extends AppError {
  details: { expected: number; informed: number; difference: number; differenceByMethod: Record<string, number> | null; expectedByMethod: ExpectedMethodRow[] };
  constructor(details: CashDifferenceReasonRequiredError['details']) {
    super(
      `O valor informado tem diferença de R$ ${details.difference.toFixed(2)} em relação ao esperado. Confira a contagem e, se a diferença for real, informe o motivo (mínimo ${DIFFERENCE_REASON_MIN} caracteres).`,
      400,
      'DIFFERENCE_REASON_REQUIRED'
    );
    this.details = details;
    Object.setPrototypeOf(this, CashDifferenceReasonRequiredError.prototype);
  }
  toJSON() {
    return { ...super.toJSON(), details: this.details };
  }
}

async function namesOf(db: PrismaTransactionClient, ids: string[]) {
  const users = await db.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  const byId = new Map(users.map((u) => [u.id, u.name]));
  return (id: string) => ({ id, name: byId.get(id) ?? null });
}

/** Resumo gravado no fechamento (normal ou forçado): o que se esperava, o que foi informado, quem, quando e quais vendas. */
async function buildClosingSummary(
  db: PrismaTransactionClient,
  input: {
    companyId: string;
    register: { id: string; userId: string; registerNumber: number; branchId: string; openedAt: Date };
    closeType: 'NORMAL' | 'FORCED';
    closedAt: Date;
    closedBy: string;
    authorizedBy?: { id: string; name: string } | null;
    expected: ExpectedBreakdown;
    actualAmount: number;
    declared: Record<string, number> | null;
    difference: number;
    differenceReason: string | null;
  }
) {
  const name = await namesOf(db, [input.register.userId, input.closedBy]);
  const sales = await db.sale.findMany({
    where: { companyId: input.companyId, cashRegisterId: input.register.id },
    select: { id: true, saleNumber: true, status: true, totalAmount: true },
    orderBy: { saleNumber: 'asc' },
  });
  return {
    closeType: input.closeType,
    registerNumber: input.register.registerNumber,
    branchId: input.register.branchId,
    period: { openedAt: input.register.openedAt, closedAt: input.closedAt },
    operator: name(input.register.userId),
    closedBy: name(input.closedBy),
    authorizedBy: input.authorizedBy ?? null,
    expected: input.expected,
    declared: { total: input.actualAmount, byMethod: input.declared },
    difference: { total: input.difference, byMethod: differenceByMethod(input.expected, input.declared) },
    differenceReason: input.differenceReason,
    sales: {
      count: sales.length,
      items: sales.map((s) => ({ saleId: s.id, saleNumber: s.saleNumber, status: String(s.status), totalAmount: Number(s.totalAmount) })),
    },
  };
}

/** 409 do fechamento normal bloqueado: leva a lista das pendências e os valores para a tela oferecer o forçado. */
export class CashClosePendingError extends ConflictError {
  details: CashRegisterPendencies & { blockedBy: Array<'PENDING_PAYMENTS' | 'OPEN_SALES'>; forceCloseRoles: string[] };
  constructor(details: CashClosePendingError['details']) {
    const parts: string[] = [];
    if (details.blockedBy.includes('PENDING_PAYMENTS')) {
      parts.push(`${details.totals.pendingPaymentsCount} pagamento(s) aguardando confirmação (R$ ${details.totals.pendingPaymentsAmount.toFixed(2)})`);
    }
    if (details.blockedBy.includes('OPEN_SALES')) {
      parts.push(`${details.totals.openSalesCount} venda(s) em aberto (saldo R$ ${details.totals.openSalesBalance.toFixed(2)})`);
    }
    super(`O caixa tem pendências: ${parts.join(' e ')}. Resolva as pendências ou peça o fechamento forçado a um gerente/administrador.`, 'CASH_CLOSE_PENDING');
    this.name = 'CashClosePendingError';
    this.details = details;
    Object.setPrototypeOf(this, CashClosePendingError.prototype);
  }
  toJSON() {
    return { ...super.toJSON(), details: this.details };
  }
}

type MovementLike = { movementType: string; amount: unknown };

function expectedFromMovements(movements: MovementLike[]) {
  return movements.reduce((acc, movement) => {
    switch (movement.movementType) {
      case 'OPENING':
      case 'SALE':
      case 'DEPOSIT':
        return acc + Number(movement.amount);
      case 'WITHDRAWAL':
      case 'CANCELLATION': // estorno de venda paga — mesmo efeito de saída que sangria
      case 'RETURN': // estorno proporcional de devolução — mesmo efeito de saída
        return acc - Number(movement.amount);
      default:
        return acc;
    }
  }, 0);
}

function movementsSummary(movements: MovementLike[]) {
  return movements.reduce((acc, m) => {
    const t = m.movementType;
    acc[t] = acc[t] ?? { count: 0, total: 0 };
    acc[t].count++;
    acc[t].total = r2(acc[t].total + Number(m.amount));
    return acc;
  }, {} as Record<string, { count: number; total: number }>);
}

/**
 * Quem opera um caixa (fechar, reforço, retirada, vender nele) — business-state-machines.md, "Caixa — quem opera".
 * O caixa é do operador que o abriu: OPERATOR só no próprio; MANAGER nos da sua filial (supervisão); COMPANY_ADMIN e
 * SUPER_ADMIN nos da empresa. Sem userType (chamada interna) não restringe.
 */
export function assertCanOperateRegister(
  register: { userId: string; branchId: string },
  actor: { userId: string; userType?: string; branchId?: string | null }
) {
  if (!actor.userType || actor.userType === 'SUPER_ADMIN' || actor.userType === 'COMPANY_ADMIN') return;
  if (actor.branchId !== register.branchId) throw new Error('Cash register not found or already closed');
  if (actor.userType !== 'MANAGER' && register.userId !== actor.userId) {
    throw new Error('Caixa de outro operador: só quem o abriu, a gerência da filial ou a administração opera este caixa');
  }
}

export class CashRegisterService {
  // Abrir caixa
  async openCashRegister(data: {
    companyId: string;
    branchId: string;
    userId: string;
    registerNumber: number;
    openingAmount: number;
    notes?: string;
  }) {
    // Verificar se já existe caixa aberto para este operador
    const existingOpen = await prisma.cashRegister.findFirst({
      where: {
        companyId: data.companyId,
        branchId: data.branchId,
        userId: data.userId,
        status: 'OPEN',
      },
    });

    if (existingOpen) {
      throw new Error(`Você já tem um caixa aberto nesta filial (caixa nº ${existingOpen.registerNumber}). Feche-o antes de abrir outro.`);
    }

    // Verificar se o número do caixa já está em uso (aberto)
    const registerInUse = await prisma.cashRegister.findFirst({
      where: {
        companyId: data.companyId,
        branchId: data.branchId,
        registerNumber: data.registerNumber,
        status: 'OPEN',
      },
    });

    if (registerInUse) {
      throw new Error(
        `O caixa nº ${data.registerNumber} já está aberto por outro operador nesta filial. Use o número do caixa deste terminal.`
      );
    }

    // As checagens acima rodam ANTES da transação (TOCTOU): duas aberturas
    // concorrentes do mesmo usuário, ou do mesmo número de caixa na mesma
    // filial, podem ler "nenhum aberto" ao mesmo tempo e ambas passarem. A
    // garantia real está nos dois índices únicos parciais do banco
    // (`cash_registers_one_open_per_user`/`..._per_branch_register_number`,
    // `WHERE status='OPEN'`) — a que perde a corrida recebe P2002 aqui,
    // tratado como erro de negócio claro em vez de vazar como 500 genérico.
    try {
      return await runInTransaction(async (tx) => {
        const cashRegister = await tx.cashRegister.create({
          data: {
            companyId: data.companyId,
            branchId: data.branchId,
            userId: data.userId,
            registerNumber: data.registerNumber,
            status: 'OPEN',
            openingAmount: data.openingAmount,
            expectedAmount: data.openingAmount,
            notes: data.notes,
          },
        });

        // Registrar movimento de abertura
        await tx.cashMovement.create({
          data: {
            cashRegisterId: cashRegister.id,
            movementType: 'OPENING',
            amount: data.openingAmount,
            notes: data.notes || 'Abertura de caixa',
            userId: data.userId,
          },
        });

        return cashRegister;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error(
          `Não foi possível abrir o caixa: você já tem um caixa aberto ou o caixa nº ${data.registerNumber} acabou de ser aberto por outro operador.`
        );
      }
      throw error;
    }
  }

  // Fechar caixa
  async closeCashRegister(
    id: string,
    companyId: string,
    data: {
      actualAmount: number;
      closedBy: string;
      notes?: string;
      /** Informado por forma de pagamento (opcional); a soma precisa bater com actualAmount. */
      declaredByMethod?: Record<string, number> | null;
      /** Motivo da diferença entre informado e esperado (obrigatório com diferença, pela política). */
      differenceReason?: string | null;
      requesterUserType?: string;
      requesterBranchId?: string | null;
    }
  ) {
    const declared = validateDeclared(data.actualAmount, data.declaredByMethod);
    const differenceReason = data.differenceReason?.trim() || null;

    const cashRegister = await prisma.cashRegister.findFirst({
      where: {
        id,
        companyId,
        status: 'OPEN',
      },
    });

    if (!cashRegister) {
      throw new Error('Cash register not found or already closed');
    }
    assertCanOperateRegister(cashRegister, { userId: data.closedBy, userType: data.requesterUserType, branchId: data.requesterBranchId });

    // Política de fechamento (docs/CORTEX/policies/CAIXA.md), lida da filial do caixa.
    const policies = await policyService.effective(companyId, cashRegister.branchId);
    const blockPendingPayments = policies['cash.blockCloseWithPendingPayments'] !== false;
    const blockOpenSales = policies['cash.blockCloseWithOpenSales'] !== false;
    const requireDifferenceReason = policies['cash.requireDifferenceReason'] !== false;

    // Fechar caixa em transação
    return await runInTransaction(async (tx) => {
      // Guarda atômica contra fechamento concorrente do mesmo caixa (mesmo
      // padrão TOCTOU já usado em payment.service.ts::cancelPayment/
      // refundPayment) — sem isso, o `findFirst` com status:'OPEN' acima
      // roda FORA da transação, então duas chamadas quase simultâneas
      // (duplo clique em "Fechar Caixa", ou um retry de rede) podiam ambas
      // ler "está aberto" e ambas fechar o caixa: dois CashMovement de
      // CLOSING seriam criados, e a que commitasse por último sobrescreveria
      // silenciosamente actualAmount/difference/closedBy/notes do
      // fechamento oficial do dia — corrompendo o registro de conciliação
      // financeira sem nenhum erro visível para ninguém.
      const closedAt = new Date();
      const closeUpdate = await tx.cashRegister.updateMany({
        where: { id, companyId, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          actualAmount: data.actualAmount,
          closedAt,
          closedBy: data.closedBy,
          notes: data.notes,
        },
      });

      if (closeUpdate.count === 0) {
        throw new Error('Cash register not found or already closed');
      }

      // Pendências conferidas DEPOIS de travar a linha do caixa (a mesma transação): se bloquearem, o throw desfaz o
      // fechamento. Com a política permitindo, o fechamento normal segue e guarda a fotografia das pendências.
      const pendencies = await listRegisterPendencies(tx, id);
      const blockedBy: Array<'PENDING_PAYMENTS' | 'OPEN_SALES'> = [];
      if (blockPendingPayments && pendencies.pendingPayments.length > 0) blockedBy.push('PENDING_PAYMENTS');
      if (blockOpenSales && pendencies.openSales.length > 0) blockedBy.push('OPEN_SALES');
      if (blockedBy.length > 0) {
        throw new CashClosePendingError({ ...pendencies, blockedBy, forceCloseRoles: [...(policies['cash.forceCloseRoles'] as string[])] });
      }

      // Esperado × informado com TODO o movimento do caixa (relido aqui: nada entra entre a trava e o cálculo).
      const movements = await tx.cashMovement.findMany({ where: { cashRegisterId: id } });
      const expected = await expectedByMethod(tx, companyId, movements);
      const expectedAmount = r2(expectedFromMovements(movements));
      const difference = r2(data.actualAmount - expectedAmount);
      if (Math.abs(difference) >= 0.01 && requireDifferenceReason && (differenceReason ?? '').length < DIFFERENCE_REASON_MIN) {
        throw new CashDifferenceReasonRequiredError({
          expected: expectedAmount,
          informed: data.actualAmount,
          difference,
          differenceByMethod: differenceByMethod(expected, declared),
          expectedByMethod: expected.byMethod,
        });
      }
      const closingSummary = await buildClosingSummary(tx, {
        companyId,
        register: cashRegister,
        closeType: 'NORMAL',
        closedAt,
        closedBy: data.closedBy,
        expected,
        actualAmount: data.actualAmount,
        declared,
        difference,
        differenceReason,
      });
      const hasPendencies = pendencies.pendingPayments.length > 0 || pendencies.openSales.length > 0;
      await tx.cashRegister.update({
        where: { id },
        data: {
          expectedAmount,
          difference,
          differenceReason,
          closingSummary: JSON.parse(JSON.stringify(closingSummary)),
          ...(hasPendencies
            ? { pendingSnapshot: JSON.parse(JSON.stringify({ ...pendencies, capturedAt: closedAt, closeType: 'NORMAL' })) }
            : {}),
        },
      });

      const closedRegister = await tx.cashRegister.findUniqueOrThrow({
        where: { id },
        include: {
          movements: true,
        },
      });

      // Registrar movimento de fechamento
      await tx.cashMovement.create({
        data: {
          cashRegisterId: id,
          movementType: 'CLOSING',
          amount: data.actualAmount,
          notes: data.notes || `Fechamento de caixa. Diferença: ${difference.toFixed(2)}`,
          userId: data.closedBy,
        },
      });

      return closedRegister;
    });
  }

  /**
   * Fechamento FORÇADO (docs/CORTEX/policies/CAIXA.md): fecha o caixa mesmo com pendências, com motivo (mín. 10) e por
   * um perfil de `cash.forceCloseRoles` (padrão Gerente/Administrador). Quem pede sem esse perfil (ex.: o operador no
   * PDV) informa as credenciais de um autorizador com o perfil — outra pessoa (verifyDualAuthorization).
   *
   * Nada é escondido nem apagado: vendas em aberto continuam em aberto, pagamentos pendentes continuam pendentes (a
   * reconciliação continua valendo), sangrias/reforços/pagamentos/diferença ficam como estão. O que muda: status
   * CLOSED, closeType FORCED, forcedReason e pendingSnapshot (pendências, valores, operador do caixa, quem forçou, quem
   * autorizou, filial, data/hora e resumo dos movimentos).
   */
  async forceCloseCashRegister(
    id: string,
    companyId: string,
    data: {
      actualAmount: number;
      reason: string;
      notes?: string;
      declaredByMethod?: Record<string, number> | null;
      /** Motivo próprio da diferença; sem ele, vale o motivo do fechamento forçado. */
      differenceReason?: string | null;
      requester: { userId: string; userType: string; branchId?: string | null };
      authorizerNumericId?: number | null;
      authorizerPassword?: string | null;
      authorizerMfaCode?: string | null;
      requestId?: string;
      device?: string;
    }
  ) {
    const reason = (data.reason ?? '').trim();
    if (reason.length < FORCE_CLOSE_REASON_MIN) {
      throw new AppError(`Informe o motivo do fechamento forçado (mínimo ${FORCE_CLOSE_REASON_MIN} caracteres)`, 400, 'FORCE_CLOSE_REASON_REQUIRED');
    }
    if (!Number.isFinite(data.actualAmount) || data.actualAmount < 0) {
      throw new AppError('Informe o valor contado em caixa (maior ou igual a zero)', 400, 'INVALID_AMOUNT');
    }
    const declared = validateDeclared(data.actualAmount, data.declaredByMethod);

    const cashRegister = await prisma.cashRegister.findFirst({ where: { id, companyId, status: 'OPEN' }, include: { movements: true } });
    if (!cashRegister) {
      throw new Error('Cash register not found or already closed');
    }
    assertCanOperateRegister(cashRegister, { userId: data.requester.userId, userType: data.requester.userType, branchId: data.requester.branchId });

    const policies = await policyService.effective(companyId, cashRegister.branchId);
    const forceCloseRoles = [...(policies['cash.forceCloseRoles'] as string[])];
    const securityContext = {
      requestId: data.requestId,
      companyId,
      branchId: cashRegister.branchId,
      userId: data.requester.userId,
      device: data.device,
    };

    // Quem pede tem o perfil → é quem autoriza. Sem o perfil → outra pessoa com o perfil, com as próprias credenciais.
    const requesterHasRole = data.requester.userType === 'SUPER_ADMIN' || forceCloseRoles.includes(data.requester.userType);
    let authorizer: { id: string; name: string };
    if (requesterHasRole) {
      const me = await prisma.user.findFirst({ where: { id: data.requester.userId }, select: { id: true, name: true } });
      authorizer = { id: data.requester.userId, name: me?.name ?? 'solicitante' };
    } else {
      if (!data.authorizerNumericId || !data.authorizerPassword) {
        throw new AppError(
          'O fechamento forçado precisa da autorização de um gerente ou administrador: informe as credenciais de quem autoriza',
          403,
          'FORCE_CLOSE_AUTHORIZATION_REQUIRED'
        );
      }
      const verified = await verifyDualAuthorization({
        companyId,
        requesterId: data.requester.userId,
        authorizerNumericId: data.authorizerNumericId,
        authorizerPassword: data.authorizerPassword,
        authorizerMfaCode: data.authorizerMfaCode ?? undefined,
        allowedRoles: forceCloseRoles,
        actionEvent: 'CASH_FORCE_CLOSE',
        subjectLabel: 'cash register force close',
        securityContext,
      });
      authorizer = { id: verified.id, name: verified.name };
    }

    const [operator, branch, requesterUser] = await Promise.all([
      prisma.user.findFirst({ where: { id: cashRegister.userId }, select: { id: true, name: true } }),
      prisma.branch.findFirst({ where: { id: cashRegister.branchId, companyId }, select: { id: true, name: true } }),
      prisma.user.findFirst({ where: { id: data.requester.userId }, select: { id: true, name: true } }),
    ]);

    const result = await runInTransaction(async (tx) => {
      // Movimentos e pendências relidos DENTRO da transação, depois de travar o caixa (updateMany abaixo reivindica o
      // fechamento; a leitura em seguida vê o estado final).
      const claimed = await tx.cashRegister.updateMany({
        where: { id, companyId, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy: data.requester.userId },
      });
      if (claimed.count === 0) {
        throw new Error('Cash register not found or already closed');
      }
      const movements = await tx.cashMovement.findMany({ where: { cashRegisterId: id } });
      const expectedAmount = r2(expectedFromMovements(movements));
      const expected = await expectedByMethod(tx, companyId, movements);
      const difference = r2(data.actualAmount - expectedAmount);
      const pendencies = await listRegisterPendencies(tx, id);
      const forcedAt = new Date();
      const differenceReason = data.differenceReason?.trim() || reason;
      const closingSummary = await buildClosingSummary(tx, {
        companyId,
        register: cashRegister,
        closeType: 'FORCED',
        closedAt: forcedAt,
        closedBy: data.requester.userId,
        authorizedBy: authorizer,
        expected,
        actualAmount: data.actualAmount,
        declared,
        difference,
        differenceReason,
      });
      const snapshot = {
        closeType: 'FORCED',
        forcedAt,
        reason,
        branch: branch ? { id: branch.id, name: branch.name } : { id: cashRegister.branchId, name: null },
        registerNumber: cashRegister.registerNumber,
        operator: operator ? { id: operator.id, name: operator.name } : { id: cashRegister.userId, name: null },
        requestedBy: requesterUser ? { id: requesterUser.id, name: requesterUser.name } : { id: data.requester.userId, name: null },
        authorizedBy: authorizer,
        openingAmount: Number(cashRegister.openingAmount),
        expectedAmount,
        actualAmount: data.actualAmount,
        difference,
        movements: movementsSummary(movements),
        ...pendencies,
      };

      await tx.cashRegister.update({
        where: { id },
        data: {
          expectedAmount,
          actualAmount: data.actualAmount,
          difference,
          notes: data.notes,
          closeType: 'FORCED',
          forcedReason: reason,
          differenceReason,
          closingSummary: JSON.parse(JSON.stringify(closingSummary)),
          pendingSnapshot: JSON.parse(JSON.stringify(snapshot)),
        },
      });
      await tx.cashMovement.create({
        data: {
          cashRegisterId: id,
          movementType: 'CLOSING',
          amount: data.actualAmount,
          notes: `Fechamento FORÇADO — ${reason}. Diferença: ${difference.toFixed(2)}. Pendências: ${pendencies.totals.pendingPaymentsCount} pagamento(s) pendente(s), ${pendencies.totals.openSalesCount} venda(s) em aberto.`,
          userId: data.requester.userId,
          requestedBy: data.requester.userId,
          authorizedBy: authorizer.id,
        },
      });
      return tx.cashRegister.findUniqueOrThrow({ where: { id }, include: { movements: true } });
    });

    Logger.security('CASH_FORCE_CLOSE_COMPLETED', `Caixa nº ${cashRegister.registerNumber} fechado de forma FORÇADA — ${reason}`, {
      ...securityContext,
      cashRegisterId: id,
      authorizerId: authorizer.id,
    });

    return { ...result, authorizer };
  }

  // Buscar caixa atual aberto do usuário
  async getCurrentOpenRegister(companyId: string, branchId: string, userId: string) {
    return await prisma.cashRegister.findFirst({
      where: {
        companyId,
        branchId,
        userId,
        status: 'OPEN',
      },
      include: {
        movements: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  // Adicionar movimento — hoje só reforço (DEPOSIT). Retirada (WITHDRAWAL)
  // exige dupla autorização e tem seu próprio método (requestWithdrawal),
  // por isso é explicitamente rejeitada aqui em vez de aceita sem checagem.
  async addCashMovement(data: {
    cashRegisterId: string;
    companyId: string;
    movementType: 'WITHDRAWAL' | 'DEPOSIT';
    amount: number;
    notes?: string;
    userId: string;
    requesterBranchId?: string | null;
    requesterUserType?: string;
  }) {
    if (data.movementType === 'WITHDRAWAL') {
      throw new Error(
        'Retirada de caixa exige autorização de um segundo usuário — use requestWithdrawal / POST /cash-register/:id/withdrawal'
      );
    }

    // Verificar se o caixa está aberto E pertence à empresa do requisitante.
    // Sem o filtro por companyId aqui, qualquer usuário autenticado de
    // QUALQUER empresa podia lançar sangria/reforço no caixa aberto de
    // outra empresa apenas acertando o cashRegisterId (IDOR cross-tenant).
    const cashRegister = await prisma.cashRegister.findFirst({
      where: {
        id: data.cashRegisterId,
        companyId: data.companyId,
        status: 'OPEN',
      },
    });

    if (!cashRegister) {
      throw new Error('Cash register not found or already closed');
    }

    assertCanOperateRegister(cashRegister, { userId: data.userId, userType: data.requesterUserType, branchId: data.requesterBranchId });

    return await runInTransaction(async (tx) => {
      // Incremento atômico condicionado a caixa ABERTO: gravar o valor absoluto lido antes da transação perdia
      // reforços simultâneos, e um caixa fechado nesse intervalo recebia o lançamento.
      const incremented = await tx.cashRegister.updateMany({
        where: { id: data.cashRegisterId, companyId: data.companyId, status: 'OPEN' },
        data: { expectedAmount: { increment: data.amount } },
      });
      if (incremented.count === 0) {
        throw new Error('Cash register not found or already closed');
      }

      return tx.cashMovement.create({
        data: {
          cashRegisterId: data.cashRegisterId,
          movementType: data.movementType,
          amount: data.amount,
          notes: data.notes,
          userId: data.userId,
        },
      });
    });
  }

  /**
   * Retirada de caixa (sangria) com dupla autorização — a operação mais
   * sensível do PDV além de pagamento: move dinheiro físico para fora do
   * caixa. O operador que solicita NUNCA pode ser quem autoriza (mesma
   * pessoa aprovando a própria retirada anula o controle por completo).
   *
   * O autorizador se identifica com as PRÓPRIAS credenciais (numericId +
   * senha, e MFA se tiver habilitado) diretamente nesta chamada — não é um
   * fluxo assíncrono de aprovação posterior, é autorização presencial no
   * mesmo PDV, no mesmo instante. Nada é persistido (nenhum CashMovement)
   * se a autorização falhar em qualquer etapa — uma tentativa rejeitada
   * gera apenas um evento de segurança (SystemLog via Logger.security),
   * nunca um lançamento no ledger do caixa.
   */
  async requestWithdrawal(data: {
    cashRegisterId: string;
    companyId: string;
    branchId?: string | null;
    requesterId: string;
    requesterUserType?: string;
    amount: number;
    reason: string;
    authorizerNumericId: number;
    authorizerPassword: string;
    authorizerMfaCode?: string;
    requestId?: string;
    device?: string;
  }) {
    const securityContext = {
      requestId: data.requestId,
      companyId: data.companyId,
      branchId: data.branchId ?? undefined,
      userId: data.requesterId,
      device: data.device,
    };

    const cashRegister = await prisma.cashRegister.findFirst({
      where: { id: data.cashRegisterId, companyId: data.companyId, status: 'OPEN' },
    });
    if (!cashRegister) {
      throw new Error('Cash register not found or already closed');
    }

    assertCanOperateRegister(cashRegister, { userId: data.requesterId, userType: data.requesterUserType, branchId: data.branchId });

    if (!(data.amount > 0)) {
      throw new Error('Amount must be greater than zero');
    }
    if (!data.reason || data.reason.trim().length < 3) {
      throw new Error('Reason is required (minimum 3 characters)');
    }

    const authorizer = await verifyDualAuthorization({
      companyId: data.companyId,
      requesterId: data.requesterId,
      authorizerNumericId: data.authorizerNumericId,
      authorizerPassword: data.authorizerPassword,
      authorizerMfaCode: data.authorizerMfaCode,
      allowedRoles: WITHDRAWAL_AUTHORIZER_ROLES,
      actionEvent: 'WITHDRAWAL',
      subjectLabel: 'withdrawal',
      securityContext,
    });

    // Nenhum hardware de gaveta é acionado pelo backend: a gaveta (quando
    // existe) é um periférico local do PDV, comandado pelo app desktop via
    // ESC/POS — este projeto não tem essa integração implementada hoje (o
    // PrinterService do PDV usa impressão via driver do SO, não comandos
    // ESC/POS brutos). Reportar isso honestamente em vez de fingir que um
    // comando foi enviado.
    const drawerSupported = false;

    const movement = await runInTransaction(async (tx) => {
      const created = await tx.cashMovement.create({
        data: {
          cashRegisterId: data.cashRegisterId,
          movementType: 'WITHDRAWAL',
          amount: data.amount,
          notes: data.reason,
          userId: data.requesterId,
          requestedBy: data.requesterId,
          authorizedBy: authorizer.id,
        },
      });

      await tx.cashRegister.update({
        where: { id: data.cashRegisterId },
        data: { expectedAmount: { decrement: data.amount } },
      });

      return created;
    });

    Logger.security('WITHDRAWAL_COMPLETED', `Retirada de caixa de R$ ${data.amount.toFixed(2)} concluída`, {
      ...securityContext,
      movementId: movement.id,
      authorizerId: authorizer.id,
      amount: data.amount,
    });

    return {
      movement,
      authorizer: { id: authorizer.id, name: authorizer.name },
      drawerSupported,
    };
  }

  // Listar caixas (histórico)
  async listCashRegisters(filters: {
    companyId: string;
    branchId?: string;
    userId?: string;
    status?: 'OPEN' | 'CLOSED';
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      companyId,
      branchId,
      userId,
      status,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = filters;

    const where: Prisma.CashRegisterWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(userId && { userId }),
      ...(status && { status }),
      ...(startDate || endDate
        ? {
            openedAt: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }
        : {}),
    };

    const [cashRegisters, total] = await Promise.all([
      prisma.cashRegister.findMany({
        where,
        include: {
          movements: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { openedAt: 'desc' },
      }),
      prisma.cashRegister.count({ where }),
    ]);

    return {
      cashRegisters,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Buscar caixa por ID
  async getCashRegisterById(
    id: string,
    companyId: string,
    requester?: { userType: string; branchId?: string | null }
  ) {
    const cashRegister = await prisma.cashRegister.findFirst({
      where: { id, companyId },
      include: {
        movements: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // SUPER_ADMIN/COMPANY_ADMIN têm acesso a todas as filiais da empresa
    // (mesmo critério de requireBranchAccess em middleware/permission.ts).
    // Qualquer outro papel (MANAGER/OPERATOR) só pode ver o caixa da PRÓPRIA
    // filial — antes disso não era checado aqui, então um operador da
    // Filial A1 conseguia ler saldo/movimentos completos do caixa da A2
    // (confirmado em teste real: vazamento de dado financeiro entre
    // filiais da mesma empresa).
    if (
      cashRegister &&
      requester &&
      requester.userType !== 'SUPER_ADMIN' &&
      requester.userType !== 'COMPANY_ADMIN' &&
      requester.branchId !== cashRegister.branchId
    ) {
      return null;
    }

    return cashRegister;
  }

  // Pendências atuais do caixa (a tela de fechamento mostra antes de fechar) + se a política bloqueia o fechamento normal.
  async getPendencies(id: string, companyId: string, requester?: { userType: string; branchId?: string | null }) {
    const cashRegister = await this.getCashRegisterById(id, companyId, requester);
    if (!cashRegister) {
      throw new Error('Cash register not found');
    }
    const policies = await policyService.effective(companyId, cashRegister.branchId);
    const db = prisma as unknown as PrismaTransactionClient;
    const pendencies = await listRegisterPendencies(db, id);
    const blockedBy: string[] = [];
    if (policies['cash.blockCloseWithPendingPayments'] !== false && pendencies.pendingPayments.length > 0) blockedBy.push('PENDING_PAYMENTS');
    if (policies['cash.blockCloseWithOpenSales'] !== false && pendencies.openSales.length > 0) blockedBy.push('OPEN_SALES');
    // Prévia do fechamento: esperado por forma de pagamento (a tela pede o informado de cada uma).
    const expected = await expectedByMethod(db, companyId, cashRegister.movements);
    return {
      ...pendencies,
      blockedBy,
      normalCloseAllowed: blockedBy.length === 0,
      forceCloseRoles: policies['cash.forceCloseRoles'],
      expected,
      requireDifferenceReason: policies['cash.requireDifferenceReason'] !== false,
    };
  }

  // Relatório de fechamento
  async getClosureReport(
    id: string,
    companyId: string,
    requester?: { userType: string; branchId?: string | null }
  ) {
    const cashRegister = await this.getCashRegisterById(id, companyId, requester);

    if (!cashRegister) {
      throw new Error('Cash register not found');
    }

    // Agrupar movimentos por tipo
    const movementsByType = cashRegister.movements.reduce((acc, movement) => {
      const type = movement.movementType;
      if (!acc[type]) {
        acc[type] = {
          count: 0,
          total: 0,
        };
      }
      acc[type].count++;
      acc[type].total += Number(movement.amount);
      return acc;
    }, {} as Record<string, { count: number; total: number }>);

    // Agrupar pagamentos por forma
    const paymentsByMethod = cashRegister.movements
      .filter(m => m.movementType === 'SALE' && m.paymentMethod)
      .reduce((acc, movement) => {
        const method = movement.paymentMethod!;
        if (!acc[method]) {
          acc[method] = {
            count: 0,
            total: 0,
          };
        }
        acc[method].count++;
        acc[method].total += Number(movement.amount);
        return acc;
      }, {} as Record<string, { count: number; total: number }>);

    // Dinheiro recebido neste caixa: total entregue, troco e composição das cédulas (quando o controle estava ligado).
    const cashPaymentIds = cashRegister.movements
      .filter((m) => m.movementType === 'SALE' && m.paymentMethod === 'CASH' && m.referenceType === 'Payment' && m.referenceId)
      .map((m) => m.referenceId!);
    const cashPayments = cashPaymentIds.length
      ? await prisma.payment.findMany({
          where: { id: { in: cashPaymentIds }, companyId },
          select: { amount: true, receivedAmount: true, changeAmount: true, cashBreakdown: true },
        })
      : [];
    const notes = new Map<number, number>();
    for (const p of cashPayments) {
      for (const entry of (p.cashBreakdown as Array<{ value: number; quantity: number }> | null) ?? []) {
        notes.set(entry.value, (notes.get(entry.value) ?? 0) + entry.quantity);
      }
    }
    const cashReceived = {
      received: cashPayments.reduce((sum, p) => sum + Number(p.receivedAmount ?? p.amount), 0),
      change: cashPayments.reduce((sum, p) => sum + Number(p.changeAmount), 0),
      paymentsWithBreakdown: cashPayments.filter((p) => p.cashBreakdown).length,
      notes: [...notes.entries()].sort((a, b) => b[0] - a[0]).map(([value, quantity]) => ({ value, quantity })),
    };

    // Pendências: caixa aberto → as de agora; caixa fechado → a fotografia do fechamento (forçado ou normal com
    // pendências permitidas pela política). As atuais também vão, para mostrar o que ainda não foi resolvido.
    const currentPendencies = await listRegisterPendencies(prisma as unknown as PrismaTransactionClient, cashRegister.id);

    return {
      cashReceived,
      cashRegister,
      summary: {
        openingAmount: Number(cashRegister.openingAmount),
        expectedAmount: Number(cashRegister.expectedAmount),
        actualAmount: cashRegister.actualAmount ? Number(cashRegister.actualAmount) : null,
        difference: cashRegister.difference ? Number(cashRegister.difference) : null,
        status: cashRegister.status,
        closeType: cashRegister.closeType,
        forced: cashRegister.closeType === 'FORCED',
        forcedReason: cashRegister.forcedReason,
      },
      pendingAtClose: cashRegister.pendingSnapshot ?? null,
      currentPendencies,
      // Fechado: o resumo gravado no fechamento. Aberto: o esperado de agora por forma de pagamento.
      closingSummary: cashRegister.closingSummary ?? null,
      expectedNow:
        cashRegister.status === 'OPEN'
          ? await expectedByMethod(prisma as unknown as PrismaTransactionClient, companyId, cashRegister.movements)
          : null,
      movementsByType,
      paymentsByMethod,
    };
  }
}

export default new CashRegisterService();
