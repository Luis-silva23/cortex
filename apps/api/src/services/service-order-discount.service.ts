import { prisma, runInTransaction } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import { Logger } from './logger.service';
import { evaluateDiscount, authorizeDiscount, recordDiscountEvents, DiscountEventInput, round2 } from './discount-policy.service';

/**
 * Desconto da ordem de serviço (docs/CORTEX/policies/DESCONTO.md). Antes nenhuma rota gravava
 * `service_orders.discountAmount` — o campo existia, entrava no valor cobrado (registerPayment) e ficava sempre 0.
 *
 * O desconto é informado POR TIPO — peças (`partsDiscount`) e mão de obra (`laborDiscount`) — e cada tipo é comparado
 * com o limite livre do seu tipo sobre o subtotal do seu tipo: peças até `discount.productFreePercent` (5%), mão de
 * obra até `discount.serviceFreePercent` (0% = qualquer desconto em serviço exige autorização).
 *
 * Os valores informados SUBSTITUEM o desconto vigente da OS (não somam): informar 0 remove o desconto daquele tipo.
 * `service_orders.discountAmount` guarda o total; a divisão por tipo fica nos `discount_events` (PART/SERVICE),
 * append-only — o último evento de cada tipo é o desconto vigente daquele tipo.
 *
 * Só antes do pagamento: OS paga, ENCERRADA ou CANCELADA não recebe desconto (o valor cobrado, a conta a receber e a
 * comissão já foram congelados no pagamento).
 */

const CLOSED_STATUSES = ['ENCERRADA', 'CANCELADA'];

export interface ServiceOrderDiscountInput {
  serviceOrderId: string;
  companyId: string;
  requester: { userId: string; userType: string; branchId?: string | null };
  partsDiscount: number;
  laborDiscount: number;
  reason?: string | null;
  authorizerNumericId?: number | null;
  authorizerPassword?: string | null;
  authorizerMfaCode?: string | null;
  requestId?: string;
  device?: string;
}

function money(value: unknown, field: string): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new AppError(`${field}: informe um valor maior ou igual a zero`, 400, 'INVALID_DISCOUNT');
  if (Math.abs(round2(n) - n) > 1e-9) throw new AppError(`${field}: use no máximo 2 casas decimais`, 400, 'INVALID_DISCOUNT');
  return round2(n);
}

/** Desconto vigente por tipo = último evento de cada tipo desta OS (0 quando nunca houve). */
export async function currentServiceOrderDiscountSplit(serviceOrderId: string, companyId: string) {
  const events = await prisma.discountEvent.findMany({
    where: { serviceOrderId, companyId, itemType: { in: ['PART', 'SERVICE'] } },
    orderBy: { createdAt: 'desc' },
    select: { itemType: true, discountAmount: true },
  });
  const last = (t: string) => events.find((e) => e.itemType === t);
  return { partsDiscount: Number(last('PART')?.discountAmount ?? 0), laborDiscount: Number(last('SERVICE')?.discountAmount ?? 0) };
}

