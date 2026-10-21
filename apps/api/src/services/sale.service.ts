import { prisma, runInTransaction } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import productService from './product.service';
import stockService from './stock.service';
import cacheService from './cache.service';
import { Logger } from './logger.service';
import { verifyDualAuthorization } from './dual-authorization.service';
import { evaluateDiscount, authorizeDiscount, recordDiscountEvents, DiscountEventInput } from './discount-policy.service';
import partnerService from './partner.service';
import { refundedValue, round2 } from './sale-refund';
import { assertCanOperateRegister } from './cash-register.service';
import { agreementPaymentIds, reverseAgreementEffects } from './agreement-effects';
import { reservedFor } from './stock-reservations';

// Mesmo critério de perfil usado em outras operações financeiras sensíveis
// (retirada de caixa) — cancelar OU devolver uma venda já criada é
// igualmente sensível: estoque já baixou e pode já haver pagamento
// aprovado (dinheiro no caixa). Compartilhado por cancelSale e returnSale —
// ver ACHADO DE AUDITORIA em returnSale: a devolução fazia o mesmo estorno
// financeiro do cancelamento mas sem nenhuma autorização.
const SALE_REVERSAL_AUTHORIZER_ROLES = ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];
// Quem pode aprovar convênio que exige aprovação (Partner.requiresApproval). O desconto MANUAL segue a política
// `discount.authorizerRoles` (discount-policy.service.ts).
const PARTNER_AUTHORIZER_ROLES = ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];

export class SaleService {
  // Criar venda completa (com itens e movimentações de estoque)
  async createSale(data: {
    companyId: string;
    branchId: string;
    customerId?: string;
    userId: string;
    userType: string;
    cashRegisterId: string;
    items: Array<{
      productId: string;
      quantity: number;
      unitPrice: number;
      discountAmount?: number;
      discountPercent?: number;
      notes?: string;
    }>;
    discountAmount?: number;
    discountPercent?: number;
    notes?: string;
    // Convênio/parceiro selecionado no PDV (ex.: "Posto Santa") — distinto
    // do desconto manual acima. Ver partner.service.ts.
    partnerId?: string;
    // Só necessários quando o desconto excede o limite do operador E a
    // regra permite aprovação (`requiresApproval: true`) — mesmo padrão de
    // `cancelSale`: o autorizador se identifica com as PRÓPRIAS credenciais
    // na mesma chamada. Também usado quando o convênio selecionado exige
    // aprovação (`Partner.requiresApproval`).
    discountAuthorizerNumericId?: number;
    discountAuthorizerPassword?: string;
    discountAuthorizerMfaCode?: string;
    // Motivo do desconto — obrigatório quando o desconto passa o limite livre da política (discount_events).
    discountReason?: string;
  }) {
    // Verificar se o caixa está aberto e pertence à empresa da venda
    const cashRegister = await prisma.cashRegister.findFirst({
      where: {
        id: data.cashRegisterId,
        companyId: data.companyId,
        status: 'OPEN',
      },
    });

    if (!cashRegister) {
      throw new Error('Cash register is not open');
    }

    // O caixa precisa pertencer à MESMA filial da venda — antes desta
    // checagem, um operador da Filial A1 conseguia criar uma venda com
    // branchId=A1 mas cashRegisterId de um caixa da Filial A2 (mesma
    // empresa), afetando o expectedAmount de um caixa de outra filial que
    // não tem relação com a venda (confirmado em teste real: aceito com
    // 201, corrompendo a contabilidade da filial errada).
    if (cashRegister.branchId !== data.branchId) {
      throw new Error('Cash register does not belong to the sale branch');
    }
    assertCanOperateRegister(cashRegister, { userId: data.userId, userType: data.userType, branchId: data.branchId });

    // Calcular subtotal
    let subtotal = 0;
    let grossSubtotal = 0; // soma de quantity*unitPrice, ANTES de qualquer desconto — base para o % do limite de desconto
    let totalItemDiscounts = 0;
    const items: Array<{
      productId: string;
      productName: string;
      productSku: string;
      quantity: number;
      unitPrice: number;
      discountAmount: number;
      discountPercent: number;
      totalPrice: number;
      notes?: string;
    }> = [];

    for (const item of data.items) {
      // Produto precisa pertencer à mesma empresa da venda. Antes desta
      // correção, `findUnique({ where: { id } })` não filtrava por
      // companyId — um usuário da Empresa A podia vender um produto da
      // Empresa B (usando nome/preço/SKU de B) e ainda gerar uma
      // movimentação de estoque referenciando o produto errado.
      const product = await prisma.product.findFirst({
        where: { id: item.productId, companyId: data.companyId },
      });

      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }

      // Produto desativado no cadastro não se vende (o PDV o adicionava ao carrinho por SKU/nome
      // e o servidor aceitava — achado de auditoria).
      if (product.isActive === false) {
        throw new Error(`Product ${product.name} is inactive and cannot be sold`);
      }

      // Verificar estoque
      const stockCheck = await productService.checkStock(
        item.productId,
        data.companyId,
        item.quantity,
        data.branchId
      );

      if (!stockCheck.available) {
        throw new Error(
          `Insufficient stock for product ${product.name}. Available: ${stockCheck.currentStock}, Requested: ${stockCheck.requested}`
        );
      }

      // ACHADO DE AUDITORIA (PRE-PRODUCTION HARDENING): `item.unitPrice`
      // vinha direto do corpo da requisição e era usado sem NENHUMA
      // comparação com `product.salePrice`. Todo o sistema de limite/
      // aprovação de desconto (discount.service.ts, DISCOUNT_AUTHORIZER_ROLES
      // logo abaixo) só governa `discountAmount`/`discountPercent` — um
      // operador sem nenhuma permissão de desconto podia simplesmente
      // informar `unitPrice: 0.01` (com discountAmount: 0) e vender qualquer
      // produto por centavos, contornando por completo a aprovação
      // gerencial, já que o preço em si nunca era validado contra o
      // catálogo. Preço de venda agora SEMPRE vem do produto — o cliente só
      // controla o desconto (que é, esse sim, auditado e limitado abaixo).
      const unitPrice = Number(product.salePrice);

      const itemTotal = item.quantity * unitPrice - (item.discountAmount || 0);
      // Defesa em profundidade (o schema já barra desconto negativo): o desconto de um item não
      // pode superar o valor do próprio item.
      if (itemTotal < 0) {
        throw new Error(`Discount exceeds the item total for product ${product.name}`);
      }
      subtotal += itemTotal;
      grossSubtotal += item.quantity * unitPrice;
      totalItemDiscounts += item.discountAmount || 0;

      items.push({
        productId: item.productId,
        productName: product.name,
        productSku: product.sku,
        quantity: item.quantity,
        unitPrice,
        discountAmount: item.discountAmount || 0,
        // percentual derivado do valor (o do cliente é só informativo e poderia divergir)
        discountPercent: item.quantity * unitPrice > 0 ? round2(((item.discountAmount || 0) / (item.quantity * unitPrice)) * 100) : 0,
        totalPrice: itemTotal,
        notes: item.notes,
      });
    }

