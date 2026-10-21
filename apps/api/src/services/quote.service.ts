import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { AppError, ConflictError } from '@ln-system/shared';
import { policyService } from './policy.service';

/**
 * Ciclo de vida do orçamento (docs/CORTEX/policies/ORCAMENTO.md):
 * ORÇAMENTO (DRAFT) → AGUARDANDO APROVAÇÃO (SENT) → APROVADO → ORDEM DE SERVIÇO (CONVERTED).
 *
 * Sem resposta do cliente por `quote.expirationDays` dias (contados do último envio ou da última reabertura), o
 * orçamento SENT fica "vencido": pode ser encerrado manualmente (em lote, com motivo — evento CLOSED) ou, com
 * `quote.autoExpire`, pela rotina diária (evento EXPIRED, performedBy 'SYSTEM'). Encerrado = status EXPIRED. Nada é
 * apagado: `quote_events` guarda cada encerramento/reabertura. `quote.allowReopen` permite reabrir (EXPIRED → SENT).
 */

/** Orçamento "em aberto" para fins de duplicidade: ainda pode virar OS sem criar outro. */
export const QUOTE_OPEN_STATUSES = ['DRAFT', 'SENT', 'APPROVED'] as const;
/** Só estes podem ser encerrados (APPROVED espera a OS; REJECTED/CONVERTED já têm decisão). */
export const QUOTE_CLOSABLE_STATUSES = ['DRAFT', 'SENT'] as const;
export const QUOTE_SYSTEM_ACTOR = 'SYSTEM';
const REASON_MIN = 5;
const MAX_CLOSE_BATCH = 100;
const DAY_MS = 86_400_000;
/** Janela de "encerrados recentes" mostrados na tela de novo orçamento. */
const RELATED_CLOSED_WINDOW_DAYS = 180;

/** Conflito com dados extras para a tela (ex.: o id do orçamento que já existe). */
export class QuoteConflictError extends ConflictError {
  constructor(message: string, code: string, public details: Record<string, unknown>) {
    super(message, code);
    this.name = 'QuoteConflictError';
    Object.setPrototypeOf(this, QuoteConflictError.prototype);
  }
}

/**
 * SENT sem resposta desde `cutoff`: nenhuma versão enviada depois do corte e nenhuma reabertura depois do corte. A
 * reabertura reinicia a contagem sem reescrever o `sentAt` (a data real do envio é histórico).
 */
function overdueWhere(cutoff: Date): Prisma.QuoteWhereInput {
  return {
    status: 'SENT',
    versions: { none: { sentAt: { gt: cutoff } } },
    events: { none: { eventType: 'REOPENED', createdAt: { gt: cutoff } } },
  };
}

const cutoffFor = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

function assertReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < REASON_MIN) throw new AppError(`Informe o motivo (mínimo ${REASON_MIN} caracteres)`, 400, 'REASON_REQUIRED');
  return text;
}

function assertNotClosed(status: string) {
  if (status === 'EXPIRED') {
    throw new ConflictError('Orçamento encerrado — reabra o orçamento antes de continuar', 'QUOTE_CLOSED');
  }
}

type QuoteItemInput = {
  itemType: 'SERVICE' | 'PART';
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

/**
 * Calcula os totais (laborTotal/partsTotal/totalAmount) e o shape dos itens
 * já com totalPrice calculado, a partir de uma lista bruta de itens. Usado
 * tanto na criação do orçamento quanto na criação de novas versões — os dois
 * pontos precisam somar exatamente da mesma forma.
 */
// Limites do schema: quantity Decimal(10,3), unitPrice/totalPrice/totalAmount
// Decimal(10,2). Acima disso o Postgres estoura com um erro cru do Prisma.
const MAX_QUANTITY = 9_999_999;
const MAX_MONEY = 99_999_999.99;

/**
 * ACHADO DE AUDITORIA: nada validava os itens — a UI (e qualquer cliente da
 * API) podia enviar quantidade 0/negativa/NaN, preço negativo, descrição
 * vazia ou um itemType inválido, e o total (que vira o valor da OS na
 * conversão) saía absurdo ou o Prisma respondia com um erro cru. Validado
 * aqui, no único ponto que soma os valores, para criação e nova versão.
 */
function assertValidItems(items: QuoteItemInput[]) {
  items.forEach((item, index) => {
    const label = `Item ${index + 1}`;
    if (item?.itemType !== 'SERVICE' && item?.itemType !== 'PART') {
      throw new Error(`${label}: itemType must be SERVICE or PART`);
    }
    if (typeof item.description !== 'string' || item.description.trim() === '') {
      throw new Error(`${label}: description is required`);
    }
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error(`${label}: quantity must be a number greater than zero`);
    }
    if (typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      throw new Error(`${label}: unitPrice must be a number greater than or equal to zero`);
    }
    if (item.quantity > MAX_QUANTITY || item.unitPrice > MAX_MONEY || item.quantity * item.unitPrice > MAX_MONEY) {
      throw new Error(`${label}: value exceeds the supported limit`);
    }
  });

  const total = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  if (total > MAX_MONEY) {
    throw new Error('Quote total exceeds the supported limit');
  }
}

