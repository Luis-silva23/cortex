import { prisma, InstallmentPolicy } from '@ln-system/database';

/**
 * Política de parcelamento configurável por empresa/filial/forma de
 * pagamento — ver comentário no schema.prisma. Antes desta classe,
 * `Payment.installments` era aceito sem NENHUMA validação de backend em
 * payment.service.ts::processPayment.
 */
export class InstallmentPolicyService {
  async list(companyId: string): Promise<InstallmentPolicy[]> {
    return prisma.installmentPolicy.findMany({
      where: { companyId },
      orderBy: [{ paymentMethod: 'asc' }, { branchId: 'asc' }],
    });
  }

  async create(data: {
    companyId: string;
    branchId?: string | null;
    paymentMethod: string;
    maxInstallments: number;
    interestFreeInstallments: number;
  }): Promise<InstallmentPolicy> {
    if (data.maxInstallments < 1) {
      throw new Error('maxInstallments deve ser pelo menos 1');
    }
    if (data.interestFreeInstallments < 0 || data.interestFreeInstallments > data.maxInstallments) {
      throw new Error('interestFreeInstallments deve estar entre 0 e maxInstallments');
    }

    if (data.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: data.branchId, companyId: data.companyId } });
      if (!branch) {
        throw new Error('Filial não encontrada nesta empresa');
      }
    }

    // A constraint única do banco (companyId, branchId, paymentMethod) não
    // pega duas políticas "todas as filiais" (branchId NULL) para o mesmo
    // método — Postgres trata NULL como distinto em índices únicos. Checagem
    // explícita para o caso branchId nulo, que é o único não coberto.
    if (!data.branchId) {
      const existing = await prisma.installmentPolicy.findFirst({
        where: { companyId: data.companyId, branchId: null, paymentMethod: data.paymentMethod as any },
      });
      if (existing) {
        throw new Error('Já existe uma política para todas as filiais com esta forma de pagamento — edite a existente');
      }
    }

    return prisma.installmentPolicy.create({
      data: {
        companyId: data.companyId,
        branchId: data.branchId ?? null,
        paymentMethod: data.paymentMethod as any,
        maxInstallments: data.maxInstallments,
        interestFreeInstallments: data.interestFreeInstallments,
        isActive: true,
      },
    });
  }

  async update(
    id: string,
    companyId: string,
    data: Partial<{ maxInstallments: number; interestFreeInstallments: number; isActive: boolean }>
  ): Promise<InstallmentPolicy> {
    const existing = await prisma.installmentPolicy.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Política de parcelamento não encontrada');
    }

    const maxInstallments = data.maxInstallments ?? existing.maxInstallments;
    const interestFreeInstallments = data.interestFreeInstallments ?? existing.interestFreeInstallments;
    if (maxInstallments < 1) {
      throw new Error('maxInstallments deve ser pelo menos 1');
    }
    if (interestFreeInstallments < 0 || interestFreeInstallments > maxInstallments) {
      throw new Error('interestFreeInstallments deve estar entre 0 e maxInstallments');
    }

    return prisma.installmentPolicy.update({ where: { id }, data });
  }

  async delete(id: string, companyId: string): Promise<void> {
    const existing = await prisma.installmentPolicy.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Política de parcelamento não encontrada');
    }
    await prisma.installmentPolicy.delete({ where: { id } });
  }

  /**
   * Consultada de dentro de payment.service.ts::processPayment. Regra de
   * fallback quando a empresa não cadastrou NENHUMA política para o método:
   * permite só 1x (à vista) — nunca assume um limite de parcelas "razoável"
   * arbitrário, e nunca deixa parcelamento sem limite algum por omissão.
   * Prioridade: política específica da filial > política de toda a empresa.
   */
  async validateInstallments(params: {
    companyId: string;
    branchId: string;
    paymentMethod: string;
    installments: number;
  }): Promise<void> {
    if (params.installments < 1) {
      throw new Error('installments deve ser pelo menos 1');
    }

    const policy =
      (await prisma.installmentPolicy.findFirst({
        where: { companyId: params.companyId, branchId: params.branchId, paymentMethod: params.paymentMethod as any, isActive: true },
      })) ||
      (await prisma.installmentPolicy.findFirst({
        where: { companyId: params.companyId, branchId: null, paymentMethod: params.paymentMethod as any, isActive: true },
      }));

    const maxAllowed = policy?.maxInstallments ?? 1;

    if (params.installments > maxAllowed) {
      throw new Error(
        `Parcelamento em ${params.installments}x excede o máximo permitido para ${params.paymentMethod} (${maxAllowed}x)`
      );
    }
  }
}

export default new InstallmentPolicyService();
