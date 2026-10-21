import { prisma, runWithRLSContext } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { ConflictError } from '@ln-system/shared';

/**
 * Regra do projeto: não apagar histórico financeiro. Nenhuma operação aqui
 * faz DELETE — cancelamentos e estornos são sempre um novo estado/evento,
 * nunca a remoção do registro original.
 */
export class FinancialService {
  // ---------- CONTAS A PAGAR ----------

  async createPayable(data: {
    companyId: string;
    branchId?: string;
    supplierId?: string;
    description: string;
    amount: number;
    dueDate: Date;
    referenceType?: string;
    referenceId?: string;
    notes?: string;
  }) {
    if (data.supplierId) {
      const supplier = await prisma.supplier.findFirst({
        where: { id: data.supplierId, companyId: data.companyId },
        select: { id: true },
      });
      if (!supplier) {
        throw new Error('Supplier not found');
      }
    }

    return await prisma.accountsPayable.create({
      data: {
        companyId: data.companyId,
        branchId: data.branchId,
        supplierId: data.supplierId,
        description: data.description,
        amount: data.amount,
        dueDate: data.dueDate,
        status: 'PENDING',
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        notes: data.notes,
      },
    });
  }

  async listPayables(filters: {
    companyId: string;
    branchId?: string;
    supplierId?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const { companyId, branchId, supplierId, status, startDate, endDate, page = 1, limit = 20 } = filters;

    const where: Prisma.AccountsPayableWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(supplierId && { supplierId }),
      ...(status && { status: status as any }),
      ...((startDate || endDate) && {
        dueDate: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        },
      }),
    };

