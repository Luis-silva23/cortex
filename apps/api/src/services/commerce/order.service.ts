import crypto from 'crypto';
import { z } from 'zod';
import { prisma, runInTransaction } from '@ln-system/database';
import type { ExternalOrder, ExternalOrderItem, ExternalOrderStatus } from '@prisma/client';
import type { ChannelPrincipal } from '../../middleware/channel-auth';
import { CommerceError, commerceError } from './errors';
import { releaseReservations } from '../stock-reservations';
import { enqueueOrderStatus } from '../integrations/outbox.service';

/**
 * Pedido externo da Commerce API. O que esta camada faz — e o que NÃO faz:
 *  - recebe o pedido do canal, RESOLVE cada item contra o catálogo PUBLICADO do CÓRTEX e confere o PREÇO OFICIAL: se o preço (ou o
 *    total) que o canal mostrou ao cliente difere do atual, o pedido inteiro é recusado (nunca se cobra um valor que o CÓRTEX não
 *    calculou). Recusar por preço é o comportamento conservador; a regra definitiva é decisão de produto (DECISIONS 89);
 *  - guarda o pedido (`RECEIVED`) com itens imutáveis. Pedido NÃO é venda: não baixa estoque, não cria pagamento nem documento fiscal.
 *    Aceitar (reservar estoque) e converter em venda são a Fase 2;
 *  - é idempotente: o mesmo `externalOrderId` com o mesmo conteúdo devolve o pedido já existente; com conteúdo diferente, 409;
 *  - empresa, filial e canal são os da credencial (`principal`), nunca os da requisição.
 */
const money = z
  .number()
  .finite()
  .min(0)
  .max(10_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'use no máximo 2 casas decimais');

const quantity = z
  .number()
  .finite()
  .positive()
  .max(100_000)
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'use no máximo 3 casas decimais');

export const createOrderSchema = z
  .object({
    externalOrderId: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:\-]+$/, 'use letras, números e . _ : -'),
    items: z
      .array(z.object({ sku: z.string().trim().min(1).max(80), quantity, unitPrice: money }).strict())
      .min(1)
      .max(200),
    total: money,
    currency: z.literal('BRL').default('BRL'),
    customer: z
      .object({
        name: z.string().trim().min(1).max(200),
        document: z.string().trim().max(30).optional(),
        email: z.string().trim().email().max(200).optional(),
        phone: z.string().trim().max(30).optional(),
      })
      .strict()
      .optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const toCents = (v: number) => Math.round(v * 100);
export const fromCents = (c: number) => c / 100;

export function orderFingerprint(input: CreateOrderInput): string {
  const items = [...input.items].sort((a, b) => a.sku.localeCompare(b.sku)).map((i) => [i.sku, i.quantity, toCents(i.unitPrice)]);
  return crypto.createHash('sha256').update(JSON.stringify({ items, total: toCents(input.total), customer: input.customer ?? null, notes: input.notes ?? null })).digest('hex');
}

type OrderWithItems = ExternalOrder & {
  items: ExternalOrderItem[];
  sale?: { saleNumber: number } | null;
  fulfillment?: { status: string; type: string | null } | null;
};

export function orderView(o: OrderWithItems) {
  return {
    orderId: o.externalOrderId,
    cortexOrderId: o.id,
    status: o.status,
    paymentStatus: o.paymentStatus,
    total: o.totalAmount === null ? null : Number(o.totalAmount),
    currency: 'BRL' as const,
    items: o.items.map((i) => ({ sku: i.sku, name: i.name, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), lineTotal: Number(i.lineTotal) })),
    statusReason: o.statusReason,
    statusChangedAt: o.statusChangedAt,
    receivedAt: o.receivedAt,
    // Só depois da conversão: número da venda e estado da entrega (a venda existe sem a entrega concluída).
    ...(o.sale ? { saleNumber: o.sale.saleNumber } : {}),
    ...(o.fulfillment ? { fulfillment: { status: o.fulfillment.status, type: o.fulfillment.type } } : {}),
  };
}

const ORDER_VIEW_INCLUDE = { items: true, sale: { select: { saleNumber: true } }, fulfillment: { select: { status: true, type: true } } } as const;

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

