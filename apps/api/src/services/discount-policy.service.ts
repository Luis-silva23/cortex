import { AppError, ConflictError } from '@ln-system/shared';
import { PrismaTransactionClient } from '@ln-system/database';
import { policyService } from './policy.service';
import { checkSaleDiscount } from './discount.service';
import { verifyDualAuthorization } from './dual-authorization.service';
import { SystemLogContext } from './logger.service';

/**
 * Política de desconto do CÓRTEX (docs/CORTEX/policies/DESCONTO.md) — decisão do dono em 2026-09-27:
 *
 *  - Peças/produtos: até `discount.productFreePercent` (padrão 5%) SEM autorização.
 *  - Serviços/mão de obra: `discount.serviceFreePercent` (padrão 0%) — qualquer desconto em serviço exige autorização.
 *  - O limite de cada tipo é aplicado sobre o SUBTOTAL DAQUELE TIPO (soma das peças / soma da mão de obra), nunca sobre
 *    o total misturado: 10% de desconto na mão de obra não "cabe" nos 5% livres das peças.
 *  - Acima do limite: autorização de um perfil de `discount.authorizerRoles` (padrão Gerente/Administrador), com as
 *    PRÓPRIAS credenciais, e quem solicita nunca autoriza (verifyDualAuthorization). Motivo obrigatório.
 *  - Todo desconto (inclusive dentro do limite livre) grava `discount_events`, item a item (append-only).
 *
 * Combinação com a `DiscountRule` antiga (por papel, discount.service.ts): a POLÍTICA é a base; uma regra ativa do papel
 * só pode RESTRINGIR MAIS. Regra excedida com `requiresApproval=true` → exige autorização (mesmo que a política
 * libere); regra excedida com `requiresApproval=false` → recusado (409), nem com autorização. Sem regra cadastrada vale
 * só a política (a antiga "sem regra = livre" deixou de existir por decisão do dono).
 */

export type DiscountBucket = 'PRODUCT' | 'SERVICE';
export type DiscountItemType = 'PRODUCT' | 'PART' | 'SERVICE' | 'ORDER';

export interface BucketTotals {
  /** Soma bruta do tipo (quantidade × preço), antes de qualquer desconto. */
  subtotal: number;
  /** Desconto manual total do tipo (itens + desconto geral atribuído ao tipo). */
  discount: number;
}

export interface DiscountViolation {
  itemType: DiscountItemType;
  bucket: DiscountBucket | 'ORDER';
  freeLimitPercent: number | null;
  requestedPercent: number;
  source: 'POLICY' | 'DISCOUNT_RULE';
}