// QuoteItem.productId é um `String?` solto (sem FK) — sem esta checagem, um
// productId de outra empresa (ou inexistente) era aceito e seguia para a OS
// gerada na conversão. Mesma classe já corrigida em purchase-order.service.
async function assertProductsBelongToCompany(items: QuoteItemInput[], companyId: string) {
  const productIds = [...new Set(items.map((i) => i.productId).filter((id): id is string => Boolean(id)))];
  if (productIds.length === 0) return;

  const found = await prisma.product.findMany({
    where: { id: { in: productIds }, companyId },
    select: { id: true },
  });
  if (found.length !== productIds.length) {
    throw new Error('One or more products were not found in this company');
  }
}

function computeTotals(items: QuoteItemInput[]) {
  const preparedItems = items.map((i) => ({
    itemType: i.itemType,
    productId: i.productId,
    description: i.description,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    totalPrice: i.quantity * i.unitPrice,
  }));

  const laborTotal = preparedItems.filter((i) => i.itemType === 'SERVICE').reduce((sum, i) => sum + i.totalPrice, 0);
  const partsTotal = preparedItems.filter((i) => i.itemType === 'PART').reduce((sum, i) => sum + i.totalPrice, 0);
  const totalAmount = laborTotal + partsTotal;

  return { preparedItems, laborTotal, partsTotal, totalAmount };
}

