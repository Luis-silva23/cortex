import { prisma, runInTransaction, Prisma } from '@ln-system/database';
import stockService from './stock.service';
import cacheService from './cache.service';

/**
 * Inventário físico (FASE 11 do plano de execução) — diferente do endpoint
 * "one-shot" `POST /stock/inventory` (que já existia e cria movimentações
 * de estoque diretamente, sem histórico de sessão), este serviço implementa
 * o fluxo completo exigido: planejamento → contagem → divergência →
 * recontagem → aprovação → fechamento, usando os modelos `Inventory` e
 * `InventoryCount` do schema (já existiam no banco, mas nenhum service ou
 * rota os usava — eram efetivamente código morto).
 *
 * Contagem NUNCA apaga histórico: cada linha de `InventoryCount` guarda o
 * saldo do sistema no momento da PRIMEIRA contagem (`systemQuantity`, fixo)
 * e a contagem mais recente (`countedQuantity`) — uma recontagem atualiza a
 * mesma linha (upsert por `inventoryId+productId`), preservando o saldo de
 * sistema original para que a divergência continue comparável.
 *
 * O ajuste de estoque só é gerado no FECHAMENTO (`close`), nunca durante a
 * contagem — antes disso a divergência é só uma prévia, rastreável e
 * reversível (basta cancelar o inventário).
 */
