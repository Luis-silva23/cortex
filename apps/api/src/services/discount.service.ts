import { prisma } from '@ln-system/database';

/**
 * Limite/autorização de desconto (FASE 14) — o modelo `DiscountRule` já
 * existia no schema (companyId, userType, discountType, maxDiscount,
 * requiresApproval) mas nunca era consultado em lugar nenhum: qualquer
 * operador conseguia aplicar QUALQUER desconto (inclusive 100%, ou maior
 * que o valor do item) numa venda, sem checagem nem auditoria — gap real
 * correspondente à seção 28 do prompt mestre ("Manager/admin podem
 * autorizar conforme limites. Autorização precisa ser identificada.
 * Registrar auditoria.").
 *
 * Correspondência com roleId (RBAC granular) NÃO é considerada aqui — só
 * `userType` (sempre presente, ao contrário de uma role específica, que é
 * opcional). Regras com `roleId` preenchido são ignoradas por esta
 * implementação (propositalmente não combinadas por acidente com todos os
 * usuários de um tipo). Uma empresa que não cadastrou nenhuma regra
 * continua sem nenhuma restrição — este recurso é aditivo, nunca quebra
 * quem ainda não configurou nada.
 */
export interface DiscountCheckResult {
  allowed: boolean;
  requiresApproval: boolean;
  rule?: { id: string; name: string; maxDiscount: number };
}

export async function checkSaleDiscount(data: {
  companyId: string;
  userType: string;
  subtotal: number;
  totalDiscount: number; // soma de todo desconto aplicado (itens + geral), em R$
}): Promise<DiscountCheckResult> {
  if (data.totalDiscount <= 0) {
    return { allowed: true, requiresApproval: false };
  }

  // Regra específica do userType tem prioridade sobre a genérica da
  // empresa (userType null aplica a todos).
  const effectiveRule =
    (await prisma.discountRule.findFirst({
      where: { companyId: data.companyId, roleId: null, isActive: true, userType: data.userType as any },
    })) ||
    (await prisma.discountRule.findFirst({
      where: { companyId: data.companyId, roleId: null, isActive: true, userType: null },
    }));

  if (!effectiveRule) {
    return { allowed: true, requiresApproval: false };
  }

  const maxDiscount = Number(effectiveRule.maxDiscount);
  const withinLimit =
    effectiveRule.discountType === 'PERCENTAGE'
      ? data.subtotal > 0 && (data.totalDiscount / data.subtotal) * 100 <= maxDiscount
      : data.totalDiscount <= maxDiscount;

  if (withinLimit) {
    return { allowed: true, requiresApproval: false };
  }

  return {
    allowed: false,
    requiresApproval: effectiveRule.requiresApproval,
    rule: { id: effectiveRule.id, name: effectiveRule.name, maxDiscount },
  };
}