    // Convênio/parceiro (ex.: "Posto Santa 10%") — validado e calculado
    // inteiramente a partir do cadastro em banco (partner.service.ts), nunca
    // de um percentual/valor vindo do cliente.
    let partnerDiscountAmount = 0;
    let partnerRequiresApproval = false;
    let partnerName: string | undefined;
    if (data.partnerId) {
      const partnerResult = await partnerService.validateAndComputeDiscount({
        companyId: data.companyId,
        branchId: data.branchId,
        partnerId: data.partnerId,
        grossSubtotal,
      });

      if (!partnerResult.stackable && (totalItemDiscounts > 0 || (data.discountAmount || 0) > 0)) {
        throw new Error(
          `Convênio "${partnerResult.partner.name}" não pode ser combinado com outro desconto nesta venda`
        );
      }

      partnerDiscountAmount = partnerResult.discountAmount;
      partnerRequiresApproval = partnerResult.requiresApproval;
      partnerName = partnerResult.partner.name;
    }

    // Calcular total com desconto geral + convênio
    const totalAmount = subtotal - (data.discountAmount || 0) - partnerDiscountAmount;
    if (totalAmount < 0) {
      throw new Error('Sale total cannot be negative — the discounts exceed the subtotal');
    }

    // Política de desconto (docs/CORTEX/policies/DESCONTO.md): todo item da venda do PDV é produto/peça, então o
    // desconto MANUAL (itens + geral) é comparado com `discount.productFreePercent` sobre o subtotal bruto dos produtos.
    // O convênio (Partner) não é desconto manual: não conta para o limite livre da política, mas continua contando para
    // a regra do papel (DiscountRule), como antes, e mantém a própria exigência de aprovação.
    const generalDiscount = data.discountAmount || 0;
    const securityContext = { companyId: data.companyId, branchId: data.branchId, userId: data.userId };
    const discountEvaluation = await evaluateDiscount({
      companyId: data.companyId,
      branchId: data.branchId,
      userType: data.userType,
      buckets: { PRODUCT: { subtotal: grossSubtotal, discount: totalItemDiscounts + generalDiscount } },
      extraDiscountForRule: partnerDiscountAmount,
      productItemType: 'PRODUCT',
    });
    let discountAuthorizer = await authorizeDiscount(discountEvaluation, {
      companyId: data.companyId,
      requesterId: data.userId,
      reason: data.discountReason,
      authorizerNumericId: data.discountAuthorizerNumericId,
      authorizerPassword: data.discountAuthorizerPassword,
      authorizerMfaCode: data.discountAuthorizerMfaCode,
      actionEvent: 'SALE_DISCOUNT',
      securityContext,
    });
    if (partnerRequiresApproval && !discountAuthorizer) {
      if (!data.discountAuthorizerNumericId || !data.discountAuthorizerPassword) {
        throw new Error(`Convênio "${partnerName}" exige autorização de um Gerente/Admin`);
      }
      discountAuthorizer = await verifyDualAuthorization({
        companyId: data.companyId,
        requesterId: data.userId,
        authorizerNumericId: data.discountAuthorizerNumericId,
        authorizerPassword: data.discountAuthorizerPassword,
        authorizerMfaCode: data.discountAuthorizerMfaCode,
        allowedRoles: PARTNER_AUTHORIZER_ROLES,
        actionEvent: 'SALE_DISCOUNT',
        subjectLabel: 'sale discount',
        securityContext,
      });
    }
    const manualNeededAuthorization = discountEvaluation.requiresAuthorization;
    const productFreeLimit = discountEvaluation.limits.PRODUCT;
    const discountReason = data.discountReason?.trim() || null;

