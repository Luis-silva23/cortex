import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import saleService from '../../src/services/sale.service';
import paymentService from '../../src/services/payment.service';
import purchaseOrderService from '../../src/services/purchase-order.service';
import serviceOrderService from '../../src/services/service-order.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Suíte de integração REAL (PostgreSQL + RLS reais, nenhum mock) que
 * reproduz a classe de bug encontrada na auditoria de 2026-09-09: o retry
 * de numeração sequencial sob concorrência (saleNumber/poNumber/osNumber)
 * dependia de `error.meta.target`, que a extensão de RLS do Prisma
 * ($extends + $transaction([...]) em lote) zera sob o client real da
 * aplicação — invisível para a suíte unitária (que mocka o Prisma inteiro).
 *
 * Contexto: docs/CORTEX/DATABASE.md (RLS e transações); TASK-005 do quadro de tarefas
 * original, que não está no repositório.
 */

const N_CONCURRENT = 15;

async function runInRLSContext<T>(companyId: string, branchId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRLSContext({ companyId, userType: 'OPERATOR', branchId }, fn);
}

describe('Concorrência real — numeração sequencial sob carga', () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createFixture('conc');
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it(`${N_CONCURRENT} vendas simultâneas na mesma filial: sem duplicata, sem erro cru vazando`, async () => {
    const attempts = Array.from({ length: N_CONCURRENT }, () =>
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        saleService.createSale({
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          userId: fixture.userId,
          userType: 'OPERATOR',
          cashRegisterId: fixture.cashRegisterId,
          items: [
            {
              productId: fixture.productId,
              quantity: 1,
              unitPrice: 10,
            },
          ],
        })
      )
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    // Toda venda que teve sucesso precisa ter um saleNumber único — a
    // asserção central que provaria o bug antigo (números duplicados ou
    // ausentes por causa de retry quebrado).
    const saleNumbers = fulfilled.map((r) => r.value.saleNumber);
    expect(new Set(saleNumbers).size).toBe(saleNumbers.length);

    // ENDURECIDO (2026-09-21): era `>= 60%`. Aquele limiar aceitava perder
    // vendas legítimas sob carga como se fosse esperado — e escondia que a
    // perda vinha do esgotamento de tentativas (medido: 8 de 15 vendas
    // simultâneas falhando numa execução real, 100% das falhas em P2002).
    // Com o saleNumber alocado dentro da transação atrás de um advisory
    // lock por (companyId, branchId), as vendas serializam e nenhuma é
    // perdida: 15/15 é determinístico.
    expect(fulfilled.length).toBe(N_CONCURRENT);
    expect([...saleNumbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N_CONCURRENT }, (_, i) => i + 1)
    );

    // Qualquer falha restante precisa ser o erro de negócio limpo, nunca o
    // erro cru do Prisma (a regressão real encontrada na auditoria).
    for (const r of rejected) {
      const message = (r.reason as Error).message;
      expect(message).not.toMatch(/Invalid `tx\.sale\.create/);
      expect(message).not.toMatch(/Unique constraint failed on the \(not available\)/);
    }
  });

  it(`${N_CONCURRENT} pedidos de compra simultâneos na mesma filial: sem duplicata, sem erro cru vazando`, async () => {
    const attempts = Array.from({ length: N_CONCURRENT }, () =>
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        purchaseOrderService.create({
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          supplierId: fixture.supplierId,
          items: [{ productId: fixture.productId, quantity: 1, unitCost: 5 }],
        })
      )
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    const poNumbers = fulfilled.map((r) => r.value.poNumber);
    expect(new Set(poNumbers).size).toBe(poNumbers.length);
    // ENDURECIDO (2026-09-21) — mesma justificativa das vendas/OS acima: o
    // poNumber agora é alocado dentro da transação atrás de um advisory
    // lock por (companyId, branchId), então 15/15 é determinístico.
    expect(fulfilled.length).toBe(N_CONCURRENT);
    expect([...poNumbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N_CONCURRENT }, (_, i) => i + 1)
    );

    for (const r of rejected) {
      const message = (r.reason as Error).message;
      expect(message).not.toMatch(/Invalid `prisma\.purchaseOrder\.create/);
      expect(message).not.toMatch(/Unique constraint failed on the \(not available\)/);
    }
  });

  it(`${N_CONCURRENT} aberturas de OS simultâneas na mesma filial: sem duplicata, sem erro cru vazando`, async () => {
    const attempts = Array.from({ length: N_CONCURRENT }, () =>
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        serviceOrderService.create({
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          customerId: fixture.customerId,
          motorcycleId: fixture.motorcycleId,
          entryKilometer: 1000,
          userId: fixture.userId,
        })
      )
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    const osNumbers = fulfilled.map((r) => r.value.osNumber);
    expect(new Set(osNumbers).size).toBe(osNumbers.length);
    // ENDURECIDO (2026-09-21): era `>= 60%`, um limiar que só existia porque
    // a numeração era um check-then-act com retry — o número de sucessos
    // dependia de quantas tentativas sobravam, então o teste passava ou
    // falhava por sorte (medido em 8 execuções: 7, 10, 10, 11, 11, 11, 12,
    // 13 de 15). Agora que a numeração é alocada dentro da transação, atrás
    // de um advisory lock por (companyId, branchId), as 15 aberturas
    // SERIALIZAM em vez de competir: 15/15 é o resultado determinístico, e
    // exigi-lo é o que faz este teste voltar a ser uma regressão de
    // verdade — remover a trava derruba o teste na hora, em vez de só
    // aumentar a chance de ele piscar.
    expect(fulfilled.length).toBe(N_CONCURRENT);
    expect([...osNumbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N_CONCURRENT }, (_, i) => i + 1)
    );

    for (const r of rejected) {
      const message = (r.reason as Error).message;
      expect(message).not.toMatch(/Invalid `prisma\.\$transaction/);
      expect(message).not.toMatch(/Unique constraint failed on the \(not available\)/);
    }
  });

  // ACHADO DE AUDITORIA (2026-09-14): pagamentos CASH concorrentes sem
  // `transactionId` (então sem a proteção da constraint UNIQUE) para a
  // mesma venda liam `approvedAmount` ANTES de qualquer transação — duas
  // requisições concorrentes liam o mesmo valor desatualizado, ambas
  // passavam pela checagem de "ainda falta pagar" e ambas eram aprovadas,
  // subavaliando `sale.paidAmount` mesmo tendo recebido dinheiro em dobro.
  // `SELECT ... FOR UPDATE` na linha da venda + releitura dentro da
  // transação (payment.service.ts) corrige isso — só uma prova real contra
  // Postgres consegue comprovar que o lock realmente serializa (o teste
  // unitário mockado só prova que o código CHAMA $queryRaw, não que ele
  // funciona).
  it(`${N_CONCURRENT} pagamentos CASH concorrentes (sem transactionId) para a mesma venda: só um é aprovado, o resto é rejeitado com erro de negócio limpo`, async () => {
    const createdSale = await runInRLSContext(fixture.companyId, fixture.branchId, () =>
      saleService.createSale({
        companyId: fixture.companyId,
        branchId: fixture.branchId,
        userId: fixture.userId,
        userType: 'OPERATOR',
        cashRegisterId: fixture.cashRegisterId,
        items: [{ productId: fixture.productId, quantity: 1, unitPrice: 10 }],
      })
    );
    if (!createdSale) {
      throw new Error('setup failed: createSale returned no sale');
    }
    const sale = createdSale;

    const attempts = Array.from({ length: N_CONCURRENT }, () =>
      runInRLSContext(fixture.companyId, fixture.branchId, () =>
        paymentService.processPayment({
          companyId: fixture.companyId,
          saleId: sale.id,
          paymentMethod: 'CASH',
          amount: Number(sale.totalAmount),
        })
      )
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    // O ponto central: exatamente UM pagamento pode ser aprovado para uma
    // venda que só cabe um pagamento integral — não "a maioria", não
    // "pelo menos um": exatamente um, senão o lock não está serializando.
    const approved = fulfilled.filter((r) => r.value.status === 'APPROVED');
    expect(approved.length).toBe(1);

    // Todo o resto precisa ter sido REJEITADO com o erro de negócio limpo
    // (checagem otimista OU a releitura travada, ambas mensagens
    // aceitáveis) — nunca um erro cru de deadlock/timeout do Postgres
    // vazando para o caller.
    expect(rejected.length).toBe(N_CONCURRENT - 1);
    for (const r of rejected) {
      expect((r.reason as Error).message).toMatch(/already fully paid/);
    }

    // Prova final, direta no banco: a venda foi paga exatamente uma vez,
    // nunca em dobro (nem em paidAmount, nem no caixa). Leitura de
    // verificação via `prismaUnsafeBypassRLS.$transaction([...])` (mesmo
    // padrão já comprovado em rbac.integration.test.ts) — uma NOVA
    // `runWithRLSContext` logo depois de 15 chamadas concorrentes
    // acumuladas provou ser instável para reler o estado recém-commitado
    // neste ambiente.
    const [, finalSale] = await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.sale.findUnique({ where: { id: sale.id } }) as any,
    ]);
    const finalSaleRow = finalSale as { paidAmount: unknown; status: string } | null;
    expect(Number(finalSaleRow!.paidAmount)).toBe(Number(sale.totalAmount));
    expect(finalSaleRow!.status).toBe('PAID');
  }, 30000);
});
