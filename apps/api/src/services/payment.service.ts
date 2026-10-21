import { prisma, runInTransaction, runWithRLSContext, PrismaTransactionClient } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { selectAdapter, providerAdapter, MANUAL_PROVIDER, ChargeResult, PaymentGatewayAdapter, PaymentGatewayStatus } from './payment-adapters';
import { AppError, ConflictError } from '@ln-system/shared';
import { splitInstallments, InstallmentError } from '@ln-system/shared/utils/installments';

export const PAYMENT_EXCEPTION_APPROVED_ON_CLOSED_SALE = 'APPROVED_ON_CLOSED_SALE';

/**
 * Confere que o valor é divisível na quantidade de parcelas pedida (inteiro >= 1, valor em centavos exatos, cada parcela com pelo
 * menos R$ 0,01) com a MESMA função que calcula as parcelas (`splitInstallments`: centavos inteiros). Recusa vira 400 com código.
 */
export function assertInstallable(amount: number, installments: number): void {
  try {
    splitInstallments(amount, installments);
  } catch (error) {
    if (error instanceof InstallmentError) throw new AppError(error.message, 400, error.code === 'INSTALLMENT_TOO_SMALL' ? 'INSTALLMENTS_INVALID' : error.code);
    throw error;
  }
}
import { round2 } from './sale-refund';
import { normalizeCashBreakdown, CashBreakdownEntry } from './cash-breakdown';
import paymentSettingsService from './payment-settings.service';
import installmentPolicyService from './installment-policy.service';
import { policyService } from './policy.service';
import employeeAgreementService from './employee-agreement.service';
import { DISABLED_MESSAGE } from './agreement-common';
import agreementCompanyService from './agreement-company.service';
import { AGREEMENT_METHODS, reverseAgreementEffects } from './agreement-effects';

const isAgreementMethod = (method: string) => (AGREEMENT_METHODS as readonly string[]).includes(method);

// Status finais de pagamento — uma vez atingidos, o pagamento nunca deve
// ser reprocessado (evita cobrança duplicada ou crédito duplicado na venda).
const TERMINAL_PAYMENT_STATUSES = new Set(['APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED']);

/**
 * Traduz o status (rico, transiente) devolvido pelo adaptador de gateway
 * para o status (final, persistido) do enum `PaymentStatus` do banco.
 *
 * TIMEOUT e UNKNOWN NUNCA são prova de falha — a orientação de negócio é
 * clara: em caso de timeout/desconhecido, o pagamento fica PENDING
 * (aguardando reconciliação), nunca é marcado como rejeitado/cancelado só
 * porque a chamada ao gateway não respondeu a tempo. Isso evita o pior tipo
 * de bug financeiro: cliente pagou, gateway confirmou depois, mas o sistema
 * já tinha decidido (errado) que a cobrança falhou.
 */
function toDbStatus(gatewayStatus: PaymentGatewayStatus): 'APPROVED' | 'REJECTED' | 'PENDING' | 'CANCELLED' {
  switch (gatewayStatus) {
    case 'APPROVED':
      return 'APPROVED';
    case 'DECLINED':
      return 'REJECTED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'PENDING':
    case 'TIMEOUT':
    case 'UNKNOWN':
    default:
      return 'PENDING';
  }
}

// Status da venda depois de cancelar/estornar um pagamento. CANCELLED/RETURNED são finais: cancelar um PENDING que
// sobrou numa venda devolvida a reabria como PENDING (aceitando pagamento de novo). Lido na transação, não do snapshot.
async function saleStatusAfterReversal(tx: PrismaTransactionClient, saleId: string, totalPaid: number, totalAmount: number) {
  const { status } = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, select: { status: true } });
  if (status === 'CANCELLED' || status === 'RETURNED') return status;
  return totalPaid >= totalAmount ? 'PAID' : totalPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING';
}

