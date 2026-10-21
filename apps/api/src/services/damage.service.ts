import { prisma, runInTransaction } from '@ln-system/database';
import cacheService from './cache.service';
import stockService from './stock.service';

/**
 * Avaria (FASE 12) — registro de perda de estoque (produto vencido,
 * danificado, perdido ou roubado). O modelo `DamageRecord` já existia no
 * schema (campo `approvedBy` obrigatório, não nulável — a intenção original
 * já era "avaria exige aprovação"), mas nenhum service/rota o usava.
 *
 * Diferente de Inventário (FASE 11), aqui não existe uma etapa de aprovação
 * separada da criação: a regra de negócio (seção 34 do prompt mestre) é que
 * SÓ Gerente/Admin da empresa/Super Admin podem registrar avaria — a
 * permissão para criar a rota (checada em `damage.routes.ts`) já É a
 * aprovação. `recordedBy` e `approvedBy` ficam iguais (a mesma pessoa
 * autorizada que registra).
 *
 * Movimento é imutável: correção é reversão (`isReversed`), nunca edição ou
 * exclusão do registro original — mesmo princípio já aplicado a
 * cancelamento de venda e devolução nesta sessão.
 */
export class DamageService {
  async record(data: {
    companyId: string;
    branchId: string;
    productId: string;
    quantity: number;
    reason: 'EXPIRED' | 'DAMAGED' | 'LOST' | 'THEFT';
    description?: string;
    photoUrls?: string[];
    recordedBy: string;
  }) {
    if (data.quantity <= 0) {
      throw new Error('Quantidade da avaria deve ser maior que zero');
    }

    const branch = await prisma.branch.findFirst({
      where: { id: data.branchId, companyId: data.companyId },
      select: { id: true },
    });
    if (!branch) {
      throw new Error('Filial não pertence à empresa do solicitante');
    }

    const product = await prisma.product.findFirst({
      where: { id: data.productId, companyId: data.companyId },
      select: { id: true },
    });
    if (!product) {
      throw new Error('Produto não encontrado nesta empresa');
    }

    const damage = await runInTransaction(async (tx) => {
      // ACHADO DE AUDITORIA: o LOSS abaixo escrevia direto no ledger
      // (tx.stockMovement.create) sem nenhuma trava — bypassava por
      // completo `product.allowNegativeStock` (mesmo guard já corrigido
      // nesta sessão em stock.service.ts::createMovement, que só cobre a
      // rota crua POST /stock/movement; este fluxo de avaria nunca passava
      // por lá) e não travava a linha do produto, então era possível
      // registrar avaria de mais unidades do que existem fisicamente em
      // estoque mesmo com o produto configurado para nunca permitir saldo
      // negativo. Mesmo padrão de lock+releitura já usado em
      // adjustStock/transferStock/sale.service.ts/transfer.service.ts.
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${data.productId} FOR UPDATE`;
      const productRow = await tx.product.findUniqueOrThrow({
        where: { id: data.productId },
        select: { allowNegativeStock: true, name: true },
      });
      if (!productRow.allowNegativeStock) {
        const { balance } = await stockService.getBalance(data.productId, data.companyId, data.branchId, tx);
        if (balance < data.quantity) {
          throw new Error(
            `Saldo insuficiente para registrar avaria de ${productRow.name}. Disponível: ${balance}, avaria: ${data.quantity}`
          );
        }
      }

      const created = await tx.damageRecord.create({
        data: {
          companyId: data.companyId,
          branchId: data.branchId,
          productId: data.productId,
          quantity: data.quantity,
          reason: data.reason,
          description: data.description,
          photoUrls: data.photoUrls ? JSON.stringify(data.photoUrls) : undefined,
          approvedBy: data.recordedBy,
          recordedBy: data.recordedBy,
        },
      });

      await tx.stockMovement.create({
        data: {
          companyId: data.companyId,
          branchId: data.branchId,
          productId: data.productId,
          movementType: 'LOSS',
          quantity: data.quantity,
          referenceType: 'DamageRecord',
          referenceId: created.id,
          notes: `Avaria (${data.reason}): ${data.description || 'sem descrição'}`,
          userId: data.recordedBy,
        },
      });

      return created;
    });

    // Ver nota em stock.service.ts sobre o cache de saldo não sendo
    // invalidado automaticamente por escritas diretas no ledger.
    await cacheService.invalidate(`product:${data.productId}:stock*`);

    return damage;
  }

  // ACHADO DE AUDITORIA: sem `take`/`skip` — retornava TODAS as avarias já
  // registradas pela empresa, para sempre (registro é imutável, nunca
  // apagado, só revertido). Mesma classe de bug já corrigida em
  // device-list/sales-stats nesta sessão: uma empresa com anos de uso
  // acumula um payload sempre crescente em toda visita à tela de Avarias.
  // Paginação real, com default generoso o bastante para não mudar o
  // comportamento percebido da tela hoje (que ainda não tem UI de
  // paginação) — api.ts::getDamageRecords continua devolvendo o array
  // puro, zero mudança de contrato para o frontend.
  async list(
    companyId: string,
    filters: { branchId?: string; productId?: string; isReversed?: boolean; page?: number; limit?: number }
  ) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 100;
    const where = {
      companyId,
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(filters.productId && { productId: filters.productId }),
      ...(filters.isReversed !== undefined && { isReversed: filters.isReversed }),
    };

    const [damages, total] = await Promise.all([
      prisma.damageRecord.findMany({
        where,
        include: { product: { select: { id: true, sku: true, name: true } } },
        orderBy: { recordedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.damageRecord.count({ where }),
    ]);

    return { damages, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
  }

  async getById(id: string, companyId: string) {
    const damage = await prisma.damageRecord.findFirst({
      where: { id, companyId },
      include: { product: { select: { id: true, sku: true, name: true } } },
    });
    if (!damage) {
      throw new Error('Registro de avaria não encontrado');
    }
    return damage;
  }

  async reverse(data: { damageId: string; companyId: string; reversedBy: string; reason: string }) {
    const damage = await prisma.damageRecord.findFirst({
      where: { id: data.damageId, companyId: data.companyId },
    });
    if (!damage) {
      throw new Error('Registro de avaria não encontrado');
    }
    if (damage.isReversed) {
      throw new Error('Este registro de avaria já foi revertido');
    }

    const result = await runInTransaction(async (tx) => {
      await tx.stockMovement.create({
        data: {
          companyId: damage.companyId,
          branchId: damage.branchId,
          productId: damage.productId,
          movementType: 'RETURN',
          quantity: damage.quantity,
          referenceType: 'DamageRecord',
          referenceId: damage.id,
          notes: `Reversão de avaria: ${data.reason}`,
          userId: data.reversedBy,
        },
      });

      return tx.damageRecord.update({
        where: { id: damage.id },
        data: {
          isReversed: true,
          reversedAt: new Date(),
          reversedBy: data.reversedBy,
          reverseReason: data.reason,
        },
      });
    });

    await cacheService.invalidate(`product:${damage.productId}:stock*`);

    return result;
  }
}

export default new DamageService();
