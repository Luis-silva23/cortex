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
 * Terminal/TEF/PIX por provedor (business-state-machines.md, "Pagamento por terminal/provedor"). Um terminal FALSO,
 * registrado só neste processo de teste, controla o que o "provedor" responde. Prova: valor da venda enviado ao
 * terminal; resposta perdida vira PENDING (nunca recusa) e é reconciliada; nova tentativa com a mesma chave não cobra
 * de novo; sem chave, o saldo reservado impede a segunda cobrança; recusa libera o saldo; reconciliações concorrentes
 * aplicam o pagamento uma vez só.
 */
class FakeTerminal implements PaymentGatewayAdapter {
  readonly name = 'test-terminal';
  readonly external = true;
  charges: ChargeRequest[] = [];
  /** o que o terminal responde ao cobrar; 'THROW' = resposta perdida (o provedor registra APPROVED) */
  reply: 'APPROVED' | 'DECLINED' | 'THROW' | 'PENDING' = 'APPROVED';
  providerStatus = new Map<string, ChargeResult['status']>();
  cancels: string[] = [];
  /** como o terminal responde a um pedido de cancelamento; 'THROW' = sem resposta */
  cancelReply: 'CANCELLED' | 'APPROVED' | 'PENDING' | 'THROW' = 'CANCELLED';
  /** executado enquanto o cancelamento está no provedor (simula algo concorrente) */
  duringCancel?: (transactionId: string) => Promise<void>;

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(req);
    if (this.reply === 'THROW') {
      this.providerStatus.set(req.transactionId!, 'APPROVED');
      throw new Error('timeout de rede');
    }
    this.providerStatus.set(req.transactionId!, this.reply);
    return { status: this.reply, authorizationCode: 'AUT-1', nsuHost: 'NSU-1' };
  }

  async cancel(transactionId: string): Promise<ChargeResult> {
    this.cancels.push(transactionId);
    if (this.duringCancel) await this.duringCancel(transactionId);
    if (this.cancelReply === 'THROW') throw new Error('terminal fora do ar');
    if (this.cancelReply === 'CANCELLED') this.providerStatus.set(transactionId, 'CANCELLED');
    return { status: this.cancelReply, authorizationCode: this.cancelReply === 'APPROVED' ? 'AUT-3' : undefined };
  }

  async checkStatus(transactionId: string): Promise<ChargeResult> {
    return { status: this.providerStatus.get(transactionId) ?? 'PENDING', authorizationCode: 'AUT-2' };
  }
}