// Trava a venda e confere o status DEPOIS do lock: a checagem feita antes da transação não vale se um
// cancelamento/devolução comitar no intervalo (o pagamento transformaria a venda cancelada em PAID).
async function lockSaleForPayment(tx: PrismaTransactionClient, saleId: string) {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM sales WHERE id = ${saleId} FOR UPDATE`;
  const status = rows[0]?.status;
  if (!status) throw new Error('Sale not found');
  if (status === 'CANCELLED' || status === 'RETURNED') {
    throw new Error('Cannot process payment for cancelled or returned sale');
  }
}

export class PaymentService {
  // Processar pagamento (com idempotência)
  async processPayment(data: {
    companyId: string;
    saleId: string;
    paymentMethod: string;
    amount: number;
    receivedAmount?: number;
    cashBreakdown?: CashBreakdownEntry[];
    installments?: number;
    transactionId?: string;
    authorizationCode?: string;
    cardBrand?: string;
    cardLastDigits?: string;
    nsuHost?: string;
    nsuTef?: string;
    notes?: string;
    /** Quem registra (operador) — convênio grava quem criou/autorizou a utilização. */
    userId?: string;
    /** Convênio de funcionário (EMPLOYEE_AGREEMENT) ou empresa conveniada (COMPANY_AGREEMENT). */
    employeeAgreementId?: string;
    agreementCompanyId?: string;
  }) {
    // Verificar idempotência (se transactionId já existe).
    //
    // transactionId é @unique globalmente no banco (schema.prisma), então
    // se um registro com esse transactionId já existe, há duas
    // possibilidades bem diferentes:
    //   1) É um RETRY da mesma requisição (mesma venda, mesma empresa) —
    //      devolvemos o pagamento já processado, sem cobrar de novo.
    //   2) É uma COLISÃO genuína — outro pagamento, de outra venda ou
    //      outra empresa, por acaso usou o mesmo transactionId. Isso NUNCA
    //      deve ser silenciosamente aceito como "sucesso": devolver o
    //      registro errado significaria dizer a um chamador que a venda X
    //      foi paga quando na verdade o pagamento é da venda Y.
    if (data.transactionId) {
      const existingPayment = await prisma.payment.findUnique({
        where: { transactionId: data.transactionId },
      });

      if (existingPayment) {
        if (existingPayment.saleId === data.saleId && existingPayment.companyId === data.companyId) {
          return existingPayment;
        }
        throw new Error(
          `transactionId '${data.transactionId}' already belongs to a different sale/company (not a retry — refusing to reuse it)`
        );
      }
    }

    // Buscar venda
    const sale = await prisma.sale.findFirst({
      where: {
        id: data.saleId,
        companyId: data.companyId,
      },
      include: {
        payments: true,
      },
    });

    if (!sale) {
      throw new Error('Sale not found');
    }

    if (sale.status === 'CANCELLED' || sale.status === 'RETURNED') {
      throw new Error('Cannot process payment for cancelled or returned sale');
    }

    // Capacidade restante da venda: pagamentos APROVADOS já contam como
    // dinheiro recebido, e pagamentos PENDING (ex.: um PIX ainda não
    // confirmado) já reservam capacidade — se ignorássemos os PENDING,
    // dois pagamentos "pendentes" poderiam somar mais que o total da venda
    // e, se ambos forem aprovados depois via reconciliação, a venda
    // ficaria paga em dobro.
    const approvedAmount = sale.payments
      .filter(p => p.status === 'APPROVED')
      .reduce((acc, p) => acc + Number(p.amount), 0);

    const pendingAmount = sale.payments
      .filter(p => p.status === 'PENDING')
      .reduce((acc, p) => acc + Number(p.amount), 0);

    const committedAmount = approvedAmount + pendingAmount;
    const remainingAmount = Number(sale.totalAmount) - committedAmount;

    if (remainingAmount <= 0) {
      throw new Error('Sale is already fully paid (or fully committed by pending payments)');
    }

    // Dinheiro: `amount` acima do restante (ou `receivedAmount` acima de `amount`) é o cliente entregando mais;
    // o pagamento vale só o restante e a diferença é troco (registrado à parte, nunca somado ao caixa).
    const isCash = data.paymentMethod === 'CASH';
    if (data.receivedAmount !== undefined && !isCash) {
      throw new Error('Valor recebido só se aplica a pagamento em dinheiro');
    }
    if (data.receivedAmount !== undefined && data.receivedAmount < data.amount) {
      throw new Error('Valor recebido não pode ser menor que o valor pago');
    }
    if (data.cashBreakdown && !isCash) {
      throw new Error('Cédulas só se aplicam a pagamento em dinheiro');
    }
    // Convênio (funcionário / empresa conveniada): aprovado internamente, sem gateway — fluxo próprio abaixo.
    if (isAgreementMethod(data.paymentMethod)) {
      return this.processAgreementPayment(data, sale, remainingAmount);
    }
    if (data.employeeAgreementId || data.agreementCompanyId) {
      throw new AppError('Convênio informado só vale para as formas de pagamento de convênio', 400, 'AGREEMENT_NOT_APPLICABLE');
    }
    const settings = await paymentSettingsService.getEffective(data.companyId, sale.branchId);
    // Controle de cédulas (configuração da empresa/filial): quando ligado, o dinheiro exige a composição do recebido.
    let cashBreakdown: CashBreakdownEntry[] | null = null;
    if (isCash) {
      if (settings.cashDenominationControl || data.cashBreakdown) {
        cashBreakdown = normalizeCashBreakdown(data.cashBreakdown ?? [], data.receivedAmount ?? data.amount);
      }
    }

    // Dinheiro é o único método em que "pagar a mais" é uma operação normal
    // (o cliente entrega uma nota maior e recebe troco) — isso é calculado
    // logo abaixo via `changeAmount`. Para qualquer outro método (cartão,
    // PIX, etc.) não existe conceito de troco: cobrar mais do que o
    // restante da venda é sempre um erro.
    if (data.paymentMethod !== 'CASH' && data.amount > remainingAmount) {
      throw new Error(`Payment amount exceeds remaining balance. Remaining: ${remainingAmount}`);
    }

    // Quantidade de parcelas nunca vem do cliente sem checagem: cada
    // empresa (opcionalmente por filial) define seu próprio limite via
    // InstallmentPolicy — sem política cadastrada, o padrão é 1x (à vista).
    assertInstallable(data.amount, data.installments ?? 1);
    await installmentPolicyService.validateInstallments({
      companyId: data.companyId,
      branchId: sale.branchId,
      paymentMethod: data.paymentMethod,
      installments: data.installments ?? 1,
    });

    // Selecionar o adaptador correto para o método de pagamento e iniciar
    // a cobrança. Nenhum adaptador hoje fala com um gateway real — veja
    // src/services/payment-adapters/ para o porquê de cada um se comportar
    // como se comporta (dinheiro e cartão manual resolvem na hora; PIX/TEF
    // ficam honestamente PENDING por não haver gateway integrado).
    const adapter = selectAdapter(data.paymentMethod, settings);
    if (adapter.external) {
      const provider = data.paymentMethod === 'PIX' ? settings.pixProvider : settings.cardProvider;
      return this.processExternalPayment(data, sale, adapter, provider);
    }
    const chargeResult: ChargeResult = await adapter.charge({
      amount: isCash ? Math.min(data.amount, remainingAmount) : data.amount,
      paymentMethod: data.paymentMethod,
      installments: data.installments,
      transactionId: data.transactionId,
      authorizationCode: data.authorizationCode,
      cardBrand: data.cardBrand,
      cardLastDigits: data.cardLastDigits,
      nsuHost: data.nsuHost,
      nsuTef: data.nsuTef,
      notes: data.notes,
    });

    const dbStatus = toDbStatus(chargeResult.status);

    // Se o gateway (ou a ausência dele) devolveu um status transiente
    // (TIMEOUT/UNKNOWN), preservamos o motivo nas notas do pagamento para
    // quem for reconciliar depois — sem isso, um PENDING por timeout fica
    // indistinguível de um PENDING "normal" de PIX aguardando o cliente.
    const notes = chargeResult.reason
      ? [data.notes, `[gateway:${chargeResult.status}] ${chargeResult.reason}`].filter(Boolean).join(' | ')
      : data.notes;

    // Criar pagamento em transação (com proteção real contra corrida:
    // a verificação acima é otimista, mas a garantia definitiva é a
    // constraint UNIQUE em transactionId no banco — se duas requisições
    // concorrentes chegarem aqui com o mesmo transactionId, a segunda
    // `create` falha com P2002 e devolvemos o pagamento já existente
    // em vez de propagar um erro genérico ou criar cobrança duplicada).
    try {
      return await runInTransaction(async (tx) => {
        // ACHADO DE AUDITORIA (mesma classe do bug de estoque já corrigido
        // em sale.service.ts): `approvedAmount`/`remainingAmount` acima são
        // otimistas, calculados ANTES desta transação a partir de uma
        // leitura solta. Duas chamadas concorrentes a processPayment() para
        // a mesma venda (ex.: dois pagamentos CASH parciais, sem
        // transactionId — então sem a proteção da constraint UNIQUE) leem o
        // mesmo `approvedAmount` desatualizado, ambas passam a checagem de
        // "ainda falta pagar" e ambas são aprovadas: a venda fica
        // subavaliada em `paidAmount` (a 2ª aprovação sobrescreve o
        // `newTotalPaid` da 1ª usando o mesmo valor base stale), mesmo
        // tendo recebido dinheiro em dobro. `SELECT ... FOR UPDATE` na
        // linha da venda serializa as transações concorrentes; só depois
        // religemos os pagamentos já aprovados (agora refletindo qualquer
        // aprovação concorrente que tenha comitado primeiro) e revalidamos
        // antes de aplicar os efeitos financeiros deste pagamento.
        await lockSaleForPayment(tx, data.saleId);

        const approvedPayments = await tx.payment.findMany({
          where: { saleId: data.saleId, status: 'APPROVED' },
          select: { amount: true },
        });
        const freshApprovedAmount = approvedPayments.reduce((acc, p) => acc + Number(p.amount), 0);

        const freshRemainingAmount = Number(sale.totalAmount) - freshApprovedAmount;
        if (dbStatus === 'APPROVED') {
          if (freshRemainingAmount <= 0) {
            throw new Error('Sale is already fully paid (concurrent payment approved first)');
          }
          if (!isCash && data.amount > freshRemainingAmount) {
            throw new Error(
              `Payment amount exceeds remaining balance. Remaining: ${freshRemainingAmount}`
            );
          }
        }
        const appliedAmount = isCash ? round2(Math.min(data.amount, freshRemainingAmount)) : data.amount;
        const receivedAmount = isCash ? data.receivedAmount ?? data.amount : null;
        const changeAmount = isCash ? round2(receivedAmount! - appliedAmount) : 0;

        // Criar pagamento
        const payment = await tx.payment.create({
          data: {
            companyId: data.companyId,
            saleId: data.saleId,
            paymentMethod: data.paymentMethod as any,
            status: dbStatus,
            amount: appliedAmount,
            receivedAmount,
            changeAmount,
            ...(cashBreakdown ? { cashBreakdown } : {}),
            installments: data.installments || 1,
            transactionId: data.transactionId,
            authorizationCode: chargeResult.authorizationCode ?? data.authorizationCode,
            cardBrand: data.cardBrand,
            cardLastDigits: data.cardLastDigits,
            nsuHost: chargeResult.nsuHost ?? data.nsuHost,
            nsuTef: chargeResult.nsuTef ?? data.nsuTef,
            paidAt: dbStatus === 'APPROVED' ? new Date() : null,
            notes,
          },
        });

        // Só aplicamos os efeitos financeiros (atualizar valores da venda e
        // registrar movimento de caixa) quando o pagamento é efetivamente
        // APROVADO. Um pagamento PENDING (PIX/TEF sem gateway) não deve
        // mexer no saldo da venda nem no caixa — o dinheiro ainda não está
        // confirmado.
        if (dbStatus === 'APPROVED') {
          await this.applyApprovedPaymentEffects(tx, payment, sale, freshApprovedAmount);
        }

        return payment;
      });
    } catch (error: any) {
      // P2002 = violação de constraint única (Prisma). Se for o transactionId,
      // é uma corrida de idempotência: outra requisição concorrente já criou
      // o pagamento. Buscamos e devolvemos o registro existente — mas, assim
      // como na checagem otimista acima, só se ele realmente pertencer a
      // esta mesma venda/empresa (senão é uma colisão real, não um retry).
      if (error?.code === 'P2002' && data.transactionId) {
        const existing = await prisma.payment.findUnique({
          where: { transactionId: data.transactionId },
        });
        if (existing && existing.saleId === data.saleId && existing.companyId === data.companyId) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Convênio (docs/CORTEX/policies/CONVENIOS.md). Aprovado internamente (não há dinheiro nem gateway): numa ÚNICA
   * transação, com a venda travada, grava o pagamento APPROVED, cria a utilização + parcelas em folha (funcionário) ou a
   * conta a receber (empresa conveniada) conferindo situação e limite com a linha do convênio travada, e aplica os
   * efeitos de pagamento aprovado. Caixa: segue a regra atual (`applyApprovedPaymentEffects`) — o movimento SALE é
   * registrado com a forma de pagamento EMPLOYEE_AGREEMENT/COMPANY_AGREEMENT e soma ao esperado, como cartão/PIX; NÃO é
   * dinheiro da gaveta (conciliar gaveta × total é a decisão contábil pendente "esperado inclui cartão/PIX").
   */
  private async processAgreementPayment(
    data: { companyId: string; saleId: string; paymentMethod: string; amount: number; installments?: number; transactionId?: string; notes?: string; userId?: string; employeeAgreementId?: string; agreementCompanyId?: string },
    sale: { id: string; totalAmount: Prisma.Decimal | number; branchId: string | null; saleNumber: number; cashRegisterId: string | null; userId: string | null },
    remainingAmount: number
  ) {
    const isEmployee = data.paymentMethod === 'EMPLOYEE_AGREEMENT';
    const policies = await policyService.effective(data.companyId, sale.branchId);
    if (isEmployee ? !policies['employeeAgreement.enabled'] : !policies['companyAgreement.enabled']) {
      throw new AppError(isEmployee ? DISABLED_MESSAGE.employee : DISABLED_MESSAGE.company, 400, 'AGREEMENT_DISABLED');
    }
    const agreementId = isEmployee ? data.employeeAgreementId : data.agreementCompanyId;
    if (!agreementId || (isEmployee ? data.agreementCompanyId : data.employeeAgreementId)) {
      throw new AppError(
        isEmployee ? 'Informe o funcionário conveniado (employeeAgreementId)' : 'Informe a empresa conveniada (agreementCompanyId)',
        400,
        'AGREEMENT_REQUIRED'
      );
    }
    const installments = data.installments ?? 1;
    const maxInstallments = isEmployee ? policies['employeeAgreement.maxInstallments'] : 1;
    if (!Number.isInteger(installments) || installments < 1 || installments > maxInstallments) {
      throw new AppError(`Parcelas inválidas: de 1 a ${maxInstallments}`, 400, 'INSTALLMENTS_INVALID');
    }
    assertInstallable(data.amount, installments);
    const amount = round2(data.amount);
    if (amount > round2(remainingAmount)) {
      throw new Error(`Payment amount exceeds remaining balance. Remaining: ${remainingAmount}`);
    }
    const timezone = policies['company.timezone'];

    try {
      return await runInTransaction(async (tx) => {
        await lockSaleForPayment(tx, sale.id);
        const committed = await tx.payment.findMany({ where: { saleId: sale.id, status: { in: ['APPROVED', 'PENDING'] } }, select: { amount: true, status: true } });
        const committedAmount = committed.reduce((acc, p) => acc + Number(p.amount), 0);
        const remaining = round2(Number(sale.totalAmount) - committedAmount);
        if (remaining <= 0) throw new Error('Sale is already fully paid (or fully committed by pending payments)');
        if (amount > remaining) throw new Error(`Payment amount exceeds remaining balance. Remaining: ${remaining}`);
        const approvedBefore = committed.filter((p) => p.status === 'APPROVED').reduce((acc, p) => acc + Number(p.amount), 0);

        // Convênio travado antes do INSERT (a FK composta toma KEY SHARE no INSERT; travar depois é impasse).
        if (isEmployee) await employeeAgreementService.lockForPayment(tx, data.companyId, agreementId);
        else await agreementCompanyService.lockForPayment(tx, data.companyId, agreementId);

        const payment = await tx.payment.create({
          data: {
            companyId: data.companyId,
            saleId: sale.id,
            paymentMethod: data.paymentMethod as any,
            status: 'APPROVED',
            amount,
            installments,
            transactionId: data.transactionId,
            paidAt: new Date(),
            notes: data.notes,
            ...(isEmployee ? { employeeAgreementId: agreementId } : { agreementCompanyId: agreementId }),
          },
        });

        if (isEmployee) {
          await employeeAgreementService.createChargeForPayment(tx, {
            companyId: data.companyId,
            branchId: sale.branchId,
            agreementId,
            saleId: sale.id,
            paymentId: payment.id,
            amount,
            installments,
            userId: data.userId,
            timezone,
            policy: { limitType: policies['employeeAgreement.limitType'], limitValue: Number(policies['employeeAgreement.limitValue']) },
          });
        } else {
          await agreementCompanyService.createReceivableForPayment(tx, {
            companyId: data.companyId,
            agreementCompanyId: agreementId,
            sale: { id: sale.id, saleNumber: sale.saleNumber, branchId: sale.branchId },
            paymentId: payment.id,
            amount,
            timezone,
          });
        }

        await this.applyApprovedPaymentEffects(tx, payment, sale, approvedBefore);
        return payment;
      });
    } catch (error: any) {
      if (error?.code === 'P2002' && data.transactionId) {
        const existing = await prisma.payment.findUnique({ where: { transactionId: data.transactionId } });
        if (existing && existing.saleId === sale.id && existing.companyId === data.companyId) return existing;
      }
      throw error;
    }
  }

  /**
   * Terminal/provedor externo (TEF, PSP de PIX) — intenção primeiro: (1) grava o pagamento PENDING com a chave de
   * idempotência, sob lock da venda, reservando o saldo; (2) aciona o provedor com o valor da venda (o operador não
   * redigita); (3) liquida pelo resultado. Exceção ou falta de resposta NUNCA vira recusa: fica PENDING para
   * reconciliação (`reconcilePayment`), e uma nova tentativa com a mesma chave devolve este mesmo pagamento sem cobrar.
   */
  private async processExternalPayment(
    data: { companyId: string; saleId: string; paymentMethod: string; amount: number; installments?: number; transactionId?: string; notes?: string },
    sale: { id: string; totalAmount: Prisma.Decimal | number },
    adapter: PaymentGatewayAdapter,
    provider: string
  ) {
    const transactionId = data.transactionId ?? `srv-${randomUUID()}`;
    let intent;
    try {
      intent = await runInTransaction(async (tx) => {
        await lockSaleForPayment(tx, sale.id);
        const committed = await tx.payment.findMany({ where: { saleId: sale.id, status: { in: ['APPROVED', 'PENDING'] } }, select: { amount: true } });
        const remaining = Number(sale.totalAmount) - committed.reduce((acc, p) => acc + Number(p.amount), 0);
        if (remaining <= 0) throw new Error('Sale is already fully paid (or fully committed by pending payments)');
        if (data.amount > remaining) throw new Error(`Payment amount exceeds remaining balance. Remaining: ${remaining}`);
        return tx.payment.create({
          data: {
            companyId: data.companyId,
            saleId: sale.id,
            paymentMethod: data.paymentMethod as any,
            status: 'PENDING',
            amount: data.amount,
            installments: data.installments || 1,
            transactionId,
            provider,
            notes: [data.notes, `[${adapter.name}] aguardando o provedor`].filter(Boolean).join(' | '),
          },
        });
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const existing = await prisma.payment.findUnique({ where: { transactionId } });
        if (existing && existing.saleId === sale.id && existing.companyId === data.companyId) return existing;
      }
      throw error;
    }

    let result: ChargeResult;
    try {
      result = await adapter.charge({ amount: data.amount, paymentMethod: data.paymentMethod, installments: data.installments, transactionId, notes: data.notes });
    } catch (error: any) {
      result = { status: 'UNKNOWN', reason: `sem resposta do provedor: ${error?.message ?? error}` };
    }
    return this.settlePayment(intent.id, result);
  }

  /**
   * Liquida um pagamento PENDING pelo resultado do provedor. Guarda atômica (PENDING → final): chamadas concorrentes
   * (processamento + reconciliação, ou duas reconciliações) aplicam os efeitos financeiros uma única vez.
   */
  private async settlePayment(paymentId: string, result: ChargeResult) {
    const dbStatus = toDbStatus(result.status);
    return runInTransaction(async (tx) => {
      if (dbStatus === 'PENDING') {
        if (result.reason) {
          const current = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
          await tx.payment.updateMany({
            where: { id: paymentId, status: 'PENDING' },
            data: { notes: [current.notes, `[gateway:${result.status}] ${result.reason}`].filter(Boolean).join(' | ') },
          });
        }
        return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      }
      if (dbStatus === 'APPROVED') {
        // Trava a venda antes de liquidar. Venda já cancelada/devolvida: o provedor aprovou mesmo assim — registra o fato
        // e abre exceção (antes a liquidação falhava e o pagamento ficava PENDING para sempre, sem alerta).
        const { saleId } = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { saleId: true } });
        const [sale] = await tx.$queryRaw<Array<{ status: string; branchId: string | null }>>`SELECT status::text AS status, "branchId" FROM sales WHERE id = ${saleId} FOR UPDATE`;
        if (sale && (sale.status === 'CANCELLED' || sale.status === 'RETURNED')) {
          return this.recordApprovalOnClosedSale(tx, paymentId, result, sale);
        }
      }
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: {
          status: dbStatus,
          paidAt: dbStatus === 'APPROVED' ? new Date() : null,
          ...(dbStatus === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
          ...(result.authorizationCode ? { authorizationCode: result.authorizationCode } : {}),
          ...(result.nsuHost ? { nsuHost: result.nsuHost } : {}),
          ...(result.nsuTef ? { nsuTef: result.nsuTef } : {}),
        },
      });
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { sale: true } });
      if (claimed.count === 0 || dbStatus !== 'APPROVED') return payment;
      const others = await tx.payment.findMany({ where: { saleId: payment.saleId, status: 'APPROVED', id: { not: paymentId } }, select: { amount: true } });
      await this.applyApprovedPaymentEffects(tx, payment, payment.sale, others.reduce((acc, p) => acc + Number(p.amount), 0));
      return payment;
    });
  }

  /**
   * Provedor aprovou/capturou depois que a venda foi cancelada/devolvida. O CÓRTEX registra a verdade: pagamento
   * APPROVED (com os dados do provedor); a venda NÃO muda (continua cancelada/devolvida); nada entra no caixa (o dinheiro
   * está no provedor, não na gaveta); abre uma exceção para tratamento. O que fazer com o dinheiro (estornar sempre,
   * aceitar, decidir caso a caso) é [DECISÃO NECESSÁRIA] — nada é decidido automaticamente aqui.
   */
  private async recordApprovalOnClosedSale(
    tx: PrismaTransactionClient,
    paymentId: string,
    result: ChargeResult,
    sale: { status: string; branchId: string | null }
  ) {
    const current = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        paidAt: new Date(),
        ...(result.authorizationCode ? { authorizationCode: result.authorizationCode } : {}),
        ...(result.nsuHost ? { nsuHost: result.nsuHost } : {}),
        ...(result.nsuTef ? { nsuTef: result.nsuTef } : {}),
        notes: [current.notes, `[INCONSISTÊNCIA DE INTEGRAÇÃO] provedor aprovou com a venda ${sale.status === 'CANCELLED' ? 'cancelada' : 'devolvida'}: tratar em Financeiro › Conciliação`]
          .filter(Boolean)
          .join(' | '),
      },
    });
    if (claimed.count === 1) {
      await tx.paymentException.create({
        data: {
          companyId: current.companyId,
          branchId: sale.branchId,
          paymentId,
          saleId: current.saleId,
          type: PAYMENT_EXCEPTION_APPROVED_ON_CLOSED_SALE,
          saleStatus: sale.status,
          amount: current.amount,
          provider: current.provider,
          providerStatus: result.status,
        },
      });
    }
    return tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { sale: true } });
  }

  /**
   * Pagamento que virou exceção (aprovado com a venda já encerrada) não passa pelo cancelamento/estorno comum: nada dele
   * entrou no caixa nem na venda, então "reverter" lançaria saída de caixa sem a entrada correspondente e reabriria a
   * venda encerrada — e o dinheiro continuaria no provedor. O tratamento é pela exceção (estorno no provedor ou registro
   * manual). Conferido DENTRO da transação da guarda de status: a exceção nasce na mesma transação que aprova o pagamento,
   * então quem enxerga APPROVED enxerga a exceção (a reconciliação concorrente não escapa).
   */
  private async assertNotPaymentException(tx: PrismaTransactionClient, paymentId: string) {
    const exception = await tx.paymentException.findFirst({ where: { paymentId }, select: { id: true } });
    if (exception) {
      throw new ConflictError(
        'Este pagamento foi aprovado pelo provedor depois que a venda foi encerrada. Trate a inconsistência de integração em Financeiro › Conciliação (estorno no provedor ou registro manual).',
        'PAYMENT_IN_EXCEPTION'
      );
    }
  }

  async listPaymentExceptions(companyId: string, options: { open?: boolean } = {}) {
    return prisma.paymentException.findMany({
      where: { companyId, ...(options.open ? { resolvedAt: null } : {}) },
      include: { payment: { select: { id: true, paymentMethod: true, status: true, transactionId: true, authorizationCode: true } } },
      orderBy: { detectedAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Tratamento de uma exceção. Não decide regra comercial: executa a ação que uma pessoa autorizada escolheu.
   * - REFUND: estorna no provedor (idempotente pela transação); só marca REFUNDED com a confirmação do provedor.
   *   A exceção é "reservada" antes de chamar o provedor: dois pedidos simultâneos nunca estornam duas vezes.
   * - MANUAL: registra que foi tratada fora do sistema, com justificativa obrigatória (sem movimentar dinheiro).
   */
  async resolvePaymentException(id: string, companyId: string, userId: string, action: 'REFUND' | 'MANUAL', note?: string) {
    const exception = await prisma.paymentException.findFirst({ where: { id, companyId }, include: { payment: true } });
    if (!exception) throw new AppError('Inconsistência de integração não encontrada', 404, 'PAYMENT_EXCEPTION_NOT_FOUND');
    if (exception.resolvedAt) throw new ConflictError('Esta inconsistência já foi tratada', 'PAYMENT_EXCEPTION_RESOLVED');
    const trimmed = note?.trim() ?? '';

    if (action === 'MANUAL') {
      if (trimmed.length < 10) throw new AppError('Descreva como a inconsistência foi tratada (mínimo 10 caracteres)', 400, 'NOTE_REQUIRED');
      const done = await prisma.paymentException.updateMany({
        where: { id, resolvedAt: null, resolution: null },
        data: { resolvedAt: new Date(), resolution: 'MANUAL', resolvedBy: userId, notes: trimmed },
      });
      if (done.count === 0) throw new ConflictError('Esta inconsistência já está sendo tratada', 'PAYMENT_EXCEPTION_BUSY');
      return prisma.paymentException.findUniqueOrThrow({ where: { id } });
    }

    const payment = exception.payment;
    const adapter = payment.provider ? providerAdapter(payment.provider, payment.paymentMethod === 'PIX' ? 'pix' : 'card') : undefined;
    if (!adapter?.refund || !payment.transactionId) {
      throw new ConflictError('Estorno indisponível para este provedor: trate fora do sistema e registre como tratamento manual.', 'REFUND_UNAVAILABLE');
    }
    const reserved = await prisma.paymentException.updateMany({ where: { id, resolvedAt: null, resolution: null }, data: { resolution: 'REFUND_IN_PROGRESS', resolvedBy: userId } });
    if (reserved.count === 0) throw new ConflictError('Esta inconsistência já está sendo tratada', 'PAYMENT_EXCEPTION_BUSY');

    let result: ChargeResult;
    try {
      result = await adapter.refund(payment.transactionId, Number(payment.amount));
    } catch {
      result = { status: 'UNKNOWN' };
    }
    if (result.status !== 'REFUNDED' && result.status !== 'CANCELLED') {
      // Sem confirmação: libera a exceção para nova tentativa (o provedor é idempotente pela transação).
      await prisma.paymentException.updateMany({ where: { id, resolution: 'REFUND_IN_PROGRESS' }, data: { resolution: null, resolvedBy: null } });
      throw new ConflictError('O provedor não confirmou o estorno. Nada foi alterado; tente de novo.', 'REFUND_UNCONFIRMED');
    }
    return runInTransaction(async (tx) => {
      await tx.payment.updateMany({ where: { id: payment.id, status: 'APPROVED' }, data: { status: 'REFUNDED', refundedAt: new Date() } });
      await tx.paymentException.update({
        where: { id },
        data: { resolvedAt: new Date(), resolution: 'REFUNDED', notes: trimmed || null },
      });
      return tx.paymentException.findUniqueOrThrow({ where: { id } });
    });
  }

  // Aplica os efeitos financeiros de um pagamento aprovado: atualiza o
  // status/saldo da venda e registra o movimento de caixa. Compartilhado
  // entre `processPayment` (aprovação imediata) e `reconcilePayment`
  // (aprovação tardia, quando um pagamento que estava PENDING é resolvido).
  private async applyApprovedPaymentEffects(
    tx: PrismaTransactionClient,
    payment: { id: string; amount: Prisma.Decimal | number; paymentMethod: string; changeAmount?: Prisma.Decimal | number },
    sale: { id: string; totalAmount: Prisma.Decimal | number; cashRegisterId: string | null; userId: string | null; saleNumber: number },
    previouslyApprovedAmount: number
  ) {
    // reconcilePayment chega aqui sem ter travado a venda; processPayment já travou (reentrante na mesma transação).
    await lockSaleForPayment(tx, sale.id);
    const newTotalPaid = previouslyApprovedAmount + Number(payment.amount);
    const totalAmount = Number(sale.totalAmount);

    let status: 'PAID' | 'PARTIALLY_PAID' | 'PENDING' = 'PENDING';
    if (newTotalPaid >= totalAmount) {
      status = 'PAID';
    } else if (newTotalPaid > 0) {
      status = 'PARTIALLY_PAID';
    }

    await tx.sale.update({
      where: { id: sale.id },
      data: {
        status,
        paidAmount: newTotalPaid,
        changeAmount: { increment: Number(payment.changeAmount ?? 0) },
      },
    });

    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: um pagamento PENDING (PIX/TEF) pode
    // ser aprovado/reconciliado (`reconcilePayment`) bem depois da venda —
    // inclusive depois que o caixa daquele turno já foi fechado. Sem esta
    // checagem, o movimento/expectedAmount abaixo mexiam num caixa já
    // fechado (imutável por regra — mesmo princípio de cancelSale/
    // sale.service.ts: um caixa fechado nunca é reescrito retroativamente).
    // A venda continua tendo seu status/paidAmount atualizados acima —
    // o pagamento é real — só o lançamento de caixa deste turno específico
    // é pulado quando o caixa não está mais aberto para recebê-lo.
    // Venda de CANAL (sem caixa físico, sem operador): o dinheiro não passa pela gaveta, então não há movimento de caixa nem ajuste do
    // esperado. Venda física sempre tem os dois (CHECK `sales_physical_origin_check` no banco). Pagamento externo fica no próprio pedido.
    if (!sale.cashRegisterId || !sale.userId) return;
    const register = await tx.cashRegister.findUnique({ where: { id: sale.cashRegisterId } });
    if (!register || register.status !== 'OPEN') {
      return;
    }

    await tx.cashMovement.create({
      data: {
        cashRegisterId: sale.cashRegisterId,
        movementType: 'SALE',
        amount: payment.amount,
        paymentMethod: payment.paymentMethod as any,
        referenceType: 'Payment',
        referenceId: payment.id,
        notes: `Pagamento da venda #${sale.saleNumber}`,
        userId: sale.userId,
      },
    });

    // CORREÇÃO: cash-register.service.ts incrementa `expectedAmount` a cada
    // movimento de sangria/reforço (addCashMovement) e o recalcula do zero
    // ao fechar o caixa (somando também os movimentos SALE) — mas nada
    // incrementava `expectedAmount` quando o movimento SALE era criado aqui.
    // Resultado: o caixa exibido durante o dia (GET /cash-register/current)
    // nunca refletia as vendas, só sangria/reforço manuais, embora o valor
    // no fechamento acabasse correto (recalculado do zero a partir dos
    // movimentos). Mantém a mesma semântica do fechamento: todo pagamento
    // (qualquer forma) soma ao valor esperado do caixa.
    await tx.cashRegister.update({
      where: { id: sale.cashRegisterId },
      data: { expectedAmount: { increment: Number(payment.amount) } },
    });
  }

  // Reconciliar um pagamento pendente/incerto (PENDING vindo de TIMEOUT,
  // UNKNOWN, ou de um PIX/TEF genuinamente ainda aguardando confirmação).
  //
  // NUNCA trata timeout/pendência como prova de falha: em vez de recobrar
  // ou cancelar automaticamente, consulta o status atual junto ao
  // adaptador (que, para um gateway real, chamaria a API de consulta de
  // status) e só então decide o que fazer. Pagamentos já em estado final
  // (APPROVED/REJECTED/CANCELLED/REFUNDED) são devolvidos sem qualquer
  // reprocessamento — reconciliar um pagamento já resolvido não deve
  // duplicar seus efeitos.
  /**
   * Reconciliação automática (job `reconcile-external-payments`): consulta o provedor de cada pagamento externo ainda
   * PENDING há mais de `olderThanMs` (dá tempo à resposta normal chegar). Cada um no contexto da própria empresa.
   */
  async reconcilePendingExternal(options: { olderThanMs?: number; limit?: number } = {}) {
    const cutoff = new Date(Date.now() - (options.olderThanMs ?? 60_000));
    const pending = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
      prisma.payment.findMany({
        where: { status: 'PENDING', provider: { not: null }, transactionId: { not: null }, createdAt: { lt: cutoff } },
        select: { id: true, companyId: true },
        orderBy: { createdAt: 'asc' },
        take: options.limit ?? 100,
      })
    );
    let settled = 0;
    for (const p of pending) {
      try {
        const result = await runWithRLSContext({ companyId: p.companyId, userType: 'SUPER_ADMIN', branchId: null }, () => this.reconcilePayment(p.id, p.companyId));
        if (result.status !== 'PENDING') settled++;
      } catch {
        // um provedor fora do ar não impede os demais; o pagamento segue PENDING para a próxima rodada
      }
    }
    return { checked: pending.length, settled };
  }

  async reconcilePayment(id: string, companyId: string) {
    const payment = await prisma.payment.findFirst({
      where: { id, companyId },
      include: {
        sale: {
          include: { payments: true },
        },
      },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      // Já resolvido — reconciliar de novo não deve reaplicar efeitos
      // financeiros nem sobrescrever o resultado.
      return payment;
    }

    if (!payment.transactionId) {
      // Sem transactionId não há nada para consultar num gateway — este
      // pagamento só pode ser resolvido manualmente (cancelPayment, ou uma
      // nova tentativa via processPayment com um novo transactionId).
      return payment;
    }

    // Consulta o MESMO provedor que processou (gravado no pagamento), mesmo que a configuração tenha mudado.
    const kind = payment.paymentMethod === 'PIX' ? 'pix' : 'card';
    const adapter = payment.provider ? providerAdapter(payment.provider, kind) : selectAdapter(payment.paymentMethod);
    if (!adapter) throw new Error(`Provedor de pagamento "${payment.provider}" indisponível neste servidor`);
    let result: ChargeResult;
    try {
      result = await adapter.checkStatus(payment.transactionId);
    } catch (error: any) {
      result = { status: 'UNKNOWN', reason: `consulta ao provedor falhou: ${error?.message ?? error}` };
    }
    // Continua incerto → devolve como está, sem gravar (a reconciliação periódica não acumula notas; nunca recobra
    // nem recusa por falta de resposta). Final → liquida com guarda.
    if (toDbStatus(result.status) === 'PENDING') return payment;
    return this.settlePayment(payment.id, result);
  }

  // Listar pagamentos
  async listPayments(filters: {
    companyId: string;
    saleId?: string;
    paymentMethod?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      companyId,
      saleId,
      paymentMethod,
      status,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = filters;

    const where: Prisma.PaymentWhereInput = {
      companyId,
      ...(saleId && { saleId }),
      ...(paymentMethod && { paymentMethod: paymentMethod as any }),
      ...(status && { status: status as any }),
      ...(startDate || endDate
        ? {
            paidAt: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }
        : {}),
    };

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          sale: {
            include: {
              customer: true,
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.count({ where }),
    ]);

    return {
      payments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Consultar pagamento por transactionId — isolado por tenant (companyId
  // vem do usuário autenticado, nunca do cliente)
  async getPaymentByTransactionId(transactionId: string, companyId: string) {
    return await prisma.payment.findFirst({
      where: { transactionId, companyId },
      include: {
        sale: true,
      },
    });
  }

  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: `applyApprovedPaymentEffects` soma ao
  // `expectedAmount` do caixa quando um pagamento é aprovado (ver comentário
  // acima), mas nem `cancelPayment` nem `refundPayment` desfaziam essa soma
  // — um pagamento aprovado podia ser cancelado/estornado e o caixa
  // continuava "esperando" um dinheiro que o próprio sistema já tinha
  // marcado como devolvido/sem efeito. Mesmo princípio de reversão já
  // usado em sale.service.ts::cancelSale (CANCELLATION, só em caixa OPEN).
  private async reverseCashForApprovedPayment(
    tx: PrismaTransactionClient,
    payment: { id: string; amount: Prisma.Decimal | number; paymentMethod?: string | null },
    sale: { id: string; cashRegisterId: string | null; saleNumber: number },
    userId: string,
    label: 'cancelamento' | 'estorno'
  ) {
    if (!sale.cashRegisterId) return;
    const register = await tx.cashRegister.findUnique({ where: { id: sale.cashRegisterId } });
    if (!register || register.status !== 'OPEN') return;

    await tx.cashMovement.create({
      data: {
        cashRegisterId: sale.cashRegisterId,
        movementType: 'CANCELLATION',
        amount: payment.amount,
        // Forma do pagamento estornado: o fechamento confronta o esperado por forma (CAIXA.md).
        ...(payment.paymentMethod ? { paymentMethod: payment.paymentMethod as any } : {}),
        referenceType: 'PaymentReversal',
        referenceId: payment.id,
        notes: `${label === 'cancelamento' ? 'Cancelamento' : 'Estorno'} de pagamento da venda #${sale.saleNumber}`,
        userId,
      },
    });
    await tx.cashRegister.update({
      where: { id: sale.cashRegisterId },
      data: { expectedAmount: { decrement: Number(payment.amount) } },
    });
  }

  // Cancelar pagamento
  async cancelPayment(id: string, companyId: string, userId: string) {
    const payment = await prisma.payment.findFirst({
      where: { id, companyId },
      include: {
        sale: true,
      },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    if (payment.status === 'CANCELLED' || payment.status === 'REFUNDED') {
      throw new Error('Payment already cancelled or refunded');
    }

    // Transação ainda aberta num terminal/PSP: cancelar só aqui deixava o provedor livre para capturar depois (cliente
    // cobrado, venda sem pagamento — a liquidação ignora o que não está mais PENDING). O provedor decide primeiro.
    if (payment.status === 'PENDING' && payment.provider && payment.provider !== MANUAL_PROVIDER && payment.transactionId) {
      await this.cancelAtProvider({ ...payment, provider: payment.provider, transactionId: payment.transactionId });
    }

    const wasApproved = payment.status === 'APPROVED';

    return await runInTransaction(async (tx) => {
      // Guarda atômica no status LIDO: cancelamento concorrente, ou uma liquidação (reconciliação aprovando o PENDING)
      // entre a leitura e aqui, não passa — antes o cancelamento seguia com `wasApproved` desatualizado e o caixa
      // da aprovação não era revertido.
      const cancelUpdate = await tx.payment.updateMany({
        where: { id, status: payment.status },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (cancelUpdate.count === 0) {
        const current = await tx.payment.findUniqueOrThrow({ where: { id }, select: { status: true } });
        if (current.status === 'CANCELLED' || current.status === 'REFUNDED') {
          throw new Error('Payment already cancelled or refunded');
        }
        throw new ConflictError('O pagamento mudou de situação enquanto era cancelado. Atualize e tente de novo.', 'PAYMENT_STATUS_CHANGED');
      }
      await this.assertNotPaymentException(tx, id);
      const updatedPayment = await tx.payment.findUniqueOrThrow({ where: { id } });

      // Recalcular status da venda
      const payments = await tx.payment.findMany({
        where: {
          saleId: payment.saleId,
          status: 'APPROVED',
        },
      });

      const totalPaid = payments.reduce((acc, p) => acc + Number(p.amount), 0);
      const status = await saleStatusAfterReversal(tx, payment.saleId, totalPaid, Number(payment.sale.totalAmount));

      await tx.sale.update({
        where: { id: payment.saleId },
        data: {
          status,
          paidAmount: totalPaid,
        },
      });

      if (wasApproved) {
        await this.reverseCashForApprovedPayment(tx, payment, payment.sale, userId, 'cancelamento');
      }
      // Convênio: parcelas em folha ainda não processadas / conta a receber em aberto são canceladas (sem apagar).
      if (isAgreementMethod(payment.paymentMethod)) {
        await reverseAgreementEffects(tx, { paymentIds: [id] }, userId, `cancelamento do pagamento da venda #${payment.sale.saleNumber}`);
      }

      return updatedPayment;
    });
  }

  /**
   * Pede ao provedor que desfaça uma transação ainda pendente. Só segue para o cancelamento local quando o provedor
   * confirma (CANCELLED/DECLINED). Se ele já tinha aprovado, o pagamento é liquidado como aprovado e o cancelamento é
   * recusado (devolver dinheiro é estorno). Sem resposta, sem suporte ou resposta incerta: nada muda e o operador sabe.
   */
  private async cancelAtProvider(payment: { id: string; paymentMethod: string; provider: string; transactionId: string }) {
    const adapter = providerAdapter(payment.provider, payment.paymentMethod === 'PIX' ? 'pix' : 'card');
    if (!adapter) {
      throw new ConflictError(`Provedor de pagamento "${payment.provider}" indisponível neste servidor: o pagamento segue pendente`, 'PROVIDER_UNAVAILABLE');
    }
    if (!adapter.cancel) {
      throw new ConflictError(
        'Este provedor não permite cancelar uma transação pendente. Verifique o status: se aprovada, faça o estorno.',
        'PROVIDER_CANCEL_UNSUPPORTED'
      );
    }
    let result: ChargeResult;
    try {
      result = await adapter.cancel(payment.transactionId);
    } catch {
      throw new ConflictError('Sem resposta do provedor ao cancelar: o pagamento segue pendente. Tente de novo ou verifique o status.', 'PROVIDER_NO_RESPONSE');
    }
    if (result.status === 'APPROVED') {
      await this.settlePayment(payment.id, result);
      throw new ConflictError('O provedor já tinha aprovado esta transação: o pagamento foi confirmado. Para devolver o valor, faça o estorno.', 'PROVIDER_ALREADY_APPROVED');
    }
    if (result.status !== 'CANCELLED' && result.status !== 'DECLINED') {
      throw new ConflictError('O provedor não confirmou o cancelamento: o pagamento segue pendente. Tente de novo ou verifique o status.', 'PROVIDER_CANCEL_UNCONFIRMED');
    }
  }

  // Estornar pagamento
  async refundPayment(id: string, companyId: string, userId: string) {
    const payment = await prisma.payment.findFirst({
      where: { id, companyId },
      include: { sale: true },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    if (payment.status !== 'APPROVED') {
      throw new Error('Only approved payments can be refunded');
    }

    return await runInTransaction(async (tx) => {
      // Mesma guarda atômica de cancelPayment — evita duplo-estorno
      // concorrente do mesmo pagamento.
      const refundUpdate = await tx.payment.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'REFUNDED', refundedAt: new Date() },
      });
      if (refundUpdate.count === 0) {
        throw new Error('Only approved payments can be refunded');
      }
      await this.assertNotPaymentException(tx, id);
      const updatedPayment = await tx.payment.findUniqueOrThrow({ where: { id } });

      // Recalcular status/paidAmount da venda sem este pagamento (mesma
      // lógica de cancelPayment) — um estorno também precisa refletir no
      // saldo da venda, não só no caixa.
      const payments = await tx.payment.findMany({
        where: { saleId: payment.saleId, status: 'APPROVED' },
      });
      const totalPaid = payments.reduce((acc, p) => acc + Number(p.amount), 0);
      const status = await saleStatusAfterReversal(tx, payment.saleId, totalPaid, Number(payment.sale.totalAmount));
      await tx.sale.update({
        where: { id: payment.saleId },
        data: { status, paidAmount: totalPaid },
      });

      await this.reverseCashForApprovedPayment(tx, payment, payment.sale, userId, 'estorno');
      if (isAgreementMethod(payment.paymentMethod)) {
        await reverseAgreementEffects(tx, { paymentIds: [id] }, userId, `estorno do pagamento da venda #${payment.sale.saleNumber}`);
      }

      return updatedPayment;
    });
  }
}

export default new PaymentService();
