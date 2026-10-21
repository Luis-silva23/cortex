import { ChargeRequest, ChargeResult, PaymentGatewayAdapter } from './types';

/**
 * Métodos de pagamento que exigiriam um gateway real (PIX, TEF de
 * cartão, transferência bancária, etc) mas para os quais nenhuma
 * integração existe neste ambiente.
 *
 * Diferente do código antigo (que marcava qualquer pagamento como
 * APPROVED na criação, inclusive PIX/TEF, com um comentário admitindo
 * "em produção pode ser PENDING"), este adaptador é honesto: sem um
 * gateway de verdade, é IMPOSSÍVEL confirmar de forma confiável que o
 * dinheiro entrou. Então ele sempre devolve PENDING.
 *
 * `checkStatus` é, pela mesma razão, um no-op: não há API de consulta
 * real para chamar. Quando um gateway de PIX/TEF de verdade for
 * integrado, é aqui — ou num adaptador dedicado (`PixAdapter`,
 * `TefAdapter`) que implemente a mesma interface — que entraria a
 * chamada HTTP real de consulta de status da transação.
 */
export class PendingManualAdapter implements PaymentGatewayAdapter {
  readonly name = 'pending-manual';

  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    return {
      status: 'PENDING',
      reason: 'Sem gateway real integrado — pagamento aguarda confirmação/reconciliação manual.',
    };
  }

  async checkStatus(_transactionId: string): Promise<ChargeResult> {
    // TODO(gateway real): chamar aqui a API de consulta de status do
    // provedor (ex.: GET /pix/transacoes/{id} do PSP, ou consulta de NSU
    // no host TEF) e mapear o retorno dele para PaymentGatewayStatus.
    return {
      status: 'PENDING',
      reason: 'Sem gateway real integrado — nada para consultar ainda.',
    };
  }
}

export default new PendingManualAdapter();