export type OrderActor = { type: 'CHANNEL'; keyId: string } | { type: 'USER'; userId: string } | { type: 'SYSTEM' };
const actorData = (a: OrderActor) => (a.type === 'USER' ? { actorId: a.userId, actor: 'USER' } : a.type === 'SYSTEM' ? { actor: 'SYSTEM' } : { actor: `CHANNEL:${a.keyId}` });

export async function logOrderEvent(
  tx: { channelEvent: { create: (args: any) => Promise<unknown> } },
  order: { id: string; companyId: string; branchId: string | null; channelId: string; externalOrderId: string },
  type: string,
  level: 'INFO' | 'WARN',
  message: string,
  actor: OrderActor,
  correlationId?: string,
  extra: Record<string, unknown> = {}
) {
  await tx.channelEvent.create({
    data: {
      companyId: order.companyId,
      branchId: order.branchId,
      channelId: order.channelId,
      type,
      level,
      message,
      correlationId: correlationId ?? null,
      actorId: actor.type === 'USER' ? actor.userId : null,
      data: { orderId: order.id, externalOrderId: order.externalOrderId, ...actorData(actor), ...extra } as any,
    },
  });
}

async function replayOrConflict(principal: ChannelPrincipal, input: CreateOrderInput) {
  const existing = await prisma.externalOrder.findFirst({ where: { channelId: principal.channelId, externalOrderId: input.externalOrderId }, include: { items: true } });
  if (!existing) throw commerceError.orderConflict();
  const stored = (existing.payload as { fingerprint?: string } | null)?.fingerprint;
  if (stored !== orderFingerprint(input)) throw commerceError.orderConflict();
  return { order: orderView(existing), replayed: true };
}