export interface DiscountEvaluation {
  limits: Record<DiscountBucket, number>;
  requestedPercent: Record<DiscountBucket, number>;
  /** Tipos (buckets) cujo desconto passou do limite livre da política. */
  bucketsOverLimit: DiscountBucket[];
  violations: DiscountViolation[];
  requiresAuthorization: boolean;
  /** Regra do papel excedida sem permitir aprovação: recusa definitiva. */
  refusedByRule: { id: string; name: string; maxDiscount: number } | null;
  authorizerRoles: string[];
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const percentOf = (discount: number, base: number) => (base > 0 ? round3((discount / base) * 100) : 0);
// Tolerância de meio centavo: 5% de R$ 33,33 = 1,6665 — o operador que dá R$ 1,67 não deve pedir autorização.
const withinLimit = (discount: number, base: number, limitPercent: number) => discount <= round2((base * limitPercent) / 100) + 0.005;

/** 409 que o PDV/Admin usam para abrir o pedido de autorização (com o limite livre vigente e o percentual pedido). */
export class DiscountAuthorizationRequiredError extends ConflictError {
  details: {
    freeLimitPercent: number | null;
    requestedPercent: number;
    itemType: DiscountItemType;
    violations: DiscountViolation[];
    authorizerRoles: string[];
  };
  constructor(evaluation: DiscountEvaluation) {
    const first = evaluation.violations[0];
    const label =
      first.source === 'DISCOUNT_RULE'
        ? 'a regra de desconto do seu perfil'
        : first.itemType === 'SERVICE'
          ? `o limite sem autorização para serviços/mão de obra (${first.freeLimitPercent}%)`
          : `o limite sem autorização para peças/produtos (${first.freeLimitPercent}%)`;
    super(
      `Desconto de ${first.requestedPercent}% passa ${label}. É preciso a autorização de um gerente ou administrador (outra pessoa) e o motivo do desconto.`,
      'DISCOUNT_AUTHORIZATION_REQUIRED'
    );
    this.name = 'DiscountAuthorizationRequiredError';
    this.details = {
      freeLimitPercent: first.freeLimitPercent,
      requestedPercent: first.requestedPercent,
      itemType: first.itemType,
      violations: evaluation.violations,
      authorizerRoles: evaluation.authorizerRoles,
    };
    Object.setPrototypeOf(this, DiscountAuthorizationRequiredError.prototype);
  }
  toJSON() {
    return { ...super.toJSON(), details: this.details };
  }
}

/**
 * Avalia o desconto pedido contra a política (por tipo) e a regra do papel. Não lança: quem chama decide (exigir
 * autorização, recusar). `branchId` é o da venda/OS (a filial pode ter limite próprio).
 */
export async function evaluateDiscount(input: {
  companyId: string;
  branchId: string | null;
  userType: string;
  buckets: Partial<Record<DiscountBucket, BucketTotals>>;
  /** Descontos que não são manuais mas contam para a regra do papel (ex.: convênio "Posto Santa" da venda). */
  extraDiscountForRule?: number;
  /** Tipo gravado nas violações do bucket de produtos: PRODUCT na venda, PART na OS. */
  productItemType?: 'PRODUCT' | 'PART';
}): Promise<DiscountEvaluation> {
  const product = input.buckets.PRODUCT ?? { subtotal: 0, discount: 0 };
  const service = input.buckets.SERVICE ?? { subtotal: 0, discount: 0 };
  const grossSubtotal = product.subtotal + service.subtotal;
  const manualDiscount = product.discount + service.discount;
  const totalForRule = manualDiscount + (input.extraDiscountForRule ?? 0);

  // Regra do papel primeiro (compatibilidade: é a checagem que já existia, com a mesma assinatura).
  const rule = await checkSaleDiscount({
    companyId: input.companyId,
    userType: input.userType,
    subtotal: grossSubtotal,
    totalDiscount: totalForRule,
  });

  const policies = await policyService.effective(input.companyId, input.branchId);
  const limits: Record<DiscountBucket, number> = {
    PRODUCT: Number(policies['discount.productFreePercent']),
    SERVICE: Number(policies['discount.serviceFreePercent']),
  };
  const requestedPercent: Record<DiscountBucket, number> = {
    PRODUCT: percentOf(product.discount, product.subtotal),
    SERVICE: percentOf(service.discount, service.subtotal),
  };

  const violations: DiscountViolation[] = [];
  const bucketsOverLimit: DiscountBucket[] = [];
  if (product.discount > 0 && !withinLimit(product.discount, product.subtotal, limits.PRODUCT)) {
    bucketsOverLimit.push('PRODUCT');
    violations.push({ itemType: input.productItemType ?? 'PRODUCT', bucket: 'PRODUCT', freeLimitPercent: limits.PRODUCT, requestedPercent: requestedPercent.PRODUCT, source: 'POLICY' });
  }
  if (service.discount > 0 && !withinLimit(service.discount, service.subtotal, limits.SERVICE)) {
    bucketsOverLimit.push('SERVICE');
    violations.push({ itemType: 'SERVICE', bucket: 'SERVICE', freeLimitPercent: limits.SERVICE, requestedPercent: requestedPercent.SERVICE, source: 'POLICY' });
  }

  let refusedByRule: DiscountEvaluation['refusedByRule'] = null;
  if (!rule.allowed) {
    if (!rule.requiresApproval) {
      refusedByRule = rule.rule ?? { id: '', name: 'regra de desconto', maxDiscount: 0 };
    } else {
      violations.push({
        itemType: 'ORDER',
        bucket: 'ORDER',
        freeLimitPercent: rule.rule ? rule.rule.maxDiscount : null,
        requestedPercent: percentOf(totalForRule, grossSubtotal),
        source: 'DISCOUNT_RULE',
      });
    }
  }

  return {
    limits,
    requestedPercent,
    bucketsOverLimit,
    violations,
    requiresAuthorization: violations.length > 0,
    refusedByRule,
    authorizerRoles: [...(policies['discount.authorizerRoles'] as string[])],
  };
}

export interface DiscountAuthorizationInput {
  companyId: string;
  requesterId: string;
  reason?: string | null;
  authorizerNumericId?: number | null;
  authorizerPassword?: string | null;
  authorizerMfaCode?: string | null;
  /** Prefixo dos eventos de segurança: 'SALE_DISCOUNT', 'SERVICE_ORDER_DISCOUNT'. */
  actionEvent: string;
  securityContext?: SystemLogContext;
}

export const DISCOUNT_REASON_MIN = 5;

/**
 * Aplica a decisão da avaliação: recusa (regra do papel), pede autorização (409 com os dados), exige motivo e confere
 * o autorizador. Devolve o autorizador (ou null quando o desconto está dentro do limite livre).
 */
export async function authorizeDiscount(evaluation: DiscountEvaluation, input: DiscountAuthorizationInput) {
  if (evaluation.refusedByRule) {
    throw new ConflictError(
      `Desconto passa o máximo da regra "${evaluation.refusedByRule.name}" (${evaluation.refusedByRule.maxDiscount}) e esta regra não permite autorização por outra pessoa`,
      'DISCOUNT_LIMIT_EXCEEDED'
    );
  }
  if (!evaluation.requiresAuthorization) return null;

  if (!input.authorizerNumericId || !input.authorizerPassword) {
    throw new DiscountAuthorizationRequiredError(evaluation);
  }
  const reason = (input.reason ?? '').trim();
  if (reason.length < DISCOUNT_REASON_MIN) {
    throw new AppError(`Informe o motivo do desconto (mínimo ${DISCOUNT_REASON_MIN} caracteres)`, 400, 'DISCOUNT_REASON_REQUIRED');
  }

  return verifyDualAuthorization({
    companyId: input.companyId,
    requesterId: input.requesterId,
    authorizerNumericId: input.authorizerNumericId,
    authorizerPassword: input.authorizerPassword,
    authorizerMfaCode: input.authorizerMfaCode ?? undefined,
    allowedRoles: evaluation.authorizerRoles,
    actionEvent: input.actionEvent,
    subjectLabel: 'discount',
    securityContext: input.securityContext,
  });
}

export interface DiscountEventInput {
  companyId: string;
  branchId: string | null;
  saleId?: string | null;
  serviceOrderId?: string | null;
  quoteId?: string | null;
  itemRef?: string | null;
  itemType: DiscountItemType;
  description?: string | null;
  originalAmount: number;
  discountAmount: number;
  freeLimitPercent: number;
  requiredAuthorization: boolean;
  requestedBy: string;
  authorizedBy?: string | null;
  reason?: string | null;
}

/** Grava os eventos de desconto NA MESMA transação da venda/OS (sem desconto aplicado, sem evento; e vice-versa). */
export async function recordDiscountEvents(tx: PrismaTransactionClient, events: DiscountEventInput[]) {
  if (events.length === 0) return;
  await tx.discountEvent.createMany({
    data: events.map((e) => ({
      companyId: e.companyId,
      branchId: e.branchId,
      saleId: e.saleId ?? null,
      serviceOrderId: e.serviceOrderId ?? null,
      quoteId: e.quoteId ?? null,
      itemRef: e.itemRef ?? null,
      itemType: e.itemType,
      description: e.description ?? null,
      originalAmount: round2(e.originalAmount),
      discountAmount: round2(e.discountAmount),
      discountPercent: percentOf(e.discountAmount, e.originalAmount),
      finalAmount: round2(e.originalAmount - e.discountAmount),
      freeLimitPercent: e.freeLimitPercent,
      requiredAuthorization: e.requiredAuthorization,
      requestedBy: e.requestedBy,
      authorizedBy: e.authorizedBy ?? null,
      reason: e.reason ? e.reason.trim() : null,
    })),
  });
}