export class QuoteService {
  /**
   * Criar orçamento (DRAFT) com a primeira versão (versionNumber 1). Cliente
   * e motocicleta precisam pertencer à mesma empresa, e a motocicleta
   * precisa de fato pertencer ao cliente informado — o caller não é
   * confiável para manter essa consistência sozinho.
   */
  async create(data: {
    companyId: string;
    branchId: string;
    customerId: string;
    motorcycleId: string;
    validUntil?: Date;
    notes?: string;
    createdBy: string;
    items: QuoteItemInput[];
    /** O usuário viu o orçamento em aberto deste veículo e quer mesmo criar outro. */
    confirmNew?: boolean;
  }) {
    if (!data.items || data.items.length === 0) {
      throw new Error('Quote must have at least one item');
    }

    const [customer, motorcycle, branch] = await Promise.all([
      prisma.customer.findFirst({ where: { id: data.customerId, companyId: data.companyId }, select: { id: true } }),
      prisma.motorcycle.findFirst({
        where: { id: data.motorcycleId, companyId: data.companyId },
        select: { id: true, customerId: true },
      }),
      // ACHADO DE AUDITORIA DE INTEGRAÇÃO: Quote.branchId é um `String`
      // solto no schema (sem @relation) — mesma classe de bug já corrigida
      // em stock.service.ts/purchase-order.service.ts. Sem esta checagem,
      // um branchId de outra empresa (ou inválido) era aceito sem erro.
      prisma.branch.findFirst({ where: { id: data.branchId, companyId: data.companyId }, select: { id: true } }),
    ]);

    if (!customer) {
      throw new Error('Customer not found');
    }
    if (!motorcycle) {
      throw new Error('Motorcycle not found');
    }
    if (motorcycle.customerId !== data.customerId) {
      throw new Error('Motorcycle does not belong to this customer');
    }
    if (!branch) {
      throw new Error('Branch not found in this company');
    }

    assertValidItems(data.items);
    await assertProductsBelongToCompany(data.items, data.companyId);

    const { preparedItems, laborTotal, partsTotal, totalAmount } = computeTotals(data.items);

    // Numeração sequencial de quoteNumber, escopada por companyId
    // (@@unique([companyId, quoteNumber])).
    // CORREÇÃO (2026-09-24, achado ao revisar a correção de numeração desta
    // mesma rodada — ver o comentário longo em service-order.service.ts):
    // este ponto ainda usava o padrão antigo de "ler fora da transação +
    // retry em P2002", que é exatamente o padrão medido falhando ~metade
    // das criações concorrentes legítimas (não é flakiness de teste, é a
    // corretude limitada pelo número de tentativas). A conversão de
    // orçamento em OS (mais abaixo, neste mesmo arquivo) e osNumber/
    // saleNumber/poNumber já foram corrigidos com leitura+inserção na MESMA
    // transação, serializada por um advisory lock — aplicando o mesmo
    // padrão aqui. classid 4204 = numeração de orçamento; a chave é só
    // companyId (não companyId:branchId) porque a constraint única também é
    // só por companyId.
    const MAX_QUOTE_NUMBER_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_QUOTE_NUMBER_ATTEMPTS; attempt++) {
      try {
        return await runInTransaction(async (tx) => {
          // `$executeRaw`, não `$queryRaw`: `pg_advisory_xact_lock` retorna
          // `void` e o Prisma falha ao desserializar essa coluna.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4204, hashtext(${data.companyId}))`;

          // Cliente voltou com o mesmo veículo: sem confirmação explícita, não nasce um segundo orçamento em aberto.
          // Checado sob a mesma trava da numeração (e da reabertura): duas criações simultâneas não passam juntas.
          if (!data.confirmNew) {
            const open = await tx.quote.findFirst({
              where: { companyId: data.companyId, motorcycleId: data.motorcycleId, status: { in: [...QUOTE_OPEN_STATUSES] } },
              orderBy: { createdAt: 'desc' },
              select: { id: true, quoteNumber: true, status: true },
            });
            if (open) {
              throw new QuoteConflictError(
                `Já existe um orçamento em aberto para este veículo (#${open.quoteNumber}). Continue o existente ou confirme que quer criar outro.`,
                'OPEN_QUOTE_EXISTS',
                { existingQuoteId: open.id, existingQuoteNumber: open.quoteNumber, existingStatus: open.status }
              );
            }
          }

          const lastQuote = await tx.quote.findFirst({
            where: { companyId: data.companyId },
            orderBy: { quoteNumber: 'desc' },
            select: { quoteNumber: true },
          });
          const quoteNumber = (lastQuote?.quoteNumber || 0) + 1;

          return await tx.quote.create({
            data: {
              companyId: data.companyId,
              branchId: data.branchId,
              customerId: data.customerId,
              motorcycleId: data.motorcycleId,
              quoteNumber,
              status: 'DRAFT',
              validUntil: data.validUntil,
              notes: data.notes,
              createdBy: data.createdBy,
              versions: {
                create: {
                  versionNumber: 1,
                  laborTotal,
                  partsTotal,
                  discountAmount: 0,
                  totalAmount,
                  createdBy: data.createdBy,
                  items: { create: preparedItems },
                },
              },
            },
            include: { versions: { include: { items: true } } },
          });
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        if (attempt === MAX_QUOTE_NUMBER_ATTEMPTS) {
          throw new Error('Failed to generate a unique quote number after multiple attempts');
        }
      }
    }

    throw new Error('Failed to generate a unique quote number after multiple attempts');
  }

  /**
   * Adicionar nova versão a um orçamento já existente. Uma versão enviada ou
   * decidida nunca é reescrita — para "mudar o orçamento" depois de enviado,
   * cria-se uma versão nova, preservando o histórico do que o cliente
   * realmente viu/decidiu.
   */
  async addVersion(
    quoteId: string,
    companyId: string,
    data: {
      validUntil?: Date;
      notes?: string;
      createdBy: string;
      items: QuoteItemInput[];
    }
  ) {
    if (!data.items || data.items.length === 0) {
      throw new Error('Quote version must have at least one item');
    }

    const quote = await prisma.quote.findFirst({ where: { id: quoteId, companyId } });
    if (!quote) {
      throw new Error('Quote not found');
    }
    if (quote.status === 'CONVERTED') {
      throw new Error('Cannot add a new version to a quote that has already been converted into a service order');
    }
    assertNotClosed(quote.status);

    assertValidItems(data.items);
    await assertProductsBelongToCompany(data.items, companyId);

    const { preparedItems, laborTotal, partsTotal, totalAmount } = computeTotals(data.items);

    // Mesmo padrão de retry-em-P2002 do quoteNumber, agora escopado por
    // quoteId (@@unique([quoteId, versionNumber])).
    for (let attempt = 0; attempt < 5; attempt++) {
      const lastVersion = await prisma.quoteVersion.findFirst({
        where: { quoteId },
        orderBy: { versionNumber: 'desc' },
      });
      const versionNumber = (lastVersion?.versionNumber || 0) + 1;

      try {
        return await runInTransaction(async (tx) => {
          const version = await tx.quoteVersion.create({
            data: {
              quoteId,
              versionNumber,
              laborTotal,
              partsTotal,
              discountAmount: 0,
              totalAmount,
              createdBy: data.createdBy,
              items: { create: preparedItems },
            },
            include: { items: true },
          });

          // Uma versão nova é uma proposta fresca e ainda não vista pelo
          // cliente — se o orçamento estava SENT (aguardando decisão de uma
          // versão anterior) ou REJECTED (decisão negativa já registrada),
          // esses status ficariam "mentindo" sobre a versão atual. DRAFT é o
          // único status que reflete corretamente "existe uma versão que
          // ainda não foi enviada/decidida".
          if (quote.status === 'SENT' || quote.status === 'REJECTED') {
            const moved = await tx.quote.updateMany({ where: { id: quoteId, status: { in: ['SENT', 'REJECTED'] } }, data: { status: 'DRAFT' } });
            // Encerrado no meio do caminho: a nova versão não "reabre" o orçamento por fora da reabertura.
            if (moved.count === 0) {
              const current = await tx.quote.findUnique({ where: { id: quoteId }, select: { status: true } });
              if (current) assertNotClosed(current.status);
            }
          }

          return version;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Failed to generate a unique version number after multiple attempts');
  }

  /**
   * Marcar uma versão como enviada ao cliente. Idempotente: reenviar uma
   * versão já enviada não é erro, só não sobrescreve o sentAt original.
   */
  async send(quoteId: string, companyId: string, versionNumber: number) {
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new Error('versionNumber must be a positive integer');
    }

    const quote = await prisma.quote.findFirst({ where: { id: quoteId, companyId } });
    if (!quote) {
      throw new Error('Quote not found');
    }
    if (quote.status === 'CONVERTED') {
      throw new Error('Cannot send a version of a quote that has already been converted into a service order');
    }
    // Encerrado só volta a aguardar o cliente pela reabertura (motivo + evento REOPENED), não por um reenvio.
    assertNotClosed(quote.status);

    const version = await prisma.quoteVersion.findFirst({ where: { quoteId, versionNumber } });
    if (!version) {
      throw new Error('Quote version not found');
    }

    if (version.sentAt) {
      return version;
    }

    return await runInTransaction(async (tx) => {
      const updated = await tx.quoteVersion.update({ where: { id: version.id }, data: { sentAt: new Date() } });
      // Guarda: um encerramento concorrente não é desfeito por este envio.
      const moved = await tx.quote.updateMany({ where: { id: quoteId, status: { not: 'EXPIRED' } }, data: { status: 'SENT' } });
      if (moved.count === 0) assertNotClosed('EXPIRED');
      return updated;
    });
  }

  /**
   * Registrar a decisão do cliente (aprovação ou rejeição) sobre uma versão
   * já enviada. Não existe portal do cliente nesta fase — quem registra a
   * decisão é um funcionário (decidedBy), reportando o que o cliente decidiu
   * por telefone/presencialmente/etc.
   */
  async decide(
    quoteId: string,
    companyId: string,
    data: { versionNumber: number; approved: boolean; decidedBy: string; decisionNotes?: string }
  ) {
    if (!Number.isInteger(data.versionNumber) || data.versionNumber < 1) {
      throw new Error('versionNumber must be a positive integer');
    }
    // `approved` ausente/string vinha como truthy/falsy e gravava uma decisão
    // que ninguém tomou (ex.: "false" aprovava).
    if (typeof data.approved !== 'boolean') {
      throw new Error('approved must be true or false');
    }

    const quote = await prisma.quote.findFirst({ where: { id: quoteId, companyId } });
    if (!quote) {
      throw new Error('Quote not found');
    }
    // Cliente respondeu depois do encerramento: reabre (volta a AGUARDANDO APROVAÇÃO) e então registra a decisão.
    assertNotClosed(quote.status);

    const version = await prisma.quoteVersion.findFirst({ where: { quoteId, versionNumber: data.versionNumber } });
    if (!version) {
      throw new Error('Quote version not found');
    }
    if (!version.sentAt) {
      throw new Error('Cannot decide on a version that has not been sent to the customer yet');
    }
    if (version.approvedAt) {
      throw new Error("This version's decision was already recorded");
    }

    return await runInTransaction(async (tx) => {
      const updated = await tx.quoteVersion.update({
        where: { id: version.id },
        data: {
          isApproved: data.approved,
          approvedAt: new Date(),
          decidedBy: data.decidedBy,
          decisionNotes: data.decisionNotes,
        },
      });

      // Guarda: um encerramento concorrente não é sobrescrito por uma decisão registrada no mesmo instante.
      const moved = await tx.quote.updateMany({
        where: { id: quoteId, status: { not: 'EXPIRED' } },
        data: { status: data.approved ? 'APPROVED' : 'REJECTED' },
      });
      if (moved.count === 0) assertNotClosed('EXPIRED');

      return updated;
    });
  }

  /**
   * Converter a versão aprovada de um orçamento numa OS real (ENTRADA), com
   * os itens já pré-carregados. A OS "nasce" da versão aprovada — não
   * chamamos ServiceOrderService.addItem() aqui porque ele gerencia sua
   * própria transação e tem efeito colateral de baixa de estoque imediata
   * quando a OS já está em EXECUCAO+ — irrelevante para uma OS recém-aberta
   * em ENTRADA, onde nenhum item deve baixar estoque ainda.
   */
  async convertToServiceOrder(
    quoteId: string,
    companyId: string,
    data: {
      branchId: string;
      entryKilometer: number;
      userId: string;
      fuelLevel?: string;
      visibleDamages?: string;
      personalItems?: string;
      entryNotes?: string;
    }
  ) {
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, companyId } });
    if (!quote) {
      throw new Error('Quote not found');
    }
    if (quote.status !== 'APPROVED') {
      throw new Error(`Cannot convert a quote with status ${quote.status} — only APPROVED quotes can be converted`);
    }
    if (typeof data.entryKilometer !== 'number' || !Number.isFinite(data.entryKilometer) || data.entryKilometer < 0) {
      throw new Error('entryKilometer must be a number greater than or equal to zero');
    }

    // ServiceOrder.branchId é escalar solto: `data.branchId` vinha direto do
    // corpo — mesma classe já corrigida em create() (Quote.branchId) e em
    // purchase-order/stock. Sem isto a OS podia nascer numa filial de outra
    // empresa.
    const branch = await prisma.branch.findFirst({ where: { id: data.branchId, companyId }, select: { id: true } });
    if (!branch) {
      throw new Error('Branch not found in this company');
    }

    // Em teoria existe só uma versão aprovada (reversionar reseta o status
    // para DRAFT, tirando o APPROVED anterior de cena) — mas por segurança
    // pegamos a mais recente por versionNumber caso haja ambiguidade.
    const approvedVersion = await prisma.quoteVersion.findFirst({
      where: { quoteId, isApproved: true },
      include: { items: true },
      orderBy: { versionNumber: 'desc' },
    });
    if (!approvedVersion) {
      throw new Error('No approved version found for this quote');
    }

    const existingLink = await prisma.serviceOrder.findFirst({ where: { quoteVersionId: approvedVersion.id } });
    if (existingLink) {
      throw new Error('This quote version has already been converted into a service order');
    }

    // ACHADO DE AUDITORIA: `ServiceOrder` tem DUAS constraints únicas que
    // podem colidir num P2002 aqui — `quoteVersionId` (@unique) e
    // `@@unique([branchId, osNumber])`. O código antigo tratava QUALQUER
    // P2002 como "esta versão já foi convertida", mas `osNumber` colide com
    // uma OS DE OUTRA venda/orçamento qualquer na mesma filial (duas
    // conversões concorrentes de ORÇAMENTOS DIFERENTES no mesmo horário de
    // pico) — um cenário sem relação nenhuma com este orçamento, que
    // recebia uma mensagem de erro factualmente errada e a transação
    // inteira era descartada sem nunca tentar de novo. Mesmo padrão de
    // numeração sequencial já corrigido (com retry+jitter) em
    // service-order.service.ts::create() — que inclusive já documentava
    // este risco específico em convertToServiceOrder sem corrigi-lo aqui.
    // Como `error.meta.target` não é confiável através da extensão de RLS
    // (ver nota em sale.service.ts/service-order.service.ts), a forma
    // correta de decidir qual constraint colidiu é reconsultar
    // `existingLink`: se agora existir de verdade, a conversão concorrente
    // desta MESMA versão venceu (erro correto); se continuar null, a
    // colisão foi em osNumber e vale a pena tentar de novo com o próximo
    // número.
    // CORREÇÃO (2026-09-21): este é o SEGUNDO ponto que insere em
    // `service_orders`, então precisa da MESMA trava de numeração usada em
    // service-order.service.ts::create() — classid 4201 com a chave
    // `companyId:branchId` idêntica — senão uma conversão de orçamento e
    // uma abertura de OS concorrentes continuam podendo escolher o mesmo
    // osNumber (a trava de uma não enxerga a outra) e a numeração volta a
    // depender do retry. Com a trava, o único P2002 que ainda pode estourar
    // aqui é o de `quoteVersionId` — exatamente o que a re-checagem de
    // `existingLink` no catch abaixo já distingue corretamente.
    const MAX_OS_NUMBER_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_OS_NUMBER_ATTEMPTS; attempt++) {
      try {
        return await runInTransaction(async (tx) => {
          // `$executeRaw`, não `$queryRaw`: `pg_advisory_xact_lock` retorna
          // `void` e o Prisma falha ao desserializar essa coluna.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4201, hashtext(${`${companyId}:${data.branchId}`}))`;

          const lastOs = await tx.serviceOrder.findFirst({
            where: { companyId, branchId: data.branchId },
            orderBy: { osNumber: 'desc' },
            select: { osNumber: true },
          });
          const osNumber = (lastOs?.osNumber || 0) + 1;

          const serviceOrder = await tx.serviceOrder.create({
            data: {
              companyId,
              branchId: data.branchId,
              osNumber,
              customerId: quote.customerId,
              motorcycleId: quote.motorcycleId,
              quoteVersionId: approvedVersion.id,
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
              notes: `Abertura da OS a partir do orçamento #${quote.quoteNumber} (versão ${approvedVersion.versionNumber})`,
            },
          });

          let laborTotal = 0;
          let partsTotal = 0;

          for (const quoteItem of approvedVersion.items) {
            const totalPrice = Number(quoteItem.totalPrice);

            await tx.serviceOrderItem.create({
              data: {
                serviceOrderId: serviceOrder.id,
                itemType: quoteItem.itemType,
                productId: quoteItem.productId,
                description: quoteItem.description,
                quantity: quoteItem.quantity,
                unitPrice: quoteItem.unitPrice,
                totalPrice: quoteItem.totalPrice,
                isCompleted: false,
              },
            });

            if (quoteItem.itemType === 'PART') {
              partsTotal += totalPrice;
            } else {
              laborTotal += totalPrice;
            }
          }

          const updatedOs = await tx.serviceOrder.update({
            where: { id: serviceOrder.id },
            data: {
              laborTotal,
              partsTotal,
              finalTotal: laborTotal + partsTotal,
            },
            include: { items: true },
          });

          await tx.quote.update({ where: { id: quoteId }, data: { status: 'CONVERTED' } });

          return updatedOs;
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }

        const nowLinked = await prisma.serviceOrder.findFirst({ where: { quoteVersionId: approvedVersion.id } });
        if (nowLinked) {
          throw new Error('This quote version has already been converted into a service order');
        }

        if (attempt === MAX_OS_NUMBER_ATTEMPTS) {
          throw new Error('Sistema com alta concorrência no momento — tente novamente em instantes');
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
      }
    }
    throw new Error('Não foi possível converter o orçamento em OS (conflito de numeração persistente)');
  }

  /** Dias sem resposta por filial (`quote.expirationDays`; a filial pode ter valor próprio). */
  private async expirationDaysFor(companyId: string, branchIds: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(branchIds)];
    const entries = await Promise.all(
      unique.map(async (b) => [b, await policyService.get(companyId, b, 'quote.expirationDays')] as [string, number])
    );
    return new Map(entries);
  }

  /**
   * Prazo de resposta do cliente: conta do envio da versão vigente ou da última reabertura (o mais recente). Só
   * orçamento SENT tem prazo; `overdue` = vencido (pode ser encerrado; com `quote.autoExpire`, a rotina encerra).
   */
  private static deadline(status: string, lastSentAt: Date | null | undefined, lastReopenedAt: Date | null | undefined, days: number, now: Date) {
    if (status !== 'SENT' || !lastSentAt) return { overdue: false, respondBy: null as Date | null, daysWithoutResponse: null as number | null };
    const start = lastReopenedAt && lastReopenedAt > lastSentAt ? lastReopenedAt : lastSentAt;
    const respondBy = new Date(start.getTime() + days * DAY_MS);
    return {
      overdue: respondBy.getTime() <= now.getTime(),
      respondBy,
      daysWithoutResponse: Math.max(0, Math.floor((now.getTime() - start.getTime()) / DAY_MS)),
    };
  }

  async getById(id: string, companyId: string, now: Date = new Date()) {
    const quote = await prisma.quote.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        motorcycle: true,
        // Cada versão traz a OS gerada por ela (só a aprovada/convertida
        // tem) — sem isto um orçamento CONVERTED não tinha como apontar
        // para a OS que nasceu dele.
        versions: {
          include: { items: true, serviceOrder: { select: { id: true, osNumber: true, status: true } } },
          orderBy: { versionNumber: 'asc' },
        },
        // Histórico de encerramento/expiração/reabertura (nunca apagado).
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!quote) return null;
    const policies = await policyService.effective(companyId, quote.branchId);
    const days = policies['quote.expirationDays'];
    const latest = quote.versions[quote.versions.length - 1];
    const lastReopen = [...quote.events].reverse().find((e) => e.eventType === 'REOPENED');
    return {
      ...quote,
      ...QuoteService.deadline(quote.status, latest?.sentAt, lastReopen?.createdAt, days, now),
      expirationDays: days,
      reopenAllowed: quote.status === 'EXPIRED' && policies['quote.allowReopen'],
    };
  }

