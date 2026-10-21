import { prisma, runInTransaction, prismaUnsafeBypassRLS, Prisma, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import cacheService from './cache.service';
import stockService from './stock.service';
import { reservedFor } from './stock-reservations';

/**
 * Transferência entre filiais (FASE 24) — os modelos `Transfer`/
 * `TransferItem` já existiam no schema (fluxo completo já modelado:
 * PENDING → IN_TRANSIT → RECEIVED, com CANCELLED), mas nenhum service/rota
 * os usava (código morto, igual ao caso de Inventário na FASE 11). O único
 * primitivo existente (`StockService.transferStock`) faz uma transferência
 * INSTANTÂNEA entre filiais, sem etapa de aprovação, sem "em trânsito", sem
 * confirmação de recebimento — não atende à exigência do prompt mestre
 * (seção 24/35: "SOLICITADA → APROVADA → EM TRÂNSITO → RECEBIDA", com
 * rejeição/cancelamento/divergência). Continua existindo para outros usos
 * (ex.: ajuste administrativo direto), mas o fluxo formal de transferência
 * agora passa por aqui.
 *
 * Só EMPRESA A → FILIAL A → FILIAL B, nunca entre empresas — companyId é
 * sempre o mesmo em `fromBranchId`/`toBranchId` (ambas resolvidas e
 * validadas contra a mesma `companyId` do solicitante).
 */
export class TransferService {
  async request(data: {
    companyId: string;
    fromBranchId: string;
    toBranchId: string;
    requestedBy: string;
    items: Array<{ productId: string; quantity: number }>;
    notes?: string;
  }) {
    if (data.fromBranchId === data.toBranchId) {
      throw new Error('Filial de origem e destino não podem ser a mesma');
    }
    if (!data.items || data.items.length === 0) {
      throw new Error('Transfer must have at least one item');
    }

    // RLS de `branches` restringe um usuário sem role "empresa inteira"
    // (ex.: OPERATOR) a enxergar só a PRÓPRIA filial (ver
    // `rls_company_branch_match` — só MANAGER/COMPANY_ADMIN/SUPER_ADMIN
    // enxergam todas as filiais da empresa). Um operador da Filial A
    // solicitando uma transferência PARA a Filial B legitimamente precisa
    // confirmar que a Filial B existe e é da mesma empresa, sem que isso
    // signifique enxergar dados gerais da Filial B.
    //
    // RLS é imposta pelo POSTGRES a partir do estado de SESSÃO da conexão
    // (`set_config`), não pelo objeto JS que envolve a query — então nem o
    // client "cru" (`prismaUnsafeBypassRLS`, sem a extensão) escapa da RLS
    // sozinho: sem NENHUM `set_config` aplicado, a policy nega tudo por
    // padrão (fail-closed, confirmado em teste isolado: 0 linhas). E um
    // `runWithRLSContext(SUPER_ADMIN, ...)` ANINHADO dentro do contexto já
    // ativo da requisição (setado por `tenantIsolation`) também se mostrou
    // pouco confiável sob tráfego real (mesma chamada, ora aplicava o
    // bypass corretamente, ora não — mesmo com o contexto JS lido como
    // SUPER_ADMIN no instante da chamada). A única forma determinística:
    // aplicar o `set_config` de bypass EXPLICITAMENTE, na mesma conexão/
    // transação da consulta, via `$transaction([...])` em lote no client
    // cru — sem depender de nenhuma composição de contexto assíncrono.
    const [, branches] = await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.branch.findMany({
        where: { id: { in: [data.fromBranchId, data.toBranchId] }, companyId: data.companyId },
        select: { id: true },
      }),
    ]);
    if (branches.length !== 2) {
      throw new Error('Ambas as filiais precisam pertencer à mesma empresa do solicitante');
    }

    const productIds = data.items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, companyId: data.companyId },
      select: { id: true },
    });
    if (products.length !== new Set(productIds).size) {
      throw new Error('One or more products were not found in this company');
    }

    // Número sequencial por empresa — mesma estratégia de retry sob
    // colisão já usada em Inventory (FASE 11) e Sale (concorrência real).
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await prisma.transfer.findFirst({
        where: { companyId: data.companyId },
        orderBy: { transferNumber: 'desc' },
        select: { transferNumber: true },
      });
      const nextNumber = (last?.transferNumber ?? 0) + 1;

      try {
        return await prisma.transfer.create({
          data: {
            companyId: data.companyId,
            fromBranchId: data.fromBranchId,
            toBranchId: data.toBranchId,
            transferNumber: nextNumber,
            status: 'PENDING',
            requestedBy: data.requestedBy,
            notes: data.notes,
            items: {
              create: data.items.map((i) => ({ productId: i.productId, requestedQuantity: i.quantity })),
            },
          },
          include: { items: true },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Não foi possível criar a transferência (conflito de numeração persistente)');
  }

  async getById(id: string, companyId: string) {
    const transfer = await prisma.transfer.findFirst({
      where: { id, companyId },
      include: { items: { include: { product: { select: { id: true, sku: true, name: true } } } } },
    });
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }
    return transfer;
  }

  async list(companyId: string, filters: { branchId?: string; status?: string }) {
    return prisma.transfer.findMany({
      where: {
        companyId,
        ...(filters.status && { status: filters.status as any }),
        ...(filters.branchId && { OR: [{ fromBranchId: filters.branchId }, { toBranchId: filters.branchId }] }),
      },
      include: { items: true },
      orderBy: { requestedAt: 'desc' },
    });
  }

  /** Aprovação — só quem tem permissão (checado na rota) chega aqui. */
  async approve(data: { transferId: string; companyId: string; approvedBy: string }) {
    const transfer = await prisma.transfer.findFirst({ where: { id: data.transferId, companyId: data.companyId } });
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }
    if (transfer.status !== 'PENDING') {
      throw new Error(`Transferência não está pendente (status atual: ${transfer.status}) — não é possível aprovar`);
    }
    return prisma.transfer.update({
      where: { id: transfer.id },
      data: { approvedBy: data.approvedBy, approvedAt: new Date() },
      include: { items: true },
    });
  }

  /**
   * Rejeição (antes de enviar) — o schema não tem um status REJECTED
   * distinto de CANCELLED; reaproveita CANCELLED com o motivo registrado em
   * `notes`, mesma convenção já usada em outras entidades deste sistema
   * (ex.: PurchaseOrder.cancel).
   */
  async reject(data: { transferId: string; companyId: string; reason: string }) {
    const transfer = await prisma.transfer.findFirst({ where: { id: data.transferId, companyId: data.companyId } });
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }
    if (!['PENDING'].includes(transfer.status)) {
      throw new Error(`Só é possível rejeitar uma transferência pendente (status atual: ${transfer.status})`);
    }
    return prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'CANCELLED', notes: `${transfer.notes ? transfer.notes + ' | ' : ''}Rejeitada: ${data.reason}` },
    });
  }

  /**
   * Envio — sai fisicamente da filial de origem. Precisa estar APROVADA
   * (approvedBy preenchido). Gera TRANSFER_OUT no estoque da origem AGORA
   * (mercadoria já saiu fisicamente) — o destino só recebe estoque real na
   * confirmação de recebimento, nunca antes (mercadoria "em trânsito" não
   * pertence a nenhuma das duas filiais no ledger).
   */
  async send(data: {
    transferId: string;
    companyId: string;
    sentBy: string;
    items: Array<{ transferItemId: string; sentQuantity: number }>;
  }) {
    const transfer = await prisma.transfer.findFirst({
      where: { id: data.transferId, companyId: data.companyId },
      include: { items: true },
    });
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }
    if (transfer.status !== 'PENDING' || !transfer.approvedBy) {
      throw new Error('Transferência precisa estar aprovada antes do envio');
    }

    const result = await runInTransaction(async (tx) => {
      // Reivindica a transição ANTES de mexer em estoque: um segundo "Enviar" simultâneo (duplo clique) encontra
      // 0 linhas e é recusado, em vez de lançar outro TRANSFER_OUT.
      const claimed = await tx.transfer.updateMany({
        where: { id: transfer.id, companyId: data.companyId, status: 'PENDING', approvedBy: { not: null } },
        data: { status: 'IN_TRANSIT', sentBy: data.sentBy, sentAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new Error('Transferência já enviada ou não está mais pendente');
      }

      for (const sendItem of data.items) {
        const item = transfer.items.find((i) => i.id === sendItem.transferItemId);
        if (!item) {
          throw new Error(`Item ${sendItem.transferItemId} não pertence a esta transferência`);
        }
        if (sendItem.sentQuantity <= 0 || sendItem.sentQuantity > Number(item.requestedQuantity)) {
          throw new Error(`Quantidade enviada inválida para o produto — solicitado: ${item.requestedQuantity}`);
        }

        // ACHADO DE AUDITORIA: o TRANSFER_OUT abaixo escrevia direto no
        // ledger (tx.stockMovement.create) sem nenhuma trava — a única
        // checagem era "sentQuantity <= requestedQuantity", nunca contra o
        // saldo REAL disponível na filial de origem. Isso ignorava
        // completamente `product.allowNegativeStock` (mesmo guard já
        // corrigido nesta sessão em stock.service.ts::createMovement, que
        // só cobre a rota crua POST /stock/movement — este fluxo formal de
        // transferência nunca passava por lá) e não travava a linha do
        // produto, então dois envios concorrentes do mesmo produto na
        // mesma filial (duas transferências diferentes, ou um duplo clique
        // em "Enviar") podiam ambos passar e levar o saldo a negativo
        // mesmo com o produto configurado para nunca permitir isso. Mesmo
        // padrão de lock+releitura já usado em adjustStock/transferStock/
        // sale.service.ts.
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${item.productId} FOR UPDATE`;
        const product = await tx.product.findUniqueOrThrow({
          where: { id: item.productId },
          select: { allowNegativeStock: true, name: true },
        });
        if (!product.allowNegativeStock) {
          const { balance } = await stockService.getBalance(item.productId, data.companyId, transfer.fromBranchId, tx);
          // O que está reservado para pedido externo não sai em transferência (disponível = saldo − reservas vivas).
          const reserved = await reservedFor(tx, { companyId: data.companyId, branchId: transfer.fromBranchId, productId: item.productId });
          if (balance - reserved < sendItem.sentQuantity) {
            throw new Error(
              `Saldo insuficiente para transferir ${product.name}. Disponível na filial de origem: ${balance - reserved}, solicitado: ${sendItem.sentQuantity}`
            );
          }
        }

        await tx.transferItem.update({
          where: { id: item.id },
          data: { sentQuantity: sendItem.sentQuantity },
        });

        await tx.stockMovement.create({
          data: {
            companyId: data.companyId,
            branchId: transfer.fromBranchId,
            productId: item.productId,
            movementType: 'TRANSFER_OUT',
            quantity: -sendItem.sentQuantity,
            referenceType: 'Transfer',
            referenceId: transfer.id,
            notes: `Transferência #${transfer.transferNumber} enviada para outra filial`,
            userId: data.sentBy,
          },
        });
      }

      return tx.transfer.findUniqueOrThrow({ where: { id: transfer.id }, include: { items: true } });
    });

    await Promise.all(data.items.map((i) => {
      const item = transfer.items.find((ti) => ti.id === i.transferItemId);
      return item ? cacheService.invalidate(`product:${item.productId}:stock*`) : Promise.resolve();
    }));

    return result;
  }

  /**
   * Recebimento — confirma entrada física na filial de destino. Suporta
   * divergência: a quantidade recebida pode ser MENOR que a enviada (perda/
   * avaria no transporte) — nunca maior. A diferença fica registrada em
   * `TransferItem.receivedQuantity` vs `sentQuantity`, nunca escondida.
   */
  async receive(data: {
    transferId: string;
    companyId: string;
    receivedBy: string;
    items: Array<{ transferItemId: string; receivedQuantity: number }>;
  }) {
    const transfer = await prisma.transfer.findFirst({
      where: { id: data.transferId, companyId: data.companyId },
      include: { items: true },
    });
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }
    if (transfer.status !== 'IN_TRANSIT') {
      throw new Error(`Transferência não está em trânsito (status atual: ${transfer.status}) — não é possível receber`);
    }

    const result = await runInTransaction(async (tx) => {
      const claimed = await tx.transfer.updateMany({
        where: { id: transfer.id, companyId: data.companyId, status: 'IN_TRANSIT' },
        data: { status: 'RECEIVED', receivedBy: data.receivedBy, receivedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new Error('Transferência já recebida ou não está mais em trânsito');
      }

      for (const recvItem of data.items) {
        const item = transfer.items.find((i) => i.id === recvItem.transferItemId);
        if (!item) {
          throw new Error(`Item ${recvItem.transferItemId} não pertence a esta transferência`);
        }
        const sent = Number(item.sentQuantity ?? 0);
        if (recvItem.receivedQuantity < 0 || recvItem.receivedQuantity > sent) {
          throw new Error(`Quantidade recebida (${recvItem.receivedQuantity}) não pode exceder a enviada (${sent})`);
        }

        const divergence = sent - recvItem.receivedQuantity;
        await tx.transferItem.update({
          where: { id: item.id },
          data: {
            receivedQuantity: recvItem.receivedQuantity,
            notes: divergence > 0 ? `Divergência: ${divergence} unidade(s) não recebida(s)` : item.notes,
          },
        });

        if (recvItem.receivedQuantity > 0) {
          await tx.stockMovement.create({
            data: {
              companyId: data.companyId,
              branchId: transfer.toBranchId,
              productId: item.productId,
              movementType: 'TRANSFER_IN',
              quantity: recvItem.receivedQuantity,
              referenceType: 'Transfer',
              referenceId: transfer.id,
              notes: `Transferência #${transfer.transferNumber} recebida da filial de origem${divergence > 0 ? ` (divergência: ${divergence} unidade(s))` : ''}`,
              userId: data.receivedBy,
            },
          });
        }
      }

      return tx.transfer.findUniqueOrThrow({ where: { id: transfer.id }, include: { items: true } });
    });

    await Promise.all(data.items.map((i) => {
      const item = transfer.items.find((ti) => ti.id === i.transferItemId);
      return item ? cacheService.invalidate(`product:${item.productId}:stock*`) : Promise.resolve();
    }));

    return result;
  }

  /** Cancelamento antes do envio (mercadoria ainda não saiu fisicamente). */
  async cancel(data: { transferId: string; companyId: string; reason: string }) {
    const transfer = await prisma.transfer.findFirst({ where: { id: data.transferId, companyId: data.companyId } });
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }
    if (!['PENDING'].includes(transfer.status)) {
      throw new Error(
        `Não é possível cancelar uma transferência ${transfer.status} — mercadoria já em trânsito/recebida precisa de uma transferência reversa, não cancelamento`
      );
    }
    return prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'CANCELLED', notes: `${transfer.notes ? transfer.notes + ' | ' : ''}Cancelada: ${data.reason}` },
    });
  }
}

export default new TransferService();