    // Número sequencial da venda: "último número + 1" lido fora da
    // transação (findFirst) sob concorrência real deixa duas vendas
    // simultâneas na mesma filial lerem o mesmo "último número" e ambas
    // tentarem criar com o mesmo saleNumber — a que perde a corrida contra
    // a constraint @@unique([companyId, branchId, saleNumber]) recebia uma
    // exceção crua do Prisma (P2002) devolvida como erro genérico ao
    // cliente, mesmo sendo uma venda legítima (confirmado em teste de
    // carga real: 2 de 5 vendas simultâneas na mesma filial falhavam assim).
    // Sem uma sequence de banco dedicada, o padrão correto para esta
    // constraint é recalcular e tentar de novo quando colide — cada
    // tentativa relê o número mais recente já commitado pela concorrente
    // que venceu, então converge rapidamente sem intervenção do cliente.
    // CORREÇÃO (2026-09-21, mesma da numeração de OS em
    // service-order.service.ts — ver o comentário longo lá): recalcular e
    // tentar de novo NÃO basta. Com o "último número + 1" lido FORA da
    // transação, N vendas simultâneas na mesma filial leem todas o mesmo
    // número, só UMA vence e cada rodada de retry converte ~1-2 perdedoras:
    // o total de sucessos fica limitado pelo número de TENTATIVAS, não pela
    // corretude (medido: 8 de 15 vendas simultâneas falhando, 100% em
    // P2002). Agora ler-e-inserir acontece na MESMA transação, serializado
    // por (companyId, branchId) com um advisory lock de transação
    // (liberado sozinho no COMMIT/ROLLBACK). classid 4202 = numeração de
    // venda, para não bloquear OS/compra/orçamento.
    const MAX_SALE_NUMBER_ATTEMPTS = 5;
    let sale;
    for (let attempt = 1; attempt <= MAX_SALE_NUMBER_ATTEMPTS; attempt++) {
      try {
        sale = await runInTransaction(async (tx) => {
          // `$executeRaw`, não `$queryRaw`: `pg_advisory_xact_lock` retorna
          // `void` e o Prisma falha ao desserializar essa coluna.
          // Primeira instrução da transação, ANTES de qualquer lock de
          // linha (`products ... FOR UPDATE` mais abaixo) — a ordem de
          // aquisição é sempre a mesma em todas as vendas, então não há
          // ciclo de deadlock possível entre as duas travas.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4202, hashtext(${`${data.companyId}:${data.branchId}`}))`;

          const lastSale = await tx.sale.findFirst({
            where: {
              companyId: data.companyId,
              branchId: data.branchId,
            },
            orderBy: { saleNumber: 'desc' },
            select: { saleNumber: true },
          });
          const saleNumber = (lastSale?.saleNumber || 0) + 1;

          // Criar venda
          const newSale = await tx.sale.create({
            data: {
              companyId: data.companyId,
              branchId: data.branchId,
              saleNumber,
              customerId: data.customerId,
              userId: data.userId,
              cashRegisterId: data.cashRegisterId,
              status: 'PENDING',
              subtotal,
              discountAmount: data.discountAmount || 0,
              discountPercent: subtotal > 0 ? round2(((data.discountAmount || 0) / subtotal) * 100) : 0,
              partnerId: data.partnerId,
              partnerDiscountAmount,
              totalAmount,
              paidAmount: 0,
              changeAmount: 0,
              notes: data.notes,
              items: {
                create: items,
              },
            },
            include: {
              items: true,
              customer: true,
            },
          });

          // Evidência de TODO desconto (inclusive dentro do limite livre), item a item, na mesma transação da venda.
          const unusedItems = [...newSale.items];
          const discountEvents: DiscountEventInput[] = [];
          const eventBase = {
            companyId: data.companyId,
            branchId: data.branchId,
            saleId: newSale.id,
            freeLimitPercent: productFreeLimit,
            requestedBy: data.userId,
          };
          for (const line of items) {
            if (!(line.discountAmount > 0)) continue;
            const idx = unusedItems.findIndex((i) => i.productId === line.productId && Number(i.discountAmount) === line.discountAmount);
            const saleItem = idx >= 0 ? unusedItems.splice(idx, 1)[0] : undefined;
            discountEvents.push({
              ...eventBase,
              itemRef: saleItem?.id ?? line.productId,
              itemType: 'PRODUCT',
              description: `${line.productName} (${line.quantity} × ${line.unitPrice.toFixed(2)})`,
              originalAmount: line.quantity * line.unitPrice,
              discountAmount: line.discountAmount,
              requiredAuthorization: manualNeededAuthorization,
              authorizedBy: manualNeededAuthorization ? discountAuthorizer?.id : null,
              reason: discountReason,
            });
          }
          if (generalDiscount > 0) {
            discountEvents.push({
              ...eventBase,
              itemType: 'ORDER',
              description: `Desconto geral da venda #${saleNumber}`,
              originalAmount: subtotal,
              discountAmount: generalDiscount,
              requiredAuthorization: manualNeededAuthorization,
              authorizedBy: manualNeededAuthorization ? discountAuthorizer?.id : null,
              reason: discountReason,
            });
          }
          if (partnerDiscountAmount > 0) {
            discountEvents.push({
              ...eventBase,
              itemRef: data.partnerId ?? null,
              itemType: 'ORDER',
              description: `Convênio ${partnerName ?? ''}`.trim(),
              originalAmount: subtotal - generalDiscount,
              discountAmount: partnerDiscountAmount,
              requiredAuthorization: partnerRequiresApproval,
              authorizedBy: partnerRequiresApproval ? discountAuthorizer?.id : null,
              reason: discountReason ?? 'Convênio cadastrado',
            });
          }
          await recordDiscountEvents(tx, discountEvents);

          // Criar movimentações de estoque
          //
          // ACHADO DE TESTE DE CONCORRÊNCIA REAL (não simulado): duas vendas
          // simultâneas da última unidade de um produto com
          // allowNegativeStock=false AMBAS foram aprovadas e o saldo foi a
          // -1. Causa: o checkStock() lá em cima roda ANTES desta
          // transação, então duas requisições concorrentes o executam
          // contra o mesmo saldo ainda não commitado — clássico
          // check-then-act sem atomicidade. `SELECT ... FOR UPDATE` na
          // linha do produto serializa as duas transações concorrentes
          // (a segunda bloqueia até a primeira commitar/reverter); só
          // depois disso relemos o saldo — agora já refletindo a
          // movimentação da primeira — e só então decidimos se ainda cabe
          // esta venda. checkStock() acima continua útil como fail-fast
          // otimista (evita gastar trabalho com desconto/convênio/dupla
          // autorização numa venda que provavelmente vai falhar mesmo),
          // mas só esta checagem aqui dentro é a que realmente impede a
          // corrida — reprovar aqui reverte a transação inteira (a venda
          // em si também não é criada).
          // ORDEM FIXA DE TRAVA (por id do produto): duas vendas com os mesmos produtos em ordem oposta (A: p1,p2 × B: p2,p1) travavam as
          // linhas em ordem de chegada e podiam esperar uma pela outra (deadlock). Percorrendo sempre por id, nunca há ciclo. É a mesma
          // regra que a OS já usava em `transitionStatus` e que o aceite/conversão de pedido externo usa.
          const lockOrder = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
          for (const item of lockOrder) {
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${item.productId} FOR UPDATE`;

            const product = await tx.product.findUnique({
              where: { id: item.productId },
              select: { allowNegativeStock: true, name: true },
            });
            if (!product?.allowNegativeStock) {
              const { balance } = await stockService.getBalance(item.productId, data.companyId, data.branchId, tx);
              // Disponível = saldo − reservas vivas de pedidos externos: o balcão não vende o que já foi prometido a um canal.
              const reserved = await reservedFor(tx, { companyId: data.companyId, branchId: data.branchId, productId: item.productId });
              if (balance - reserved < item.quantity) {
                throw new Error(
                  `Insufficient stock for product ${product?.name ?? item.productId}. Available: ${balance - reserved}, Requested: ${item.quantity}`
                );
              }
            }

            await tx.stockMovement.create({
              data: {
                companyId: data.companyId,
                branchId: data.branchId,
                productId: item.productId,
                movementType: 'SALE',
                quantity: -item.quantity, // Negativo para saída
                referenceType: 'Sale',
                referenceId: newSale.id,
                userId: data.userId,
              },
            });
          }

          return newSale;
        });
        break;
      } catch (error) {
        // NÃO usar `error.meta.target` para decidir se é o conflito de
        // saleNumber: quando a query passa pela extensão de RLS (ver
        // packages/database/index.ts), CADA operação é executada dentro de
        // um `base.$transaction([...])` em forma de ARRAY (batched), e
        // quando um P2002 estoura ali dentro, o Prisma não consegue mais
        // popular `meta.target` — vem sempre `null`, mesmo para uma
        // constraint normal do schema (confirmado em teste real e
        // reproduzido isoladamente: idêntico em qualquer model, não é
        // específico de `sales`). Isso é o client de PRODUÇÃO de verdade —
        // toda venda real passa por aqui — então checar `targetText.
        // includes('saleNumber')` fazia esta função nunca re-tentar de
        // verdade: o PRIMEIRO conflito de concorrência já lançava o erro
        // cru pro cliente (confirmado com teste de carga real: 5 de 12
        // vendas simultâneas na mesma filial falhavam com "Unique
        // constraint failed on the (not available)"). `tx.sale.create()`
        // só tem UMA constraint única além da PK
        // (`@@unique([companyId, branchId, saleNumber])`), então qualquer
        // P2002 aqui só pode ser ela — mesmo padrão (sem depender de
        // `meta.target`) já usado em transfer/quote/inventory.service.ts.
        const isSaleNumberConflict =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

        if (!isSaleNumberConflict) {
          throw error;
        }
        if (attempt === MAX_SALE_NUMBER_ATTEMPTS) {
          // Contenção extrema (muitas vendas concorrentes na mesma filial
          // esgotando todas as tentativas) — nunca vaza o erro cru do
          // Prisma pro cliente (mensagem de stack trace interna, sem
          // nenhuma ação clara). Confirmado em teste de carga real: 15
          // vendas simultâneas na mesma filial, 2 esgotaram as 5
          // tentativas.
          throw new Error('Sistema com alta concorrência no momento — tente finalizar a venda novamente em instantes');
        }
        // Concorrente venceu a corrida por este número — tenta de novo com
        // o próximo número, agora já refletindo o que ela acabou de commitar.
        // Jitter aleatório evita que várias requisições que colidiram no
        // mesmo instante recalculem e colidam de novo em lockstep sob
        // concorrência muito alta (ex.: 10 vendas simultâneas na mesma
        // filial — observado sem o jitter).
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
      }
    }

    // Ver nota em stock.service.ts: escritas diretas no ledger de estoque
    // (fora de stockService.createMovement) não invalidam automaticamente
    // o cache de saldo — precisa fazer explicitamente aqui.
    await Promise.all(items.map((item) => cacheService.invalidate(`product:${item.productId}:stock*`)));

    return sale;
  }

  // Listar vendas com filtros
  async listSales(filters: {
    companyId: string;
    branchId?: string;
    customerId?: string;
    userId?: string;
    cashRegisterId?: string;
    status?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      companyId,
      branchId,
      customerId,
      userId,
      cashRegisterId,
      status,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = filters;

    // Busca da tela de vendas: número da venda (Int — só igualdade; aceita o
    // "#" que a tela exibe) OU parte do nome do cliente. Até 9 dígitos para
    // caber num Int do Postgres.
    const term = search?.trim().replace(/^#/, '').trim();
    const searchFilter: Prisma.SaleWhereInput | undefined = term
      ? {
          OR: [
            ...(/^\d{1,9}$/.test(term) ? [{ saleNumber: Number(term) }] : []),
            { customer: { is: { name: { contains: term, mode: 'insensitive' as const } } } },
          ],
        }
      : undefined;

    const where: Prisma.SaleWhereInput = {
      companyId,
      ...searchFilter,
      ...(branchId && { branchId }),
      ...(customerId && { customerId }),
      ...(userId && { userId }),
      ...(cashRegisterId && { cashRegisterId }),
      ...(status && { status: status as any }),
      ...(startDate || endDate
        ? {
            saleDate: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }
        : {}),
    };

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        include: {
          customer: true,
          items: {
            include: {
              product: true,
            },
          },
          payments: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { saleDate: 'desc' },
      }),
      prisma.sale.count({ where }),
    ]);

    return {
      sales,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Buscar venda por ID
  async getSaleById(id: string, companyId: string) {
    return await prisma.sale.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        // Vendedor: a tela de detalhe do admin-web mostra quem vendeu, mas a
        // API nunca devolvia `user` (o card ficava vazio). Só id/nome.
        user: { select: { id: true, name: true } },
        items: {
          include: {
            product: true,
          },
        },
        payments: true,
      },
    });
  }

