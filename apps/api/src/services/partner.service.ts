import { prisma, Partner } from '@ln-system/database';

/**
 * Convênios/parceiros (catálogo de descontos nomeados que o cliente
 * apresenta no balcão — "tenho desconto do Posto Santa") — ver comentário
 * no schema.prisma sobre a diferença para `DiscountRule` (limite de
 * autorização por userType). Nenhum percentual/valor é fixo no código: tudo
 * vem do cadastro da própria empresa.
 */
export class PartnerService {
  async list(companyId: string, branchId?: string): Promise<Partner[]> {
    return prisma.partner.findMany({
      where: {
        companyId,
        ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string, companyId: string): Promise<Partner | null> {
    return prisma.partner.findFirst({ where: { id, companyId } });
  }

  async create(data: {
    companyId: string;
    branchId?: string | null;
    name: string;
    description?: string;
    discountType?: 'PERCENTAGE' | 'FIXED';
    discountValue: number;
    maxDiscountAmount?: number | null;
    stackable?: boolean;
    requiresApproval?: boolean;
    validFrom?: Date | null;
    validUntil?: Date | null;
  }): Promise<Partner> {
    if (data.discountType !== 'FIXED' && (data.discountValue < 0 || data.discountValue > 100)) {
      throw new Error('Percentual de desconto deve estar entre 0 e 100');
    }
    if (data.discountValue < 0) {
      throw new Error('Valor de desconto não pode ser negativo');
    }

    if (data.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: data.branchId, companyId: data.companyId } });
      if (!branch) {
        throw new Error('Filial não encontrada nesta empresa');
      }
    }

    return prisma.partner.create({
      data: {
        companyId: data.companyId,
        branchId: data.branchId ?? null,
        name: data.name,
        description: data.description,
        discountType: data.discountType ?? 'PERCENTAGE',
        discountValue: data.discountValue,
        maxDiscountAmount: data.maxDiscountAmount ?? null,
        stackable: data.stackable ?? false,
        requiresApproval: data.requiresApproval ?? false,
        validFrom: data.validFrom ?? null,
        validUntil: data.validUntil ?? null,
        isActive: true,
      },
    });
  }

  async update(
    id: string,
    companyId: string,
    data: Partial<{
      name: string;
      description: string | null;
      branchId: string | null;
      discountType: 'PERCENTAGE' | 'FIXED';
      discountValue: number;
      maxDiscountAmount: number | null;
      stackable: boolean;
      requiresApproval: boolean;
      validFrom: Date | null;
      validUntil: Date | null;
      isActive: boolean;
    }>
  ): Promise<Partner> {
    const existing = await prisma.partner.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Convênio não encontrado');
    }

    if (data.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: data.branchId, companyId } });
      if (!branch) {
        throw new Error('Filial não encontrada nesta empresa');
      }
    }

    return prisma.partner.update({ where: { id }, data });
  }

  /**
   * Convênio não tem histórico de venda por FK real (`Sale.partnerId` é
   * `onDelete: SetNull`) — ainda assim, preferimos desativar a excluir, para
   * o relatório de vendas antigas continuar mostrando qual convênio foi
   * usado em cada venda já fechada.
   */
  async delete(id: string, companyId: string): Promise<void> {
    const existing = await prisma.partner.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Convênio não encontrado');
    }
    await prisma.partner.delete({ where: { id } });
  }

  async toggleActive(id: string, companyId: string): Promise<Partner> {
    const existing = await prisma.partner.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Convênio não encontrado');
    }
    return prisma.partner.update({ where: { id }, data: { isActive: !existing.isActive } });
  }

  /**
   * Valida e calcula o desconto de convênio no momento da venda — chamado
   * de dentro de sale.service.ts::createSale. Nunca confia em nenhum valor
   * de desconto vindo do cliente: o `discountValue`/`maxDiscountAmount`
   * usados aqui são sempre os do registro em banco, nunca o que o PDV
   * eventualmente exiba na tela.
   */
  async validateAndComputeDiscount(params: {
    companyId: string;
    branchId: string;
    partnerId: string;
    grossSubtotal: number;
  }): Promise<{ discountAmount: number; requiresApproval: boolean; stackable: boolean; partner: { id: string; name: string } }> {
    const partner = await prisma.partner.findFirst({
      where: { id: params.partnerId, companyId: params.companyId },
    });

    if (!partner) {
      throw new Error('Convênio não encontrado');
    }
    if (!partner.isActive) {
      throw new Error(`Convênio "${partner.name}" está inativo`);
    }
    if (partner.branchId && partner.branchId !== params.branchId) {
      throw new Error(`Convênio "${partner.name}" não é válido nesta filial`);
    }

    const now = new Date();
    if (partner.validFrom && partner.validFrom > now) {
      throw new Error(`Convênio "${partner.name}" ainda não está vigente`);
    }
    if (partner.validUntil && partner.validUntil < now) {
      throw new Error(`Convênio "${partner.name}" expirou`);
    }

    let discountAmount =
      partner.discountType === 'PERCENTAGE'
        ? (params.grossSubtotal * Number(partner.discountValue)) / 100
        : Number(partner.discountValue);

    if (partner.maxDiscountAmount != null) {
      discountAmount = Math.min(discountAmount, Number(partner.maxDiscountAmount));
    }
    discountAmount = Math.min(discountAmount, params.grossSubtotal);

    return {
      discountAmount,
      requiresApproval: partner.requiresApproval,
      stackable: partner.stackable,
      partner: { id: partner.id, name: partner.name },
    };
  }
}

export default new PartnerService();