export const commerceOrderService = {
  /** `source`: de onde o pedido veio (Commerce API do site próprio ou webhook/consulta de um provedor pelo Integration Gateway). */
  async create(principal: ChannelPrincipal, raw: unknown, correlationId?: string, opts: { source?: 'COMMERCE_API' | 'WEBHOOK' } = {}) {
    const parsed = createOrderSchema.safeParse(raw);
    if (!parsed.success) throw commerceError.invalidRequest(parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
    const input = parsed.data;

    const skus = input.items.map((i) => i.sku);
    if (new Set(skus).size !== skus.length) throw commerceError.invalidRequest([{ path: 'items', message: 'SKU repetido: some as quantidades numa só linha' }]);

    try {
      return await runInTransaction(async (tx) => {
        const existing = await tx.externalOrder.findFirst({ where: { channelId: principal.channelId, externalOrderId: input.externalOrderId }, include: { items: true } });
        if (existing) {
          const stored = (existing.payload as { fingerprint?: string } | null)?.fingerprint;
          if (stored !== orderFingerprint(input)) throw commerceError.orderConflict();
          return { order: orderView(existing), replayed: true };
        }

        // Só produto PUBLICADO para este canal, ativo, da empresa e (se tiver filial) da filial de atendimento. Produto inexistente,
        // despublicado ou de outra filial são indistinguíveis para o canal (não revela o que existe).
        const links = await tx.channelProductLink.findMany({
          where: {
            channelId: principal.channelId,
            published: true,
            product: { is: { companyId: principal.companyId, isActive: true, sku: { in: skus }, OR: [{ branchId: null }, { branchId: principal.branchId }] } },
          },
          include: { product: { select: { id: true, sku: true, name: true, salePrice: true } } },
        });
        const bySku = new Map(links.map((l) => [l.product.sku, l.product]));
        const missing = skus.filter((s) => !bySku.has(s));
        if (missing.length) throw commerceError.productUnavailable(missing);

        const mismatches: Array<{ sku: string; channelUnitPrice: number; currentPrice: number }> = [];
        const lines = input.items.map((i) => {
          const product = bySku.get(i.sku)!;
          const priceCents = toCents(Number(product.salePrice));
          if (toCents(i.unitPrice) !== priceCents) mismatches.push({ sku: i.sku, channelUnitPrice: i.unitPrice, currentPrice: fromCents(priceCents) });
          return { product, quantity: i.quantity, priceCents, channelPriceCents: toCents(i.unitPrice), lineCents: Math.round(i.quantity * priceCents) };
        });
        if (mismatches.length) throw commerceError.priceMismatch(mismatches);

        const totalCents = lines.reduce((s, l) => s + l.lineCents, 0);
        if (toCents(input.total) !== totalCents) throw commerceError.totalMismatch(input.total, fromCents(totalCents));

        const created = await tx.externalOrder.create({
          data: {
            companyId: principal.companyId,
            branchId: principal.branchId,
            channelId: principal.channelId,
            externalOrderId: input.externalOrderId,
            status: 'RECEIVED',
            paymentStatus: 'UNKNOWN',
            source: opts.source ?? 'COMMERCE_API',
            totalAmount: fromCents(totalCents),
            channelTotal: input.total,
            correlationId: correlationId ?? null,
            payload: { fingerprint: orderFingerprint(input), currency: input.currency, customer: input.customer ?? null, notes: input.notes ?? null, itemCount: input.items.length } as any,
            items: {
              create: lines.map((l) => ({
                branchId: principal.branchId,
                productId: l.product.id,
                sku: l.product.sku,
                name: l.product.name,
                quantity: l.quantity,
                channelUnitPrice: fromCents(l.channelPriceCents),
                unitPrice: fromCents(l.priceCents),
                lineTotal: fromCents(l.lineCents),
              })),
            },
          },
          include: { items: true },
        });
        await logOrderEvent(tx, created, 'ORDER_RECEIVED', 'INFO', 'Pedido recebido pela Commerce API (ainda não é venda, pagamento nem baixa de estoque)', { type: 'CHANNEL', keyId: principal.keyId }, correlationId, {
          total: fromCents(totalCents),
          items: created.items.length,
        });
        return { order: orderView(created), replayed: false };
      });
    } catch (err) {
      // Corrida: duas requisições com o mesmo pedido ao mesmo tempo — a segunda viola a unicidade e vira repetição (ou conflito).
      if (isUniqueViolation(err)) return replayOrConflict(principal, input);
      throw err;
    }
  },

  async get(principal: ChannelPrincipal, externalOrderId: string) {
    const order = await prisma.externalOrder.findFirst({ where: { channelId: principal.channelId, externalOrderId }, include: ORDER_VIEW_INCLUDE });
    if (!order) throw commerceError.notFound('Pedido');
    return orderView(order);
  },

  /**
   * Cancelamento pelo canal, antes de virar venda (RECEIVED ou ACCEPTED): libera a reserva na mesma transação. Depois de virar venda
   * o cancelamento é o da venda (autorização, estorno e reposição de estoque pelo fluxo próprio) — aqui responde 409 e o evento do
   * canal fica como pedido de revisão. Repetir é inofensivo.
   */
  async cancelByChannel(principal: ChannelPrincipal, externalOrderId: string, reason: string | undefined, correlationId?: string) {
    const order = await prisma.externalOrder.findFirst({ where: { channelId: principal.channelId, externalOrderId } });
    if (!order) throw commerceError.notFound('Pedido');
    return transition(order.id, ['RECEIVED', 'ACCEPTED'], 'CANCELLED', reason ?? 'Cancelado pelo canal', { type: 'CHANNEL', keyId: principal.keyId }, correlationId);
  },

  // ----------------------------------------------------------------------------------------------------------------
  // Administração (usuário do CÓRTEX; a empresa vem do JWT e a RLS isola)
  // ----------------------------------------------------------------------------------------------------------------
  async listForChannel(companyId: string, channelId: string, input: { status?: ExternalOrderStatus; page: number; limit: number }) {
    // Canal de outra empresa (ou inexistente) é 404, não uma lista vazia que confirmaria o id.
    if (!(await prisma.salesChannel.findFirst({ where: { id: channelId, companyId }, select: { id: true } }))) throw commerceError.notFound('Canal');
    const where = { companyId, channelId, ...(input.status ? { status: input.status } : {}) };
    const [total, rows] = await Promise.all([
      prisma.externalOrder.count({ where }),
      prisma.externalOrder.findMany({ where, include: ORDER_VIEW_INCLUDE, orderBy: { receivedAt: 'desc' }, skip: (input.page - 1) * input.limit, take: input.limit }),
    ]);
    return { data: rows.map(orderView), pagination: { page: input.page, limit: input.limit, total } };
  },

  async getForAdmin(companyId: string, channelId: string, orderId: string) {
    const order = await prisma.externalOrder.findFirst({ where: { id: orderId, companyId, channelId }, include: { ...ORDER_VIEW_INCLUDE, payments: true, reservations: true } });
    if (!order) throw commerceError.notFound('Pedido');
    return {
      ...orderView(order),
      payments: order.payments.map((p) => ({ providerRef: p.providerRef, status: p.status, amount: Number(p.amount), method: p.method, source: p.source, lastEventAt: p.lastEventAt })),
      reservations: order.reservations.map((r) => ({ productId: r.productId, quantity: Number(r.quantity), status: r.status, expiresAt: r.expiresAt, closedReason: r.closedReason })),
    };
  },

  async rejectByAdmin(input: { companyId: string; channelId: string; orderId: string; reason: string; actorId: string; correlationId?: string }) {
    const order = await prisma.externalOrder.findFirst({ where: { id: input.orderId, companyId: input.companyId, channelId: input.channelId } });
    if (!order) throw commerceError.notFound('Pedido');
    return transition(order.id, ['RECEIVED'], 'REJECTED', input.reason, { type: 'USER', userId: input.actorId }, input.correlationId);
  },

  async cancelByAdmin(input: { companyId: string; channelId: string; orderId: string; reason: string; actorId: string; correlationId?: string }) {
    const order = await prisma.externalOrder.findFirst({ where: { id: input.orderId, companyId: input.companyId, channelId: input.channelId } });
    if (!order) throw commerceError.notFound('Pedido');
    return transition(order.id, ['RECEIVED', 'ACCEPTED'], 'CANCELLED', input.reason, { type: 'USER', userId: input.actorId }, input.correlationId);
  },
};

/** Muda o estado com guarda atômica (`UPDATE … WHERE status IN (from)`): duas mudanças concorrentes não passam as duas. */
async function transition(orderId: string, from: ExternalOrderStatus[], to: ExternalOrderStatus, reason: string, actor: OrderActor, correlationId?: string) {
  return runInTransaction(async (tx) => {
    const current = await tx.externalOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    if (current.status === to) return orderView(current); // já está nesse estado: repetir é inofensivo
    const res = await tx.externalOrder.updateMany({ where: { id: orderId, status: { in: from } }, data: { status: to, statusReason: reason.slice(0, 500), statusChangedAt: new Date() } });
    if (res.count !== 1) throw commerceError.invalidState(current.status);
    // A reserva do pedido morre junto com ele, na MESMA transação: o estoque volta a ficar disponível sem esperar rotina nenhuma.
    const released = await releaseReservations(tx, orderId, to === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_REJECTED');
    const updated = await tx.externalOrder.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_VIEW_INCLUDE });
    // Caixa de saída: avisa o provedor (se o canal tiver um). Quando foi o próprio canal que cancelou, não devolve o eco.
    if (!(actor.type === 'CHANNEL' && to === 'CANCELLED')) await enqueueOrderStatus(tx, updated, to === 'CANCELLED' ? 'CANCELLED' : 'REJECTED', { reason, correlationId });
    await logOrderEvent(tx, updated, to === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_REJECTED', 'INFO', to === 'CANCELLED' ? 'Pedido cancelado' : 'Pedido recusado', actor, correlationId, { reason: reason.slice(0, 200), reservationsReleased: released });
    // Dinheiro já confirmado num pedido que não vai virar venda: nunca é ignorado; a devolução é tratada por pessoa autorizada.
    const confirmed = await tx.externalPayment.count({ where: { orderId, status: 'CONFIRMED' } });
    if (confirmed > 0) await logOrderEvent(tx, updated, 'PAYMENT_ON_CLOSED_ORDER', 'WARN', `Pedido ${to === 'CANCELLED' ? 'cancelado' : 'recusado'} com pagamento confirmado: a devolução do dinheiro precisa de tratamento por pessoa autorizada`, actor, correlationId, { orderStatus: to });
    return orderView(updated);
  });
}

export { CommerceError };
export default commerceOrderService;
