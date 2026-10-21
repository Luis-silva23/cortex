import { ChargeRequest, ChargeResult, PaymentGatewayAdapter } from './types';

/**
 * Cartão (débito/crédito) SEM um terminal TEF integrado.
 *
 * Isto representa explicitamente o comportamento que já existia de forma
 * implícita no código antigo: "o operador passou o cartão na maquininha
 * física dele (fora do sistema) e confirma no PDV que foi aprovado". Não há
 * chamada real a nenhum gateway — o sistema está apenas confiando na
 * palavra do operador.
 *
 * Isolar esse comportamento num adaptador nomeado (em vez de deixá-lo
 * implícito dentro do PaymentService) deixa claro, para quem ler o código,
 * que isto NÃO é uma integração real — e torna trivial trocar por um
 * `TefAdapter` de verdade no futuro sem tocar no restante do sistema.
 */
export class ManualCardAdapter implements PaymentGatewayAdapter {
  readonly name = 'manual-card';

  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    // "Confiamos" no operador: ele já confirmou fisicamente que o cartão
    // foi aprovado na maquininha antes de registrar isso no sistema.
    return { status: 'APPROVED' };
  }

  async checkStatus(_transactionId: string): Promise<ChargeResult> {
    // Não há gateway para consultar — o status manual já é final desde a
    // criação (nunca fica PENDING), então não há nada a reconciliar aqui.
    return { status: 'APPROVED' };
  }
}

export default new ManualCardAdapter();
