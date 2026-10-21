import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { AppError } from '@ln-system/shared';
import cacheService from './cache.service';
import { stockLedger, INBOUND_TYPES, OUTBOUND_TYPES } from './stock-ledger';
import { reservedFor, availabilityOf } from './stock-reservations';

/** Tipos de saída comercial que respeitam reservas de pedidos externos (docs/CORTEX/COMMERCE_API.md §4). */
const RESERVATION_AWARE_TYPES: readonly string[] = ['SALE', 'SUPPLIER_RETURN', 'TRANSFER_OUT'];

/**
 * Situação do estoque a partir do saldo. `hasMovements` distingue "nunca inventariado" (nenhuma movimentação) de
 * "saldo zero porque vendeu tudo".
 */
export function stockStatus(balance: number, count: number, product: { minStock: number | null; maxStock: number | null }) {
  const hasMovements = count > 0;
  const minStock = product.minStock || 0;
  return {
    balance,
    hasMovements,
    minStock,
    maxStock: product.maxStock,
    status: !hasMovements ? 'NOT_INVENTORIED' : balance <= 0 ? 'OUT_OF_STOCK' : balance <= minStock ? 'LOW_STOCK' : 'OK',
  };
}

export interface StockMovementInput {
  companyId: string;
  branchId?: string;
  productId: string;
  movementType: string;
  quantity: number;
  unitCost?: number;
  totalCost?: number;
  referenceType?: string;
  referenceId?: string;
  notes?: string;
  userId: string;
}

export class StockService {
  // `ProductService.getProductStock` cacheia o saldo por alguns minutos
  // (`CacheTTL.CURRENT_STOCK`, ver product.service.ts) sob a chave
  // `product:<id>:stock[:<branchId>]`. Nenhum ponto de escrita do ledger
  // (aqui, em inventory.service.ts ou damage.service.ts) invalidava esse
  // cache — confirmado via teste real: após um ajuste/avaria/inventário, a
  // rota `GET /products/:id/stock` continuava devolvendo o saldo antigo até
  // o TTL expirar. `*` no final do padrão cobre tanto a chave sem filial
  // quanto qualquer filial específica já cacheada para este produto.
  /** Público para quem grava movimentos via *InTx (ex.: importação) invalidar depois do commit. */
  async invalidateStockCache(productId: string) {
    await cacheService.invalidate(`product:${productId}:stock*`);
  }

  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: StockMovement.branchId é um `String?`
  // solto no schema (não é FK) — mesma classe de bug já corrigida em
  // purchase-order.service.ts::receive, só que aqui presente em TODO o
  // módulo de estoque (createMovement/adjustStock/transferStock/
  // performInventory aceitavam branchId direto do cliente sem checar se
  // pertencia à empresa). Sem isso, qualquer branchId (de outra empresa, ou
  // simplesmente inválido) era aceito e gravado no ledger — o estoque, que é
  // a fonte da verdade do sistema, ficava silenciosamente corrompido/
  // inacessível em qualquer consulta de saldo escopada por filial real.
  private async assertBranchBelongsToCompany(
    branchId: string | undefined,
    companyId: string,
    client: PrismaTransactionClient = prisma as unknown as PrismaTransactionClient
  ) {
    if (!branchId) return;
    const branch = await client.branch.findFirst({ where: { id: branchId, companyId }, select: { id: true } });
    if (!branch) {
      throw new Error(`Branch ${branchId} not found in this company`);
    }
  }

