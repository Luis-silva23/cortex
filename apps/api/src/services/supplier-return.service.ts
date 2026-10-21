import { Prisma } from '@prisma/client';
import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { AppError, AuthorizationError, ConflictError } from '@ln-system/shared';
import { policyService } from './policy.service';
import { stockLedger } from './stock-ledger';
import stockService from './stock.service';
import { reservedByProduct } from './stock-reservations';
import { withCompanyWideRead } from '../utils/company-wide-read';

/**
 * Devolução ao fornecedor (docs/CORTEX/policies/DEVOLUCAO-FORNECEDOR.md).
 *
 * NÃO é garantia ao cliente (essa nasce da OS — warranty.service.ts). Aqui o produto/peça veio da cadeia de
 * fornecimento e volta para o fornecedor: danificado, com defeito, errado, não pedido ou outro motivo.
 *
 * Fluxo: REQUESTED → APPROVED (estoque sai NA MESMA transação) | REJECTED → SENT → CLOSED (resultado);
 * CANCELLED só antes do envio (se já aprovada, o estoque volta com movimento de entrada referenciado).
 * Nada é apagado: cada passo grava um evento (supplier_return_events) e a auditoria da rota.
 *
 * O que NÃO é decidido aqui (política da empresa, ainda não definida): lançamento financeiro do crédito/reembolso
 * (conta a pagar/receber) e documento fiscal de devolução de compra. O resultado só é REGISTRADO (tipo + valor).
 */

export const SUPPLIER_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'SENT', 'CLOSED', 'CANCELLED'] as const;
export const SUPPLIER_RETURN_REASONS = ['DAMAGED', 'DEFECTIVE', 'WRONG_ITEM', 'NOT_ORDERED', 'OTHER'] as const;
export const SUPPLIER_RETURN_OUTCOMES = ['CREDIT', 'REPLACEMENT', 'REFUND', 'REFUSED_BY_SUPPLIER'] as const;

export type SupplierReturnStatus = (typeof SUPPLIER_RETURN_STATUSES)[number];
export type SupplierReturnReason = (typeof SUPPLIER_RETURN_REASONS)[number];
export type SupplierReturnOutcome = (typeof SUPPLIER_RETURN_OUTCOMES)[number];

const STATUS_LABEL: Record<SupplierReturnStatus, string> = {
  REQUESTED: 'solicitada',
  APPROVED: 'aprovada',
  REJECTED: 'recusada',
  SENT: 'enviada ao fornecedor',
  CLOSED: 'encerrada',
  CANCELLED: 'cancelada',
};

/** Quem pode registrar e movimentar (solicitar, enviar). MECHANIC nem chega aqui (rota nega); VIEWER só consulta. */
export const SUPPLIER_RETURN_WRITER_TYPES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'] as const;

// classid do advisory lock da numeração de devolução (4201 OS, 4202 venda, 4203 pedido de compra, 4204 orçamento,
// 4205/4206 fiscal, 4210 agenda). Chave = empresa, porque o número é único por empresa.
const NUMBER_LOCK_CLASS = 4220;
const MAX_NUMBER_ATTEMPTS = 5;

export interface SupplierReturnActor {
  userId: string;
  userType: string;
  companyId: string;
  branchId?: string | null;
}

export interface CreateSupplierReturnInput {
  branchId: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  reason: SupplierReturnReason;
  description?: string | null;
  items: Array<{ productId: string; quantity: number; unitCost?: number | null; notes?: string | null; damageRecordId?: string | null }>;
}

export interface CloseSupplierReturnInput {
  outcome: SupplierReturnOutcome;
  outcomeAmount?: number | null;
  outcomeNotes?: string | null;
  /** Só em REPLACEMENT: quantidades de reposição que CHEGARAM (entrada de estoque). Sem isto, nada entra. */
  receivedItems?: Array<{ productId: string; quantity: number }>;
}

