import { prisma, runInTransaction } from '@ln-system/database';
import { FiscalDocumentStatus, FiscalDocumentType, Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import { FiscalProviderAdapter } from './fiscal-adapters/types';
import unconfiguredAdapter from './fiscal-adapters/unconfigured-adapter';
import { ConflictError } from '@ln-system/shared';
import { policyService } from './policy.service';

/**
 * LOCAL STAND-IN PARA OBJECT STORAGE
 * ===================================
 * `FISCAL_STORAGE_PATH` (default `./fiscal-storage`) é um diretório no
 * disco local usado apenas para desenvolvimento/homologação neste ambiente.
 * Antes de produção, isto DEVE ser substituído por um provedor de object
 * storage real (S3, GCS, Azure Blob) com o mesmo contrato — este serviço só
 * grava o arquivo e persiste o "path"/URL resultante em
 * `FiscalDocument.xmlUrl`/`pdfUrl`, então trocar a implementação de
 * `storeFiscalFile` é suficiente.
 */
const FISCAL_STORAGE_PATH = process.env.FISCAL_STORAGE_PATH || './fiscal-storage';

/**
 * Seleciona o adapter de provedor fiscal para uma empresa/filial.
 *
 * Nenhum provedor real está integrado neste ambiente (sem certificado
 * digital, sem credenciais de homologação/produção de SEFAZ ou de um
 * intermediário como Focus NFe/eNotas). Por isso, hoje esta função sempre
 * retorna o `UnconfiguredFiscalAdapter`. Quando um provedor real existir,
 * este é o único ponto que precisa mudar: inspecionar `FiscalConfig`
 * (ex: um campo `provider`/credenciais) e instanciar o adapter
 * correspondente.
 */
function resolveAdapter(_config: { nfceEnabled: boolean; nfeEnabled: boolean } | null): FiscalProviderAdapter {
  return unconfiguredAdapter;
}

// Campos que upsertConfig aceita gravar (lista fechada — ver o comentário lá).
const UPSERTABLE_CONFIG_FIELDS = [
  'nfceEnabled',
  'nfceSeriesNumber',
  'nfeEnabled',
  'nfeSeriesNumber',
  'certificatePath',
  'certificatePassword',
  'cscId',
  'cscToken',
  'environment',
  'cancelTimeLimit',
] as const;

// Segredos: nunca saem pela API (só um booleano dizendo se estão configurados).
const SECRET_CONFIG_FIELDS = ['certificatePassword', 'cscToken'] as const;

const DRAFT_IN_FLIGHT_MS = 10 * 60 * 1000;

/**
 * Venda que pode receber documento fiscal de VENDA (docs/CORTEX/policies/FISCAL.md):
 *  - CANCELLED: a venda não ocorreu — nunca gera emissão (nem nota nova por causa do cancelamento).
 *  - PENDING / PARTIALLY_PAID: pagamento não confirmado = venda não concluída.
 *  - PAID: emite. RETURNED: inalterado (devolução fiscal é operação própria — DECISÃO NECESSÁRIA).
 */
export const FISCAL_EMITTABLE_SALE_STATUSES = ['PAID', 'RETURNED'];
function assertSaleEmittable(status: string | null | undefined) {
  if (status === 'CANCELLED') {
    throw new ConflictError('Venda cancelada não gera documento fiscal: a venda não ocorreu.', 'FISCAL_SALE_CANCELLED');
  }
  if (status === 'PENDING' || status === 'PARTIALLY_PAID') {
    throw new ConflictError(
      'A venda ainda não foi concluída (pagamento não confirmado). O documento fiscal só é emitido depois da confirmação do pagamento.',
      'FISCAL_SALE_NOT_COMPLETED'
    );
  }
}

export class FiscalService {
  // ---------------- FiscalConfig ----------------

  // Uso INTERNO (emissão/cancelamento e adapters): linha completa, com segredos.
  // Para responder a uma requisição use toPublicConfig().
  async getConfig(companyId: string, branchId: string) {
    return await prisma.fiscalConfig.findUnique({
      where: { companyId_branchId: { companyId, branchId } },
    });
  }

  // ACHADO DE AUDITORIA (SEGURANÇA): GET /fiscal/config devolvia a linha
  // inteira, incluindo `certificatePassword` e `cscToken` em texto puro — para
  // qualquer COMPANY_ADMIN, em qualquer resposta (a do POST também). A tela só
  // usa se o segredo existe, então a API devolve `hasCertificatePassword` /
  // `hasCscToken` no lugar do valor.
  toPublicConfig<T extends { certificatePassword?: string | null; cscToken?: string | null } | null>(config: T) {
    if (!config) return config;
    const { certificatePassword, cscToken, ...safe } = config;
    return { ...safe, hasCertificatePassword: !!certificatePassword, hasCscToken: !!cscToken };
  }

  /**
   * Cria ou atualiza a configuração fiscal de uma empresa/filial.
   * Deliberadamente agnóstica de UF: nenhuma regra tributária por estado é
   * codificada aqui — apenas os campos genéricos já existentes no schema
   * (certificado, CSC, ambiente, limite de cancelamento). Regras
   * UF-específicas (prazos, alíquotas, obrigatoriedade de CSC etc.) devem
   * ficar a cargo do provedor fiscal real (adapter) quando integrado.
   */
  async upsertConfig(data: {
    companyId: string;
    branchId: string;
    nfceEnabled?: boolean;
    nfceSeriesNumber?: number;
    nfeEnabled?: boolean;
    nfeSeriesNumber?: number;
    certificatePath?: string;
    certificatePassword?: string;
    cscId?: string;
    cscToken?: string;
    environment?: string;
    cancelTimeLimit?: number;
  }) {
    const { companyId, branchId } = data;

    // Só os campos que este método declara: a rota espalhava `req.body`
    // inteiro aqui, então qualquer chave extra (ex.: os contadores internos
    // nfceNextNumber/nfeNextNumber, ou `id`) ia direto para o Prisma.
    // Segredo (senha do certificado, token CSC) vazio/ausente MANTÉM o valor
    // já gravado — o GET nunca devolve o segredo (ver toPublicConfig), então a
    // tela não tem como reenviá-lo e um PUT sem ele não pode apagá-lo.
    const rest: Record<string, unknown> = {};
    for (const key of UPSERTABLE_CONFIG_FIELDS) {
      const value = (data as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const isSecret = (SECRET_CONFIG_FIELDS as readonly string[]).includes(key);
      if (isSecret && (value === null || value === '')) continue;
      // Segredos cifrados em repouso (secret-box); quem emitir de verdade abre com openSecret.
      rest[key] = isSecret && typeof value === 'string' ? sealSecret(value) : value;
    }

    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: FiscalConfig.branchId é `String`
    // solto no schema (sem @relation) — mesma classe de bug já corrigida em
    // stock/quote/purchase-order.service.ts. Sem esta checagem, um branchId
    // de outra empresa (ou inválido) era aceito sem erro.
    const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId }, select: { id: true } });
    if (!branch) {
      throw new Error('Branch not found in this company');
    }

    return await prisma.fiscalConfig.upsert({
      where: { companyId_branchId: { companyId, branchId } },
      create: { companyId, branchId, ...rest },
      update: rest,
    });
  }

  // ---------------- FiscalDocument ----------------

  async getDocumentById(id: string, companyId: string) {
    return await prisma.fiscalDocument.findFirst({ where: { id, companyId } });
  }

  async listDocuments(filters: {
    companyId: string;
    branchId?: string;
    status?: FiscalDocumentStatus;
    saleId?: string;
    serviceOrderId?: string;
    page?: number;
    limit?: number;
  }) {
    const { companyId, branchId, status, saleId, serviceOrderId, page = 1, limit = 20 } = filters;

    const where: Prisma.FiscalDocumentWhereInput = {
      companyId,
      ...(branchId && { branchId }),
      ...(status && { status }),
      ...(saleId && { saleId }),
      ...(serviceOrderId && { serviceOrderId }),
    };

    const [documents, total] = await Promise.all([
      prisma.fiscalDocument.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.fiscalDocument.count({ where }),
    ]);

    return { documents, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Emite um documento fiscal (NFC-e) para uma venda já existente.
   *
   * Sempre cria uma linha em `FiscalDocument`, mesmo quando não há provedor
   * configurado — isso registra a tentativa de emissão (auditável) em vez
   * de simplesmente recusar silenciosamente. O `FiscalConfig` da
   * empresa/filial determina qual adapter é usado (hoje, sempre o
   * `UnconfiguredFiscalAdapter`, já que nenhum provedor real está
   * integrado neste ambiente).
   */
  async emitDocument(saleId: string, companyId: string, branchId: string) {
    const sale = await prisma.sale.findFirst({ where: { id: saleId, companyId, branchId } });
    if (!sale) {
      throw new Error('Sale not found');
    }
    // Regras fiscais da venda (docs/CORTEX/policies/FISCAL.md). RETURNED segue como antes: devolução fiscal é operação
    // própria e a regra está como DECISÃO NECESSÁRIA.
    assertSaleEmittable(sale.status);
    const policies = await policyService.effective(companyId, branchId);
    const enabled = (policies['fiscal.enabledOperations'] as string[]) ?? [];
    if (!enabled.includes('SALE')) {
      throw new ConflictError(
        'A emissão fiscal de venda está desligada nas políticas desta empresa/filial (Configurações › Políticas › Fiscal).',
        'FISCAL_OPERATION_DISABLED'
      );
    }

    let config = await this.getConfig(companyId, branchId);
    const documentType: FiscalDocumentType = 'NFCE';
    const seriesNumber = config?.nfceSeriesNumber ?? 1;

    // ACHADO DE AUDITORIA: `nextNumber` era lido uma única vez, fora de
    // qualquer transação/lock, e usado direto no `create()` — mesma classe
    // de corrida já identificada, testada sob carga real e corrigida em
    // sale.service.ts::createSale (e, por precedente citado lá,
    // transfer/quote/inventory.service.ts): duas emissões quase
    // simultâneas na mesma empresa/filial/série (dois caixas emitindo
    // NFC-e ao mesmo tempo) podiam ambas ler o mesmo `nfceNextNumber` e
    // ambas tentar criar um FiscalDocument com o mesmo `number`. A
    // constraint `@@unique([companyId, branchId, documentType, series,
    // number])` impede o registro duplicado chegar no banco, mas sem este
    // retry a chamada perdedora vazava um P2002 cru — pior aqui do que em
    // Sale porque numeração de NFC-e/NFe é compliance-crítica (dois
    // documentos fiscais reais nunca podem compartilhar série+número).
    // Mesma estratégia: recalcula e tenta de novo quando colide, com
    // jitter, até um limite de tentativas.
    const MAX_NUMBER_ATTEMPTS = 5;
    let document;
    for (let attempt = 1; attempt <= MAX_NUMBER_ATTEMPTS; attempt++) {
      try {
        document = await runInTransaction(async (tx) => {
          // Uma emissão por venda de cada vez (duplo clique, dois caixas): a checagem de documento ativo só vale
          // atrás desta trava. DRAFT conta — é o estado entre criar o documento e o provedor responder; um DRAFT
          // com mais de 10 min é tratado como emissão abandonada (processo caiu) e não trava a venda para sempre.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4205, hashtext(${saleId}))`;
          // A venda pode ter sido cancelada entre a leitura acima e aqui: relida com trava compartilhada (o
          // cancelamento, que faz UPDATE na linha, espera esta transação ou é esperado por ela).
          const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM sales WHERE id = ${saleId} FOR SHARE`;
          assertSaleEmittable(locked[0]?.status ?? sale.status);
          const existing = await tx.fiscalDocument.findFirst({
            where: {
              saleId,
              companyId,
              OR: [
                { status: { in: ['AUTHORIZED', 'PENDING', 'CONTINGENCY'] } },
                { status: 'DRAFT', createdAt: { gt: new Date(Date.now() - DRAFT_IN_FLIGHT_MS) } },
              ],
            },
            select: { id: true },
          });
          if (existing) {
            throw new Error('A fiscal document is already active or in progress for this sale');
          }

          // Numeração da série serializada por filial (lida DENTRO da trava, não da config lida antes).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4206, hashtext(${`${companyId}:${branchId}`}))`;
          const freshConfig = await tx.fiscalConfig.findUnique({ where: { companyId_branchId: { companyId, branchId } } });
          const nextNumber = freshConfig?.nfceNextNumber ?? 1;

          const created = await tx.fiscalDocument.create({
            data: {
              companyId,
              branchId,
              documentType,
              status: FiscalDocumentStatus.DRAFT,
              series: String(seriesNumber),
              number: nextNumber,
              saleId,
              totalAmount: sale.totalAmount,
            },
          });
          if (freshConfig) {
            await tx.fiscalConfig.update({
              where: { companyId_branchId: { companyId, branchId } },
              data: { nfceNextNumber: nextNumber + 1 },
            });
          }
          return created;
        });
        break;
      } catch (error) {
        const isNumberConflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!isNumberConflict) {
          throw error;
        }
        if (attempt === MAX_NUMBER_ATTEMPTS) {
          throw new Error('Sistema com alta concorrência na emissão fiscal no momento — tente novamente em instantes');
        }
        // Concorrente venceu a corrida por este número — relê a config
        // (já refletindo o incremento que a concorrente acabou de commitar)
        // e tenta de novo com o próximo número disponível.
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
        config = await this.getConfig(companyId, branchId);
      }
    }

    // Inalcançável na prática (o loop sempre `break`s com `document` setado
    // ou lança antes de sair) — só para o TypeScript provar que `document`
    // não é mais `undefined` daqui em diante sem recorrer a `!`.
    if (!document) {
      throw new Error('Sistema com alta concorrência na emissão fiscal no momento — tente novamente em instantes');
    }

    const items = await prisma.saleItem.findMany({ where: { saleId } });

    const adapter = resolveAdapter(config);

    let result;
    try {
      result = await adapter.emit({
        companyId,
        branchId,
        documentType,
        series: document.series,
        number: document.number,
        totalAmount: Number(sale.totalAmount),
        saleId,
        items: items.map((item) => ({
          description: item.productName,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          totalPrice: Number(item.totalPrice),
        })),
      });
    } catch (error: any) {
      logger.error(`Fiscal emission failed for document ${document.id}:`, error);
      result = {
        status: FiscalDocumentStatus.PENDING,
        errorMessage: error?.message || 'Unexpected error during fiscal emission',
      };
    }

    let xmlUrl: string | undefined;
    if (result.xmlContent) {
      xmlUrl = await this.storeFiscalFile(companyId, document.id, result.xmlContent);
    }

    const updated = await prisma.fiscalDocument.update({
      where: { id: document.id },
      data: {
        status: result.status,
        accessKey: result.accessKey,
        authorizationProtocol: result.authorizationProtocol,
        xmlUrl,
        qrCode: result.qrCode,
        issuedAt: new Date(),
        authorizedAt: result.authorizedAt,
        rejectionReason: result.rejectionReason || result.errorMessage,
      },
    });

    return updated;
  }

  /**
   * Cancela um documento fiscal já emitido. Documentos DRAFT/PENDING sem
   * autorização real também podem ser cancelados administrativamente
   * (nunca houve emissão de fato), mas um documento já CANCELLED nunca
   * pode ser cancelado de novo.
   */
  async cancelDocument(documentId: string, companyId: string, reason: string) {
    const document = await prisma.fiscalDocument.findFirst({ where: { id: documentId, companyId } });
    if (!document) {
      throw new Error('Fiscal document not found');
    }
    if (document.status === FiscalDocumentStatus.CANCELLED) {
      throw new Error('Fiscal document is already cancelled');
    }
    if (!reason || !reason.trim()) {
      throw new Error('Cancellation reason is required');
    }

    const config = await this.getConfig(companyId, document.branchId);
    const adapter = resolveAdapter(config);

    let result;
    try {
      result = await adapter.cancel(documentId, reason);
    } catch (error: any) {
      logger.error(`Fiscal cancellation failed for document ${documentId}:`, error);
      result = {
        status: document.status,
        errorMessage: error?.message || 'Unexpected error during fiscal cancellation',
      };
    }

    // ACHADO DE AUDITORIA: entre a checagem de status acima (linha 279) e o
    // `update()` original havia dois pontos de `await` (getConfig/
    // adapter.cancel) sem nenhuma trava — duas chamadas de cancelamento
    // quase simultâneas para o MESMO documento podiam ambas passar pela
    // checagem de "já cancelado" e ambas escrever por cima uma da outra.
    //
    // Diferente de payment/cash-register/service-order/financial/quote
    // (onde o resultado final é sempre um status TERMINAL que naturalmente
    // exclui uma segunda tentativa de um `updateMany({where:{status:{not:
    // TERMINAL}}})`), aqui `result.status` pode legitimamente continuar
    // PENDING (provedor não configurado, ou uma falha/timeout real de
    // SEFAZ) — nesse caso um `updateMany` com esse mesmo formato NUNCA
    // excluiria uma segunda chamada, porque a linha nunca sai do estado
    // "não CANCELLED". A garantia correta aqui é serializar as duas
    // transações com `SELECT ... FOR UPDATE` (mesmo padrão já usado em
    // payment.service.ts::processPayment) e RELER o status já commitado
    // antes de gravar: a chamada que esperou o lock vê o resultado real da
    // concorrente e se recusa a sobrescrever um cancelamento genuíno já
    // concluído, em vez de gravar às cegas por cima.
    return await runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} FOR UPDATE`;

      const fresh = await tx.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } });
      if (fresh.status === FiscalDocumentStatus.CANCELLED) {
        throw new Error('Fiscal document is already cancelled');
      }

      return await tx.fiscalDocument.update({
        where: { id: documentId },
        data: {
          status: result.status,
          cancelReason: reason,
          cancelledAt: result.status === FiscalDocumentStatus.CANCELLED ? result.cancelledAt || new Date() : undefined,
          rejectionReason: result.errorMessage,
        },
      });
    });
  }

  /**
   * LOCAL STAND-IN para object storage privado (S3/GCS/Azure Blob).
   * Grava o XML/DANFE em disco local sob `FISCAL_STORAGE_PATH` e retorna
   * o caminho como se fosse a URL do arquivo. Isto NÃO é adequado para
   * produção (sem redundância, sem controle de acesso real, não
   * escalável entre múltiplas instâncias) — deve ser substituído por um
   * cliente de object storage real antes do deploy em produção, mantendo
   * o mesmo contrato: recebe o conteúdo, retorna a referência persistida
   * em `FiscalDocument.xmlUrl`/`pdfUrl`.
   */
  private async storeFiscalFile(companyId: string, documentId: string, content: string): Promise<string> {
    const dir = path.join(FISCAL_STORAGE_PATH, companyId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${documentId}.xml`);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }
}

export default new FiscalService();