  // Calcula o saldo resultante de aplicar UM movimento sobre um saldo atual
  // — mesma categorização de tipos usada em getBalance() (entradas
  // positivas, saídas negativas, ADJUSTMENT com sinal livre, INVENTORY
  // absoluto), extraída aqui para não divergir entre os dois lugares que
  // precisam da mesma lógica.
  private applyMovementToBalance(currentBalance: number, movementType: string, quantity: number): number {
    if (movementType === 'INVENTORY') {
      return Math.abs(quantity);
    }
    // Mesmas listas do livro (stock-ledger.ts) — antes duplicadas aqui e sem SUPPLIER_RETURN.
    if ((INBOUND_TYPES as readonly string[]).includes(movementType)) {
      return currentBalance + Math.abs(quantity);
    }
    if ((OUTBOUND_TYPES as readonly string[]).includes(movementType)) {
      return currentBalance - Math.abs(quantity);
    }
    // ADJUSTMENT (e qualquer tipo não reconhecido, tratado como delta livre
    // igual a ADJUSTMENT): sinal do valor informado.
    return currentBalance + quantity;
  }

  // Criar movimentação de estoque
  //
  // ACHADO DE AUDITORIA: esta era a ÚNICA via de escrita no ledger que não
  // respeitava `product.allowNegativeStock` — `adjustStock`/`transferStock`
  // (mais abaixo neste arquivo) e o SALE inline em sale.service.ts sempre
  // travaram a linha do produto e recusaram uma saída que deixasse o saldo
  // negativo quando `allowNegativeStock=false`, mas `createMovement` (usado
  // diretamente por `POST /stock/movement`, e internamente por
  // purchase-order.service.ts::returnToSupplier) aceitava QUALQUER
  // `movementType`/`quantity` sem nenhuma checagem de saldo. Como o schema
  // de validação (`stockMovementSchema`) não restringe `movementType` nem o
  // sinal de `quantity`, qualquer usuário com a permissão operacional
  // `stock:adjust` podia gravar `{ movementType: 'LOSS', quantity: -500 }`
  // e derrubar o saldo para negativo sem erro — corrompendo a fonte da
  // verdade do estoque. Mesmo padrão de lock+releitura já usado em
  // adjustStock/transferStock/sale.service.ts.
  async createMovement(data: StockMovementInput) {
    const movement = await runInTransaction(async (tx) => this.createMovementGuarded(tx, data));

    await this.invalidateStockCache(data.productId);

    return movement;
  }

