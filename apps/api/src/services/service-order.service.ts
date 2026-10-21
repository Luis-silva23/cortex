import { prisma, runInTransaction } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { AppError, AuthorizationError, ConflictError } from '@ln-system/shared';
import stockService from './stock.service';
import { reservedFor } from './stock-reservations';
import cacheService from './cache.service';
import warrantyService from './warranty.service';
import { policyService } from './policy.service';
import type { WarrantyDecisionInput } from '@ln-system/shared/src/validators/pdv.validators';

// Transições permitidas do fluxo documentado:
// ENTRADA -> DIAGNOSTICO -> ORCAMENTO -> APROVACAO -> EXECUCAO -> PRONTO -> ENTREGA -> ENCERRADA
// CANCELADA é possível a partir de qualquer estado não-terminal.
// (Valores do enum sem acento — ver ServiceOrderStatus em schema.prisma.)
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  ENTRADA: ['DIAGNOSTICO', 'CANCELADA'],
  DIAGNOSTICO: ['ORCAMENTO', 'CANCELADA'],
  ORCAMENTO: ['APROVACAO', 'CANCELADA'],
  APROVACAO: ['EXECUCAO', 'CANCELADA'],
  EXECUCAO: ['PRONTO', 'CANCELADA'],
  PRONTO: ['ENTREGA', 'CANCELADA'],
  ENTREGA: ['ENCERRADA'],
  ENCERRADA: [],
  CANCELADA: [],
};

// Pagamento só com a OS tecnicamente concluída (total final): antes disso itens/mão de obra ainda mudam e a comissão
// congelaria um total provisório. Ver docs/CORTEX/contracts/business-state-machines.md, "OS — pagamento".
const PAYABLE_STATUSES = ['PRONTO', 'ENTREGA'] as const;

// Recusa de negócio (409, PT-BR): antes era Error em inglês, que escapava à tradução por estar num ternário.
function notPayableError(status: string) {
  return new ConflictError(
    status === 'CANCELADA'
      ? 'OS cancelada não recebe pagamento.'
      : `A OS só pode ser paga quando estiver PRONTO ou em ENTREGA (situação atual: ${status}).`,
    'SERVICE_ORDER_NOT_PAYABLE'
  );
}

