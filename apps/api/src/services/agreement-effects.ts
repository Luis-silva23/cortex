import { PrismaTransactionClient } from '@ln-system/database';
import { AGREEMENT_RECEIVABLE_REF } from './agreement-company.service';
import { round2 } from './agreement-common';

export const AGREEMENT_METHODS = ['EMPLOYEE_AGREEMENT', 'COMPANY_AGREEMENT'] as const;

/** Ids dos pagamentos de convênio de uma venda (lidos DENTRO da transação, depois do lock da venda). */
export function agreementPaymentIds(payments: Array<{ id: string; paymentMethod: string }> | null | undefined): string[] {
  return (payments ?? []).filter((p) => (AGREEMENT_METHODS as readonly string[]).includes(p.paymentMethod)).map((p) => p.id);
}

/**
 * Venda cancelada/devolvida (total) ou pagamento de convênio cancelado/estornado: desfaz o convênio SEM apagar nada.
 *  - Funcionário: utilização marcada cancelada; parcelas ainda não processadas (SCHEDULED) → CANCELLED. Parcelas já
 *    descontadas em folha (DEDUCTED) ficam como estão e aparecem "a compensar" — como devolver ao funcionário é
 *    [DECISÃO NECESSÁRIA] (nenhum estorno é inventado aqui).
 *  - Empresa conveniada: conta a receber em aberto (PENDING/OVERDUE) → CANCELLED com nota. Conta já recebida fica PAID
 *    (devolução do valor à conveniada é [DECISÃO NECESSÁRIA]).
 * Roda na MESMA transação da operação que cancela (atômico com o cancelamento).
 */
export async function reverseAgreementEffects(
  tx: PrismaTransactionClient,
  scope: { saleId?: string; paymentIds?: string[] },
  userId: string,
  reason: string
) {
  let paymentIds = scope.paymentIds ?? [];
  if (scope.saleId) {
    const rows = await tx.payment.findMany({
      where: { saleId: scope.saleId, paymentMethod: { in: [...AGREEMENT_METHODS] as any } },
      select: { id: true },
    });
    paymentIds = [...new Set([...paymentIds, ...rows.map((r) => r.id)])];
  }
  const result = { chargesCancelled: 0, deductionsCancelled: 0, deductedToCompensate: 0, receivablesCancelled: 0, receivablesAlreadyPaid: 0 };
  if (paymentIds.length === 0) return result;

  const now = new Date();
  const charges = await tx.employeeAgreementCharge.findMany({ where: { paymentId: { in: paymentIds }, cancelledAt: null }, select: { id: true } });
  for (const c of charges) {
    const claimed = await tx.employeeAgreementCharge.updateMany({ where: { id: c.id, cancelledAt: null }, data: { cancelledAt: now, cancelledBy: userId } });
    if (claimed.count === 0) continue;
    result.chargesCancelled++;
    const cancelled = await tx.employeePayrollDeduction.updateMany({ where: { chargeId: c.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    result.deductionsCancelled += cancelled.count;
    const deducted = await tx.employeePayrollDeduction.aggregate({ where: { chargeId: c.id, status: 'DEDUCTED' }, _sum: { amount: true } });
    result.deductedToCompensate = round2(result.deductedToCompensate + Number(deducted._sum.amount ?? 0));
  }

  const receivables = await tx.accountsReceivable.findMany({
    where: { referenceType: AGREEMENT_RECEIVABLE_REF, referenceId: { in: paymentIds }, agreementCompanyId: { not: null } },
    select: { id: true, status: true, notes: true },
  });
  for (const r of receivables) {
    if (r.status === 'PAID') {
      result.receivablesAlreadyPaid++;
      continue;
    }
    if (r.status === 'CANCELLED') continue;
    const done = await tx.accountsReceivable.updateMany({
      where: { id: r.id, status: { in: ['PENDING', 'OVERDUE'] } },
      data: { status: 'CANCELLED', notes: `${r.notes ?? ''}\nCancelada: ${reason}`.trim() },
    });
    result.receivablesCancelled += done.count;
  }
  return result;
}
