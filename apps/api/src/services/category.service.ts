import { prisma } from '@ln-system/database';

/**
 * ACHADO DE AUDITORIA DE INTEGRAÇÃO: o model `Category` sempre existiu no
 * schema (com hierarquia via parentId/children, RLS já configurado desde a
 * migração inicial), e `Product.categoryId` já referencia essa tabela — mas
 * nenhum service/rota jamais existiu para ele. O client do admin-web
 * (api.getCategories()/createCategory()) já chamava GET/POST /categories
 * há tempos, mas a rota nunca foi montada em routes/index.ts, então TODA
 * chamada retornava 404 — silenciosamente engolido pelo `catch (error) {
 * console.error(...) }` nas páginas de criar/editar produto. Resultado:
 * o <select> de categoria ficava sempre vazio para todo mundo, em toda
 * empresa, sem erro nenhum visível ao usuário.
 */
export class CategoryService {
  async list(companyId: string) {
    return prisma.category.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string, companyId: string) {
    const category = await prisma.category.findFirst({ where: { id, companyId } });
    if (!category) {
      throw new Error('Category not found');
    }
    return category;
  }

  async create(data: { companyId: string; name: string; description?: string; parentId?: string }) {
    if (!data.name || !data.name.trim()) {
      throw new Error('name é obrigatório');
    }

    if (data.parentId) {
      const parent = await prisma.category.findFirst({ where: { id: data.parentId, companyId: data.companyId } });
      if (!parent) {
        throw new Error('Categoria pai não encontrada nesta empresa');
      }
    }

    return prisma.category.create({
      data: {
        companyId: data.companyId,
        name: data.name.trim(),
        description: data.description,
        parentId: data.parentId,
      },
    });
  }

  async update(
    id: string,
    companyId: string,
    data: { name?: string; description?: string; parentId?: string | null; isActive?: boolean }
  ) {
    const existing = await prisma.category.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Category not found');
    }

    if (data.parentId) {
      if (data.parentId === id) {
        throw new Error('Uma categoria não pode ser pai de si mesma');
      }
      const parent = await prisma.category.findFirst({ where: { id: data.parentId, companyId } });
      if (!parent) {
        throw new Error('Categoria pai não encontrada nesta empresa');
      }
    }

    return prisma.category.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name.trim() }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.parentId !== undefined && { parentId: data.parentId }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });
  }

  // Desativa em vez de apagar — produtos existentes referenciam a categoria
  // por categoryId (onDelete: SetNull no schema), então apagar de verdade
  // desassociaria produtos silenciosamente. Mesmo princípio já usado em
  // supplier/motorcycle/partner.service.ts nesta base.
  async deactivate(id: string, companyId: string) {
    const existing = await prisma.category.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Category not found');
    }
    await prisma.category.update({ where: { id }, data: { isActive: false } });
  }
}

export default new CategoryService();
