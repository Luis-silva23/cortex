import { prisma, runInTransaction } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import stockService from './stock.service';
import cacheService from './cache.service';

export class PurchaseOrderService {
  /**
   * Criar pedido de compra (DRAFT). NÃO altera estoque — só o recebimento
   * confirmado altera estoque, conforme a regra do projeto.
   */
  async create(data: {
    companyId: string;
    branchId: string;
    supplierId: string;
    expectedDelivery?: Date;
    notes?: string;
    items: Array<{ productId: string; quantity: number; unitCost: number }>;
  }) {
    if (!data.items || data.items.length === 0) {
      throw new Error('Purchase order must have at least one item');
    }

    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, companyId: data.companyId },
      select: { id: true },
    });
    if (!supplier) {
      throw new Error('Supplier not found');
    }

    // Todos os produtos precisam pertencer à mesma empresa.
    const productIds = data.items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, companyId: data.companyId },
      select: { id: true },
    });
    if (products.length !== new Set(productIds).size) {
      throw new Error('One or more products were not found in this company');
    }

    const items = data.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      unitCost: i.unitCost,
      totalCost: i.quantity * i.unitCost,
    }));
    const subtotal = items.reduce((sum, i) => sum + i.totalCost, 0);

    // Numeração sequencial por filial (`@@unique([companyId, branchId,
    // poNumber])`) — sem retry, duas requisições concorrentes na mesma
    // filial liam o mesmo "último número" e a que perdesse a corrida
    // contra a constraint única recebia um P2002 cru (500 genérico) em vez
    // de convergir automaticamente. Mesmo padrão (sem depender de
    // `error.meta.target`, que a extensão de RLS não preserva em erros de
    // `$transaction` em lote — ver nota em sale.service.ts) já usado em
    // transfer/quote/inventory.service.ts.
    // CORREÇÃO (2026-09-21, mesma da numeração de OS em
    // service-order.service.ts — ver o comentário longo lá): o retry
    // sozinho não resolve. Com o "último número + 1" lido FORA de qualquer
    // transação, N pedidos simultâneos na mesma filial leem todos o mesmo
    // número e só UM vence por rodada — o total de sucessos ficava limitado
    // pelo número de TENTATIVAS, não pela corretude (medido: 8 de 15
    // pedidos simultâneos falhando, 100% em P2002). Agora ler-e-inserir
    // acontece na MESMA transação, serializado por (companyId, branchId)
    // com um advisory lock de transação (liberado sozinho no
    // COMMIT/ROLLBACK). classid 4203 = numeração de pedido de compra.
    const MAX_PO_NUMBER_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_PO_NUMBER_ATTEMPTS; attempt++) {
      try {
        return await runInTransaction(async (tx) => {
          // `$executeRaw`, não `$queryRaw`: `pg_advisory_xact_lock` retorna
          // `void` e o Prisma falha ao desserializar essa coluna.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4203, hashtext(${`${data.companyId}:${data.branchId}`}))`;

          const lastPo = await tx.purchaseOrder.findFirst({
            where: { companyId: data.companyId, branchId: data.branchId },
            orderBy: { poNumber: 'desc' },
            select: { poNumber: true },
          });
          const poNumber = (lastPo?.poNumber || 0) + 1;

          return await tx.purchaseOrder.create({
            data: {
              companyId: data.companyId,
              branchId: data.branchId,
              poNumber,
              supplierId: data.supplierId,
              status: 'DRAFT',
              expectedDelivery: data.expectedDelivery,
              subtotal,
              taxAmount: 0,
              totalAmount: subtotal,
              notes: data.notes,
              items: { create: items },
            },
            include: { items: true, supplier: true },
          });
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        if (attempt === MAX_PO_NUMBER_ATTEMPTS) {
          // Nunca vaza o erro cru do Prisma pro cliente numa contenção
          // extrema — mesmo tratamento final de sale.service.ts.
          throw new Error('Sistema com alta concorrência no momento — tente novamente em instantes');
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
      }
    }
    throw new Error('Não foi possível criar o pedido de compra (conflito de numeração persistente)');
  }

  async getById(id: string, companyId: string) {
    return await prisma.purchaseOrder.findFirst({
      where: { id, companyId },
      include: {
        supplier: true,
        items: { include: { product: { select: { id: true, name: true, sku: true } } } },
        invoices: true,
      },
    });
  }

  async list(filters: {
    companyId: string;
    branchId?: string;
    supplierId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const { companyId, branchId, supplierId, status, page = 1, limit = 20 } = filters;
    const where = {
      companyId,
      ...(branchId && { branchId }),
      ...(supplierId && { supplierId }),
      ...(status && { status: status as any }),
    };

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        // `_count.items`: a coluna "Itens" da tela de compras; contar no banco
        // evita carregar as linhas de cada pedido só para exibir um número.
        include: { supplier: { select: { id: true, name: true } }, _count: { select: { items: true } } },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { orderDate: 'desc' },
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Aprovar pedido (DRAFT/SENT -> CONFIRMED). Ainda não altera estoque.
   */
  async approve(id: string, companyId: string, approvedBy: string) {
    const po = await prisma.purchaseOrder.findFirst({ where: { id, companyId } });
    if (!po) {
      throw new Error('Purchase order not found');
    }
    if (!['DRAFT', 'SENT'].includes(po.status)) {
      throw new Error(`Cannot approve a purchase order with status ${po.status}`);
    }

    return await prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'CONFIRMED', approvedBy, approvedAt: new Date() },
    });
  }

  async cancel(id: string, companyId: string) {
    const po = await prisma.purchaseOrder.findFirst({ where: { id, companyId } });
    if (!po) {
      throw new Error('Purchase order not found');
    }
    if (po.status === 'RECEIVED') {
      throw new Error('Cannot cancel a purchase order that has already been received');
    }
    if (po.status === 'CANCELLED') {
      throw new Error('Purchase order is already cancelled');
    }

    return await prisma.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
  }

  /**
   * Recebimento (parcial ou total). É o ÚNICO ponto que altera estoque de
   * verdade — cria um StockMovement PURCHASE por item recebido, referenciado
   * ao pedido, e atualiza receivedQuantity por item. O pedido só vira
   * RECEIVED quando TODOS os itens estiverem 100% recebidos.
   */
  async receive(
    id: string,
    companyId: string,
    data: {
      branchId: string;
      userId: string;
      items: Array<{ itemId: string; receivedQuantity: number }>;
      invoice?: {
        invoiceNumber: string;
        series: string;
        accessKey: string;
        issueDate: Date;
        totalAmount: number;
      };
    }
  ) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id, companyId },
      include: { items: true },
    });
    if (!po) {
      throw new Error('Purchase order not found');
    }
    if (!['CONFIRMED'].includes(po.status)) {
      throw new Error(`Purchase order must be CONFIRMED before receiving (current: ${po.status})`);
    }

    // Detecção de NF duplicada ANTES de qualquer alteração de estoque —
    // checa tanto por accessKey (chave de acesso NF-e, globalmente única
    // quando informada — a identificação mais confiável) quanto pela
    // combinação fornecedor+número+série. Não confia só no número: duas
    // notas de fornecedores diferentes podem ter o mesmo número/série; a
    // constraint `@@unique([companyId, supplierId, invoiceNumber, series])`
    // já é escopada por fornecedor para isso. `accessKey` tem `@unique`
    // global no schema (garantia real no banco), então esta pré-checagem só
    // adiciona uma mensagem de erro clara ANTES de gastar a transação de
    // estoque — sem ela, uma chave de acesso duplicada com número/série
    // diferente (erro de digitação) só falhava depois, no meio da
    // transação, com um P2002 genérico.
    if (data.invoice) {
      const duplicate = await prisma.invoice.findFirst({
        where: {
          OR: [
            { accessKey: data.invoice.accessKey },
            { companyId, supplierId: po.supplierId, invoiceNumber: data.invoice.invoiceNumber, series: data.invoice.series },
          ],
        },
      });
      if (duplicate) {
        throw new Error(
          duplicate.accessKey === data.invoice.accessKey
            ? 'Duplicate invoice: this accessKey (chave de acesso NF-e) was already received'
            : 'Duplicate invoice: this invoiceNumber+series was already received from this supplier'
        );
      }
    }

    const result = await runInTransaction(async (tx) => {
      // ACHADO DE AUDITORIA DE INTEGRAÇÃO (duas falhas juntas, mesmo bloco):
      //
      // 1) `data.branchId` vinha direto do corpo da requisição e era usado
      // sem NENHUMA validação contra o próprio pedido — StockMovement.
      // branchId é `String?` solto no schema (não é FK), então nada no banco
      // barrava isso. Um valor errado (digitação, campo desatualizado no
      // cliente) recebia estoque em qualquer filial, sumindo silenciosamente
      // de toda consulta de saldo escopada por filial. Corrigido: a
      // movimentação sempre usa `po.branchId` (a filial do próprio pedido,
      // já validada na criação), nunca o valor solto do request.
      //
      // 2) `po`/`po.items` foram lidos ANTES desta transação, sem lock —
      // duas chamadas concorrentes de recebimento (parcial) no mesmo pedido
      // liam o mesmo `receivedQuantity` desatualizado, ambas passavam na
      // checagem de "quanto falta receber" e ambas incrementavam a partir da
      // mesma base, sobre-recebendo estoque além do que foi pedido. Corrigido
      // com o mesmo padrão de `SELECT ... FOR UPDATE` + releitura já usado em
      // stock.service.ts/sale.service.ts.
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
      const freshPo = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { items: true } });
      if (freshPo.status !== 'CONFIRMED') {
        throw new Error(`Purchase order must be CONFIRMED before receiving (current: ${freshPo.status})`);
      }

      // ACHADO DE AUDITORIA: `remaining` é calculado de `freshPo.items`, um
      // snapshot lido UMA vez antes do laço — se o mesmo `itemId` aparecesse
      // duas vezes em `data.items` (ex.: [{A, 10}, {A, 10}] num item com 10
      // restantes), cada entrada passava sozinha na checagem contra o mesmo
      // snapshot e as duas incrementavam, recebendo 20 de um item que só
      // faltavam 10 (estoque inflado no ledger, custo do produto atualizado
      // em cima de quantidade que nunca chegou). Agrega as entradas por
      // itemId ANTES de validar, então a checagem vale para o TOTAL pedido
      // do item. Entradas <= 0 continuam ignoradas (como antes), mas o item
      // ainda precisa pertencer ao pedido.
      const requestedByItem = new Map<string, number>();
      for (const receivedItem of data.items) {
        if (!freshPo.items.some((i) => i.id === receivedItem.itemId)) {
          throw new Error(`Item ${receivedItem.itemId} does not belong to this purchase order`);
        }
        if (receivedItem.receivedQuantity > 0) {
          requestedByItem.set(
            receivedItem.itemId,
            (requestedByItem.get(receivedItem.itemId) ?? 0) + receivedItem.receivedQuantity
          );
        }
      }

      for (const [itemId, requestedQuantity] of requestedByItem) {
        const item = freshPo.items.find((i) => i.id === itemId)!;

        const remaining = Number(item.quantity) - Number(item.receivedQuantity);
        if (requestedQuantity > remaining) {
          throw new Error(
            `Cannot receive ${requestedQuantity} of item ${item.id} — only ${remaining} remaining`
          );
        }

        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { receivedQuantity: { increment: requestedQuantity } },
        });

        // Movimentação real de estoque — fonte da verdade é o ledger.
        await tx.stockMovement.create({
          data: {
            companyId,
            branchId: freshPo.branchId,
            productId: item.productId,
            movementType: 'PURCHASE',
            quantity: requestedQuantity,
            unitCost: item.unitCost,
            totalCost: Number(item.unitCost) * requestedQuantity,
            referenceType: 'PurchaseOrder',
            referenceId: po.id,
            userId: data.userId,
          },
        });

        // ACHADO DE AUDITORIA DE INTEGRAÇÃO: Product.costPrice só era
        // gravado no cadastro/import manual do produto — recebimento de PO
        // nunca o atualizava, então relatórios de margem/valor de estoque
        // (report.job.ts, dashboard.service.ts) ficavam calculando lucro em
        // cima de um custo de aquisição cada vez mais desatualizado a cada
        // compra com preço diferente. Mesma classe do bug já corrigido para
        // Motorcycle.kilometerReading — atualiza para o custo do
        // recebimento mais recente (não monotônico como km: custo pode
        // legitimamente cair, ex. promoção do fornecedor).
        await tx.product.update({
          where: { id: item.productId },
          data: { costPrice: item.unitCost },
        });
      }

      if (data.invoice) {
        await tx.invoice.create({
          data: {
            companyId,
            supplierId: po.supplierId,
            purchaseOrderId: po.id,
            invoiceNumber: data.invoice.invoiceNumber,
            series: data.invoice.series,
            accessKey: data.invoice.accessKey,
            issueDate: data.invoice.issueDate,
            totalAmount: data.invoice.totalAmount,
            isReceived: true,
            receivedAt: new Date(),
          },
        });
      }

      // Recalcular se o pedido está totalmente recebido.
      const updatedItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
      const fullyReceived = updatedItems.every((i) => Number(i.receivedQuantity) >= Number(i.quantity));

      const updatedPo = await tx.purchaseOrder.update({
        where: { id: po.id },
        data: fullyReceived ? { status: 'RECEIVED', receivedDate: new Date() } : {},
        include: { items: true },
      });

      return updatedPo;
    });

    // Ver nota em stock.service.ts: escritas diretas no ledger dentro de
    // uma transação (`tx.stockMovement.create`) não invalidam o cache de
    // saldo automaticamente — precisa ser feito aqui, após o commit.
    const receivedProductIds = new Set(
      data.items.filter((i) => i.receivedQuantity > 0).map((i) => po.items.find((it) => it.id === i.itemId)?.productId).filter(Boolean)
    );
    await Promise.all([...receivedProductIds].map((productId) => cacheService.invalidate(`product:${productId}:stock*`)));

    return result;
  }

  /**
   * Devolução ao fornecedor — gera movimentação reversa (nunca apaga o
   * recebimento original).
   */
  // ACHADO DE AUDITORIA: a devolução só checava que o pedido estava RECEIVED
  // e delegava ao ledger — sem validar que `productId` sequer pertence ao
  // pedido, nem limitar `quantity` ao que foi de fato recebido menos o que
  // já foi devolvido dele. Qualquer produto do estoque (recebido em outro
  // pedido ou vendido por outros canais) podia ser "devolvido" a um
  // fornecedor por um pedido que nunca o incluiu, e a mesma devolução podia
  // ser repetida sem teto até o saldo zerar (a trava de saldo negativo só
  // protege o saldo, não a semântica "devolvo o que este pedido entregou").
  // `branchId` do corpo também era usado direto; como em `receive`, a filial
  // que recebeu o pedido (`po.branchId`) é a única de onde a devolução sai.
  // Checagem, soma das devoluções anteriores e escrita no ledger agora
  // rodam na MESMA transação sob `FOR UPDATE` do pedido, então duas
  // devoluções concorrentes não passam juntas pelo mesmo saldo devolvível.
  async returnToSupplier(
    id: string,
    companyId: string,
    data: { branchId: string; userId: string; productId: string; quantity: number; reason: string }
  ) {
    if (!Number.isFinite(data.quantity) || data.quantity <= 0) {
      throw new Error('Return quantity must be greater than zero');
    }

    const movement = await runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { id, companyId }, include: { items: true } });
      if (!po) {
        throw new Error('Purchase order not found');
      }
      if (po.status !== 'RECEIVED') {
        throw new Error('Can only return items from a fully received purchase order');
      }

      const poItemsForProduct = po.items.filter((i) => i.productId === data.productId);
      if (poItemsForProduct.length === 0) {
        throw new Error('Product is not part of this purchase order');
      }
      const receivedTotal = poItemsForProduct.reduce((sum, i) => sum + Number(i.receivedQuantity), 0);

      const previousReturns = await tx.stockMovement.aggregate({
        where: { companyId, referenceType: 'PurchaseReturn', referenceId: po.id, productId: data.productId },
        _sum: { quantity: true },
      });
      const alreadyReturned = Math.abs(Number(previousReturns._sum.quantity ?? 0));
      const returnable = receivedTotal - alreadyReturned;
      if (data.quantity > returnable) {
        throw new Error(
          `Cannot return ${data.quantity} of this product — only ${returnable} returnable from this purchase order (received ${receivedTotal}, already returned ${alreadyReturned})`
        );
      }

      return stockService.createMovementGuarded(tx, {
        companyId,
        branchId: po.branchId,
        productId: data.productId,
        movementType: 'LOSS',
        quantity: -Math.abs(data.quantity),
        referenceType: 'PurchaseReturn',
        referenceId: po.id,
        notes: `Devolução ao fornecedor: ${data.reason}`,
        userId: data.userId,
      });
    });

    await cacheService.invalidate(`product:${data.productId}:stock*`);

    return movement;
  }
}

export default new PurchaseOrderService();