  // Corpo de `createMovement` extraído para rodar contra uma transação JÁ
  // ABERTA por quem chama (`runInTransaction` não reaproveita transação
  // ambiente — abre outra conexão). Necessário quando o chamador precisa que
  // a sua própria checagem (ex.: purchase-order.service.ts::returnToSupplier
  // somando devoluções anteriores sob lock do pedido) e a escrita no ledger
  // aconteçam na MESMA transação/lock. Não invalida o cache de saldo: quem
  // chama deve fazê-lo depois do commit.
  async createMovementGuarded(tx: PrismaTransactionClient, data: StockMovementInput) {
    await this.assertBranchBelongsToCompany(data.branchId, data.companyId, tx);
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${data.productId} FOR UPDATE`;

    // O produto precisa pertencer à mesma empresa da movimentação. Sem
    // esta checagem, um usuário autenticado de QUALQUER empresa podia
    // criar movimentações de estoque (compra, venda, ajuste...) para o
    // produto de outra empresa apenas informando o productId —
    // corrompendo o ledger (fonte da verdade) de estoque de terceiros.
    const product = await tx.product.findFirst({
      where: { id: data.productId, companyId: data.companyId },
      select: { id: true, allowNegativeStock: true, name: true },
    });
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.allowNegativeStock) {
      const { balance } = await this.getBalance(data.productId, data.companyId, data.branchId, tx);
      const resultingBalance = this.applyMovementToBalance(balance, data.movementType, data.quantity);
      if (resultingBalance < 0) {
        throw new Error(
          `Insufficient stock for product ${product.name}. Current balance: ${balance}, this movement would result in: ${resultingBalance}`
        );
      }
      // Saída COMERCIAL (venda, devolução ao fornecedor, transferência) não consome o que está prometido a pedido externo.
      // Avaria/perda/ajuste/inventário são fatos físicos e seguem só o saldo (reservationShortfalls sinaliza o que ficou sem lastro).
      if (data.branchId && RESERVATION_AWARE_TYPES.includes(data.movementType)) {
        const reserved = await reservedFor(tx, { companyId: data.companyId, branchId: data.branchId, productId: data.productId });
        if (reserved > 0 && resultingBalance < reserved) {
          throw new Error(
            `Insufficient stock for product ${product.name}. Current balance: ${balance}, reserved for external orders: ${reserved}, this movement would result in: ${resultingBalance}`
          );
        }
      }
    }

    return this.createMovementInTx(tx, {
      companyId: data.companyId,
      branchId: data.branchId,
      productId: data.productId,
      movementType: data.movementType,
      quantity: data.quantity,
      unitCost: data.unitCost,
      totalCost: data.totalCost,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      notes: data.notes,
      userId: data.userId,
    });
  }

  // Mesma criação de movimentação de `createMovement`, mas contra um client
  // de transação já aberto (`tx`) — usada por adjustStock/transferStock/
  // performInventory logo depois do `SELECT ... FOR UPDATE` na linha do
  // produto, para que o saldo lido e a movimentação escrita fiquem na MESMA
  // transação/conexão que segura o lock (ver comentário em getBalance()).
  // Sem checagem de posse do produto aqui: os três chamadores já a fizeram
  // via getBalance(..., tx) logo antes, com o mesmo companyId/tx.
  private async createMovementInTx(
    tx: PrismaTransactionClient,
    data: {
      companyId: string;
      branchId?: string;
      productId: string;
      movementType: string;
      quantity: number;
      unitCost?: number;
      totalCost?: number;
      notes?: string;
      userId: string;
      referenceType?: string;
      referenceId?: string;
    }
  ) {
    return tx.stockMovement.create({
      data: {
        companyId: data.companyId,
        branchId: data.branchId,
        productId: data.productId,
        movementType: data.movementType as any,
        quantity: data.quantity,
        unitCost: data.unitCost,
        totalCost: data.totalCost,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        notes: data.notes,
        userId: data.userId,
      },
      include: {
        product: true,
      },
    });
  }

  // Listar movimentações
  async listMovements(filters: {
    companyId: string;
    branchId?: string;
    productId?: string;
    movementType?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      companyId,
      branchId,
      productId,
      movementType,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = filters;

    const where: Prisma.StockMovementWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(productId && { productId }),
      ...(movementType && { movementType: movementType as any }),
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }
        : {}),
    };

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          product: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return {
      movements,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Calcular saldo de estoque de um produto
  // `client` defaults to the module-level `prisma` (existing callers
  // unaffected) but can be passed a `tx` from inside an active transaction
  // — needed so a caller can lock the product row (`SELECT ... FOR UPDATE`)
  // and read the balance in the SAME transaction/connection as that lock.
  // Reading through the plain `prisma` client from inside someone else's
  // transaction would just read the last-committed value and miss the
  // lock's serialization entirely.
  //
  // Tipado só como `PrismaTransactionClient` (não mais uma união com
  // `typeof prisma`): unir o tipo cru da transação com o tipo do client
  // estendido fazia o TypeScript estourar profundidade de pilha tentando
  // reconciliar os dois conjuntos de overloads genéricos de
  // `product.findFirst`/`stockMovement.findMany`. Em runtime `prisma` tem
  // exatamente os mesmos métodos de modelo — o cast abaixo é seguro.
  async getBalance(
    productId: string,
    companyId: string,
    branchId?: string,
    client?: PrismaTransactionClient,
    opts: { withHistory?: boolean } = {}
  ) {
    // Antes desta correção, este método (usado por uma rota pública de
    // consulta e internamente por adjustStock/transferStock) não verificava
    // que o produto pertence à empresa do requisitante — qualquer empresa
    // conseguia ler o saldo de estoque de qualquer outra.
    const product = await (client ?? (prisma as unknown as PrismaTransactionClient)).product.findFirst({
      where: { id: productId, companyId },
      select: { minStock: true, maxStock: true },
    });
    if (!product) {
      throw new Error('Product not found');
    }

    // Saldo calculado no banco (ver stock-ledger.ts) — antes todas as movimentações vinham para cá a cada chamada.
    const { balance, count, history } = await stockLedger.read(
      { productId, companyId, branchId },
      { client, withHistory: opts.withHistory }
    );
    return { productId, branchId, ...stockStatus(balance, count, product), history };
  }

  /**
   * DISPONÍVEL PARA VENDA de vários produtos numa filial (consulta do Balcão/Admin): saldo do livro − reservas vivas, a MESMA
   * conta (`availabilityOf`) que sale/OS/transferência conferem antes de retirar saldo. Só lê; os produtos precisam ser da empresa
   * (os de outra empresa são recusados, não ignorados em silêncio). `available` nunca fica negativo para quem consulta.
   */
  async getAvailability(companyId: string, branchId: string, productIds: string[]) {
    const ids = [...new Set(productIds)];
    const owned = await prisma.product.findMany({ where: { companyId, id: { in: ids } }, select: { id: true } });
    if (owned.length !== ids.length) throw new AppError('Produto não encontrado nesta empresa', 404, 'PRODUCT_NOT_FOUND');
    // Dentro de uma transação (como as demais saídas comerciais): o saldo do livro é SQL cru e só enxerga o contexto de RLS por `tx`.
    const map = await runInTransaction((tx) => availabilityOf(tx, { companyId, branchId, productIds: ids }));
    return ids.map((productId) => {
      const a = map.get(productId)!;
      return { productId, branchId, balance: a.balance, reserved: a.reserved, available: Math.max(0, a.available) };
    });
  }

  // Ajuste de estoque (com auditoria)
  //
  // ACHADO DE AUDITORIA (mesma classe do bug de corrida de estoque já
  // corrigido em sale.service.ts, ver comentário em getBalance): a versão
  // anterior lia `balance` ANTES de qualquer transação e só criava a
  // movimentação depois — dois ajustes/transferências/inventários
  // concorrentes no mesmo produto liam o mesmo saldo desatualizado e cada
  // um calculava sua própria `difference` a partir dele, perdendo a
  // atualização um do outro (lost update). `SELECT ... FOR UPDATE` na linha
  // do produto + releitura do saldo DENTRO da transação (mesma técnica já
  // usada por sale.service.ts) serializa as operações concorrentes.
  async adjustStock(data: {
    companyId: string;
    branchId?: string;
    productId: string;
    newQuantity: number;
    reason: string;
    userId: string;
  }) {
    // Sem filial o saldo vinha da SOMA de todas as filiais e o movimento era gravado com
    // filial NULL (fora do saldo de qualquer filial). O ajuste é sempre de uma filial.
    if (!data.branchId) {
      throw new AppError('branchId é obrigatório para ajuste de estoque', 400, 'BRANCH_REQUIRED');
    }
    const movement = await runInTransaction(async (tx) => {
      const { movement: created } = await this.adjustStockInTx(tx, { ...data, branchId: data.branchId! });
      if (!created) {
        throw new Error('New quantity is the same as current balance');
      }
      return created;
    });

    await this.invalidateStockCache(data.productId);

    return movement;
  }

  /**
   * Ajuste para um saldo alvo dentro de uma transação já aberta (lock do produto + saldo + movimento). Sem diferença,
   * não grava nada (`movement: null`). Quem chama invalida o cache depois do commit. Usado pela importação, que
   * referencia o lote no movimento.
   */
  async adjustStockInTx(
    tx: PrismaTransactionClient,
    data: { companyId: string; branchId: string; productId: string; newQuantity: number; reason: string; userId: string; referenceType?: string; referenceId?: string }
  ) {
    await this.assertBranchBelongsToCompany(data.branchId, data.companyId, tx);
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${data.productId} FOR UPDATE`;

    const { balance } = await this.getBalance(data.productId, data.companyId, data.branchId, tx);
    const difference = data.newQuantity - balance;
    if (difference === 0) return { movement: null, previousBalance: balance };

    const movement = await this.createMovementInTx(tx, {
      companyId: data.companyId,
      branchId: data.branchId,
      productId: data.productId,
      movementType: 'ADJUSTMENT',
      quantity: difference,
      notes: `Ajuste de estoque: ${data.reason}. Saldo anterior: ${balance}, Novo saldo: ${data.newQuantity}`,
      userId: data.userId,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
    });
    return { movement, previousBalance: balance };
  }