  /**
   * Encerramento manual em lote (seleção múltipla). Cada orçamento é tratado sozinho, com guarda de estado na própria
   * gravação (duas pessoas encerrando/enviando ao mesmo tempo nunca produzem dois eventos nem sobrescrevem uma decisão):
   * - DRAFT (nunca enviado): encerra a qualquer momento;
   * - SENT: só vencido (sem resposta há `quote.expirationDays` dias);
   * - EXPIRED: "já encerrado"; APPROVED/REJECTED/CONVERTED: "não permitido".
   * Resultado por item; nada é apagado (evento CLOSED em quote_events + closedAt/closedBy/closeReason).
   */
  async close(input: { companyId: string; ids: unknown; reason: unknown; userId: string }, now: Date = new Date()) {
    const reason = assertReason(input.reason);
    if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new AppError('Selecione ao menos um orçamento', 400, 'QUOTE_IDS_REQUIRED');
    }
    const ids = [...new Set(input.ids as string[])];
    if (ids.length > MAX_CLOSE_BATCH) {
      throw new AppError(`Encerre no máximo ${MAX_CLOSE_BATCH} orçamentos por vez`, 400, 'TOO_MANY_QUOTES');
    }

    const found = await prisma.quote.findMany({
      where: { id: { in: ids }, companyId: input.companyId },
      select: { id: true, quoteNumber: true, status: true, branchId: true },
    });
    const byId = new Map(found.map((q) => [q.id, q]));
    const days = await this.expirationDaysFor(input.companyId, found.map((q) => q.branchId));

