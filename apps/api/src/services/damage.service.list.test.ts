/**
 * ACHADO DE AUDITORIA: DamageService.list() não tinha `take`/`skip` —
 * retornava TODAS as avarias já registradas pela empresa, para sempre
 * (registro é imutável, nunca apagado, só revertido). Mesma classe de bug
 * já corrigida em device-list/sales-stats nesta sessão. Este teste cobre
 * a paginação adicionada: default sensato, limite máximo, e que o filtro
 * de companyId/branchId/productId/isReversed é aplicado tanto na busca
 * quanto na contagem.
 */

const findManyMock = jest.fn().mockResolvedValue([]);
const countMock = jest.fn().mockResolvedValue(0);

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    damageRecord: { findMany: findManyMock, count: countMock },
  })),
  Prisma: {},
}));

jest.mock('./cache.service', () => ({
  __esModule: true,
  default: { invalidate: jest.fn().mockResolvedValue(undefined) },
}));

import { DamageService } from './damage.service';

describe('DamageService.list — paginação (achado de auditoria: sem take/skip antes)', () => {
  const service = new DamageService();

  beforeEach(() => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);
  });

  it('usa limit=100 e page=1 por padrão quando nada é informado', async () => {
    await service.list('company-A', {});

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'company-A' }, skip: 0, take: 100 })
    );
    expect(countMock).toHaveBeenCalledWith({ where: { companyId: 'company-A' } });
  });

  it('respeita page/limit informados e calcula skip corretamente', async () => {
    await service.list('company-A', { page: 3, limit: 20 });

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
  });

  it('limita o limit máximo em 200, mesmo se um valor maior for pedido', async () => {
    await service.list('company-A', { limit: 5000 });

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });

  it('aplica os filtros de branchId/productId/isReversed tanto na busca quanto na contagem', async () => {
    await service.list('company-A', { branchId: 'branch-1', productId: 'product-1', isReversed: false });

    const expectedWhere = { companyId: 'company-A', branchId: 'branch-1', productId: 'product-1', isReversed: false };
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    expect(countMock).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('devolve pagination com total/pages calculados a partir da contagem real', async () => {
    countMock.mockResolvedValueOnce(45);

    const result = await service.list('company-A', { limit: 20 });

    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 45, pages: 3 });
  });
});