const fmtQty = (n: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(n);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Escopo de filial explícito, espelhando `rls_company_branch_match` (defesa em profundidade): SUPER_ADMIN/COMPANY_ADMIN
 * veem todas as filiais da empresa; os demais só a filial do token. Sem isto o isolamento entre filiais dependia só da
 * RLS — e uma conexão com papel que ignora RLS (superusuário/BYPASSRLS, ex.: banco de teste migrado como postgres)
 * entregava a devolução da filial 1 ao operador da filial 2.
 */
function branchScope(actor: SupplierReturnActor): Prisma.SupplierReturnWhereInput {
  if (actor.userType === 'SUPER_ADMIN' || actor.userType === 'COMPANY_ADMIN') return {};
  return { branchId: actor.branchId ?? '__sem_filial__' };
}

function notFound(): never {
  throw new AppError(
    'Devolução ao fornecedor não encontrada. Confira o número ou se ela é de outra filial.',
    404,
    'SUPPLIER_RETURN_NOT_FOUND'
  );
}

function statusChanged(): never {
  throw new ConflictError(
    'Esta devolução foi alterada por outra pessoa agora mesmo. Atualize a tela e confira a situação antes de tentar de novo.',
    'SUPPLIER_RETURN_STATUS_CHANGED'
  );
}

function invalidTransition(current: string, action: string, hint: string): never {
  throw new ConflictError(
    `A devolução está ${STATUS_LABEL[current as SupplierReturnStatus] ?? current} e não pode ser ${action}. ${hint}`,
    'SUPPLIER_RETURN_INVALID_TRANSITION'
  );
}

async function approverRoles(companyId: string, branchId: string): Promise<string[]> {
  const policies = await policyService.effective(companyId, branchId);
  return [...(policies['supplierReturn.approverRoles'] as string[])];
}

function hasApproverRole(actor: SupplierReturnActor, roles: string[]): boolean {
  return actor.userType === 'SUPER_ADMIN' || roles.includes(actor.userType);
}

const ROLE_LABEL: Record<string, string> = { MANAGER: 'Gerente', COMPANY_ADMIN: 'Administrador da empresa' };
const rolesText = (roles: string[]) => roles.map((r) => ROLE_LABEL[r] ?? r).join(' ou ');

async function assertApprover(actor: SupplierReturnActor, companyId: string, branchId: string, action: string) {
  const roles = await approverRoles(companyId, branchId);
  if (!hasApproverRole(actor, roles)) {
    throw new AuthorizationError(
      `Seu perfil não pode ${action} devolução ao fornecedor. Peça a um ${rolesText(roles)} (política "Quem aprova devolução ao fornecedor").`,
      'SUPPLIER_RETURN_APPROVER_REQUIRED'
    );
  }
  return roles;
}

function assertWriter(actor: SupplierReturnActor) {
  if (!(SUPPLIER_RETURN_WRITER_TYPES as readonly string[]).includes(actor.userType)) {
    throw new AuthorizationError(
      'Seu perfil só consulta devoluções ao fornecedor. Peça a um operador, gerente ou administrador para registrar.',
      'SUPPLIER_RETURN_FORBIDDEN'
    );
  }
}

/**
 * Maior número de devolução da EMPRESA inteira. A RLS de supplier_returns é empresa+filial: um usuário preso a uma
 * filial só enxerga as linhas dela, e o número é único por empresa — ler o máximo só da filial gerava número repetido
 * (P2002) em toda empresa com mais de uma filial. A leitura do máximo (atrás da trava 4220) usa a única ampliação
 * auditada da API, utils/company-wide-read.ts: mesma empresa, só esta leitura, contexto restaurado.
 */
async function nextReturnNumber(tx: PrismaTransactionClient, companyId: string): Promise<number> {
  const [{ n }] = await withCompanyWideRead(tx, companyId, () =>
    tx.$queryRaw<Array<{ n: number }>>`SELECT COALESCE(MAX("returnNumber"), 0)::int AS n FROM supplier_returns WHERE "companyId" = ${companyId}`
  );
  return n + 1;
}

async function addEvent(
  tx: PrismaTransactionClient,
  ret: { id: string; companyId: string; branchId: string },
  e: { type: string; fromStatus?: string | null; toStatus?: string | null; userId: string; notes?: string | null }
) {
  await tx.supplierReturnEvent.create({
    data: {
      companyId: ret.companyId,
      branchId: ret.branchId,
      returnId: ret.id,
      type: e.type,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      userId: e.userId,
      notes: e.notes ?? null,
    },
  });
}

/** Troca de status atômica: só passa se o status ainda for o lido. Duas decisões simultâneas → uma ganha, a outra 409. */
async function guardedTransition(
  tx: PrismaTransactionClient,
  ret: { id: string; companyId: string },
  from: SupplierReturnStatus[],
  data: Prisma.SupplierReturnUncheckedUpdateManyInput
) {
  const res = await tx.supplierReturn.updateMany({ where: { id: ret.id, companyId: ret.companyId, status: { in: from } }, data });
  if (res.count === 0) statusChanged();
}

type LoadedReturn = Prisma.SupplierReturnGetPayload<{ include: { items: { include: { product: { select: { id: true; name: true; sku: true } } } } } }>;

/** Itens que movimentam estoque: os ligados a uma avaria já saíram do estoque pela avaria (LOSS) — não saem de novo. */
const stockLines = (ret: LoadedReturn) => ret.items.filter((i) => !i.damageRecordId);

async function writeMovements(
  tx: PrismaTransactionClient,
  ret: LoadedReturn,
  movementType: 'SUPPLIER_RETURN' | 'RETURN' | 'PURCHASE',
  lines: Array<{ productId: string; quantity: number; unitCost: number | null }>,
  userId: string,
  notes: string
) {
  for (const l of lines) {
    await tx.stockMovement.create({
      data: {
        companyId: ret.companyId,
        branchId: ret.branchId,
        productId: l.productId,
        movementType,
        quantity: l.quantity,
        unitCost: l.unitCost ?? undefined,
        totalCost: l.unitCost !== null ? Math.round(l.unitCost * l.quantity * 100) / 100 : undefined,
        referenceType: 'SupplierReturn',
        referenceId: ret.id,
        notes,
        userId,
      },
    });
  }
}

async function invalidateStock(productIds: string[]) {
  for (const id of new Set(productIds)) await stockService.invalidateStockCache(id);
}

export class SupplierReturnService {
  private async load(id: string, actor: SupplierReturnActor): Promise<LoadedReturn> {
    const ret = await prisma.supplierReturn.findFirst({
      where: { id, companyId: actor.companyId, ...branchScope(actor) },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true } } } } },
    });
    if (!ret) notFound();
    return ret;
  }

  /** Solicitar devolução (REQUESTED). Não mexe no estoque — só a aprovação retira. */
  async create(actor: SupplierReturnActor, input: CreateSupplierReturnInput) {
    assertWriter(actor);
    const companyId = actor.companyId;
    if (!input.items || input.items.length === 0) {
      throw new AppError('Inclua ao menos um produto na devolução.', 400, 'SUPPLIER_RETURN_NO_ITEMS');
    }

    const supplier = await prisma.supplier.findFirst({ where: { id: input.supplierId, companyId }, select: { id: true } });
    if (!supplier) {
      throw new AppError('Fornecedor não encontrado nesta empresa. Selecione um fornecedor cadastrado.', 400, 'SUPPLIER_NOT_FOUND');
    }

    if (input.purchaseOrderId) {
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: input.purchaseOrderId, companyId },
        select: { id: true, supplierId: true, branchId: true, poNumber: true },
      });
      if (!po) throw new AppError('Pedido de compra não encontrado nesta empresa/filial.', 400, 'PURCHASE_ORDER_NOT_FOUND');
      if (po.supplierId !== input.supplierId) {
        throw new AppError(`O pedido de compra #${po.poNumber} é de outro fornecedor. Escolha o fornecedor do pedido ou retire o pedido.`, 400, 'PURCHASE_ORDER_SUPPLIER_MISMATCH');
      }
      if (po.branchId !== input.branchId) {
        throw new AppError(`O pedido de compra #${po.poNumber} foi recebido em outra filial. Registre a devolução na filial do pedido.`, 400, 'PURCHASE_ORDER_BRANCH_MISMATCH');
      }
    }

    const seen = new Set<string>();
    for (const it of input.items) {
      const key = `${it.productId}|${it.damageRecordId ?? ''}`;
      if (seen.has(key)) {
        throw new AppError('O mesmo produto aparece mais de uma vez. Some as quantidades numa linha só.', 400, 'SUPPLIER_RETURN_DUPLICATE_ITEM');
      }
      seen.add(key);
      if (!(it.quantity > 0)) throw new AppError('A quantidade de cada item precisa ser maior que zero.', 400, 'INVALID_QUANTITY');
    }

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, companyId },
      select: { id: true, name: true, productType: true, branchId: true },
    });
    // Produto cadastrado só para outra filial não sai do estoque desta (o livro é por filial).
    if (products.length !== productIds.length || products.some((p) => p.branchId && p.branchId !== input.branchId)) {
      throw new AppError('Um ou mais produtos não foram encontrados nesta empresa/filial. Confira os itens.', 400, 'PRODUCT_NOT_FOUND');
    }
    const service = products.find((p) => p.productType === 'SERVICE');
    if (service) {
      throw new AppError(`"${service.name}" é serviço, não mercadoria — não há o que devolver ao fornecedor.`, 400, 'SUPPLIER_RETURN_SERVICE_ITEM');
    }

    const damageIds = [...new Set(input.items.map((i) => i.damageRecordId).filter((d): d is string => !!d))];
    const damages = damageIds.length
      ? await prisma.damageRecord.findMany({
          where: { id: { in: damageIds }, companyId },
          select: { id: true, productId: true, branchId: true, quantity: true, isReversed: true },
        })
      : [];
    for (const it of input.items.filter((i) => i.damageRecordId)) {
      const d = damages.find((x) => x.id === it.damageRecordId);
      if (!d) throw new AppError('Avaria informada não encontrada nesta empresa/filial.', 400, 'DAMAGE_RECORD_NOT_FOUND');
      if (d.isReversed) throw new AppError('A avaria informada foi revertida — o produto voltou ao estoque. Retire o vínculo com a avaria.', 400, 'DAMAGE_RECORD_REVERSED');
      if (d.productId !== it.productId) throw new AppError('A avaria informada é de outro produto.', 400, 'DAMAGE_RECORD_PRODUCT_MISMATCH');
      if (d.branchId !== input.branchId) throw new AppError('A avaria informada é de outra filial.', 400, 'DAMAGE_RECORD_BRANCH_MISMATCH');
      if (it.quantity > Number(d.quantity)) {
        throw new AppError(`A avaria registrou ${fmtQty(Number(d.quantity))} unidade(s); a devolução ligada a ela não pode ter mais que isso.`, 400, 'DAMAGE_RECORD_QUANTITY_EXCEEDED');
      }
    }

    for (let attempt = 1; attempt <= MAX_NUMBER_ATTEMPTS; attempt++) {
      try {
        const created = await runInTransaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NUMBER_LOCK_CLASS}::int, hashtext(${companyId}))`;

          // Avaria já usada em outra devolução em andamento/encerrada: a soma não passa da quantidade avariada.
          // Checado atrás da mesma trava da numeração (duas solicitações simultâneas não passam juntas).
          for (const d of damages) {
            const used = await tx.supplierReturnItem.aggregate({
              where: { companyId, damageRecordId: d.id, supplierReturn: { status: { notIn: ['REJECTED', 'CANCELLED'] } } },
              _sum: { quantity: true },
            });
            const already = Number(used._sum.quantity ?? 0);
            const now = input.items.filter((i) => i.damageRecordId === d.id).reduce((s, i) => s + i.quantity, 0);
            if (round3(already + now) > Number(d.quantity)) {
              throw new ConflictError(
                `Esta avaria já está em outra devolução (${fmtQty(already)} de ${fmtQty(Number(d.quantity))} unidade(s)). Confira as devoluções abertas antes de repetir.`,
                'DAMAGE_RECORD_ALREADY_RETURNED'
              );
            }
          }

          const returnNumber = await nextReturnNumber(tx, companyId);
          const ret = await tx.supplierReturn.create({
            data: {
              companyId,
              branchId: input.branchId,
              returnNumber,
              supplierId: input.supplierId,
              purchaseOrderId: input.purchaseOrderId ?? null,
              status: 'REQUESTED',
              reason: input.reason,
              description: input.description ?? null,
              requestedBy: actor.userId,
              items: {
                create: input.items.map((i) => ({
                  branchId: input.branchId,
                  productId: i.productId,
                  quantity: i.quantity,
                  unitCost: i.unitCost ?? null,
                  notes: i.notes ?? null,
                  damageRecordId: i.damageRecordId ?? null,
                })),
              },
            },
          });
          await addEvent(tx, ret, { type: 'REQUESTED', toStatus: 'REQUESTED', userId: actor.userId, notes: input.description ?? null });
          return ret;
        });
        return this.getById(created.id, actor);
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') || attempt === MAX_NUMBER_ATTEMPTS) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictError('Não foi possível numerar a devolução agora (muitas solicitações ao mesmo tempo). Tente de novo.', 'SUPPLIER_RETURN_NUMBER_CONFLICT');
          }
          throw e;
        }
      }
    }
    throw new ConflictError('Não foi possível numerar a devolução agora. Tente de novo.', 'SUPPLIER_RETURN_NUMBER_CONFLICT');
  }

  /** Aprovar: REQUESTED → APPROVED e retirada do estoque na MESMA transação (saldo conferido sob trava do produto). */
  async approve(id: string, actor: SupplierReturnActor, notes?: string | null) {
    const ret = await this.load(id, actor);
    await assertApprover(actor, ret.companyId, ret.branchId, 'aprovar');
    if (ret.requestedBy === actor.userId) {
      throw new AuthorizationError(
        'Quem solicitou a devolução não pode aprovar a própria solicitação. Peça a outro responsável para aprovar.',
        'SUPPLIER_RETURN_SELF_DECISION'
      );
    }
    if (ret.status !== 'REQUESTED') invalidTransition(ret.status, 'aprovada', 'Só devoluções solicitadas são aprovadas.');

    const lines = stockLines(ret).map((i) => ({ productId: i.productId, quantity: Number(i.quantity), unitCost: i.unitCost !== null ? Number(i.unitCost) : null }));
    const now = new Date();

    await runInTransaction(async (tx) => {
      // 1º a guarda de status (trava a linha da devolução): a segunda aprovação simultânea espera, relê o status e sai 409
      // sem tocar no estoque.
      await guardedTransition(tx, ret, ['REQUESTED'], {
        status: 'APPROVED',
        approvedBy: actor.userId,
        approvedAt: now,
        decisionNotes: notes ?? null,
        stockWithdrawnAt: now,
      });

      const need = new Map<string, number>();
      for (const l of lines) need.set(l.productId, round3((need.get(l.productId) ?? 0) + l.quantity));
      const ids = [...need.keys()].sort();
      if (ids.length > 0) {
        // Mesma trava de venda/avaria/ajuste (linha do produto) — ordem fixa por id para não criar ciclo de espera.
        await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
        const products = await tx.product.findMany({ where: { id: { in: ids }, companyId: ret.companyId }, select: { id: true, name: true, allowNegativeStock: true } });
        const balances = await stockLedger.balances({ companyId: ret.companyId, branchId: ret.branchId, productIds: ids }, tx);
        // Disponível = saldo − reservas vivas de pedidos externos na filial: o que foi prometido a um canal não volta ao fornecedor.
        const reserved = await reservedByProduct(tx, { companyId: ret.companyId, branchId: ret.branchId, productIds: ids });
        const availableOf = (id: string) => (balances.get(id)?.balance ?? 0) - (reserved.get(id) ?? 0);
        const short = products
          .filter((p) => !p.allowNegativeStock && availableOf(p.id) < (need.get(p.id) ?? 0))
          .map((p) => `${p.name}: disponível ${fmtQty(availableOf(p.id))}, a devolver ${fmtQty(need.get(p.id) ?? 0)}`);
        if (short.length > 0) {
          throw new ConflictError(
            `Estoque insuficiente nesta filial para devolver: ${short.join('; ')}. Confira o saldo (ou a contagem) e ajuste a quantidade antes de aprovar.`,
            'SUPPLIER_RETURN_INSUFFICIENT_STOCK'
          );
        }
        await writeMovements(tx, ret, 'SUPPLIER_RETURN', lines, actor.userId, `Devolução ao fornecedor #${ret.returnNumber}`);
      }

      await addEvent(tx, ret, { type: 'APPROVED', fromStatus: 'REQUESTED', toStatus: 'APPROVED', userId: actor.userId, notes: notes ?? null });
      const linked = ret.items.length - stockLines(ret).length;
      await addEvent(tx, ret, {
        type: 'STOCK_WITHDRAWN',
        userId: actor.userId,
        notes:
          `${lines.length} item(ns) retirado(s) do estoque` +
          (linked > 0 ? `; ${linked} item(ns) ligado(s) a avaria já tinham saído do estoque pela avaria` : ''),
      });
    });

    await invalidateStock(lines.map((l) => l.productId));
    return this.getById(id, actor);
  }

  /** Recusar: REQUESTED → REJECTED, com motivo. Estoque não foi tocado. */
  async reject(id: string, actor: SupplierReturnActor, reason: string) {
    const ret = await this.load(id, actor);
    await assertApprover(actor, ret.companyId, ret.branchId, 'recusar');
    if (ret.requestedBy === actor.userId) {
      throw new AuthorizationError(
        'Quem solicitou a devolução não pode decidir a própria solicitação. Se desistiu, use "Cancelar".',
        'SUPPLIER_RETURN_SELF_DECISION'
      );
    }
    if (ret.status !== 'REQUESTED') invalidTransition(ret.status, 'recusada', 'Só devoluções solicitadas são recusadas.');

    await runInTransaction(async (tx) => {
      await guardedTransition(tx, ret, ['REQUESTED'], { status: 'REJECTED', decisionNotes: reason });
      await addEvent(tx, ret, { type: 'REJECTED', fromStatus: 'REQUESTED', toStatus: 'REJECTED', userId: actor.userId, notes: reason });
    });
    return this.getById(id, actor);
  }

  /** Enviar ao fornecedor: APPROVED → SENT (a mercadoria já saiu do estoque na aprovação). */
  async send(id: string, actor: SupplierReturnActor, shippingInfo?: string | null) {
    assertWriter(actor);
    const ret = await this.load(id, actor);
    if (ret.status !== 'APPROVED') invalidTransition(ret.status, 'enviada', 'Só devoluções aprovadas são enviadas ao fornecedor.');

    await runInTransaction(async (tx) => {
      await guardedTransition(tx, ret, ['APPROVED'], { status: 'SENT', sentAt: new Date(), sentBy: actor.userId, shippingInfo: shippingInfo ?? null });
      await addEvent(tx, ret, { type: 'SENT', fromStatus: 'APPROVED', toStatus: 'SENT', userId: actor.userId, notes: shippingInfo ?? null });
    });
    return this.getById(id, actor);
  }

  /**
   * Encerrar com o resultado do fornecedor: SENT → CLOSED. Só REGISTRA o resultado (crédito, reposição, reembolso,
   * recusa) e o valor — não lança conta a pagar/receber nem documento fiscal (política não definida).
   * Reposição: a entrada de estoque só acontece se o usuário informar as quantidades que chegaram.
   */
  async close(id: string, actor: SupplierReturnActor, input: CloseSupplierReturnInput) {
    const ret = await this.load(id, actor);
    await assertApprover(actor, ret.companyId, ret.branchId, 'encerrar');
    if (ret.status !== 'SENT') invalidTransition(ret.status, 'encerrada', 'Só devoluções enviadas ao fornecedor são encerradas.');

    const received = (input.receivedItems ?? []).filter((r) => r.quantity > 0);
    if (received.length > 0 && input.outcome !== 'REPLACEMENT') {
      throw new AppError('Entrada de mercadoria no encerramento só vale para reposição (REPLACEMENT).', 400, 'SUPPLIER_RETURN_RECEIPT_NOT_REPLACEMENT');
    }
    const returnedByProduct = new Map<string, { qty: number; unitCost: number | null; name: string }>();
    for (const i of ret.items) {
      const cur = returnedByProduct.get(i.productId);
      returnedByProduct.set(i.productId, {
        qty: round3((cur?.qty ?? 0) + Number(i.quantity)),
        unitCost: cur?.unitCost ?? (i.unitCost !== null ? Number(i.unitCost) : null),
        name: i.product.name,
      });
    }
    const receivedByProduct = new Map<string, number>();
    for (const r of received) receivedByProduct.set(r.productId, round3((receivedByProduct.get(r.productId) ?? 0) + r.quantity));
    for (const [productId, qty] of receivedByProduct) {
      const returned = returnedByProduct.get(productId);
      if (!returned) {
        throw new AppError('A reposição informada tem produto que não está nesta devolução.', 400, 'SUPPLIER_RETURN_RECEIPT_UNKNOWN_PRODUCT');
      }
      if (qty > returned.qty) {
        throw new AppError(
          `Reposição de ${returned.name} (${fmtQty(qty)}) maior que o devolvido (${fmtQty(returned.qty)}). Registre o excedente como compra.`,
          400,
          'SUPPLIER_RETURN_RECEIPT_EXCEEDS'
        );
      }
    }
    const receiptLines = [...receivedByProduct].map(([productId, quantity]) => ({ productId, quantity, unitCost: returnedByProduct.get(productId)!.unitCost }));

    await runInTransaction(async (tx) => {
      await guardedTransition(tx, ret, ['SENT'], {
        status: 'CLOSED',
        outcome: input.outcome,
        outcomeAmount: input.outcomeAmount ?? null,
        outcomeNotes: input.outcomeNotes ?? null,
        closedAt: new Date(),
        closedBy: actor.userId,
      });
      await addEvent(tx, ret, { type: 'CLOSED', fromStatus: 'SENT', toStatus: 'CLOSED', userId: actor.userId, notes: input.outcomeNotes ?? null });
      if (receiptLines.length > 0) {
        await writeMovements(tx, ret, 'PURCHASE', receiptLines, actor.userId, `Reposição do fornecedor — devolução #${ret.returnNumber}`);
        await addEvent(tx, ret, { type: 'REPLACEMENT_RECEIVED', userId: actor.userId, notes: `${receiptLines.length} item(ns) de reposição com entrada no estoque` });
      }
    });

    await invalidateStock(receiptLines.map((l) => l.productId));
    return this.getById(id, actor);
  }

  /**
   * Cancelar antes do envio: REQUESTED/APPROVED → CANCELLED, com motivo. Se já aprovada, o estoque retirado volta
   * (movimento de entrada RETURN referenciado à devolução). Nunca apaga.
   * REQUESTED: quem solicitou ou um aprovador; APPROVED: só aprovador (mexe no estoque de novo).
   */
  async cancel(id: string, actor: SupplierReturnActor, reason: string) {
    assertWriter(actor);
    const ret = await this.load(id, actor);
    if (ret.status !== 'REQUESTED' && ret.status !== 'APPROVED') {
      invalidTransition(
        ret.status,
        'cancelada',
        ret.status === 'SENT' ? 'A mercadoria já foi enviada: encerre com o resultado do fornecedor.' : 'Ela já está finalizada.'
      );
    }
    const roles = await approverRoles(ret.companyId, ret.branchId);
    const isApprover = hasApproverRole(actor, roles);
    if (ret.status === 'APPROVED' && !isApprover) {
      throw new AuthorizationError(
        `A devolução já foi aprovada e o estoque foi retirado: só ${rolesText(roles)} cancela (o estoque volta).`,
        'SUPPLIER_RETURN_APPROVER_REQUIRED'
      );
    }
    if (ret.status === 'REQUESTED' && !isApprover && ret.requestedBy !== actor.userId) {
      throw new AuthorizationError(
        `Só quem solicitou ou um ${rolesText(roles)} pode cancelar esta devolução.`,
        'SUPPLIER_RETURN_CANCEL_FORBIDDEN'
      );
    }

    const from = ret.status as SupplierReturnStatus;
    const restore = from === 'APPROVED' && ret.stockWithdrawnAt !== null;
    const lines = restore
      ? stockLines(ret).map((i) => ({ productId: i.productId, quantity: Number(i.quantity), unitCost: i.unitCost !== null ? Number(i.unitCost) : null }))
      : [];

    await runInTransaction(async (tx) => {
      await guardedTransition(tx, ret, [from], { status: 'CANCELLED' });
      await addEvent(tx, ret, { type: 'CANCELLED', fromStatus: from, toStatus: 'CANCELLED', userId: actor.userId, notes: reason });
      if (lines.length > 0) {
        await writeMovements(tx, ret, 'RETURN', lines, actor.userId, `Estorno — devolução ao fornecedor #${ret.returnNumber} cancelada`);
        await addEvent(tx, ret, { type: 'STOCK_RESTORED', userId: actor.userId, notes: `${lines.length} item(ns) devolvido(s) ao estoque` });
      }
    });

    await invalidateStock(lines.map((l) => l.productId));
    return this.getById(id, actor);
  }

  async list(
    actor: SupplierReturnActor,
    filters: { status?: SupplierReturnStatus; supplierId?: string; branchId?: string; page?: number; limit?: number }
  ) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const where: Prisma.SupplierReturnWhereInput = {
      companyId: actor.companyId,
      ...branchScope(actor),
      ...(filters.status && { status: filters.status }),
      ...(filters.supplierId && { supplierId: filters.supplierId }),
      ...(filters.branchId && { branchId: filters.branchId }),
    };
    const [rows, total] = await Promise.all([
      prisma.supplierReturn.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } }, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.supplierReturn.count({ where }),
    ]);
    return { returns: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
  }

  /** Detalhe com itens, histórico (com nomes), movimentos de estoque ligados e o que o usuário atual pode fazer. */
  async getById(id: string, actor: SupplierReturnActor) {
    const ret = await prisma.supplierReturn.findFirst({
      where: { id, companyId: actor.companyId, ...branchScope(actor) },
      include: {
        supplier: { select: { id: true, name: true, document: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ret) notFound();

    const [movements, purchaseOrder, roles] = await Promise.all([
      prisma.stockMovement.findMany({
        where: { companyId: ret.companyId, referenceType: 'SupplierReturn', referenceId: ret.id },
        select: { id: true, productId: true, movementType: true, quantity: true, createdAt: true, userId: true },
        orderBy: { createdAt: 'asc' },
      }),
      ret.purchaseOrderId
        ? prisma.purchaseOrder.findFirst({ where: { id: ret.purchaseOrderId, companyId: ret.companyId }, select: { id: true, poNumber: true } })
        : Promise.resolve(null),
      approverRoles(ret.companyId, ret.branchId),
    ]);

    const userIds = [...new Set([ret.requestedBy, ret.approvedBy, ret.sentBy, ret.closedBy, ...ret.events.map((e) => e.userId)].filter((u): u is string => !!u))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = (uid: string | null) => (uid ? users.find((u) => u.id === uid)?.name ?? null : null);

    const isWriter = (SUPPLIER_RETURN_WRITER_TYPES as readonly string[]).includes(actor.userType);
    const isApprover = hasApproverRole(actor, roles);
    const isRequester = ret.requestedBy === actor.userId;
    const allowedActions = {
      approve: ret.status === 'REQUESTED' && isApprover && !isRequester,
      reject: ret.status === 'REQUESTED' && isApprover && !isRequester,
      send: ret.status === 'APPROVED' && isWriter,
      close: ret.status === 'SENT' && isApprover,
      cancel: isWriter && ((ret.status === 'REQUESTED' && (isApprover || isRequester)) || (ret.status === 'APPROVED' && isApprover)),
    };

    return {
      ...ret,
      purchaseOrder,
      requestedByName: nameOf(ret.requestedBy),
      approvedByName: nameOf(ret.approvedBy),
      sentByName: nameOf(ret.sentBy),
      closedByName: nameOf(ret.closedBy),
      events: ret.events.map((e) => ({ ...e, userName: nameOf(e.userId) })),
      stockMovements: movements,
      approverRoles: roles,
      allowedActions,
    };
  }
}

export const supplierReturnService = new SupplierReturnService();
export default supplierReturnService;
