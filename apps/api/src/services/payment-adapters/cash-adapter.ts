import { ChargeRequest, ChargeResult, PaymentGatewayAdapter } from './types';

/**
 * Pagamento em dinheiro: não existe gateway nenhum — o caixa recebe o
 * dinheiro fisicamente no ato. A cobrança é, por definição, síncrona e
 * sempre aprovada (a validação de troco/valor é feita pelo PaymentService,
 * não por este adaptador).
 */
export class CashAdapter implements PaymentGatewayAdapter {
  readonly name = 'cash';

  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    return { status: 'APPROVED' };
  }

  async checkStatus(_transactionId: string): Promise<ChargeResult> {
    // Dinheiro nunca fica pendente — se chegou a existir um pagamento em
    // dinheiro, ele já foi resolvido no momento da criação.
    return { status: 'APPROVED' };
  }
}

export default new CashAdapter();
