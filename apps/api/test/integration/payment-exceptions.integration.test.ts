import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { registerPaymentProvider, ChargeRequest, ChargeResult, PaymentGatewayAdapter } from '../../src/services/payment-adapters';
import paymentService from '../../src/services/payment.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Provedor aprova/captura DEPOIS que a venda foi cancelada/devolvida (docs/CORTEX/BUSINESS_RULES.md, "Exceções de
 * pagamento"). O CÓRTEX registra a verdade (pagamento APPROVED), não mexe na venda nem no caixa e abre UMA exceção.
 * O tratamento (estorno no provedor ou registro manual) é uma ação explícita de quem pode estornar; a política comercial
 * é [DECISÃO NECESSÁRIA]. Terminal FALSO, registrado só neste processo de teste.
 */
class ExceptionTerminal implements PaymentGatewayAdapter {
  readonly name: string = 'test-exc-terminal';
  readonly external = true;
  providerStatus = new Map<string, ChargeResult['status']>();
  chargeReply: 'PENDING' | 'THROW' = 'PENDING';
  checkFails = false;
  refundMode: 'OK' | 'THROW' | 'THROW_ONCE' = 'OK';
  refunds: string[] = [];

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (this.chargeReply === 'THROW') {
      this.providerStatus.set(req.transactionId!, 'APPROVED');
      throw new Error('timeout de rede');
    }
    this.providerStatus.set(req.transactionId!, 'PENDING');
    return { status: 'PENDING' };
  }
  async checkStatus(transactionId: string): Promise<ChargeResult> {
    if (this.checkFails) throw new Error('provedor fora do ar');
    return { status: this.providerStatus.get(transactionId) ?? 'PENDING', authorizationCode: 'AUT-EXC' };
  }
  async cancel(transactionId: string): Promise<ChargeResult> {
    return { status: this.providerStatus.get(transactionId) === 'APPROVED' ? 'APPROVED' : 'CANCELLED' };
  }
  async refund(transactionId: string): Promise<ChargeResult> {
    this.refunds.push(transactionId);
    await new Promise((r) => setTimeout(r, 30));
    if (this.refundMode === 'THROW' || this.refundMode === 'THROW_ONCE') {
      if (this.refundMode === 'THROW_ONCE') this.refundMode = 'OK';
      throw new Error('sem resposta do provedor');
    }
    this.providerStatus.set(transactionId, 'REFUNDED');
    return { status: 'REFUNDED' };
  }
}

/** Provedor que aprova mas não oferece estorno pela API. */
class NoRefundTerminal extends ExceptionTerminal {
  readonly name: string = 'test-norefund-terminal';
  refund = undefined as any;
}