    const [payables, total] = await Promise.all([
      prisma.accountsPayable.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { dueDate: 'asc' } }),
      prisma.accountsPayable.count({ where }),
    ]);

    return { payables, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Registrar pagamento. Só é possível a partir de PENDING/OVERDUE — uma
   * conta já paga ou cancelada nunca é reescrita.
   */
  async payPayable(id: string, companyId: string, paidDate?: Date) {
    const payable = await prisma.accountsPayable.findFirst({ where: { id, companyId } });
    if (!payable) {
      throw new Error('Account payable not found');
    }
    if (!['PENDING', 'OVERDUE'].includes(payable.status)) {
      throw new Error(`Cannot pay an account with status ${payable.status}`);
    }

    return await prisma.accountsPayable.update({
      where: { id },
      data: { status: 'PAID', paidDate: paidDate || new Date() },
    });
  }

  async cancelPayable(id: string, companyId: string, reason?: string) {
    const payable = await prisma.accountsPayable.findFirst({ where: { id, companyId } });
    if (!payable) {
      throw new Error('Account payable not found');
    }
    if (payable.status === 'PAID') {
      throw new Error('Cannot cancel an account that has already been paid — use a reversal instead');
    }

    return await prisma.accountsPayable.update({
      where: { id },
      data: { status: 'CANCELLED', notes: reason ? `${payable.notes || ''}\nCancelado: ${reason}`.trim() : payable.notes },
    });
  }

  /**
   * Estorno de uma conta já paga. NUNCA reescreve o registro original —
   * cria um novo lançamento negativo referenciando o original, preservando
   * o histórico financeiro completo (conforme regra do projeto).
   */
  async reversePayable(id: string, companyId: string, reason: string) {
    const payable = await prisma.accountsPayable.findFirst({ where: { id, companyId } });
    if (!payable) {
      throw new Error('Account payable not found');
    }
    if (payable.status !== 'PAID') {
      throw new Error('Only a paid account can be reversed');
    }

    // Checagem rápida (não atômica sozinha — ver comentário abaixo) para
    // devolver o erro de negócio claro no caso comum, sem round-trip
    // desnecessário ao INSERT.
    const existingReversal = await prisma.accountsPayable.findFirst({
      where: { companyId: payable.companyId, referenceType: 'Reversal', referenceId: payable.id },
    });
    if (existingReversal) {
      throw new Error('This account has already been reversed');
    }

    // Usa `payable.companyId` (a empresa DONA do registro original), não o
    // parâmetro `companyId` (a empresa do usuário chamando) — para a
    // maioria dos usuários são o mesmo valor, mas para SUPER_ADMIN
    // (companyId sempre null/undefined no próprio token) o parâmetro vem
    // vazio e o INSERT falhava com "Argument companyId is missing"
    // (confirmado em teste real: Super Admin aprovando/estornando uma
    // conta de uma empresa específica). O estorno de um registro sempre
    // pertence à MESMA empresa do original, independente de quem aciona.
    //
    // ACHADO DE AUDITORIA: o `findFirst` acima roda FORA de qualquer
    // transação/lock — duas chamadas de estorno quase simultâneas (duplo
    // clique, retry de cliente) podiam ambas ler "nenhum estorno ainda" e
    // ambas commitar um lançamento negativo, duplicando o efeito no fluxo
    // de caixa. A garantia real é o índice único parcial do banco
    // (`accounts_payable_one_reversal_per_reference`, WHERE
    // referenceType='Reversal') — mesmo padrão já usado em
    // openCashRegister: a chamada que perde a corrida recebe P2002 aqui,
    // tratado como erro de negócio claro em vez de vazar como 500 genérico.
    try {
      return await prisma.accountsPayable.create({
        data: {
          companyId: payable.companyId,
          branchId: payable.branchId,
          supplierId: payable.supplierId,
          description: `Estorno: ${payable.description}`,
          amount: Number(payable.amount) * -1,
          dueDate: new Date(),
          status: 'PAID',
          paidDate: new Date(),
          referenceType: 'Reversal',
          referenceId: payable.id,
          notes: reason,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('This account has already been reversed');
      }
      throw error;
    }
  }

  // ---------- CONTAS A RECEBER ----------

  async createReceivable(data: {
    companyId: string;
    branchId?: string;
    customerId?: string;
    description: string;
    amount: number;
    dueDate: Date;
    referenceType?: string;
    referenceId?: string;
    notes?: string;
  }) {
    if (data.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: data.customerId, companyId: data.companyId },
        select: { id: true },
      });
      if (!customer) {
        throw new Error('Customer not found');
      }
    }

    return await prisma.accountsReceivable.create({
      data: {
        companyId: data.companyId,
        branchId: data.branchId,
        customerId: data.customerId,
        description: data.description,
        amount: data.amount,
        dueDate: data.dueDate,
        status: 'PENDING',
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        notes: data.notes,
      },
    });
  }

  async listReceivables(filters: {
    companyId: string;
    branchId?: string;
    customerId?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const { companyId, branchId, customerId, status, startDate, endDate, page = 1, limit = 20 } = filters;

    const where: Prisma.AccountsReceivableWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(customerId && { customerId }),
      ...(status && { status: status as any }),
      ...((startDate || endDate) && {
        dueDate: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        },
      }),
    };

    const [receivables, total] = await Promise.all([
      prisma.accountsReceivable.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { dueDate: 'asc' } }),
      prisma.accountsReceivable.count({ where }),
    ]);

    return { receivables, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async receivePayment(id: string, companyId: string, paidDate?: Date) {
    const receivable = await prisma.accountsReceivable.findFirst({ where: { id, companyId } });
    if (!receivable) {
      throw new Error('Account receivable not found');
    }
    if (!['PENDING', 'OVERDUE'].includes(receivable.status)) {
      throw new Error(`Cannot receive payment for an account with status ${receivable.status}`);
    }

    // Guarda atômica no status (baixa de conta de convênio concorrente com cancelamento da venda, ou duplo clique):
    // só uma transição PENDING/OVERDUE → PAID acontece.
    const done = await prisma.accountsReceivable.updateMany({
      where: { id, companyId, status: { in: ['PENDING', 'OVERDUE'] } },
      data: { status: 'PAID', paidDate: paidDate || new Date() },
    });
    if (done.count === 0) {
      throw new ConflictError(
        'A situação desta conta mudou ao mesmo tempo (recebida ou cancelada por outra operação). Atualize a tela.',
        'RECEIVABLE_STATUS_CHANGED'
      );
    }
    return await prisma.accountsReceivable.findUniqueOrThrow({ where: { id } });
  }

  async cancelReceivable(id: string, companyId: string, reason?: string) {
    const receivable = await prisma.accountsReceivable.findFirst({ where: { id, companyId } });
    if (!receivable) {
      throw new Error('Account receivable not found');
    }
    if (receivable.status === 'PAID') {
      throw new Error('Cannot cancel an account that has already been received — use a reversal instead');
    }

    return await prisma.accountsReceivable.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        notes: reason ? `${receivable.notes || ''}\nCancelado: ${reason}`.trim() : receivable.notes,
      },
    });
  }

  async reverseReceivable(id: string, companyId: string, reason: string) {
    const receivable = await prisma.accountsReceivable.findFirst({ where: { id, companyId } });
    if (!receivable) {
      throw new Error('Account receivable not found');
    }
    if (receivable.status !== 'PAID') {
      throw new Error('Only a received account can be reversed');
    }

    // Ver nota equivalente em reversePayable.
    const existingReversal = await prisma.accountsReceivable.findFirst({
      where: { companyId: receivable.companyId, referenceType: 'Reversal', referenceId: receivable.id },
    });
    if (existingReversal) {
      throw new Error('This account has already been reversed');
    }

    // Ver nota equivalente em reversePayable sobre usar `receivable.companyId`
    // e sobre o índice único parcial `accounts_receivable_one_reversal_per_reference`
    // ser a garantia real contra estorno duplicado concorrente.
    try {
      return await prisma.accountsReceivable.create({
        data: {
          companyId: receivable.companyId,
          branchId: receivable.branchId,
          customerId: receivable.customerId,
          description: `Estorno: ${receivable.description}`,
          amount: Number(receivable.amount) * -1,
          dueDate: new Date(),
          status: 'PAID',
          paidDate: new Date(),
          referenceType: 'Reversal',
          referenceId: receivable.id,
          notes: reason,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('This account has already been reversed');
      }
      throw error;
    }
  }

  // ---------- CONCILIAÇÃO / FLUXO DE CAIXA ----------

  /**
   * Marca como OVERDUE contas cuja dueDate já passou e que ainda estão
   * PENDING. Chamado por um job agendado (não altera contas já pagas ou
   * canceladas).
   */
  async markOverdueAccounts() {
    const now = new Date();

    // ACHADO (2026-09-27, convênios): o job rodava FORA de qualquer contexto RLS — com RLS FORCE, os updateMany
    // afetavam 0 linhas em silêncio e nenhuma conta virava OVERDUE. Mesmo bypass de Super Admin dos demais jobs.
    const [payables, receivables] = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
      Promise.all([
        prisma.accountsPayable.updateMany({
          where: { status: 'PENDING', dueDate: { lt: now } },
          data: { status: 'OVERDUE' },
        }),
        prisma.accountsReceivable.updateMany({
          where: { status: 'PENDING', dueDate: { lt: now } },
          data: { status: 'OVERDUE' },
        }),
      ])
    );

    return { payablesMarked: payables.count, receivablesMarked: receivables.count };
  }

  async getCashFlowSummary(companyId: string, branchId?: string, startDate?: Date, endDate?: Date) {
    const dateFilter =
      startDate || endDate
        ? { dueDate: { ...(startDate && { gte: startDate }), ...(endDate && { lte: endDate }) } }
        : {};

    const [payablesTotal, receivablesTotal, payablesPaid, receivablesPaid] = await Promise.all([
      prisma.accountsPayable.aggregate({
        where: { companyId, ...(branchId && { branchId }), ...dateFilter, status: { not: 'CANCELLED' } },
        _sum: { amount: true },
      }),
      prisma.accountsReceivable.aggregate({
        where: { companyId, ...(branchId && { branchId }), ...dateFilter, status: { not: 'CANCELLED' } },
        _sum: { amount: true },
      }),
      prisma.accountsPayable.aggregate({
        where: { companyId, ...(branchId && { branchId }), ...dateFilter, status: 'PAID' },
        _sum: { amount: true },
      }),
      prisma.accountsReceivable.aggregate({
        where: { companyId, ...(branchId && { branchId }), ...dateFilter, status: 'PAID' },
        _sum: { amount: true },
      }),
    ]);

    return {
      payables: { total: Number(payablesTotal._sum.amount || 0), paid: Number(payablesPaid._sum.amount || 0) },
      receivables: { total: Number(receivablesTotal._sum.amount || 0), paid: Number(receivablesPaid._sum.amount || 0) },
      netCashFlow: Number(receivablesPaid._sum.amount || 0) - Number(payablesPaid._sum.amount || 0),
    };
  }
}

export default new FinancialService();
