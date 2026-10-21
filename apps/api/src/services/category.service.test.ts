/**
 * ACHADO DE AUDITORIA DE INTEGRAÇÃO: GET/POST /categories eram chamados
 * pelo admin-web há tempos mas nunca tiveram service/rota no backend —
 * toda chamada 404ava silenciosamente. Este teste cobre o service novo:
 * isolamento por tenant e validação de hierarquia (parentId).
 */

const findManyCategoryMock = jest.fn();
const findFirstCategoryMock = jest.fn();
const createCategoryMock = jest.fn();
const updateCategoryMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    category: {
      findMany: findManyCategoryMock,
      findFirst: findFirstCategoryMock,
      create: createCategoryMock,
      update: updateCategoryMock,
    },
  })),
  Prisma: {},
}));

import { CategoryService } from './category.service';

describe('CategoryService', () => {
  const service = new CategoryService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('escopa por companyId e só traz categorias ativas', async () => {
      findManyCategoryMock.mockResolvedValueOnce([{ id: 'cat-1', name: 'Óleos' }]);

      await service.list('company-A');

      expect(findManyCategoryMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { companyId: 'company-A', isActive: true } })
      );
    });
  });

  describe('getById', () => {
    it('rejeita quando a categoria não pertence à empresa (isolamento cross-tenant)', async () => {
      findFirstCategoryMock.mockResolvedValueOnce(null);

      await expect(service.getById('cat-of-another-company', 'company-A')).rejects.toThrow('Category not found');
    });
  });

  describe('create', () => {
    it('rejeita nome vazio', async () => {
      await expect(service.create({ companyId: 'company-A', name: '   ' })).rejects.toThrow('name é obrigatório');
      expect(createCategoryMock).not.toHaveBeenCalled();
    });

    it('rejeita parentId de outra empresa (isolamento cross-tenant na hierarquia)', async () => {
      findFirstCategoryMock.mockResolvedValueOnce(null); // parent não encontrado nesta empresa

      await expect(
        service.create({ companyId: 'company-A', name: 'Sub-óleos', parentId: 'parent-of-another-company' })
      ).rejects.toThrow('Categoria pai não encontrada nesta empresa');
      expect(createCategoryMock).not.toHaveBeenCalled();
    });

    it('cria normalmente quando o parentId pertence à mesma empresa', async () => {
      findFirstCategoryMock.mockResolvedValueOnce({ id: 'parent-1', companyId: 'company-A' });
      createCategoryMock.mockResolvedValueOnce({ id: 'cat-new', name: 'Sub-óleos' });

      const result = await service.create({ companyId: 'company-A', name: 'Sub-óleos', parentId: 'parent-1' });

      expect(result.id).toBe('cat-new');
      expect(createCategoryMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ companyId: 'company-A', name: 'Sub-óleos', parentId: 'parent-1' }) })
      );
    });
  });

  describe('update', () => {
    it('rejeita uma categoria sendo pai de si mesma', async () => {
      findFirstCategoryMock.mockResolvedValueOnce({ id: 'cat-1', companyId: 'company-A' });

      await expect(service.update('cat-1', 'company-A', { parentId: 'cat-1' })).rejects.toThrow(
        'não pode ser pai de si mesma'
      );
      expect(updateCategoryMock).not.toHaveBeenCalled();
    });

    it('rejeita quando a categoria não pertence à empresa (isolamento cross-tenant)', async () => {
      findFirstCategoryMock.mockResolvedValueOnce(null);

      await expect(service.update('cat-of-another-company', 'company-A', { name: 'Hackeado' })).rejects.toThrow(
        'Category not found'
      );
      expect(updateCategoryMock).not.toHaveBeenCalled();
    });
  });
});
