import { prisma, runInTransaction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';

/**
 * Publicação de produtos por canal. O CÓRTEX é o mestre do catálogo; aqui há só o VÍNCULO e o estado (`published`). Nada é visível
 * para um canal até ser publicado. Só produto da empresa e (se tiver filial) da filial de atendimento do canal pode ser publicado.
 */
export const MAX_SKUS_PER_CALL = 500;

export const publicationService = {
  async setPublished(input: { companyId: string; channelId: string; skus: string[]; published: boolean; actorId: string; correlationId?: string }) {
    const channel = await prisma.salesChannel.findFirst({ where: { id: input.channelId, companyId: input.companyId } });
    if (!channel) throw new AppError('Canal não encontrado', 404, 'CHANNEL_NOT_FOUND');
    if (channel.type === 'LOJA_FISICA') throw new AppError('A loja física não publica produtos', 409, 'CHANNEL_TYPE_NOT_SUPPORTED');
    const skus = [...new Set(input.skus.map((s) => s.trim()).filter(Boolean))];
    if (skus.length === 0 || skus.length > MAX_SKUS_PER_CALL) throw new AppError(`Informe de 1 a ${MAX_SKUS_PER_CALL} SKUs`, 400, 'VALIDATION_ERROR');

    const products = await prisma.product.findMany({
      where: {
        companyId: input.companyId,
        sku: { in: skus },
        ...(channel.branchId ? { OR: [{ branchId: null }, { branchId: channel.branchId }] } : {}),
      },
      select: { id: true, sku: true },
    });
    const found = new Set(products.map((p) => p.sku));
    const unknown = skus.filter((s) => !found.has(s));

    const now = new Date();
    await runInTransaction(async (tx) => {
      for (const p of products) {
        await tx.channelProductLink.upsert({
          where: { channelId_productId: { channelId: channel.id, productId: p.id } },
          create: {
            companyId: channel.companyId,
            branchId: channel.branchId,
            channelId: channel.id,
            productId: p.id,
            published: input.published,
            publishedAt: input.published ? now : null,
            publishedBy: input.actorId,
          },
          update: { published: input.published, publishedAt: input.published ? now : null, publishedBy: input.actorId },
        });
      }
      await tx.channelEvent.create({
        data: {
          companyId: channel.companyId,
          branchId: channel.branchId,
          channelId: channel.id,
          type: input.published ? 'PRODUCTS_PUBLISHED' : 'PRODUCTS_UNPUBLISHED',
          level: 'INFO',
          message: `${products.length} produto(s) ${input.published ? 'publicado(s)' : 'despublicado(s)'} para o canal`,
          actorId: input.actorId,
          correlationId: input.correlationId ?? null,
          data: { count: products.length, skus: products.slice(0, 50).map((p) => p.sku), unknown: unknown.slice(0, 50) } as any,
        },
      });
    });
    return { updated: products.length, unknownSkus: unknown };
  },

  async list(companyId: string, channelId: string, input: { page: number; limit: number; published?: boolean }) {
    const channel = await prisma.salesChannel.findFirst({ where: { id: channelId, companyId } });
    if (!channel) throw new AppError('Canal não encontrado', 404, 'CHANNEL_NOT_FOUND');
    const where = { channelId: channel.id, ...(input.published === undefined ? {} : { published: input.published }) };
    const [total, rows] = await Promise.all([
      prisma.channelProductLink.count({ where }),
      prisma.channelProductLink.findMany({
        where,
        include: { product: { select: { sku: true, name: true, salePrice: true, isActive: true } } },
        orderBy: { product: { name: 'asc' } },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
    ]);
    return {
      data: rows.map((r) => ({ sku: r.product.sku, name: r.product.name, price: Number(r.product.salePrice), productActive: r.product.isActive, published: r.published, publishedAt: r.publishedAt })),
      pagination: { page: input.page, limit: input.limit, total },
    };
  },
};

export default publicationService;
