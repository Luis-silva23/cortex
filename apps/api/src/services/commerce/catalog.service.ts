import { z } from 'zod';
import { prisma, runInTransaction } from '@ln-system/database';
import { availabilityOf } from '../stock-reservations';
import type { ChannelPrincipal } from '../../middleware/channel-auth';

/**
 * Catálogo para a Commerce API. O CÓRTEX é o mestre: o site LÊ daqui, sob demanda — nada é copiado. Nada é público até ser PUBLICADO
 * para o canal (`channel_product_links.published`). O canal nunca recebe custo, ids internos nem o livro de estoque: só uma PROJEÇÃO
 * de disponibilidade (saldo físico da filial do canal menos a margem de segurança, limitada por uma cota opcional).
 *
 * Política de estoque do canal (em `SalesChannel.config`, todos opcionais): `stockSafetyMargin` (padrão 0), `stockQuota` (padrão sem
 * cota) e `exposeStockQuantity` (padrão false: só "em estoque" / "sem estoque"). Os padrões não inventam regra comercial: margem,
 * cota e exibir a quantidade são decisões do dono (DECISIONS 90) e ficam configuráveis por canal.
 */
const stockPolicySchema = z
  .object({
    stockSafetyMargin: z.number().int().min(0).max(100_000).optional(),
    stockQuota: z.number().int().min(0).max(1_000_000).nullable().optional(),
    exposeStockQuantity: z.boolean().optional(),
  })
  .passthrough();

export interface StockPolicy {
  safetyMargin: number;
  quota: number | null;
  exposeQuantity: boolean;
}

export function readStockPolicy(config: unknown): StockPolicy {
  const parsed = stockPolicySchema.safeParse(config ?? {});
  const c = parsed.success ? parsed.data : {};
  return { safetyMargin: c.stockSafetyMargin ?? 0, quota: c.stockQuota ?? null, exposeQuantity: c.exposeStockQuantity === true };
}

/** Quantidade que o canal pode ver: nunca negativa, nunca fracionária, nunca acima da cota. */
export function exposedQuantity(balance: number, policy: Pick<StockPolicy, 'safetyMargin' | 'quota'>): number {
  const q = Math.max(0, Math.floor(balance - policy.safetyMargin));
  return policy.quota === null ? q : Math.min(q, policy.quota);
}

export interface CatalogProduct {
  sku: string;
  externalId: string | null;
  name: string;
  description: string | null;
  brand: string | null;
  unit: string;
  category: { id: string; name: string } | null;
  price: number;
  currency: 'BRL';
  inStock: boolean;
  availableQuantity?: number;
  updatedAt: Date;
}

type LinkWithProduct = Awaited<ReturnType<typeof fetchLinks>>[number];

const productSelect = {
  id: true,
  sku: true,
  name: true,
  description: true,
  brand: true,
  unit: true,
  salePrice: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
} as const;

function visibleWhere(principal: ChannelPrincipal, extra: object[] = []) {
  return {
    channelId: principal.channelId,
    published: true,
    product: {
      is: {
        companyId: principal.companyId,
        isActive: true,
        // produto da empresa toda (sem filial) ou da filial de atendimento do canal; nunca de outra filial
        AND: [{ OR: [{ branchId: null }, { branchId: principal.branchId }] }, ...extra],
      },
    },
  };
}

async function fetchLinks(where: object, opts: { skip?: number; take?: number } = {}) {
  return prisma.channelProductLink.findMany({
    where: where as any,
    include: { product: { select: productSelect } },
    orderBy: { product: { name: 'asc' } },
    ...opts,
  });
}

type ChannelView = Pick<ChannelPrincipal, 'companyId' | 'branchId' | 'channelId' | 'channelConfig'>;

/** Disponível para venda por produto = saldo do livro da filial − reservas vivas de pedidos externos (a mesma conta do balcão e da conversão). */
async function availableByProduct(view: ChannelView, productIds: string[]): Promise<Map<string, number>> {
  // Consulta crua no cliente global não recebe o contexto RLS: roda dentro de uma transação (que o recebe), como o livro de estoque exige.
  const map = await runInTransaction((tx) => availabilityOf(tx, { companyId: view.companyId, branchId: view.branchId, productIds }));
  return new Map(productIds.map((id) => [id, map.get(id)?.available ?? 0]));
}

async function project(principal: ChannelPrincipal, links: LinkWithProduct[]): Promise<CatalogProduct[]> {
  const policy = readStockPolicy(principal.channelConfig);
  const available = await availableByProduct(principal, links.map((l) => l.product.id));
  return links.map((l) => {
    const quantity = exposedQuantity(available.get(l.product.id) ?? 0, policy);
    const out: CatalogProduct = {
      sku: l.product.sku,
      externalId: l.externalId,
      name: l.product.name,
      description: l.product.description,
      brand: l.product.brand,
      unit: l.product.unit,
      category: l.product.category ? { id: l.product.category.id, name: l.product.category.name } : null,
      price: Number(l.product.salePrice),
      currency: 'BRL',
      inStock: quantity > 0,
      updatedAt: l.product.updatedAt,
    };
    if (policy.exposeQuantity) out.availableQuantity = quantity;
    return out;
  });
}

export const catalogService = {
  async list(principal: ChannelPrincipal, input: { page: number; limit: number; q?: string }) {
    const extra: object[] = [];
    if (input.q) extra.push({ OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { sku: { contains: input.q, mode: 'insensitive' } }] });
    const where = visibleWhere(principal, extra);
    const [total, links] = await Promise.all([
      prisma.channelProductLink.count({ where: where as any }),
      fetchLinks(where, { skip: (input.page - 1) * input.limit, take: input.limit }),
    ]);
    return { data: await project(principal, links), pagination: { page: input.page, limit: input.limit, total } };
  },

  async getBySku(principal: ChannelPrincipal, sku: string): Promise<CatalogProduct | null> {
    const links = await fetchLinks(visibleWhere(principal, [{ sku }]), { take: 1 });
    if (links.length === 0) return null;
    return (await project(principal, links))[0];
  },

  /**
   * O que a caixa de saída envia a um provedor (catálogo, preço ou estoque), só do PUBLICADO para o canal, com a mesma projeção da
   * leitura: estoque = disponível (saldo − reservas) menos margem e limitado pela cota. O provedor nunca recebe custo nem ids internos.
   */
  async syncItems(view: ChannelView, kind: 'INVENTORY' | 'PRICE' | 'CATALOG') {
    const links = await fetchLinks(visibleWhere(view as ChannelPrincipal));
    if (kind === 'PRICE') return links.map((l) => ({ sku: l.product.sku, price: Number(l.product.salePrice) }));
    if (kind === 'CATALOG') return links.map((l) => ({ sku: l.product.sku, name: l.product.name, description: l.product.description, brand: l.product.brand, unit: l.product.unit, category: l.product.category?.name ?? null }));
    const policy = readStockPolicy(view.channelConfig);
    const available = await availableByProduct(view, links.map((l) => l.product.id));
    return links.map((l) => ({ sku: l.product.sku, quantity: exposedQuantity(available.get(l.product.id) ?? 0, policy) }));
  },

  /** Categorias que têm ao menos um produto publicado e ativo para o canal. */
  async categories(principal: ChannelPrincipal) {
    return prisma.category.findMany({
      where: {
        companyId: principal.companyId,
        isActive: true,
        products: { some: { isActive: true, channelLinks: { some: { channelId: principal.channelId, published: true } } } },
      },
      select: { id: true, name: true, parentId: true },
      orderBy: { name: 'asc' },
    });
  },
};

export default catalogService;