export class ServiceOrderService {
  /**
   * Abrir OS (ENTRADA). Cliente e motocicleta precisam pertencer à mesma
   * empresa/filial do requisitante.
   */
  async create(data: {
    companyId: string;
    branchId: string;
    customerId: string;
    motorcycleId: string;
    entryKilometer: number;
    fuelLevel?: string;
    visibleDamages?: string;
    personalItems?: string;
    entryNotes?: string;
    userId: string;
  }) {
    const [customer, motorcycle] = await Promise.all([
      prisma.customer.findFirst({ where: { id: data.customerId, companyId: data.companyId }, select: { id: true } }),
      prisma.motorcycle.findFirst({
        where: { id: data.motorcycleId, companyId: data.companyId, customerId: data.customerId },
        select: { id: true },
      }),
    ]);

    if (!customer) {
      throw new Error('Customer not found');
    }
    if (!motorcycle) {
      throw new Error('Motorcycle not found or does not belong to this customer');
    }

    // Numeração sequencial por filial (`@@unique([branchId, osNumber])`).
    //
    // ANTES (defeito real, medido): o "último número + 1" era lido FORA da
    // transação e só a constraint única impedia o duplicado — check-then-act
    // clássico. Com 15 aberturas simultâneas na mesma filial isso vira um
    // thundering herd: todas leem o mesmo último número, UMA vence e as
    // outras levam P2002; cada rodada de retry converte só ~1-2 perdedoras
    // em vencedoras, então o total de sucessos ficava limitado pelo NÚMERO
    // DE TENTATIVAS, não pela corretude. Medição real (8 execuções, 15
    // concorrentes): 7 a 13 sucessos, 100% das falhas em P2002, zero
    // timeout de pool e zero deadlock — ou seja, aberturas de OS legítimas
    // falhavam sob carga, não era flakiness do teste.
    //
    // AGORA: ler-e-inserir acontece na MESMA transação, serializado por
    // filial com um advisory lock de TRANSAÇÃO. `pg_advisory_xact_lock` é
    // liberado sozinho no COMMIT/ROLLBACK, não depende de nenhuma linha
    // (logo é imune ao problema de `SELECT ... FOR UPDATE` + RLS descrito
    // em packages/database/src/index.ts, onde a política filtrava a linha
    // antes do lock e travava zero linhas) e o classid 4201 isola esta
    // numeração de qualquer outra. O `tx.$queryRaw` enxerga o contexto de
    // RLS porque `runInTransaction` aplica os `set_config` como primeira
    // instrução da transação. A leitura do maior osNumber acontece DEPOIS
    // da trava e, sob READ COMMITTED (padrão do Postgres, que não alteramos
    // aqui), toma snapshot novo — já enxergando o número que a transação
    // anterior acabou de commitar.
    //
    // O retry continua como rede de segurança para escritores que não
    // passam por esta trava (quote.service.ts::convertToServiceOrder também
    // insere service_orders) e para nunca vazar P2002 cru ao cliente; com a
    // trava no lugar ele deixou de ser acionado na prática.
    const MAX_OS_NUMBER_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_OS_NUMBER_ATTEMPTS; attempt++) {
      try {
        return await runInTransaction(async (tx) => {
          // `$executeRaw` (não `$queryRaw`): `pg_advisory_xact_lock` retorna
          // `void` e o Prisma falha ao desserializar essa coluna ("Failed to
          // deserialize column of type 'void'") — `$executeRaw` não lê
          // colunas, só conta linhas afetadas.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4201, hashtext(${`${data.companyId}:${data.branchId}`}))`;

          const lastOs = await tx.serviceOrder.findFirst({
            where: { companyId: data.companyId, branchId: data.branchId },
            orderBy: { osNumber: 'desc' },
            select: { osNumber: true },
          });
          const osNumber = (lastOs?.osNumber || 0) + 1;

          const serviceOrder = await tx.serviceOrder.create({
            data: {
              companyId: data.companyId,
              branchId: data.branchId,
              osNumber,
              customerId: data.customerId,
              motorcycleId: data.motorcycleId,
              status: 'ENTRADA',
              entryDate: new Date(),
              entryKilometer: data.entryKilometer,
              fuelLevel: data.fuelLevel,
              visibleDamages: data.visibleDamages,
              personalItems: data.personalItems,
              entryNotes: data.entryNotes,
              finalTotal: 0,
            },
          });

          await tx.serviceOrderStatusHistory.create({
            data: {
              serviceOrderId: serviceOrder.id,
              fromStatus: null,
              toStatus: 'ENTRADA',
              changedBy: data.userId,
              notes: 'Abertura da OS',
            },
          });

          return serviceOrder;
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        if (attempt === MAX_OS_NUMBER_ATTEMPTS) {
          // Nunca vaza o erro cru do Prisma pro cliente numa contenção
          // extrema — mesmo tratamento final de sale.service.ts.
          throw new Error('Sistema com alta concorrência no momento — tente novamente em instantes');
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
      }
    }
    throw new Error('Não foi possível abrir a OS (conflito de numeração persistente)');
  }

  /**
   * Define/atualiza o prazo prometido de conclusão. Opcional (uma OS pode
   * nunca ter um — o dashboard de oficina cai num fallback heurístico
   * nesse caso, ver `DashboardService.getWorkshopDashboard`), mas quando
   * definido é o que decide "atrasado" de verdade, nunca apenas uma data
   * agendada qualquer.
   */
  async setEstimatedDelivery(id: string, companyId: string, estimatedDelivery: Date | null) {
    const os = await prisma.serviceOrder.findFirst({ where: { id, companyId } });
    if (!os) {
      throw new Error('Service order not found');
    }
    if (['ENCERRADA', 'CANCELADA'].includes(os.status)) {
      throw new Error(`Cannot set estimated delivery on a service order with status ${os.status}`);
    }
    return prisma.serviceOrder.update({
      where: { id },
      data: { estimatedDelivery },
    });
  }

  async getById(id: string, companyId: string) {
    return await prisma.serviceOrder.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        motorcycle: true,
        // ACHADO DE AUDITORIA DE INTEGRAÇÃO: mesma classe do bug já
        // corrigido em list() (comentário abaixo) — getById também nunca
        // trazia o mecânico. admin-web lê `os.mechanic` direto na tela de
        // detalhe (app/dashboard/service-orders/[id]/page.tsx) para decidir
        // entre "Mecânico: X" e "Atribuir mecânico"; sem este include, uma
        // OS com mecânico já atribuído sempre mostrava o botão de atribuir,
        // como se ninguém estivesse responsável.
        mechanic: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true } } } },
        statusHistory: { orderBy: { changedAt: 'asc' } },
        // Cartão "Garantia" da tela da OS (decisão do encerramento + ocorrências).
        warranty: { include: { claims: { orderBy: { createdAt: 'desc' } } } },
      },
    });
  }

  async list(filters: {
    companyId: string;
    branchId?: string;
    status?: string;
    mechanicId?: string;
    /** Histórico do cliente / do veículo (Balcão, Admin Web). Sempre dentro da empresa do token. */
    customerId?: string;
    motorcycleId?: string;
    page?: number;
    limit?: number;
  }) {
    const { companyId, branchId, status, mechanicId, customerId, motorcycleId, page = 1, limit = 20 } = filters;

    const where: Prisma.ServiceOrderWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(status && { status: status as any }),
      ...(mechanicId && { mechanicId }),
      ...(customerId && { customerId }),
      ...(motorcycleId && { motorcycleId }),
    };

    const [orders, total] = await Promise.all([
      prisma.serviceOrder.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          motorcycle: { select: { id: true, brand: true, model: true, licensePlate: true } },
          // Ausente até 2026-09-14: a listagem nunca trazia o mecânico
          // (só getById trazia, via `items`/indiretamente), então qualquer
          // tela de listagem não tinha como mostrar quem está responsável
          // sem uma consulta extra por OS.
          mechanic: { select: { id: true, name: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.serviceOrder.count({ where }),
    ]);

    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Adicionar item (peça ou serviço). A baixa de estoque real da peça só
   * acontece na conclusão da execução, não aqui — adicionar um item ao
   * orçamento não deveria travar o produto no estoque ainda.
   */
  async addItem(
    serviceOrderId: string,
    companyId: string,
    data: {
      itemType: 'SERVICE' | 'PART';
      productId?: string;
      description: string;
      quantity: number;
      unitPrice: number;
    },
    userId: string
  ) {
    const os = await prisma.serviceOrder.findFirst({ where: { id: serviceOrderId, companyId } });
    if (!os) {
      throw new Error('Service order not found');
    }
    if (['ENCERRADA', 'CANCELADA'].includes(os.status)) {
      throw new Error(`Cannot add items to a service order with status ${os.status}`);
    }
    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: `registerPayment` congela
    // AccountsReceivable.amount e MechanicCommission.baseAmount a partir de
    // laborTotal/finalTotal NO MOMENTO do pagamento. Como ENCERRADA (a única
    // outra trava) só é permitida depois de isPaid, havia uma janela real
    // entre "pago" e "encerrada" em que um item ainda podia ser adicionado,
    // inflando laborTotal/finalTotal sem nunca atualizar o valor já cobrado
    // nem a comissão já gerada — dinheiro do mecânico e contas a receber
    // ficavam permanentemente desalinhados com o total real da OS.
    if (os.isPaid) {
      throw new Error('Cannot add items to a service order that has already been paid');
    }

    // ACHADO DE AUDITORIA (mesma classe do bug já corrigido em
    // sale.service.ts): `data.unitPrice` vinha direto do corpo da
    // requisição e era usado sem comparação com `product.salePrice` para
    // itens PART ligados a um produto real do catálogo — um operador podia
    // adicionar uma peça cara com unitPrice baixo sem passar por nenhuma
    // aprovação. Para PART com productId, o preço agora sempre vem do
    // catálogo. Para SERVICE (mão de obra, sem preço de catálogo) e PART
    // sem productId (peça avulsa fora do catálogo), o preço continua
    // manual — não há como derivá-lo de outro lugar.
    let unitPrice = data.unitPrice;
    if (data.itemType === 'PART' && data.productId) {
      const product = await prisma.product.findFirst({ where: { id: data.productId, companyId } });
      if (!product) {
        throw new Error('Product not found');
      }
      unitPrice = Number(product.salePrice);
    }

    const totalPrice = data.quantity * unitPrice;

    // A baixa de estoque das peças normalmente acontece de uma vez só, na
    // transição para EXECUCAO (ver `transitionStatus`) — mas essa transição
    // só roda UMA vez. Uma peça adicionada DEPOIS que a OS já está em
    // EXECUCAO (ou além: PRONTO/ENTREGA — mecânico percebeu no meio do
    // conserto que precisa de mais uma peça) nunca passava por aquele
    // ponto, então o item entrava no total cobrado do cliente
    // (`partsTotal`/`finalTotal`) SEM NUNCA baixar o estoque de verdade —
    // o produto ficava contado como disponível quando já tinha sido usado.
    // Corrigido: se a OS já passou do ponto de baixa, a baixa acontece
    // AGORA, no próprio `addItem`, com a mesma checagem de saldo.
    const stockAlreadyConsumedStatuses = ['EXECUCAO', 'PRONTO', 'ENTREGA'];
    const needsImmediateStockDeduction =
      data.itemType === 'PART' && !!data.productId && stockAlreadyConsumedStatuses.includes(os.status);

    const result = await runInTransaction(async (tx) => {
      if (needsImmediateStockDeduction) {
        // Mesmo lock+releitura já usado em sale.service.ts/stock.service.ts
        // — sem isso, duas peças adicionadas quase ao mesmo tempo (mesma OS
        // ou OS diferentes) na última unidade do produto podiam ambas
        // passar na checagem otimista.
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${data.productId} FOR UPDATE`;
        const { balance } = await stockService.getBalance(data.productId as string, companyId, os.branchId, tx);
        const reserved = await reservedFor(tx, { companyId, branchId: os.branchId, productId: data.productId as string });
        if (balance - reserved < data.quantity) {
          throw new Error(
            `Insufficient stock for product ${data.productId} — Available: ${balance - reserved}, required: ${data.quantity}`
          );
        }
      }

      const item = await tx.serviceOrderItem.create({
        data: {
          serviceOrderId,
          itemType: data.itemType,
          productId: data.productId,
          description: data.description,
          quantity: data.quantity,
          unitPrice,
          totalPrice,
          isCompleted: needsImmediateStockDeduction,
          completedAt: needsImmediateStockDeduction ? new Date() : undefined,
        },
      });

      if (needsImmediateStockDeduction) {
        await tx.stockMovement.create({
          data: {
            companyId,
            branchId: os.branchId,
            productId: data.productId as string,
            movementType: 'SALE',
            quantity: -data.quantity,
            referenceType: 'ServiceOrder',
            referenceId: serviceOrderId,
            userId,
            notes: `Peça consumida na OS #${os.osNumber} (adicionada com a OS já em ${os.status})`,
          },
        });
      }

      const aggregateField = data.itemType === 'PART' ? 'partsTotal' : 'laborTotal';
      const updated = await tx.serviceOrder.update({
        where: { id: serviceOrderId },
        data:
          aggregateField === 'partsTotal'
            ? { partsTotal: { increment: totalPrice }, finalTotal: { increment: totalPrice } }
            : { laborTotal: { increment: totalPrice }, finalTotal: { increment: totalPrice } },
      });

      return { item, serviceOrder: updated };
    });

    if (needsImmediateStockDeduction) {
      await cacheService.invalidate(`product:${data.productId}:stock*`);
    }

    return result;
  }

  /**
   * Transição de status com validação da máquina de estados e registro
   * histórico obrigatório (auditoria de fluxo da OS).
   */
  async transitionStatus(
    serviceOrderId: string,
    companyId: string,
    toStatus: string,
    changedBy: string,
    notes?: string,
    options: { warranty?: WarrantyDecisionInput } = {}
  ) {
    const os = await prisma.serviceOrder.findFirst({ where: { id: serviceOrderId, companyId } });
    if (!os) {
      throw new Error('Service order not found');
    }

    const allowed = ALLOWED_TRANSITIONS[os.status] || [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Cannot transition from ${os.status} to ${toStatus}`);
    }

    // Separação explícita: PRONTO é conclusão TÉCNICA; ENCERRADA é
    // encerramento FINANCEIRO/ADMINISTRATIVO — nunca podem ser confundidos.
    // ENCERRADA exige pagamento confirmado.
    if (toStatus === 'ENCERRADA' && !os.isPaid) {
      throw new Error('Cannot close service order financially before payment is confirmed');
    }

    // Garantia (docs/CORTEX/policies/GARANTIA.md): decidida só no encerramento; validada antes e gravada na MESMA
    // transação da mudança de status (sem OS encerrada sem a decisão exigida, sem garantia órfã).
    if (options.warranty && toStatus !== 'ENCERRADA') {
      throw new AppError('A decisão de garantia só é informada no encerramento da OS.', 400, 'WARRANTY_ONLY_ON_CLOSE');
    }
    const closing = toStatus === 'ENCERRADA' ? await warrantyService.prepareCloseDecision(os, options.warranty) : null;

    const touchedProductIds: string[] = [];

    const result = await runInTransaction(async (tx) => {
      const updateData: Prisma.ServiceOrderUpdateInput = { status: toStatus as any };
      if (closing) {
        updateData.warrantyDecision = closing.decision;
        if (closing.exitKilometer !== undefined) updateData.exitKilometer = closing.exitKilometer;
      }

      if (toStatus === 'EXECUCAO') {
        updateData.mechanicStartedAt = new Date();
      }
      if (toStatus === 'PRONTO') {
        updateData.mechanicCompletedAt = new Date();
      }
      if (toStatus === 'ENTREGA') {
        updateData.deliveryDate = new Date();
      }
      if (toStatus === 'CANCELADA') {
        updateData.cancelledAt = new Date();
        updateData.cancelledBy = changedBy;
        updateData.cancelReason = notes || 'Não informado';
      }

      // Reivindica a transição a partir do status LIDO: uma segunda mudança simultânea (duplo clique, duas telas)
      // encontra 0 linhas e é recusada antes do histórico e da baixa de peças.
      const claimed = await tx.serviceOrder.updateMany({
        where: { id: serviceOrderId, companyId, status: os.status, ...(toStatus === 'ENCERRADA' ? { isPaid: true } : {}) },
        data: updateData as Prisma.ServiceOrderUpdateManyMutationInput,
      });
      if (claimed.count === 0) {
        throw new ConflictError(
          'Outra pessoa alterou a situação desta OS ao mesmo tempo. Atualize a tela e tente de novo.',
          'SERVICE_ORDER_STATUS_CHANGED'
        );
      }
      const updated = await tx.serviceOrder.findUniqueOrThrow({ where: { id: serviceOrderId } });

      await tx.serviceOrderStatusHistory.create({
        data: {
          serviceOrderId,
          fromStatus: os.status,
          toStatus: toStatus as any,
          changedBy,
          notes,
        },
      });

      if (closing?.warranty) {
        const warranty = await warrantyService.createInTx(tx, closing, changedBy);
        return { ...updated, warranty };
      }

      // Baixa real de estoque das peças acontece aqui, no INÍCIO da
      // EXECUCAO — é o momento em que o mecânico de fato retira/usa a
      // peça. Não antes (orçamento/aprovação não deveriam travar
      // produto em estoque) nem depois (a peça já estaria fisicamente
      // consumida sem registro). Só itens PART com productId vinculado
      // geram movimentação de estoque; itens SERVICE (mão de obra) nunca
      // tocam estoque. Tratamos a baixa como uma "venda" da peça
      // (movementType SALE), o mesmo tipo usado por sale.service.ts —
      // não existe no enum um tipo mais específico para "consumo em OS".
      // `isCompleted` funciona como guarda contra baixa em duplicidade:
      // mesmo que EXECUCAO seja reprocessada, itens já baixados não são
      // baixados de novo (hoje a máquina de estados não permite reentrar
      // em EXECUCAO, mas a guarda é barata e evita corromper o estoque
      // se isso mudar).
      if (toStatus === 'EXECUCAO') {
        const partItems = await tx.serviceOrderItem.findMany({
          where: { serviceOrderId, itemType: 'PART', productId: { not: null }, isCompleted: false },
        });

        // Ordem fixa de travas entre OS que dividem peças (A: p1,p2 × B: p2,p1 dava deadlock).
        partItems.sort((x, y) => String(x.productId).localeCompare(String(y.productId)));

        for (const item of partItems) {
          const quantity = Number(item.quantity);

          // Duas OS iniciando ao mesmo tempo com a última unidade liam o mesmo saldo (fora da transação) e as duas
          // baixavam: saldo -1. Trava a linha do produto e relê o saldo dentro da transação (igual a addItem/venda).
          await tx.$queryRaw`SELECT id FROM products WHERE id = ${item.productId as string} FOR UPDATE`;
          const { balance } = await stockService.getBalance(item.productId as string, companyId, os.branchId, tx);
          const reserved = await reservedFor(tx, { companyId, branchId: os.branchId, productId: item.productId as string });
          if (balance - reserved < quantity) {
            throw new Error(
              `Insufficient stock for product ${item.productId} to start execution. Available: ${balance - reserved}, required: ${quantity}`
            );
          }

          // Escrito via `tx` (não `stockService.createMovement`, que usa o
          // client top-level) — antes desta correção, a baixa de estoque
          // rodava numa transação SEPARADA da que marca o item como
          // concluído/muda o status da OS: se um item POSTERIOR do mesmo
          // loop falhasse por saldo insuficiente, a exceção revertia esta
          // `tx` (status da OS e `isCompleted` voltavam ao estado
          // anterior), mas as baixas de estoque de itens ANTERIORES já
          // haviam sido commitadas de forma independente e ficavam
          // órfãs — estoque debitado sem a OS de fato ter avançado.
          await tx.stockMovement.create({
            data: {
              companyId,
              branchId: os.branchId,
              productId: item.productId as string,
              movementType: 'SALE',
              quantity: -quantity,
              referenceType: 'ServiceOrder',
              referenceId: serviceOrderId,
              userId: changedBy,
              notes: `Peça consumida na OS #${os.osNumber}`,
            },
          });
          touchedProductIds.push(item.productId as string);

          await tx.serviceOrderItem.update({
            where: { id: item.id },
            data: { isCompleted: true, completedAt: new Date() },
          });
        }
      }

      return updated;
    });

    // Ver nota em stock.service.ts sobre invalidação de cache de saldo.
    await Promise.all(touchedProductIds.map((productId) => cacheService.invalidate(`product:${productId}:stock*`)));

    return result;
  }

  async assignMechanic(
    serviceOrderId: string,
    companyId: string,
    mechanicId: string,
    actor?: { userId: string; userType: string }
  ) {
    const os = await prisma.serviceOrder.findFirst({ where: { id: serviceOrderId, companyId } });
    if (!os) {
      throw new Error('Service order not found');
    }

    // A comissão vai para o mecânico vigente no momento do pagamento. Um
    // MECHANIC só pode ASSUMIR a OS para si mesmo e só se ela ainda não é de
    // outro mecânico — senão reatribuía qualquer OS (a si ou a um colega) antes
    // do pagamento e desviava a comissão. Reatribuir é de OPERATOR/MANAGER+.
    if (actor?.userType === 'MECHANIC') {
      if (mechanicId !== actor.userId) {
        throw new AuthorizationError('Mecânico só pode atribuir a OS a si mesmo');
      }
      if (os.mechanicId && os.mechanicId !== actor.userId) {
        throw new AuthorizationError('Esta OS já está com outro mecânico; peça a um gerente para reatribuir');
      }
    }

    const mechanic = await prisma.user.findFirst({ where: { id: mechanicId, companyId } });
    if (!mechanic) {
      throw new Error('Mechanic not found in this company');
    }
    // Só usuários com userType MECHANIC podem ser atribuídos como mecânico
    // responsável pela OS — antes desta checagem, qualquer usuário da
    // empresa (inclusive VIEWER) podia ser "atribuído".
    if (mechanic.userType !== 'MECHANIC') {
      throw new Error('Usuário informado não é um mecânico');
    }

    return await prisma.serviceOrder.update({ where: { id: serviceOrderId }, data: { mechanicId } });
  }

  /**
   * Ponto único onde o dinheiro da OS se torna "real" para o financeiro.
   * Escolhido aqui (e não em transitionStatus/ENCERRADA) porque é
   * exatamente a informação (`isPaid`) que a própria máquina de estados já
   * usa como pré-condição para ENCERRADA — o pagamento é a causa, o
   * encerramento é a consequência administrativa. Cria a conta a receber
   * já quitada (o fluxo de pagamento de OS neste sistema é sempre
   * confirmado/à vista no momento do registro, não existe "a prazo" aqui).
   */
  async registerPayment(serviceOrderId: string, companyId: string, paymentMethod: string) {
    const os = await prisma.serviceOrder.findFirst({ where: { id: serviceOrderId, companyId } });
    if (!os) {
      throw new Error('Service order not found');
    }
    if (os.isPaid) {
      throw new Error('Service order already paid');
    }
    if (!PAYABLE_STATUSES.includes(os.status as (typeof PAYABLE_STATUSES)[number])) {
      throw notPayableError(os.status);
    }

    const totalAmount = Number(os.laborTotal) + Number(os.partsTotal) - Number(os.discountAmount);

    // Comissão do mecânico (REQ-7, opcional): buscamos a regra ANTES da
    // transação — é uma leitura pura, sem efeito colateral, e não precisa
    // do isolamento da transação de pagamento. A ausência de regra ativa
    // para a empresa não é um erro: comissão é repartição de receita
    // opcional, nunca deve travar o fluxo de pagamento da OS.
    // Política `commission.enabled` (empresa/filial): desligada = nenhuma comissão é calculada, sem nem procurar regra.
    const commissionEnabled = os.mechanicId ? await policyService.get(companyId, os.branchId, 'commission.enabled') : false;
    const commissionRule = os.mechanicId && commissionEnabled
      ? await prisma.commissionRule.findFirst({ where: { companyId, isActive: true } })
      : null;

    return await runInTransaction(async (tx) => {
      // Guarda atômica contra registro de pagamento concorrente da mesma OS
      // (mesmo padrão TOCTOU já corrigido em payment.service.ts::
      // cancelPayment/refundPayment e cash-register.service.ts::
      // closeCashRegister) — o `findFirst` com `isPaid` acima roda FORA da
      // transação, então duas chamadas quase simultâneas (duplo clique em
      // "Confirmar pagamento", ou um retry de rede) podiam ambas ler
      // isPaid=false e ambas commitar: nem AccountsReceivable nem
      // MechanicCommission têm unique constraint em serviceOrderId, então
      // nada no banco impedia duas contas a receber PAID (receita em dobro)
      // e duas comissões pagas ao mesmo mecânico pela mesma OS.
      // Os totais entram na guarda: um desconto (service-order-discount) ou item gravado entre a leitura acima e
      // aqui faria a conta a receber sair com o total velho.
      const paymentUpdate = await tx.serviceOrder.updateMany({
        where: {
          id: serviceOrderId,
          companyId,
          isPaid: false,
          status: { in: [...PAYABLE_STATUSES] },
          laborTotal: os.laborTotal,
          partsTotal: os.partsTotal,
          discountAmount: os.discountAmount,
        },
        data: { isPaid: true, paidAt: new Date(), paymentMethod: paymentMethod as any },
      });

      if (paymentUpdate.count === 0) {
        const current = await tx.serviceOrder.findFirst({ where: { id: serviceOrderId, companyId }, select: { isPaid: true, status: true } });
        if (!current || current.isPaid) {
          throw new Error('Service order already paid');
        }
        if (current.status && !PAYABLE_STATUSES.includes(current.status as (typeof PAYABLE_STATUSES)[number])) {
          throw notPayableError(current.status);
        }
        throw new ConflictError(
          'O valor desta OS mudou enquanto o pagamento era registrado (desconto ou item novo). Confira o total e registre de novo.',
          'SERVICE_ORDER_CHANGED'
        );
      }

      const updated = await tx.serviceOrder.findUniqueOrThrow({ where: { id: serviceOrderId } });

      await tx.accountsReceivable.create({
        data: {
          companyId,
          branchId: os.branchId,
          customerId: os.customerId,
          description: `Ordem de Serviço #${os.osNumber}`,
          amount: totalAmount,
          dueDate: new Date(),
          status: 'PAID',
          paidDate: new Date(),
          referenceType: 'ServiceOrder',
          referenceId: serviceOrderId,
        },
      });

      // Base de cálculo = apenas mão de obra (laborTotal), não peças
      // (partsTotal). Prática usual de oficina: o mecânico é comissionado
      // pelo serviço que ele executa, não pela margem/venda de peças (que
      // já embute o custo de aquisição e a margem do estoque, alheios ao
      // trabalho do mecânico). Se no futuro a regra precisar variar por
      // serviceType, o ruleSnapshot abaixo já guarda o que foi usado.
      if (os.mechanicId && commissionRule) {
        const baseAmount = Number(os.laborTotal);
        const percentage = Number(commissionRule.percentage);
        const commissionAmount = Number(((baseAmount * percentage) / 100).toFixed(2));

        await tx.mechanicCommission.create({
          data: {
            companyId,
            serviceOrderId,
            mechanicId: os.mechanicId,
            ruleSnapshot: {
              ruleId: commissionRule.id,
              name: commissionRule.name,
              serviceType: commissionRule.serviceType,
              percentage,
            },
            baseAmount,
            percentage,
            commissionAmount,
          },
        });
      }

      return updated;
    });
  }
}

export default new ServiceOrderService();
