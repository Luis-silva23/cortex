import { prisma, Company } from '@ln-system/database';
import { revokeCompanyAccessTokens } from './access-token-revocation';
import type { CreateCompanyRequest, UpdateCompanyRequest } from '@ln-system/shared/types';

export class CompanyService {
  /**
   * Listar empresas
   */
  async findAll(): Promise<Company[]> {
    return prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            branches: true,
            users: true,
            licenses: true,
          },
        },
      },
    });
  }

  /**
   * Buscar empresa por ID
   */
  async findById(id: string): Promise<Company | null> {
    return prisma.company.findUnique({
      where: { id },
      include: {
        branches: true,
        licenses: true,
        _count: {
          select: {
            users: true,
          },
        },
      },
    });
  }

  /**
   * Criar empresa
   */
  async create(data: CreateCompanyRequest): Promise<Company> {
    return prisma.company.create({
      data: {
        name: data.name,
        document: data.document,
        email: data.email,
        phone: data.phone,
        isActive: true,
      },
    });
  }

  /**
   * Atualizar empresa
   */
  async update(id: string, data: UpdateCompanyRequest): Promise<Company> {
    return prisma.company.update({
      where: { id },
      data,
    });
  }

  /**
   * Deletar empresa
   *
   * `Company -> Branch` é `onDelete: Cascade` no schema, mas quase todas as
   * tabelas de negócio (Sale, ServiceOrder, StockMovement, CashRegister...)
   * guardam `companyId`/`branchId` como colunas simples SEM FK real — o
   * isolamento é feito via RLS, não via constraint referencial. Isso
   * significa que um delete direto de Company cascateava para Branch e User
   * sem qualquer proteção, e as tabelas de negócio ficavam com registros
   * órfãos permanentemente inacessíveis (companyId de uma empresa que não
   * existe mais não bate com nenhum contexto de RLS possível) — perda de
   * dados real e irreversível, disfarçada de "linha ainda existe no banco".
   * O próprio roadmap (FASE 31) só pede criar/editar/ativar/desativar/
   * consultar para empresas — nunca excluir uma empresa com dados reais.
   * Portanto: só permite excluir uma empresa vazia (sem filiais e sem
   * usuários). Para qualquer empresa com atividade real, use toggleActive.
   */
  async delete(id: string): Promise<void> {
    const company = await prisma.company.findUnique({
      where: { id },
      select: {
        id: true,
        _count: { select: { branches: true, users: true } },
      },
    });

    if (!company) {
      throw new Error('Empresa não encontrada');
    }

    if (company._count.branches > 0 || company._count.users > 0) {
      throw new Error(
        'Não é possível excluir uma empresa com filiais ou usuários vinculados. Desative a empresa em vez de excluir.'
      );
    }

    await prisma.company.delete({
      where: { id },
    });
  }

  /**
   * Ativar/Desativar empresa
   */
  async toggleActive(id: string): Promise<Company> {
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) {
      throw new Error('Empresa não encontrada');
    }

    const updated = await prisma.company.update({
      where: { id },
      data: { isActive: !company.isActive },
    });

    // Bloquear a empresa derruba as sessões: sem isso os usuários seguiam renovando o
    // acesso (o access token expira em 15 min, mas o refresh vale 7 dias). Mesmo padrão
    // de desativar usuário (user.service.ts). Reativar não recria sessão — é novo login.
    if (!updated.isActive) {
      await prisma.refreshToken.updateMany({
        where: { user: { companyId: id }, isRevoked: false },
        data: { isRevoked: true },
      });
      await revokeCompanyAccessTokens(id);
    }

    return updated;
  }
}
