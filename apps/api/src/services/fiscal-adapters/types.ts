import { FiscalDocumentStatus, FiscalDocumentType } from '@ln-system/database';

/**
 * Arquitetura de adapters fiscais
 * ================================
 * Nenhum provedor real (SEFAZ direto ou intermediário como Focus NFe/eNotas)
 * está integrado neste ambiente — não há certificado digital, credenciais de
 * homologação/produção nem acesso à internet fiscal. Esta interface define o
 * CONTRATO que um adapter real precisará implementar para ser plugado no
 * `FiscalService` sem alterar o fluxo de vendas/PDV.
 *
 * O único adapter funcional hoje é o `UnconfiguredFiscalAdapter`
 * (./unconfigured-adapter.ts), que responde de forma honesta que a emissão
 * fiscal não está configurada, em vez de fingir sucesso.
 */

export interface EmitFiscalDocumentRequest {
  companyId: string;
  branchId: string;
  documentType: FiscalDocumentType; // NFCE | NFE
  series: string;
  number: number;
  totalAmount: number;
  // Referência de origem (venda ou ordem de serviço) — apenas para o
  // adapter montar o payload; a persistência da referência é feita pelo
  // FiscalService, não pelo adapter.
  saleId?: string;
  serviceOrderId?: string;
  // Estrutura extensível de itens/tributos. Deliberadamente genérica: cada
  // UF/regime tributário tem regras próprias (ICMS, ICMS-ST, PIS/COFINS,
  // Simples Nacional etc.) que não devem ser hardcoded aqui — um provedor
  // real (ou uma camada de cálculo tributário dedicada) é responsável por
  // resolver esses valores antes de chamar o adapter, ou o adapter delega
  // isso ao provedor terceirizado (ex: Focus NFe calcula os tributos).
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    /** Estrutura livre de tributos por item — chave/valor extensível, sem
     * regra de UF hardcoded (ex: { icms: { cst: '00', aliquota: 18, valor: 12.34 } }). */
    taxes?: Record<string, unknown>;
  }>;
  customer?: {
    name: string;
    document?: string;
    email?: string;
  };
}

export interface FiscalEmissionResult {
  status: FiscalDocumentStatus; // AUTHORIZED | REJECTED | CONTINGENCY | PENDING | error-equivalent
  accessKey?: string;
  authorizationProtocol?: string;
  xmlContent?: string; // Conteúdo XML bruto, se o provedor retornou com sucesso
  pdfContent?: Buffer; // DANFE/DANFCE, se aplicável
  qrCode?: string;
  errorMessage?: string;
  rejectionReason?: string;
  authorizedAt?: Date;
}

export interface FiscalCancellationResult {
  status: FiscalDocumentStatus; // CANCELLED em caso de sucesso, ou o status anterior + errorMessage em caso de falha
  cancelledAt?: Date;
  errorMessage?: string;
}

/**
 * Contrato que todo provedor fiscal (SEFAZ direto ou intermediário) deve
 * implementar. Selecionado em runtime pelo `FiscalService` a partir do
 * `FiscalConfig` da empresa/filial.
 */
export interface FiscalProviderAdapter {
  /** Identificador do provedor, para logging/diagnóstico (ex: "unconfigured", "focus-nfe", "sefaz-direct"). */
  readonly providerName: string;

  emit(request: EmitFiscalDocumentRequest): Promise<FiscalEmissionResult>;

  cancel(documentId: string, reason: string): Promise<FiscalCancellationResult>;
}