  // Transferência entre filiais — mesmo raciocínio de lock de adjustStock:
  // a checagem de saldo na filial de origem e a criação do TRANSFER_OUT
  // agora acontecem dentro da MESMA transação que segura o lock, para que
  // duas transferências concorrentes da última unidade não passem ambas na
  // checagem otimista.
  async transferStock(data: {
    companyId: string;
    productId: string;
    fromBranchId: string;
    toBranchId: string;
    quantity: number;
    notes?: string;
    userId: string;
  }) {
    const result = await runInTransaction(async (tx) => {
      await this.assertBranchBelongsToCompany(data.fromBranchId, data.companyId, tx);
      await this.assertBranchBelongsToCompany(data.toBranchId, data.companyId, tx);
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${data.productId} FOR UPDATE`;

      const { balance } = await this.getBalance(data.productId, data.companyId, data.fromBranchId, tx);
      const reserved = await reservedFor(tx, { companyId: data.companyId, branchId: data.fromBranchId, productId: data.productId });
      if (balance - reserved < data.quantity) {
        throw new Error(`Insufficient stock at source branch. Available: ${balance - reserved}`);
      }

      // Saída da filial de origem
      const outMovement = await tx.stockMovement.create({
        data: {
          companyId: data.companyId,
          branchId: data.fromBranchId,
          productId: data.productId,
          movementType: 'TRANSFER_OUT',
          quantity: -data.quantity,
          notes: data.notes,
          userId: data.userId,
        },
      });

      // Entrada na filial de destino
      const inMovement = await tx.stockMovement.create({
        data: {
          companyId: data.companyId,
          branchId: data.toBranchId,
          productId: data.productId,
          movementType: 'TRANSFER_IN',
          quantity: data.quantity,
          referenceType: 'StockTransfer',
          referenceId: outMovement.id,
          notes: data.notes,
          userId: data.userId,
        },
      });

      return {
        outMovement,
        inMovement,
      };
    });

    await this.invalidateStockCache(data.productId);

    return result;
  }

  // Relatório de estoque (todos os produtos)
  async getStockReport(filters: {
    companyId: string;
    branchId?: string;
    categoryId?: string;
    status?: 'OUT_OF_STOCK' | 'LOW_STOCK' | 'OK';
  }) {
    const { companyId, branchId, categoryId, status } = filters;

    const products = await prisma.product.findMany({
      where: {
        companyId,
        ...(branchId && { branchId }),
        ...(categoryId && { categoryId }),
        isActive: true,
      },
      select: { id: true, sku: true, name: true, minStock: true, maxStock: true, category: { select: { name: true } } },
    });

    // Um saldo para todos os produtos numa consulta (antes: 2 consultas + o histórico inteiro POR produto).
    const balances = await stockLedger.balances({ companyId, branchId, productIds: products.map((p) => p.id) });
    const report = [];

    for (const product of products) {
      const { balance, count } = balances.get(product.id)!;
      const stockInfo = stockStatus(balance, count, product);

      // Filtrar por status se especificado
      if (status && stockInfo.status !== status) {
        continue;
      }

      report.push({
        product: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          category: product.category?.name,
        },
        stock: {
          balance: stockInfo.balance,
          hasMovements: stockInfo.hasMovements,
          minStock: stockInfo.minStock,
          maxStock: stockInfo.maxStock,
          status: stockInfo.status,
        },
      });
    }

    return report;
  }

  // Pré-visualização de importação de estoque: verifica, sem criar nenhuma
  // movimentação, quais linhas (por SKU e/ou código de barras) correspondem
  // a produtos existentes na empresa. Usado pelo wizard de importação para
  // mostrar ao usuário linhas casadas vs. não casadas ANTES da confirmação —
  // nunca descartamos silenciosamente uma linha sem produto correspondente.
  async matchProductsForImport(
    companyId: string,
    items: Array<{ sku?: string; barcode?: string }>
  ) {
    const skus = items
      .map((i) => (i.sku ? String(i.sku).trim() : undefined))
      .filter((v): v is string => Boolean(v));
    const barcodes = items
      .map((i) => (i.barcode ? String(i.barcode).trim() : undefined))
      .filter((v): v is string => Boolean(v));

    const orClauses: Prisma.ProductWhereInput[] = [];
    if (skus.length > 0) orClauses.push({ sku: { in: skus } });
    if (barcodes.length > 0) orClauses.push({ barcode: { in: barcodes } });

    const products =
      orClauses.length > 0
        ? await prisma.product.findMany({
            where: { companyId, OR: orClauses },
            select: { id: true, name: true, sku: true, barcode: true },
          })
        : [];

    const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku as string, p]));
    const byBarcode = new Map(
      products.filter((p) => p.barcode).map((p) => [p.barcode as string, p])
    );

    const matched: Array<{
      sku?: string;
      barcode?: string;
      productId: string;
      productName: string;
    }> = [];
    const unmatched: Array<{ sku?: string; barcode?: string }> = [];

    for (const item of items) {
      const sku = item.sku ? String(item.sku).trim() : undefined;
      const barcode = item.barcode ? String(item.barcode).trim() : undefined;
      const product = (sku && bySku.get(sku)) || (barcode && byBarcode.get(barcode));

      if (product) {
        matched.push({ sku, barcode, productId: product.id, productName: product.name });
      } else {
        unmatched.push({ sku, barcode });
      }
    }

    return { matched, unmatched, totalChecked: items.length };
  }

  // Inventário (contagem física)
  async performInventory(data: {
    companyId: string;
    branchId?: string;
    items: Array<{
      productId: string;
      countedQuantity: number;
    }>;
    notes?: string;
    userId: string;
  }) {
    await this.assertBranchBelongsToCompany(data.branchId, data.companyId);

    const results = [];

    // Um `$transaction` por item (não um único para o lote inteiro): cada
    // produto é independente, então travar todos de uma vez só prenderia
    // locks por mais tempo sem necessidade — mas cada item individualmente
    // precisa do mesmo lock+releitura dentro da transação que adjustStock/
    // transferStock usam, senão dois inventários concorrentes no mesmo
    // produto (ex.: reenvio duplicado do wizard) perdem a atualização um do
    // outro.
    for (const item of data.items) {
      const { movement, balance } = await runInTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${item.productId} FOR UPDATE`;

        const { balance } = await this.getBalance(item.productId, data.companyId, data.branchId, tx);
        const difference = item.countedQuantity - balance;

        const movement = await this.createMovementInTx(tx, {
          companyId: data.companyId,
          branchId: data.branchId,
          productId: item.productId,
          movementType: 'INVENTORY',
          quantity: item.countedQuantity,
          notes: `Inventário. Diferença: ${difference}. ${data.notes || ''}`,
          userId: data.userId,
        });

        return { movement, balance };
      });

      await this.invalidateStockCache(item.productId);

      results.push({
        productId: item.productId,
        previousBalance: balance,
        countedQuantity: item.countedQuantity,
        difference: item.countedQuantity - balance,
        movement,
      });
    }

    return results;
  }
}

export default new StockService();