describe('Pagamento por terminal: intenção, resposta perdida e reconciliação (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const terminal = new FakeTerminal();
  let seq = 9700;
  const token = (userType: string, branchId?: string) =>
    `Bearer ${generateAccessToken({ userId: fixture.userId, email: 'x@test.local', companyId: fixture.companyId, branchId, userType })}`;
  const operator = () => token('OPERATOR', fixture.branchId);
  const admin = () => token('COMPANY_ADMIN');

  const newSale = (total: number) =>
    bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, saleNumber: ++seq, customerId: fixture.customerId,
          userId: fixture.userId, cashRegisterId: fixture.cashRegisterId, status: 'PENDING', subtotal: total, totalAmount: total,
        },
      })
    );
  const pay = (body: object) => request(app).post('/api/payments').set('Authorization', operator()).send(body);
  const saleRow = (id: string) => bypass<any>(() => db.sale.findUnique({ where: { id } }));
  const movements = (paymentId: string) => bypass<number>(() => db.cashMovement.count({ where: { referenceType: 'Payment', referenceId: paymentId } }));

  beforeAll(async () => {
    registerPaymentProvider('TEST_TERMINAL', { card: terminal, pix: terminal });
    fixture = await createFixture('terminal');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const res = await request(app).put('/api/payment-settings').set('Authorization', admin()).send({ cardProvider: 'TEST_TERMINAL', pixProvider: 'TEST_TERMINAL', terminalId: 'POS-01' });
    expect(res.body).toMatchObject({ cardProvider: 'TEST_TERMINAL', pixProvider: 'TEST_TERMINAL', terminalId: 'POS-01' });
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) {
      await bypass(() => db.paymentSetting.deleteMany({ where: { companyId: fixture.companyId } }));
      await destroyFixture(fixture);
    }
  });

  it('provedor não registrado no servidor não pode ser configurado', async () => {
    const res = await request(app).put('/api/payment-settings').set('Authorization', admin()).send({ cardProvider: 'ACME_TEF' });
    expect(res.status).toBe(400);
  });

  it('aprovado: o valor da venda vai ao terminal; pagamento aprovado com NSU; venda paga; um lançamento no caixa', async () => {
    terminal.reply = 'APPROVED';
    const sale = await newSale(150);
    const res = await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 150, transactionId: `ok-${sale.id}` });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'APPROVED', provider: 'TEST_TERMINAL', nsuHost: 'NSU-1' });
    expect(terminal.charges.at(-1)).toMatchObject({ amount: 150, transactionId: `ok-${sale.id}` });
    expect((await saleRow(sale.id)).status).toBe('PAID');
    expect(await movements(res.body.id)).toBe(1);
  });

  it('resposta perdida: fica PENDING (não recusa); repetir com a mesma chave não cobra de novo; sem chave, o saldo reservado barra; a reconciliação aprova', async () => {
    terminal.reply = 'THROW';
    const sale = await newSale(80);
    const key = `lost-${sale.id}`;
    const first = await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount: 80, transactionId: key });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('PENDING');
    expect((await saleRow(sale.id)).status).toBe('PENDING');
    const chargesSoFar = terminal.charges.length;

    const retry = await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount: 80, transactionId: key });
    expect(retry.body.id).toBe(first.body.id);
    expect(terminal.charges.length).toBe(chargesSoFar);

    const other = await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount: 80 });
    expect(other.status).toBe(400);
    expect(terminal.charges.length).toBe(chargesSoFar);

    const rec = await request(app).post(`/api/payments/${first.body.id}/reconcile`).set('Authorization', admin());
    expect(rec.body.status).toBe('APPROVED');
    expect((await saleRow(sale.id)).status).toBe('PAID');
    expect(await movements(first.body.id)).toBe(1);
  });

  it('recusado: pagamento REJECTED, venda continua aberta e aceita nova tentativa', async () => {
    terminal.reply = 'DECLINED';
    const sale = await newSale(40);
    const declined = await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 40, transactionId: `dec-${sale.id}` });
    expect(declined.body.status).toBe('REJECTED');
    expect((await saleRow(sale.id)).status).toBe('PENDING');
    expect(await movements(declined.body.id)).toBe(0);

    terminal.reply = 'APPROVED';
    const ok = await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 40, transactionId: `dec2-${sale.id}` });
    expect(ok.body.status).toBe('APPROVED');
    expect((await saleRow(sale.id)).status).toBe('PAID');
  });

  it('reconciliações simultâneas aplicam o pagamento uma única vez', async () => {
    terminal.reply = 'THROW';
    const sale = await newSale(60);
    const pending = await pay({ saleId: sale.id, paymentMethod: 'PIX', amount: 60, transactionId: `race-${sale.id}` });
    expect(pending.body.status).toBe('PENDING');

    await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/api/payments/${pending.body.id}/reconcile`).set('Authorization', admin())));
    expect(await movements(pending.body.id)).toBe(1);
    const s = await saleRow(sale.id);
    expect([s.status, Number(s.paidAmount)]).toEqual(['PAID', 60]);
  });

  it('reconciliação automática (job) aprova o pagamento cuja resposta se perdeu', async () => {
    terminal.reply = 'THROW';
    const sale = await newSale(25);
    const pending = await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 25, transactionId: `job-${sale.id}` });
    expect(pending.body.status).toBe('PENDING');

    const result = await paymentService.reconcilePendingExternal({ olderThanMs: 0 });
    expect(result.settled).toBeGreaterThanOrEqual(1);
    expect((await saleRow(sale.id)).status).toBe('PAID');
    expect(await movements(pending.body.id)).toBe(1);
  });

  describe('cancelar pagamento pendente no terminal', () => {
    const cancel = (id: string) => request(app).post(`/api/payments/${id}/cancel`).set('Authorization', admin());
    const paymentRow = (id: string) => bypass<any>(() => db.payment.findUnique({ where: { id } }));
    const pendingPayment = async (total: number) => {
      terminal.reply = 'PENDING';
      const sale = await newSale(total);
      const res = await pay({ saleId: sale.id, paymentMethod: 'CREDIT_CARD', amount: total, transactionId: `cx-${sale.id}` });
      expect(res.body.status).toBe('PENDING');
      return { sale, payment: res.body };
    };
    afterEach(() => {
      terminal.cancelReply = 'CANCELLED';
      terminal.duringCancel = undefined;
    });

    it('o provedor confirma: cancelado no terminal e aqui; reconciliação posterior não reabre; venda aceita novo pagamento', async () => {
      const { sale, payment } = await pendingPayment(70);
      const res = await cancel(payment.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(terminal.cancels).toContain(payment.transactionId);
      await request(app).post(`/api/payments/${payment.id}/reconcile`).set('Authorization', admin());
      expect((await paymentRow(payment.id)).status).toBe('CANCELLED');
      expect(await movements(payment.id)).toBe(0);
      terminal.reply = 'APPROVED';
      const again = await pay({ saleId: sale.id, paymentMethod: 'DEBIT_CARD', amount: 70, transactionId: `cx2-${sale.id}` });
      expect(again.body.status).toBe('APPROVED');
    });

    it('o provedor já tinha aprovado: 409 pedindo estorno; pagamento confirmado, venda paga, um lançamento no caixa', async () => {
      const { sale, payment } = await pendingPayment(55);
      terminal.cancelReply = 'APPROVED';
      const res = await cancel(payment.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/estorno/);
      expect((await paymentRow(payment.id)).status).toBe('APPROVED');
      expect((await saleRow(sale.id)).status).toBe('PAID');
      expect(await movements(payment.id)).toBe(1);
    });

    it.each(['THROW', 'PENDING'] as const)('provedor sem resposta/sem confirmação (%s): 409, segue PENDING', async (reply) => {
      const { payment } = await pendingPayment(35);
      terminal.cancelReply = reply;
      const res = await cancel(payment.id);
      expect(res.status).toBe(409);
      expect((await paymentRow(payment.id)).status).toBe('PENDING');
    });

    it('cancelar o pendente que sobrou numa venda devolvida não a reabre (continua RETURNED)', async () => {
      const { sale, payment } = await pendingPayment(30);
      await bypass(() => db.sale.update({ where: { id: sale.id }, data: { status: 'RETURNED' } }));
      const res = await cancel(payment.id);
      expect(res.status).toBe(200);
      expect((await saleRow(sale.id)).status).toBe('RETURNED');
    });

    it('aprovado por reconciliação durante o cancelamento: 409, fica APPROVED com o caixa lançado (nada revertido pela metade)', async () => {
      const { sale, payment } = await pendingPayment(45);
      terminal.duringCancel = async (transactionId) => {
        terminal.providerStatus.set(transactionId, 'APPROVED');
        await paymentService.reconcilePayment(payment.id, fixture.companyId);
      };
      const res = await cancel(payment.id);
      expect(res.status).toBe(409);
      const row = await paymentRow(payment.id);
      expect(row.status).toBe('APPROVED');
      expect((await saleRow(sale.id)).status).toBe('PAID');
      expect(await movements(payment.id)).toBe(1);
    });
  });
});