  /**
   * Cancelar venda já finalizada — operação SENSÍVEL, exige dupla
   * autorização (mesmo padrão de CashRegisterService.requestWithdrawal):
   * um segundo usuário (gerência para cima) precisa se autenticar com as
   * próprias credenciais + MFA (se habilitado) para aprovar. O solicitante
   * nunca pode ser o próprio autorizador. Isso vale para TODA venda já
   * criada (não só as pagas em dinheiro) porque `createSale` já baixa
   * estoque de imediato — cancelar sempre reverte um efeito real, não uma
   * operação de rascunho. Alterar quantidade/remover item ANTES de criar a
   * venda (carrinho em montagem) é responsabilidade só do frontend/cart
   * store — nunca chega a este método, então não precisa e não tem essa
   * exigência.
   *
   * Nunca faz DELETE: a venda permanece no histórico com status CANCELLED.
   */
  async cancelSale(data: {
    id: string;
    companyId: string;
    branchId?: string | null;
    requesterId: string;
    reason: string;
    authorizerNumericId: number;
    authorizerPassword: string;
    authorizerMfaCode?: string;
    requestId?: string;
    device?: string;
  }) {
    const sale = await this.getSaleById(data.id, data.companyId);

    if (!sale) {
      throw new Error('Sale not found');
    }
    if (sale.status === 'CANCELLED') {
      throw new Error('Sale already cancelled');
    }
    if (sale.status === 'RETURNED') {
      throw new Error('Sale already returned');
    }
    if (!data.reason || data.reason.trim().length < 3) {
      throw new Error('Reason is required (minimum 3 characters)');
    }

    const securityContext = {
      requestId: data.requestId,
      companyId: data.companyId,
      branchId: data.branchId ?? sale.branchId ?? undefined,
      userId: data.requesterId,
      device: data.device,
    };

    const authorizer = await verifyDualAuthorization({
      companyId: data.companyId,
      requesterId: data.requesterId,
      authorizerNumericId: data.authorizerNumericId,
      authorizerPassword: data.authorizerPassword,
      authorizerMfaCode: data.authorizerMfaCode,
      allowedRoles: SALE_REVERSAL_AUTHORIZER_ROLES,
      actionEvent: 'SALE_CANCELLATION',
      subjectLabel: 'sale cancellation',
      securityContext,
    });

    // Total efetivamente aprovado (dinheiro/cartão/PIX já confirmado) —
    // é isso que precisa ser estornado do caixa, não o total da venda.
    const approvedTotal = sale.payments
      .filter((p) => p.status === 'APPROVED')
      .reduce((sum, p) => sum + Number(p.amount), 0);

    const result = await runInTransaction(async (tx) => {
      // Guarda atômica contra cancelamento concorrente da mesma venda: o
      // `getSaleById` acima roda ANTES da transação (TOCTOU clássico) — sob
      // concorrência real, duas requisições passam por aquele check ao
      // mesmo tempo e ambas tentariam reverter estoque/caixa, duplicando o
      // estorno financeiro (confirmado em teste de carga: 3 cancelamentos
      // simultâneos geraram 3x CashMovement/StockMovement para a mesma
      // venda). `updateMany` com o status re-checado dentro da transação
      // faz a segunda transação, ao adquirir o lock de linha, reavaliar o
      // WHERE contra o status já commitado pela primeira — 0 linhas
      // afetadas, e todo o resto do bloco (estoque/pagamento/caixa) é
      // pulado por causa do throw abaixo, revertendo a transação inteira.
      const cancelUpdate = await tx.sale.updateMany({
        where: { id: data.id, status: { notIn: ['CANCELLED', 'RETURNED'] } },
        data: {
          status: 'CANCELLED',
          cancelReason: data.reason,
          cancelledAt: new Date(),
          cancelledBy: data.requesterId,
        },
      });

      if (cancelUpdate.count === 0) {
        throw new Error('Sale already cancelled');
      }

      const updatedSale = await tx.sale.findUniqueOrThrow({
        where: { id: data.id },
        include: { items: true, payments: true },
      });

      // Só o que ainda não voltou: uma devolução parcial anterior já repôs `returnedQuantity` e já estornou o
      // valor desses itens. Itens relidos DEPOIS do lock de status acima (não os de antes da transação).
      const refundAmount = round2(Math.max(0, approvedTotal - refundedValue(updatedSale.items, approvedTotal)));

      for (const item of updatedSale.items) {
        const remaining = Number(item.quantity) - Number(item.returnedQuantity);
        if (remaining <= 0) continue;
        await tx.stockMovement.create({
          data: {
            companyId: sale.companyId,
            branchId: sale.branchId,
            productId: item.productId,
            movementType: 'RETURN',
            quantity: remaining, // Positivo para entrada
            referenceType: 'SaleCancellation',
            referenceId: sale.id,
            notes: `Cancelamento autorizado por ${authorizer.name}: ${data.reason}`,
            userId: data.requesterId,
          },
        });
      }

      // Pagamentos que nunca chegaram a ser aprovados: CANCELLED.
      // Pagamentos que JÁ aprovaram (dinheiro/cartão/PIX confirmado): o
      // status correto é REFUNDED — é dinheiro que entrou e está sendo
      // devolvido, uma situação diferente (e mais grave) de um pagamento
      // que simplesmente nunca se completou.
      await tx.payment.updateMany({
        where: { saleId: data.id, status: { not: 'APPROVED' } },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await tx.payment.updateMany({
        where: { saleId: data.id, status: 'APPROVED' },
        data: { status: 'REFUNDED', refundedAt: new Date() },
      });
      // Convênio: parcelas em folha não processadas e conta a receber em aberto → canceladas (agreement-effects.ts).
      const agreementPayments = agreementPaymentIds(updatedSale.payments);
      if (agreementPayments.length) {
        await reverseAgreementEffects(tx, { paymentIds: agreementPayments }, data.requesterId, `venda #${sale.saleNumber} cancelada: ${data.reason}`);
      }

      // Estorno no caixa: todo pagamento aprovado já somou ao
      // expectedAmount do caixa no momento da aprovação (ver
      // PaymentService.applyApprovedPaymentEffects) — cancelar a venda
      // precisa subtrair de volta o mesmo total, senão o caixa fica
      // permanentemente inflado (exatamente o cenário de fraude que esta
      // funcionalidade existe para impedir: vender, receber, cancelar
      // depois e o caixa nunca refletir a saída do dinheiro). Só ajusta um
      // caixa ainda ABERTO — um caixa já fechado é imutável por regra (ver
      // closeCashRegister); estornar uma venda de um turno já encerrado é
      // um ajuste manual em um caixa aberto posterior, não uma reescrita
      // de um fechamento já confirmado.
      let cashAdjusted = false;
      if (refundAmount > 0 && sale.cashRegisterId) {
        const register = await tx.cashRegister.findUnique({ where: { id: sale.cashRegisterId } });
        if (register && register.status === 'OPEN') {
          await tx.cashMovement.create({
            data: {
              cashRegisterId: sale.cashRegisterId,
              movementType: 'CANCELLATION',
              amount: refundAmount,
              referenceType: 'SaleCancellation',
              referenceId: sale.id,
              notes: `Estorno da venda #${sale.saleNumber} — ${data.reason}`,
              userId: data.requesterId,
              requestedBy: data.requesterId,
              authorizedBy: authorizer.id,
            },
          });
          await tx.cashRegister.update({
            where: { id: sale.cashRegisterId },
            data: { expectedAmount: { decrement: refundAmount } },
          });
          cashAdjusted = true;
        }
      }

      return { sale: updatedSale, cashAdjusted, refundAmount };
    });

    await Promise.all(sale.items.map((item) => cacheService.invalidate(`product:${item.productId}:stock*`)));

    Logger.security(
      'SALE_CANCELLATION_COMPLETED',
      `Venda #${sale.saleNumber} cancelada` +
        (result.refundAmount > 0
          ? ` — R$ ${result.refundAmount.toFixed(2)} ${result.cashAdjusted ? 'estornado no caixa' : 'NÃO estornado (caixa já fechado — requer ajuste manual)'}`
          : ''),
      { ...securityContext, saleId: sale.id, authorizerId: authorizer.id, amount: result.refundAmount }
    );

    return {
      ...result.sale,
      cashAdjusted: result.cashAdjusted,
      authorizer: { id: authorizer.id, name: authorizer.name },
    };
  }

  // Devolver venda (total ou parcial)
  //
  // ACHADO DE AUDITORIA: esta operação faz o MESMO estorno financeiro que
  // cancelSale (marca pagamento aprovado como REFUNDED, lança CashMovement
  // decrementando expectedAmount do caixa) mas, diferente de cancelSale,
  // não exigia NENHUMA autorização além de estar autenticado no tenant —
  // até VIEWER (papel só-leitura) conseguia processar um reembolso real em
  // qualquer venda. Corrigido para exigir a mesma dupla autorização já
  // estabelecida para cancelSale (SALE_REVERSAL_AUTHORIZER_ROLES).
  async returnSale(data: {
    id: string;
    companyId: string;
    branchId?: string | null;
    requesterId: string;
    reason: string;
    items?: Array<{ saleItemId: string; quantity: number }>;
    authorizerNumericId: number;
    authorizerPassword: string;
    authorizerMfaCode?: string;
    requestId?: string;
    device?: string;
  }) {
    const { id, companyId, items } = data;
    const userId = data.requesterId;
    const reason = data.reason;
    const sale = await this.getSaleById(id, companyId);

    if (!sale) {
      throw new Error('Sale not found');
    }

    if (sale.status === 'CANCELLED') {
      throw new Error('Cannot return a cancelled sale');
    }
    if (!reason || reason.trim().length < 3) {
      throw new Error('Reason is required (minimum 3 characters)');
    }

    const securityContext = {
      requestId: data.requestId,
      companyId,
      branchId: data.branchId ?? sale.branchId ?? undefined,
      userId,
      device: data.device,
    };

    const authorizer = await verifyDualAuthorization({
      companyId,
      requesterId: userId,
      authorizerNumericId: data.authorizerNumericId,
      authorizerPassword: data.authorizerPassword,
      authorizerMfaCode: data.authorizerMfaCode,
      allowedRoles: SALE_REVERSAL_AUTHORIZER_ROLES,
      actionEvent: 'SALE_RETURN',
      subjectLabel: 'sale return',
      securityContext,
    });

    // Devolução total (omitindo `items`) ou parcial (informando quais itens
    // e quantas unidades). Sem `items`, devolve o que ainda resta de cada
    // item (não necessariamente a quantidade original — a venda pode já
    // ter tido uma devolução parcial anterior).
    const itemsToReturn =
      items ||
      sale.items
        .map((item) => ({
          saleItemId: item.id,
          quantity: Number(item.quantity) - Number(item.returnedQuantity),
        }))
        .filter((item) => item.quantity > 0);

    if (itemsToReturn.length === 0) {
      throw new Error('Nothing left to return on this sale');
    }

    const result = await runInTransaction(async (tx) => {
      // Trava a venda (mesma linha que cancelSale atualiza): devolução e cancelamento concorrentes serializam, e
      // uma venda cancelada/devolvida entre a leitura acima e aqui não é devolvida de novo.
      const locked = await tx.sale.updateMany({
        where: { id, status: { notIn: ['CANCELLED', 'RETURNED'] } },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        throw new Error('Cannot return a cancelled or already returned sale');
      }


      for (const returnItem of itemsToReturn) {
        const saleItem = sale.items.find((item) => item.id === returnItem.saleItemId);

        if (!saleItem) {
          throw new Error(`Sale item ${returnItem.saleItemId} not found`);
        }
        if (returnItem.quantity <= 0) {
          throw new Error(`Return quantity must be positive for item ${saleItem.productName}`);
        }

        const alreadyReturned = Number(saleItem.returnedQuantity);
        const remaining = Number(saleItem.quantity) - alreadyReturned;
        if (returnItem.quantity > remaining) {
          throw new Error(
            `Return quantity exceeds remaining sold quantity for item ${saleItem.productName} (already returned: ${alreadyReturned}, remaining: ${remaining})`
          );
        }

        // Guarda atômica contra devolução concorrente do MESMO item: o
        // `sale.items` acima foi lido ANTES da transação (TOCTOU) — sob
        // concorrência real, duas devoluções parciais do mesmo item
        // liam o mesmo `returnedQuantity` e ambas passariam na checagem
        // acima, devolvendo mais unidades do que restam. `updateMany` com
        // `returnedQuantity: { lte: maxPriorAllowed }` reavalia contra o
        // valor já commitado ao adquirir o lock de linha — a segunda
        // tentativa concorrente afeta 0 linhas.
        const maxPriorAllowed = Number(saleItem.quantity) - returnItem.quantity;
        const itemUpdate = await tx.saleItem.updateMany({
          where: { id: saleItem.id, returnedQuantity: { lte: maxPriorAllowed } },
          data: { returnedQuantity: { increment: returnItem.quantity } },
        });
        if (itemUpdate.count === 0) {
          throw new Error(`Concurrent return detected for item ${saleItem.productName} — try again`);
        }


        await tx.stockMovement.create({
          data: {
            companyId: sale.companyId,
            branchId: sale.branchId,
            productId: saleItem.productId,
            movementType: 'RETURN',
            quantity: returnItem.quantity,
            referenceType: 'SaleReturn',
            referenceId: sale.id,
            notes: `Devolução: ${reason}`,
            userId,
          },
        });
      }

      const refreshedItems = await tx.saleItem.findMany({ where: { saleId: id } });
      const fullyReturned = refreshedItems.every((item) => Number(item.returnedQuantity) >= Number(item.quantity));

      // Estorno financeiro: pagamentos só são marcados REFUNDED quando a
      // venda fica totalmente devolvida — não existe hoje rastreio de
      // quanto de CADA pagamento já foi estornado (o schema Payment não
      // tem um valor de reembolso parcial), então marcar um pagamento como
      // REFUNDED numa devolução parcial fingiria uma certeza que o sistema
      // não tem. Para devolução parcial, o efeito financeiro real é
      // refletido no caixa (abaixo), proporcional ao valor devolvido —
      // nunca inventa um estorno de pagamento que não pode confirmar.
      if (fullyReturned) {
        await tx.payment.updateMany({
          where: { saleId: id, status: 'APPROVED' },
          data: { status: 'REFUNDED', refundedAt: new Date() },
        });
      }

      // Estorno proporcional no caixa (mesmo princípio de cancelSale): só
      // se havia pagamento aprovado e o caixa da venda ainda está aberto.
      const approvedTotal = sale.payments.filter((p) => p.status === 'APPROVED').reduce((sum, p) => sum + Number(p.amount), 0);
      let cashAdjusted = false;
      // Teto CUMULATIVO: o que já foi estornado por devoluções anteriores (valor dos itens já devolvidos) sai do
      // total pago. Sem isso, numa venda com desconto, duas devoluções parciais estornavam mais que o pago.
      const thisReturn = new Map(itemsToReturn.map((i) => [i.saleItemId, i.quantity]));
      const itemsBefore = refreshedItems.map((i) => ({ ...i, returnedQuantity: Number(i.returnedQuantity) - (thisReturn.get(i.id) ?? 0) }));
      const adjustAmount = round2(refundedValue(refreshedItems, approvedTotal) - refundedValue(itemsBefore, approvedTotal));
      if (adjustAmount > 0 && sale.cashRegisterId) {
        const register = await tx.cashRegister.findUnique({ where: { id: sale.cashRegisterId } });
        if (register && register.status === 'OPEN') {
          await tx.cashMovement.create({
            data: {
              cashRegisterId: sale.cashRegisterId,
              movementType: 'RETURN',
              amount: adjustAmount,
              referenceType: 'SaleReturn',
              referenceId: sale.id,
              notes: `Devolução da venda #${sale.saleNumber} — ${reason}`,
              userId,
              requestedBy: userId,
              authorizedBy: authorizer.id,
            },
          });
          await tx.cashRegister.update({
            where: { id: sale.cashRegisterId },
            data: { expectedAmount: { decrement: adjustAmount } },
          });
          cashAdjusted = true;
        }
      }

      const updatedSale = await tx.sale.update({
        where: { id },
        data: fullyReturned
          ? { status: 'RETURNED', cancelReason: reason, cancelledAt: new Date(), cancelledBy: userId }
          : {},
        include: { items: true, payments: true },
      });

      // Convênio (devolução total): mesmo efeito do cancelamento (agreement-effects.ts), com os pagamentos relidos na
      // transação. Devolução PARCIAL de venda de convênio: [DECISÃO NECESSÁRIA] — nada é alterado no convênio.
      const agreementPayments = fullyReturned ? agreementPaymentIds(updatedSale.payments) : [];
      if (agreementPayments.length) {
        await reverseAgreementEffects(tx, { paymentIds: agreementPayments }, userId, `venda #${sale.saleNumber} devolvida: ${reason}`);
      }

      return { sale: updatedSale, cashAdjusted, fullyReturned };
    });

    await Promise.all(
      itemsToReturn.map((item) => {
        const saleItem = sale.items.find((i) => i.id === item.saleItemId);
        return saleItem ? cacheService.invalidate(`product:${saleItem.productId}:stock*`) : Promise.resolve();
      })
    );

    Logger.security(
      'SALE_RETURN_COMPLETED',
      `Venda #${sale.saleNumber}: devolução ${result.fullyReturned ? 'total' : 'parcial'} — ${reason}`,
      { ...securityContext, saleId: sale.id, authorizerId: authorizer.id, fullyReturned: result.fullyReturned, cashAdjusted: result.cashAdjusted }
    );

    return {
      ...result.sale,
      cashAdjusted: result.cashAdjusted,
      authorizer: { id: authorizer.id, name: authorizer.name },
    };
  }

  // Estatísticas de vendas
  //
  // ACHADO DE AUDITORIA: esta função buscava TODAS as vendas PAID/
  // PARTIALLY_PAID da empresa via `findMany` (sem `take`/`skip` — sem sequer
  // um período padrão quando nenhuma data é informada, e a tela de vendas do
  // Admin Web chama `getSalesStats()` sem nenhum parâmetro), com `items` e
  // `payments` incluídos, só para somar/contar em JavaScript depois. Mesmo
  // padrão do bug já corrigido em GET /users e no device list do Super Admin
  // — só que aqui era pior: paginar não faz sentido para uma estatística
  // agregada (o total tem que ser de TODAS as vendas do período, não de uma
  // página), então a correção certa não é paginar e sim deixar o Postgres
  // agregar (aggregate/count/groupBy), sem nunca materializar as linhas
  // inteiras (com relations aninhadas) na memória do Node.
  async getSalesStats(companyId: string, branchId?: string, startDate?: string, endDate?: string) {
    const where: Prisma.SaleWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      status: { in: ['PAID', 'PARTIALLY_PAID'] },
      ...(startDate || endDate
        ? {
            saleDate: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }
        : {}),
    };

    const [saleAggregate, totalItems, paymentMethods] = await Promise.all([
      prisma.sale.aggregate({
        where,
        _count: true,
        _sum: { totalAmount: true },
      }),
      // Conta linhas de item (não quantidade) — equivalente exato ao antigo
      // `sales.reduce((acc, sale) => acc + sale.items.length, 0)`, sem
      // precisar buscar as vendas nem os itens em si.
      prisma.saleItem.count({ where: { sale: where } }),
      // Vendas por forma de pagamento (já usava groupBy — inalterado)
      prisma.payment.groupBy({
        by: ['paymentMethod'],
        where: {
          sale: where,
          status: 'APPROVED',
        },
        _sum: {
          amount: true,
        },
        _count: true,
      }),
    ]);

    const totalSales = saleAggregate._count;
    const totalRevenue = Number(saleAggregate._sum.totalAmount || 0);
    const avgTicket = totalSales > 0 ? totalRevenue / totalSales : 0;

    return {
      totalSales,
      totalRevenue,
      totalItems,
      avgTicket,
      paymentMethods: paymentMethods.map(pm => ({
        method: pm.paymentMethod,
        total: Number(pm._sum.amount || 0),
        count: pm._count,
      })),
    };
  }
}

export default new SaleService();
