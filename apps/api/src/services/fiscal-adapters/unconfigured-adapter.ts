import { FiscalDocumentStatus } from '@ln-system/database';
import {
  EmitFiscalDocumentRequest,
  FiscalCancellationResult,
  FiscalEmissionResult,
  FiscalProviderAdapter,
} from './types';
import { Logger } from '../logger.service';

/**
 * Adapter "honesto" usado quando a empresa/filial não tem um provedor
 * fiscal real configurado (sem certificado digital, sem credenciais de
 * homologação/produção de nenhum provedor — SEFAZ direto ou intermediário
 * como Focus NFe/eNotas).
 *
 * Este é o ÚNICO adapter funcional neste ambiente. Ele NUNCA finge emitir
 * um documento com sucesso: sempre retorna um status estruturado deixando
 * claro que a emissão não está disponível, em vez de esconder a limitação
 * atrás de uma resposta falsa de "autorizado".
 *
 * Quando um provedor real for integrado, ele deve implementar
 * `FiscalProviderAdapter` (ver ./types.ts) e ser selecionado pelo
 * `FiscalService` a partir do `FiscalConfig` da empresa — este adapter
 * continua sendo o fallback padrão para empresas sem configuração.
 */
export class UnconfiguredFiscalAdapter implements FiscalProviderAdapter {
  readonly providerName = 'unconfigured';

  private static readonly MESSAGE =
    'Emissão fiscal não configurada para esta empresa — configure um provedor em Configurações > Fiscal.';

  async emit(request: EmitFiscalDocumentRequest): Promise<FiscalEmissionResult> {
    // Diferente do PENDING "honesto" de PIX/TEF (payment-adapters/pending-manual-adapter.ts),
    // que aguarda legitimamente uma confirmação externa, esta tentativa de
    // emissão NUNCA vai se resolver sozinha — não há provedor configurado
    // para completá-la. Do ponto de vista de observabilidade de plataforma,
    // isso é uma falha de integração real (a emissão não pôde ser
    // concluída), então é persistida em SystemLog para a tela de Logs do
    // Super ADM TI, mesmo que o status de domínio permaneça PENDING.
    Logger.integrationPersisted('Fiscal', 'emit', false, {
      companyId: request.companyId,
      branchId: request.branchId,
      errorMessage: UnconfiguredFiscalAdapter.MESSAGE,
    });
    return {
      status: FiscalDocumentStatus.PENDING,
      errorMessage: UnconfiguredFiscalAdapter.MESSAGE,
    };
  }

  async cancel(documentId: string, _reason: string): Promise<FiscalCancellationResult> {
    Logger.integrationPersisted('Fiscal', 'cancel', false, {
      errorMessage: UnconfiguredFiscalAdapter.MESSAGE,
      documentId,
    });
    return {
      status: FiscalDocumentStatus.PENDING,
      errorMessage: UnconfiguredFiscalAdapter.MESSAGE,
    };
  }
}

export default new UnconfiguredFiscalAdapter();