describe('Exceção: provedor aprova com a venda cancelada/devolvida (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const terminal = new ExceptionTerminal();
  const noRefund = new NoRefundTerminal();
  let seq = 9800;
  const token = (userType: string, branchId?: string) =>
    `Bearer ${generateAccessToken({ userId: fixture.userId, email: 'x@test.local', companyId: fixture.companyId, branchId, userType })}`;
  const operator = () => token('OPERATOR', fixture.branchId);
  const admin = () => token('COMPANY_ADMIN');
  const manager = () => token('MANAGER', fixture.branchId);

  const newSale = (total: number) =>
    bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, saleNumber: ++seq, customerId: fixture.customerId,
          userId: fixture.userId, cashRegisterId: fixture.cashRegisterId, status: 'PENDING', subtotal: total, totalAmount: total,
        },
      })
    );
  const setSale = (id: string, status: 'CANCELLED' | 'RETURNED') => bypass(() => db.sale.update({ where: { id }, data: { status } }));
  const saleRow = (id: string) => bypass<any>(() => db.sale.findUnique({ where: { id } }));
  const paymentRow = (id: string) => bypass<any>(() => db.payment.findUnique({ where: { id } }));
  const movements = (paymentId: string) => bypass<number>(() => db.cashMovement.count({ where: { referenceType: 'Payment', referenceId: paymentId } }));
  const exceptionsOf = (paymentId: string) => bypass<any[]>(() => db.paymentException.findMany({ where: { paymentId } }));
  const reconcile = (id: string) => request(app).post(`/api/payments/${id}/reconcile`).set('Authorization', admin());
  const resolve = (id: string, body: object, auth = admin()) => request(app).post(`/api/payments/exceptions/${id}/resolve`).set('Authorization', auth).send(body);

  /** pagamento pendente no provedor; em seguida a venda é fechada e o provedor aprova */
  const approvedAfterClose = async (total: number, saleStatus: 'CANCELLED' | 'RETURNED', method = 'CREDIT_CARD') => {
    const sale = await newSale(total);
    const res = await request(app).post('/api/payments').set('Authorization', operator()).send({ saleId: sale.id, paymentMethod: method, amount: total, transactionId: `exc-${sale.id}` });
    expect(res.body.status).toBe('PENDING');
    await setSale(sale.id, saleStatus);
    terminal.providerStatus.set(res.body.transactionId, 'APPROVED');
    noRefund.providerStatus.set(res.body.transactionId, 'APPROVED');
    return { sale, payment: res.body };
  };

  const useProvider = (name: string) =>
    request(app).put('/api/payment-settings').set('Authorization', admin()).send({ cardProvider: name, pixProvider: name });

  beforeAll(async () => {
    registerPaymentProvider('TEST_EXC', { card: terminal, pix: terminal });
    registerPaymentProvider('TEST_NOREFUND', { card: noRefund, pix: noRefund });
    fixture = await createFixture('payexc');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    expect((await useProvider('TEST_EXC')).status).toBe(200);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture?.companyId) {
      const companyId = fixture.companyId;
      await bypass(() => db.paymentSetting.deleteMany({ where: { companyId } }));
      await destroyFixture(fixture);
    }
  });
  afterEach(() => {
    terminal.chargeReply = 'PENDING';
    terminal.checkFails = false;
    terminal.refundMode = 'OK';
  });

  it.each(['CANCELLED', 'RETURNED'] as const)('venda %s + provedor aprova: pagamento APPROVED, venda intacta, nada no caixa, uma exceção aberta', async (saleStatus) => {
    const { sale, payment } = await approvedAfterClose(40, saleStatus);
    const rec = await reconcile(payment.id);
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe('APPROVED');
    expect((await saleRow(sale.id)).status).toBe(saleStatus);
    expect(await movements(payment.id)).toBe(0);
    const exc = await exceptionsOf(payment.id);
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ type: 'APPROVED_ON_CLOSED_SALE', saleStatus, providerStatus: 'APPROVED', resolvedAt: null, provider: 'TEST_EXC' });
    expect(Number(exc[0].amount)).toBe(40);
    expect((await paymentRow(payment.id)).notes).toMatch(/\[INCONSISTÊNCIA DE INTEGRAÇÃO\]/);

    const list = await request(app).get('/api/payments/exceptions?open=true').set('Authorization', manager());
    expect(list.status).toBe(200);
    expect(list.body.data.map((e: any) => e.paymentId)).toContain(payment.id);
  });

  it('resposta atrasada: a cobrança perdeu a resposta, a venda foi devolvida e o job de reconciliação registra a aprovação como exceção', async () => {
    terminal.chargeReply = 'THROW';
    const sale = await newSale(22);
    const res = await request(app).post('/api/payments').set('Authorization', operator()).send({ saleId: sale.id, paymentMethod: 'PIX', amount: 22, transactionId: `late-${sale.id}` });
    expect(res.body.status).toBe('PENDING');
    await setSale(sale.id, 'RETURNED');
    await paymentService.reconcilePendingExternal({ olderThanMs: 0 });
    expect((await paymentRow(res.body.id)).status).toBe('APPROVED');
    expect((await saleRow(sale.id)).status).toBe('RETURNED');
    expect(await exceptionsOf(res.body.id)).toHaveLength(1);
  });

  it('reconciliações simultâneas: uma única exceção, uma única aprovação', async () => {
    const { payment } = await approvedAfterClose(33, 'CANCELLED');
    const results = await Promise.all(Array.from({ length: 5 }, () => reconcile(payment.id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await exceptionsOf(payment.id)).toHaveLength(1);
    expect(await movements(payment.id)).toBe(0);
  });

  it('cancelamento simultâneo à reconciliação: o provedor aprovou → nunca fica CANCELLED; uma exceção', async () => {
    const { payment } = await approvedAfterClose(27, 'CANCELLED');
    const results = await Promise.all([
      request(app).post(`/api/payments/${payment.id}/cancel`).set('Authorization', admin()),
      reconcile(payment.id),
      reconcile(payment.id),
    ]);
    expect(results[0].status).toBe(409); // provedor já aprovou: não cancela, pede estorno
    expect((await paymentRow(payment.id)).status).toBe('APPROVED');
    expect(await exceptionsOf(payment.id)).toHaveLength(1);
    expect(await movements(payment.id)).toBe(0);
  });

  // ACHADO (a regressão completa pegou, na corrida acima, o cancelamento lendo o pagamento JÁ aprovado pela
  // reconciliação): o cancelamento/estorno comum tratava o pagamento em exceção como um aprovado qualquer — marcava
  // CANCELLED/REFUNDED com o dinheiro ainda no provedor, lançava no caixa a SAÍDA de um valor que nunca entrou e
  // recalculava a situação da venda encerrada. Agora recusa (409) e aponta a tela de exceções.
  it.each([
    ['cancelamento', 'cancel'],
    ['estorno', 'refund'],
  ])('%s comum de pagamento em exceção é recusado; pagamento, caixa e venda intactos', async (_label, action) => {
    const { sale, payment } = await approvedAfterClose(19, 'CANCELLED');
    expect((await reconcile(payment.id)).body.status).toBe('APPROVED');
    const res = await request(app).post(`/api/payments/${payment.id}/${action}`).set('Authorization', admin()).set('Idempotency-Key', `exc-${action}-${payment.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_IN_EXCEPTION');
    expect(res.body.error).toMatch(/Financeiro › Conciliação/);
    expect((await paymentRow(payment.id)).status).toBe('APPROVED');
    expect(await movements(payment.id)).toBe(0);
    expect((await saleRow(sale.id)).status).toBe('CANCELLED');
    expect(await exceptionsOf(payment.id)).toHaveLength(1);
  });

  it('mesmo depois de tratada manualmente, a exceção continua bloqueando o cancelamento comum (nada dela entrou no caixa)', async () => {
    const { payment } = await approvedAfterClose(21, 'RETURNED');
    await reconcile(payment.id);
    const [exc] = await exceptionsOf(payment.id);
    expect((await resolve(exc.id, { action: 'MANUAL', note: 'Cliente ficou com crédito na loja' })).status).toBe(200);
    const res = await request(app).post(`/api/payments/${payment.id}/cancel`).set('Authorization', admin());
    expect(res.status).toBe(409);
    expect(await movements(payment.id)).toBe(0);
  });

  it('provedor indisponível na reconciliação: segue PENDING, sem exceção e sem erro 500', async () => {
    const { payment } = await approvedAfterClose(18, 'CANCELLED');
    terminal.checkFails = true;
    const rec = await reconcile(payment.id);
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe('PENDING');
    expect(await exceptionsOf(payment.id)).toHaveLength(0);
  });

  it('estorno confirmado pelo provedor: pagamento REFUNDED, exceção tratada com autor; tratar de novo → 409', async () => {
    const { payment } = await approvedAfterClose(50, 'RETURNED');
    await reconcile(payment.id);
    const [exc] = await exceptionsOf(payment.id);
    const res = await resolve(exc.id, { action: 'REFUND' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resolution: 'REFUNDED', resolvedBy: fixture.userId });
    expect((await paymentRow(payment.id)).status).toBe('REFUNDED');
    expect(terminal.refunds.filter((t) => t === payment.transactionId)).toHaveLength(1);
    expect((await resolve(exc.id, { action: 'REFUND' })).status).toBe(409);
  });

  it('retry: o provedor não responde ao estorno → 409 e nada muda; a nova tentativa estorna', async () => {
    const { payment } = await approvedAfterClose(31, 'CANCELLED');
    await reconcile(payment.id);
    const [exc] = await exceptionsOf(payment.id);
    terminal.refundMode = 'THROW_ONCE';
    const first = await resolve(exc.id, { action: 'REFUND' });
    expect(first.status).toBe(409);
    expect((await paymentRow(payment.id)).status).toBe('APPROVED');
    expect((await exceptionsOf(payment.id))[0]).toMatchObject({ resolvedAt: null, resolution: null });
    const second = await resolve(exc.id, { action: 'REFUND' });
    expect(second.status).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('REFUNDED');
  });

  it('duplicidade: três pedidos de estorno simultâneos → um estorno só no provedor', async () => {
    const { payment } = await approvedAfterClose(44, 'CANCELLED');
    await reconcile(payment.id);
    const [exc] = await exceptionsOf(payment.id);
    const results = await Promise.all([1, 2, 3].map(() => resolve(exc.id, { action: 'REFUND' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(terminal.refunds.filter((t) => t === payment.transactionId)).toHaveLength(1);
  });

  it('estorno indisponível no provedor: 409 orientando tratamento manual; manual exige justificativa e não mexe no dinheiro', async () => {
    expect((await useProvider('TEST_NOREFUND')).status).toBe(200);
    try {
      const { payment } = await approvedAfterClose(26, 'CANCELLED');
      await reconcile(payment.id);
      const [exc] = await exceptionsOf(payment.id);
      const refund = await resolve(exc.id, { action: 'REFUND' });
      expect(refund.status).toBe(409);
      expect(refund.body.error).toMatch(/Estorno indisponível/);
      expect((await exceptionsOf(payment.id))[0].resolvedAt).toBeNull();

      expect((await resolve(exc.id, { action: 'MANUAL', note: 'curta' })).status).toBe(400);
      const manual = await resolve(exc.id, { action: 'MANUAL', note: 'Estornado pelo portal do adquirente em 25/09' });
      expect(manual.status).toBe(200);
      expect(manual.body).toMatchObject({ resolution: 'MANUAL', resolvedBy: fixture.userId });
      expect((await paymentRow(payment.id)).status).toBe('APPROVED');
    } finally {
      expect((await useProvider('TEST_EXC')).status).toBe(200);
    }
  });

  it('permissões: operador não trata nem lista exceções', async () => {
    const { payment } = await approvedAfterClose(12, 'CANCELLED');
    await reconcile(payment.id);
    const [exc] = await exceptionsOf(payment.id);
    expect((await resolve(exc.id, { action: 'MANUAL', note: 'tentativa do operador sem permissão' }, operator())).status).toBe(403);
    expect((await request(app).get('/api/payments/exceptions').set('Authorization', operator())).status).toBe(403);
    expect((await exceptionsOf(payment.id))[0].resolvedAt).toBeNull();
  });
});