export class ServiceOrderDiscountService {
  async getDiscount(serviceOrderId: string, companyId: string, requester: { branchId?: string | null }) {
    const os = await this.loadVisible(serviceOrderId, companyId, requester);
    const split = await currentServiceOrderDiscountSplit(serviceOrderId, companyId);
    const events = await prisma.discountEvent.findMany({
      where: { serviceOrderId, companyId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      serviceOrderId: os.id,
      partsTotal: Number(os.partsTotal),
      laborTotal: Number(os.laborTotal),
      discountAmount: Number(os.discountAmount),
      finalTotal: Number(os.finalTotal),
      ...split,
      editable: !os.isPaid && !CLOSED_STATUSES.includes(os.status),
      events,
    };
  }

  private async loadVisible(serviceOrderId: string, companyId: string, requester: { branchId?: string | null }) {
    const os = await prisma.serviceOrder.findFirst({ where: { id: serviceOrderId, companyId } });
    // Usuário de filial só mexe na OS da própria filial (a RLS já esconde; a checagem explícita vale para chamadas internas).
    if (!os || (requester.branchId && os.branchId !== requester.branchId)) {
      throw new AppError('Ordem de serviço não encontrada', 404, 'SERVICE_ORDER_NOT_FOUND');
    }
    return os;
  }

  async applyDiscount(input: ServiceOrderDiscountInput) {
    const { serviceOrderId, companyId, requester } = input;
    const os = await this.loadVisible(serviceOrderId, companyId, requester);

    if (os.isPaid) {
      throw new ConflictError('A ordem de serviço já foi paga: o desconto só pode ser dado antes do pagamento', 'SERVICE_ORDER_ALREADY_PAID');
    }
    if (CLOSED_STATUSES.includes(os.status)) {
      throw new ConflictError(`A ordem de serviço está ${os.status === 'CANCELADA' ? 'cancelada' : 'encerrada'} e não recebe desconto`, 'SERVICE_ORDER_CLOSED');
    }

    const partsDiscount = money(input.partsDiscount, 'Desconto em peças');
    const laborDiscount = money(input.laborDiscount, 'Desconto em mão de obra');
    const partsTotal = Number(os.partsTotal);
    const laborTotal = Number(os.laborTotal);
    if (partsDiscount > partsTotal + 1e-9) {
      throw new AppError(`O desconto em peças (R$ ${partsDiscount.toFixed(2)}) passa o total de peças da OS (R$ ${partsTotal.toFixed(2)})`, 400, 'DISCOUNT_EXCEEDS_TOTAL');
    }
    if (laborDiscount > laborTotal + 1e-9) {
      throw new AppError(`O desconto em mão de obra (R$ ${laborDiscount.toFixed(2)}) passa o total de mão de obra da OS (R$ ${laborTotal.toFixed(2)})`, 400, 'DISCOUNT_EXCEEDS_TOTAL');
    }

    const previous = await currentServiceOrderDiscountSplit(serviceOrderId, companyId);
    const changedParts = previous.partsDiscount !== partsDiscount;
    const changedLabor = previous.laborDiscount !== laborDiscount;
    const totalDiscount = round2(partsDiscount + laborDiscount);
    if (!changedParts && !changedLabor && Number(os.discountAmount) === totalDiscount) {
      throw new AppError('Nenhuma alteração: o desconto informado é o mesmo já aplicado', 400, 'DISCOUNT_UNCHANGED');
    }

    const securityContext = {
      requestId: input.requestId,
      companyId,
      branchId: os.branchId,
      userId: requester.userId,
      device: input.device,
    };
    const evaluation = await evaluateDiscount({
      companyId,
      branchId: os.branchId,
      userType: requester.userType,
      buckets: {
        PRODUCT: { subtotal: partsTotal, discount: partsDiscount },
        SERVICE: { subtotal: laborTotal, discount: laborDiscount },
      },
      productItemType: 'PART',
    });
    // Autorização só para o que AUMENTA: um desconto de mão de obra já autorizado e mantido não exige nova
    // autorização quando só o de peças muda; reduzir um desconto também não. Aumentar acima do limite, sim.
    const increasedParts = partsDiscount > previous.partsDiscount;
    const increasedLabor = laborDiscount > previous.laborDiscount;
    evaluation.violations = evaluation.violations.filter((v) =>
      v.bucket === 'PRODUCT' ? increasedParts : v.bucket === 'SERVICE' ? increasedLabor : increasedParts || increasedLabor
    );
    evaluation.bucketsOverLimit = evaluation.bucketsOverLimit.filter((b) => (b === 'PRODUCT' ? increasedParts : increasedLabor));
    evaluation.requiresAuthorization = evaluation.violations.length > 0;
    if (evaluation.refusedByRule && !increasedParts && !increasedLabor) evaluation.refusedByRule = null;
    const authorizer = await authorizeDiscount(evaluation, {
      companyId,
      requesterId: requester.userId,
      reason: input.reason,
      authorizerNumericId: input.authorizerNumericId,
      authorizerPassword: input.authorizerPassword,
      authorizerMfaCode: input.authorizerMfaCode,
      actionEvent: 'SERVICE_ORDER_DISCOUNT',
      securityContext,
    });
    const reason = input.reason?.trim() || null;

    const result = await runInTransaction(async (tx) => {
      // Guarda contra concorrência: só aplica se a OS continua como foi lida (não paga, não encerrada, mesmos totais e
      // mesmo desconto). Um item lançado, um pagamento ou outro desconto no intervalo → 0 linhas → 409, nada gravado.
      const claimed = await tx.serviceOrder.updateMany({
        where: {
          id: serviceOrderId,
          companyId,
          isPaid: false,
          status: { notIn: CLOSED_STATUSES as any },
          partsTotal: os.partsTotal,
          laborTotal: os.laborTotal,
          discountAmount: os.discountAmount,
        },
        data: { discountAmount: totalDiscount, finalTotal: round2(partsTotal + laborTotal - totalDiscount) },
      });
      if (claimed.count === 0) {
        throw new ConflictError('A ordem de serviço mudou enquanto o desconto era aplicado (item, pagamento ou outro desconto). Atualize e tente de novo.', 'SERVICE_ORDER_CHANGED');
      }

      const events: DiscountEventInput[] = [];
      const base = { companyId, branchId: os.branchId, serviceOrderId, requestedBy: requester.userId, reason };
      if (changedParts) {
        const needed = evaluation.bucketsOverLimit.includes('PRODUCT') || evaluation.violations.some((v) => v.source === 'DISCOUNT_RULE');
        events.push({
          ...base,
          itemType: 'PART',
          description: `Peças da OS #${os.osNumber}`,
          originalAmount: partsTotal,
          discountAmount: partsDiscount,
          freeLimitPercent: evaluation.limits.PRODUCT,
          requiredAuthorization: needed,
          authorizedBy: needed ? authorizer?.id : null,
        });
      }
      if (changedLabor) {
        const needed = evaluation.bucketsOverLimit.includes('SERVICE') || evaluation.violations.some((v) => v.source === 'DISCOUNT_RULE');
        events.push({
          ...base,
          itemType: 'SERVICE',
          description: `Mão de obra da OS #${os.osNumber}`,
          originalAmount: laborTotal,
          discountAmount: laborDiscount,
          freeLimitPercent: evaluation.limits.SERVICE,
          requiredAuthorization: needed,
          authorizedBy: needed ? authorizer?.id : null,
        });
      }
      await recordDiscountEvents(tx, events);
      return tx.serviceOrder.findUniqueOrThrow({ where: { id: serviceOrderId } });
    });

    Logger.security(
      'SERVICE_ORDER_DISCOUNT_APPLIED',
      `Desconto na OS #${os.osNumber}: peças R$ ${partsDiscount.toFixed(2)}, mão de obra R$ ${laborDiscount.toFixed(2)}` +
        (authorizer ? ` — autorizado por ${authorizer.name}` : ' — dentro do limite livre'),
      { ...securityContext, serviceOrderId, authorizerId: authorizer?.id, amount: totalDiscount }
    );

    return {
      serviceOrder: result,
      partsDiscount,
      laborDiscount,
      discountAmount: totalDiscount,
      requiredAuthorization: evaluation.requiresAuthorization,
      authorizer: authorizer ? { id: authorizer.id, name: authorizer.name } : null,
    };
  }
}

export default new ServiceOrderDiscountService();
