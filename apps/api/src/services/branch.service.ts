import { prisma, runInTransaction, Branch } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { isRestrictViolation } from './db-errors';
import type { CreateBranchRequest, UpdateBranchRequest } from '@ln-system/shared/types';

export class BranchService {
  /**
   * Listar filiais de uma empresa
   */
  async findByCompany(companyId: string): Promise<Branch[]> {
    return prisma.branch.findMany({
      where: { companyId },
      orderBy: [{ isHeadquarter: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Buscar filial por ID — companyId é obrigatório para quem não é Super
   * Admin (garante isolamento entre empresas), opcional para Super Admin.
   */
  async findById(id: string, companyId?: string): Promise<Branch | null> {
    return prisma.branch.findFirst({
      where: companyId ? { id, companyId } : { id },
    });
  }

  /**
   * Criar filial.
   *
   * Aplica dois limites de negócio que antes não existiam em lugar nenhum
   * (não havia rota/service de filial): o limite de filiais do plano
   * (License.maxBranches, quando há uma licença ACTIVE) e, se a nova filial
   * for marcada como matriz, desmarca qualquer outra matriz existente da
   * mesma empresa — só pode haver uma por vez.
   */
  async create(data: CreateBranchRequest & { companyId: string }): Promise<Branch> {
    // AppError (não Error puro): o errorHandler devolvia 500 genérico para estas
    // duas regras de negócio e a tela só conseguia dizer "Erro ao criar filial".
    const company = await prisma.company.findUnique({ where: { id: data.companyId } });
    if (!company) {
      throw new AppError('Empresa não encontrada', 404, 'COMPANY_NOT_FOUND');
    }

    const activeLicense = await prisma.license.findFirst({
      where: { companyId: data.companyId, status: 'ACTIVE' },
    });

    if (activeLicense) {
      const branchCount = await prisma.branch.count({ where: { companyId: data.companyId } });
      if (branchCount >= activeLicense.maxBranches) {
        throw new AppError(
          `Limite de filiais do plano atingido (${activeLicense.maxBranches}). Fale com o Super ADM TI para ampliar a licença.`,
          409,
          'BRANCH_LIMIT_REACHED'
        );
      }
    }

    return runInTransaction(async (tx) => {
      if (data.isHeadquarter) {
        await tx.branch.updateMany({
          where: { companyId: data.companyId, isHeadquarter: true },
          data: { isHeadquarter: false },
        });
      }

      return tx.branch.create({
        data: {
          companyId: data.companyId,
          name: data.name,
          document: data.document,
          address: data.address,
          city: data.city,
          state: data.state,
          zipCode: data.zipCode,
          phone: data.phone,
          isHeadquarter: data.isHeadquarter ?? false,
          isActive: true,
        },
      });
    });
  }

  /**
   * Atualizar filial — companyId (quando informado) restringe a atualização
   * à empresa do requisitante, no mesmo padrão de proteção já usado em
   * user.service.ts (evita o mesmo tipo de IDOR cross-tenant já corrigido lá).
   */
  async update(id: string, data: UpdateBranchRequest, companyId?: string): Promise<Branch> {
    const existing = await this.findById(id, companyId);
    if (!existing) {
      throw new AppError('Filial não encontrada', 404, 'BRANCH_NOT_FOUND');
    }

    return runInTransaction(async (tx) => {
      if (data.isHeadquarter) {
        await tx.branch.updateMany({
          where: { companyId: existing.companyId, isHeadquarter: true, id: { not: id } },
          data: { isHeadquarter: false },
        });
      }

      return tx.branch.update({
        where: { id },
        data,
      });
    });
  }

  /**
   * Ativar/Desativar filial.
   */
  async toggleActive(id: string, companyId?: string): Promise<Branch> {
    const existing = await this.findById(id, companyId);
    if (!existing) {
      throw new AppError('Filial não encontrada', 404, 'BRANCH_NOT_FOUND');
    }

    if (existing.isActive) {
      const activeCount = await prisma.branch.count({
        where: { companyId: existing.companyId, isActive: true },
      });
      if (activeCount <= 1) {
        throw new AppError('Não é possível desativar a única filial ativa da empresa', 409, 'LAST_ACTIVE_BRANCH');
      }
    }

    return prisma.branch.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
  }

  /**
   * Deletar filial — protegido por duas checagens que a FK sozinha não
   * comunicaria com clareza para quem está usando a API: nunca deletar a
   * última filial da empresa, e deixar o erro de integridade referencial
   * (quando já existem vendas/OS/estoque referenciando esta filial) virar
   * uma mensagem legível em vez de um 500 cru do Postgres.
   */
  async delete(id: string, companyId?: string): Promise<void> {
    const existing = await this.findById(id, companyId);
    if (!existing) {
      throw new AppError('Filial não encontrada', 404, 'BRANCH_NOT_FOUND');
    }

    const totalBranches = await prisma.branch.count({ where: { companyId: existing.companyId } });
    if (totalBranches <= 1) {
      throw new AppError('Não é possível excluir a única filial da empresa', 409, 'LAST_BRANCH');
    }

    try {
      await prisma.branch.delete({ where: { id } });
    } catch (error: any) {
      if (isRestrictViolation(error)) {
        throw new AppError(
          'Não é possível excluir esta filial: existem vendas, ordens de serviço ou outros registros vinculados a ela. Desative-a em vez de excluir.',
          409,
          'BRANCH_IN_USE'
        );
      }
      throw error;
    }
  }
}

export default new BranchService();