export class InventoryService {
  async start(data: { companyId: string; branchId: string; startedBy: string; notes?: string }) {
    const branch = await prisma.branch.findFirst({
      where: { id: data.branchId, companyId: data.companyId },
      select: { id: true },
    });
    if (!branch) {
      throw new Error('Filial não pertence à empresa do solicitante');
    }

    // `inventoryNumber` é sequencial POR FILIAL (`@@unique([branchId, inventoryNumber])`)
    // — sob concorrência real, dois inventários abertos ao mesmo tempo na
    // mesma filial podem calcular o mesmo "próximo número"; a constraint
    // única do banco rejeita o perdedor (P2002), e tentamos de novo com o
    // número seguinte — a mesma filosofia de "garantia real no banco" já
    // usada em Idempotency/DeviceSession nesta sessão.
    //
    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: nada impedia dois inventários
    // IN_PROGRESS simultâneos na mesma filial — a única UNIQUE aqui era por
    // número, não por "em andamento". Corrigido com o mesmo padrão do
    // CashRegister: um índice único parcial no banco (ver migration
    // `add_inventory_one_in_progress_per_branch`) como garantia real, e a
    // pré-checagem abaixo (dentro do próprio loop de retry, então também
    // roda de novo se a corrida for decidida por essa constraint) para uma
    // mensagem de erro clara em vez de um P2002 genérico.
    for (let attempt = 0; attempt < 5; attempt++) {
      const openInventory = await prisma.inventory.findFirst({
        where: { branchId: data.branchId, status: 'IN_PROGRESS' },
        select: { inventoryNumber: true },
      });
      if (openInventory) {
        throw new Error(
          `Já existe um inventário em andamento nesta filial (#${openInventory.inventoryNumber}) — finalize ou cancele antes de iniciar um novo`
        );
      }

      const last = await prisma.inventory.findFirst({
        where: { branchId: data.branchId },
        orderBy: { inventoryNumber: 'desc' },
        select: { inventoryNumber: true },
      });
      const nextNumber = (last?.inventoryNumber ?? 0) + 1;

      try {
        return await prisma.inventory.create({
          data: {
            companyId: data.companyId,
            branchId: data.branchId,
            inventoryNumber: nextNumber,
            status: 'IN_PROGRESS',
            startedBy: data.startedBy,
            notes: data.notes,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Não foi possível iniciar o inventário (conflito de numeração persistente)');
  }

  async listByCompany(companyId: string, branchId?: string) {
    return prisma.inventory.findMany({
      where: { companyId, ...(branchId && { branchId }) },
      orderBy: { startedAt: 'desc' },
      include: { _count: { select: { counts: true } } },
    });
  }

  async getById(id: string, companyId: string) {
    const inventory = await prisma.inventory.findFirst({
      where: { id, companyId },
      include: {
        counts: {
          include: { product: { select: { id: true, sku: true, name: true, unit: true } } },
          orderBy: { countedAt: 'desc' },
        },
      },
    });
    if (!inventory) {
      throw new Error('Inventário não encontrado');
    }
    return inventory;
  }

  /**
   * Registra (ou atualiza — recontagem) a contagem de UM produto dentro de
   * um inventário em andamento.
   */
  async addCount(data: {
    inventoryId: string;
    companyId: string;
    productId: string;
    countedQuantity: number;
    countedBy: string;
    notes?: string;
  }) {
    const inventory = await prisma.inventory.findFirst({
      where: { id: data.inventoryId, companyId: data.companyId },
    });
    if (!inventory) {
      throw new Error('Inventário não encontrado');
    }
    if (inventory.status !== 'IN_PROGRESS') {
      throw new Error(`Inventário não está em andamento (status atual: ${inventory.status}) — não é possível registrar contagem`);
    }

    const product = await prisma.product.findFirst({
      where: { id: data.productId, companyId: data.companyId },
      select: { id: true },
    });
    if (!product) {
      throw new Error('Produto não encontrado nesta empresa');
    }

    const existing = await prisma.inventoryCount.findUnique({
      where: { inventoryId_productId: { inventoryId: data.inventoryId, productId: data.productId } },
    });

    // Saldo de sistema é capturado apenas na PRIMEIRA contagem do produto
    // neste inventário — uma recontagem não deve mover o alvo comparando
    // contra um saldo de sistema diferente do da primeira vez.
    const systemQuantity =
      existing != null
        ? Number(existing.systemQuantity)
        : (await stockService.getBalance(data.productId, data.companyId, inventory.branchId)).balance;

    const difference = data.countedQuantity - systemQuantity;

    return prisma.inventoryCount.upsert({
      where: { inventoryId_productId: { inventoryId: data.inventoryId, productId: data.productId } },
      create: {
        inventoryId: data.inventoryId,
        productId: data.productId,
        systemQuantity,
        countedQuantity: data.countedQuantity,
        difference,
        countedBy: data.countedBy,
        countedAt: new Date(),
        notes: data.notes,
      },
      update: {
        countedQuantity: data.countedQuantity,
        difference,
        countedBy: data.countedBy,
        countedAt: new Date(),
        notes: data.notes,
      },
    });
  }

  /**
   * Fechamento = aprovação. Só quem tem permissão para fechar (checado na
   * rota, não aqui) chega a chamar isto. Para cada produto contado com
   * divergência, gera UM movimento de estoque tipo INVENTORY (saldo
   * absoluto — rebaseia o ledger a partir daqui) vinculado a este
   * inventário via referenceType/referenceId, então nunca mistura com um
   * ajuste manual solto. Produtos sem divergência não geram movimento (nada
   * a corrigir), mas continuam registrados em `InventoryCount` como prova
   * de que foram conferidos.
   */
  async close(data: { inventoryId: string; companyId: string; closedBy: string }) {
    const inventory = await prisma.inventory.findFirst({
      where: { id: data.inventoryId, companyId: data.companyId },
      include: { counts: true },
    });
    if (!inventory) {
      throw new Error('Inventário não encontrado');
    }
    if (inventory.status !== 'IN_PROGRESS') {
      throw new Error(`Inventário não está em andamento (status atual: ${inventory.status}) — não é possível fechar`);
    }
    if (inventory.counts.length === 0) {
      throw new Error('Inventário não possui nenhuma contagem registrada');
    }

    const divergent = inventory.counts.filter((c) => Number(c.difference) !== 0);

    const result = await runInTransaction(async (tx) => {
      for (const count of divergent) {
        await tx.stockMovement.create({
          data: {
            companyId: data.companyId,
            branchId: inventory.branchId,
            productId: count.productId,
            movementType: 'INVENTORY',
            quantity: count.countedQuantity,
            referenceType: 'Inventory',
            referenceId: inventory.id,
            notes: `Fechamento de inventário #${inventory.inventoryNumber}. Sistema: ${count.systemQuantity}, Contado: ${count.countedQuantity}, Diferença: ${count.difference}`,
            userId: data.closedBy,
          },
        });
      }

      return tx.inventory.update({
        where: { id: inventory.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
        include: { counts: true },
      });
    });

    // Ver nota em stock.service.ts sobre o cache de saldo não sendo
    // invalidado automaticamente por escritas diretas no ledger.
    await Promise.all(divergent.map((c) => cacheService.invalidate(`product:${c.productId}:stock*`)));

    return result;
  }

  async cancel(data: { inventoryId: string; companyId: string; reason: string }) {
    const inventory = await prisma.inventory.findFirst({ where: { id: data.inventoryId, companyId: data.companyId } });
    if (!inventory) {
      throw new Error('Inventário não encontrado');
    }
    if (inventory.status === 'COMPLETED') {
      throw new Error('Inventário já fechado não pode ser cancelado — os ajustes já foram aplicados ao estoque');
    }
    if (inventory.status === 'CANCELLED') {
      throw new Error('Inventário já está cancelado');
    }

    return prisma.inventory.update({
      where: { id: inventory.id },
      data: { status: 'CANCELLED', notes: `${inventory.notes ? inventory.notes + ' | ' : ''}Cancelado: ${data.reason}` },
    });
  }
}

export default new InventoryService();