    const results: QuoteCloseResult[] = [];
    for (const id of ids) {
      const quote = byId.get(id);
      if (!quote) {
        results.push({ id, quoteNumber: null, fromStatus: null, outcome: 'NOT_FOUND', message: 'Orçamento não encontrado' });
        continue;
      }
      results.push(await this.closeOne(quote, { companyId: input.companyId, reason, userId: input.userId, days: days.get(quote.branchId)!, now }));
    }

    const summary = { closed: 0, alreadyClosed: 0, notAllowed: 0, notFound: 0 };
    for (const r of results) {
      if (r.outcome === 'CLOSED') summary.closed++;
      else if (r.outcome === 'ALREADY_CLOSED') summary.alreadyClosed++;
      else if (r.outcome === 'NOT_ALLOWED') summary.notAllowed++;
      else summary.notFound++;
    }
    return { reason, results, summary };
  }

  private async closeOne(
    quote: { id: string; quoteNumber: number; status: string; branchId: string },
    ctx: { companyId: string; reason: string; userId: string; days: number; now: Date }
  ): Promise<QuoteCloseResult> {
    const base = { id: quote.id, quoteNumber: quote.quoteNumber, fromStatus: quote.status };
    const notAllowed = (message: string): QuoteCloseResult => ({ ...base, outcome: 'NOT_ALLOWED', message });
    if (quote.status === 'EXPIRED') return { ...base, outcome: 'ALREADY_CLOSED', message: 'Já estava encerrado' };
    if (quote.status === 'APPROVED') return notAllowed('Aprovado pelo cliente — aguarda virar ordem de serviço');
    if (quote.status === 'REJECTED') return notAllowed('Recusado pelo cliente — a decisão já está registrada');
    if (quote.status === 'CONVERTED') return notAllowed('Já virou ordem de serviço');

    // Guarda na gravação: o estado lido (e, se SENT, ainda vencido). Mudou no meio → 0 linhas → nada é gravado.
    const guard: Prisma.QuoteWhereInput = quote.status === 'SENT' ? overdueWhere(cutoffFor(ctx.now, ctx.days)) : { status: 'DRAFT' };
    const closed = await runInTransaction(async (tx) => {
      const done = await tx.quote.updateMany({
        where: { id: quote.id, companyId: ctx.companyId, ...guard },
        data: { status: 'EXPIRED', closedAt: new Date(), closedBy: ctx.userId, closeReason: ctx.reason },
      });
      if (done.count === 0) return false;
      await tx.quoteEvent.create({
        data: {
          quoteId: quote.id,
          companyId: ctx.companyId,
          branchId: quote.branchId,
          eventType: 'CLOSED',
          fromStatus: quote.status,
          toStatus: 'EXPIRED',
          reason: ctx.reason,
          performedBy: ctx.userId,
        },
      });
      return true;
    });
    if (closed) return { ...base, outcome: 'CLOSED', message: 'Encerrado' };

    const current = await prisma.quote.findFirst({ where: { id: quote.id, companyId: ctx.companyId }, select: { status: true } });
    if (current?.status === 'EXPIRED') return { ...base, outcome: 'ALREADY_CLOSED', message: 'Já estava encerrado' };
    if (current?.status === 'SENT' && quote.status === 'SENT') {
      return notAllowed(`Ainda dentro do prazo de resposta do cliente (${ctx.days} dias desde o envio ou a reabertura)`);
    }
    return notAllowed('O orçamento mudou de situação enquanto era encerrado. Atualize a lista.');
  }

  /**
   * Reabrir (cliente voltou): EXPIRED → AGUARDANDO APROVAÇÃO (SENT) quando a versão vigente foi enviada e não decidida;
   * DRAFT quando o encerrado era um rascunho nunca enviado. REJECTED não reabre: a recusa está gravada na versão — o
   * caminho é uma nova versão (addVersion), que já existe. A reabertura reinicia o prazo de resposta (evento REOPENED)
   * e não apaga o registro do encerramento anterior.
   */
  async reopen(id: string, companyId: string, input: { reason: unknown; userId: string }) {
    const reason = assertReason(input.reason);
    const quote = await prisma.quote.findFirst({
      where: { id, companyId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { sentAt: true, approvedAt: true } } },
    });
    if (!quote) throw new AppError('Orçamento não encontrado', 404, 'QUOTE_NOT_FOUND');
    if (quote.status === 'REJECTED') {
      throw new ConflictError('Orçamento recusado pelo cliente não é reaberto: crie uma nova versão com a nova proposta', 'QUOTE_NOT_REOPENABLE');
    }
    if (quote.status !== 'EXPIRED') {
      throw new ConflictError('Só orçamento encerrado pode ser reaberto', 'QUOTE_NOT_REOPENABLE');
    }
    if (!(await policyService.get(companyId, quote.branchId, 'quote.allowReopen'))) {
      throw new ConflictError('A política da empresa não permite reabrir orçamento encerrado', 'QUOTE_REOPEN_DISABLED');
    }

    const latest = quote.versions[0];
    const toStatus = latest?.sentAt && !latest.approvedAt ? 'SENT' : 'DRAFT';

    await runInTransaction(async (tx) => {
      // Mesma trava da criação: reabrir e criar outro orçamento para o mesmo veículo ao mesmo tempo não geram dois abertos.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4204, hashtext(${companyId}))`;
      const open = await tx.quote.findFirst({
        where: { companyId, motorcycleId: quote.motorcycleId, status: { in: [...QUOTE_OPEN_STATUSES] }, id: { not: id } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, quoteNumber: true, status: true },
      });
      if (open) {
        throw new QuoteConflictError(
          `O veículo já tem outro orçamento em aberto (#${open.quoteNumber}). Continue aquele ou encerre-o antes de reabrir este.`,
          'OPEN_QUOTE_EXISTS',
          { existingQuoteId: open.id, existingQuoteNumber: open.quoteNumber, existingStatus: open.status }
        );
      }
      const done = await tx.quote.updateMany({ where: { id, companyId, status: 'EXPIRED' }, data: { status: toStatus } });
      if (done.count === 0) {
        throw new ConflictError('O orçamento mudou de situação enquanto era reaberto. Atualize e tente de novo.', 'QUOTE_STATUS_CHANGED');
      }
      await tx.quoteEvent.create({
        data: { quoteId: id, companyId, branchId: quote.branchId, eventType: 'REOPENED', fromStatus: 'EXPIRED', toStatus, reason, performedBy: input.userId },
      });
    });

    return this.getById(id, companyId);
  }

  /** Orçamentos existentes para o mesmo cliente + veículo: abertos e encerrados/recusados recentes (tela "Novo orçamento"). */
  async related(companyId: string, customerId: unknown, motorcycleId: unknown, now: Date = new Date()) {
    if (typeof customerId !== 'string' || !customerId || typeof motorcycleId !== 'string' || !motorcycleId) {
      throw new AppError('Informe o cliente e o veículo', 400, 'CUSTOMER_AND_MOTORCYCLE_REQUIRED');
    }
    const select = {
      id: true,
      quoteNumber: true,
      status: true,
      branchId: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      closeReason: true,
      validUntil: true,
      versions: {
        select: { versionNumber: true, totalAmount: true, sentAt: true, isApproved: true, approvedAt: true },
        orderBy: { versionNumber: 'desc' as const },
        take: 1,
      },
      events: { where: { eventType: 'REOPENED' }, orderBy: { createdAt: 'desc' as const }, take: 1, select: { createdAt: true } },
    };
    const [open, closed] = await Promise.all([
      prisma.quote.findMany({
        where: { companyId, customerId, motorcycleId, status: { in: [...QUOTE_OPEN_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select,
      }),
      prisma.quote.findMany({
        where: {
          companyId,
          customerId,
          motorcycleId,
          status: { in: ['EXPIRED', 'REJECTED'] },
          updatedAt: { gte: new Date(now.getTime() - RELATED_CLOSED_WINDOW_DAYS * DAY_MS) },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select,
      }),
    ]);
    const branchIds = [...open, ...closed].map((q) => q.branchId);
    const policies = new Map(
      await Promise.all([...new Set(branchIds)].map(async (b) => [b, await policyService.effective(companyId, b)] as const))
    );
    const shape = (q: (typeof open)[number]) => {
      const p = policies.get(q.branchId)!;
      const { events, ...rest } = q;
      return {
        ...rest,
        ...QuoteService.deadline(q.status, q.versions[0]?.sentAt, events[0]?.createdAt, p['quote.expirationDays'], now),
        canReopen: q.status === 'EXPIRED' && p['quote.allowReopen'],
      };
    };
    return { open: open.map(shape), closed: closed.map(shape) };
  }

  /**
   * Rotina diária (job `expire-overdue-quotes`): nas filiais com `quote.autoExpire` ligado, encerra os SENT vencidos —
   * status EXPIRED, evento EXPIRED, performedBy/closedBy 'SYSTEM'. Roda fora de requisição (contexto de plataforma).
   * `companyId` limita a uma empresa (testes).
   */
  async expireOverdue(options: { now?: Date; companyId?: string } = {}) {
    const now = options.now ?? new Date();
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const companies = await prisma.company.findMany({
        where: { isActive: true, ...(options.companyId ? { id: options.companyId } : {}) },
        select: { id: true },
      });
      let expired = 0;
      for (const company of companies) {
        const branches = await prisma.branch.findMany({ where: { companyId: company.id }, select: { id: true } });
        for (const branch of branches) {
          const policies = await policyService.effective(company.id, branch.id);
          if (!policies['quote.autoExpire']) continue;
          const days = policies['quote.expirationDays'];
          const cutoff = cutoffFor(now, days);
          const reason = `Sem resposta do cliente há ${days} dias ou mais (encerramento automático)`;
          const candidates = await prisma.quote.findMany({
            where: { companyId: company.id, branchId: branch.id, ...overdueWhere(cutoff) },
            select: { id: true },
            take: 1000,
          });
          for (const candidate of candidates) {
            const ok = await runInTransaction(async (tx) => {
              const done = await tx.quote.updateMany({
                where: { id: candidate.id, ...overdueWhere(cutoff) },
                data: { status: 'EXPIRED', closedAt: new Date(), closedBy: QUOTE_SYSTEM_ACTOR, closeReason: reason },
              });
              if (done.count === 0) return false;
              await tx.quoteEvent.create({
                data: {
                  quoteId: candidate.id,
                  companyId: company.id,
                  branchId: branch.id,
                  eventType: 'EXPIRED',
                  fromStatus: 'SENT',
                  toStatus: 'EXPIRED',
                  reason,
                  performedBy: QUOTE_SYSTEM_ACTOR,
                },
              });
              return true;
            });
            if (ok) expired++;
          }
        }
      }
      return { companies: companies.length, expired };
    });
  }

  async list(filters: {
    companyId: string;
    branchId?: string;
    customerId?: string;
    status?: string;
    /** Só os vencidos (SENT sem resposta há `quote.expirationDays` dias da filial de cada orçamento). */
    overdue?: boolean;
    page?: number;
    limit?: number;
  }, now: Date = new Date()) {
    const { companyId, branchId, customerId, status, overdue, page = 1, limit = 20 } = filters;

    const where: Prisma.QuoteWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(customerId && { customerId }),
      ...(status && { status: status as any }),
    };
    if (overdue) {
      // O prazo é por filial: uma condição por filial (a política pode ser diferente em cada uma).
      const branchIds = branchId
        ? [branchId]
        : (await prisma.branch.findMany({ where: { companyId }, select: { id: true } })).map((b) => b.id);
      const days = await this.expirationDaysFor(companyId, branchIds);
      where.AND = [{ OR: branchIds.map((b) => ({ branchId: b, ...overdueWhere(cutoffFor(now, days.get(b)!)) })) }];
    }

    const [rows, total] = await Promise.all([
      prisma.quote.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          motorcycle: { select: { id: true, brand: true, model: true, licensePlate: true } },
          // Última versão (resumo) — a lista precisa do valor vigente do
          // orçamento sem trazer todos os itens de todas as versões.
          versions: {
            select: { versionNumber: true, totalAmount: true, sentAt: true, isApproved: true, approvedAt: true },
            orderBy: { versionNumber: 'desc' },
            take: 1,
          },
          // Última reabertura: reinicia o prazo de resposta.
          events: { where: { eventType: 'REOPENED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.quote.count({ where }),
    ]);

    const days = await this.expirationDaysFor(companyId, rows.map((q) => q.branchId));
    const quotes = rows.map(({ events, ...q }) => ({
      ...q,
      ...QuoteService.deadline(q.status, q.versions[0]?.sentAt, events[0]?.createdAt, days.get(q.branchId)!, now),
    }));

    return { quotes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }
}

export type QuoteCloseOutcome = 'CLOSED' | 'ALREADY_CLOSED' | 'NOT_ALLOWED' | 'NOT_FOUND';
export interface QuoteCloseResult {
  id: string;
  quoteNumber: number | null;
  fromStatus: string | null;
  outcome: QuoteCloseOutcome;
  message: string;
}

export default new QuoteService();
