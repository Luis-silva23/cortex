import { randomUUID } from 'crypto';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import branchService from '../../src/services/branch.service';
import { errorHandler } from '../../src/middleware/errorHandler';

/**
 * FKs DE EMPRESA E DE FILIAL + CASCADE → RESTRICT (Postgres real, migrations 20261015100000 e 20261015110000).
 * Antes: 65 tabelas de negócio tinham `companyId` sem FK para `companies` (linha órfã de empresa inexistente) e 55 tinham `branchId` sem FK
 * (filial inexistente ou de OUTRA empresa — a FK do Postgres não passa pela RLS). E apagar venda/produto/OS/caixa/empresa levava junto,
 * em cascata e sem rastro, pagamentos, livro de estoque, histórico e auditoria.
 */
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

describe('FKs de empresa/filial e RESTRICT no histórico (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  const stamp = Date.now();

  beforeAll(async () => {
    A = await createFixture('cbfA');
    B = await createFixture('cbfB');
  });

  afterAll(async () => {
    if (A) await destroyFixture(A);
    if (B) await destroyFixture(B);
  });

  it('companyId de empresa INEXISTENTE é recusado pelo banco (P2003) numa tabela de negócio', async () => {
    const ghost = randomUUID();
    await expect(bypass<any>(() => db.customer.create({ data: { companyId: ghost, name: `Fantasma ${stamp}` } }))).rejects.toMatchObject({ code: 'P2003' });
    expect(await bypass<any>(() => db.customer.count({ where: { companyId: ghost } }))).toBe(0);
  });

  it('branchId de OUTRA empresa é recusado (FK composta): a empresa A não grava produto na filial da B', async () => {
    await expect(
      asCompany(A.companyId, () =>
        prisma.product.create({ data: { companyId: A.companyId, branchId: B.branchId, sku: `CBF-${stamp}-1`, name: 'cruzado', costPrice: 1, salePrice: 2 } })
      )
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await bypass<any>(() => db.product.count({ where: { companyId: A.companyId, sku: `CBF-${stamp}-1` } }))).toBe(0);
  });

  it('branchId inexistente é recusado; branchId nulo continua permitido (filial opcional)', async () => {
    await expect(
      asCompany(A.companyId, () => prisma.partner.create({ data: { companyId: A.companyId, branchId: randomUUID(), name: `P-${stamp}-x`, discountValue: 5 } }))
    ).rejects.toMatchObject({ code: 'P2003' });
    const ok = await asCompany(A.companyId, () => prisma.partner.create({ data: { companyId: A.companyId, name: `P-${stamp}-ok`, discountValue: 5 } }));
    expect(ok.branchId).toBeNull();
    const okBranch = await asCompany(A.companyId, () => prisma.partner.create({ data: { companyId: A.companyId, branchId: A.branchId, name: `P-${stamp}-b`, discountValue: 5 } }));
    expect(okBranch.branchId).toBe(A.branchId);
  });

  it('a filial com histórico NÃO pode ser excluída (RESTRICT), nem a empresa com filiais', async () => {
    await expect(bypass<any>(() => db.branch.delete({ where: { id: A.branchId } }))).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    await expect(bypass<any>(() => db.company.delete({ where: { id: A.companyId } }))).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    expect(await bypass<any>(() => db.branch.count({ where: { id: A.branchId } }))).toBe(1);
    expect(await bypass<any>(() => db.company.count({ where: { id: A.companyId } }))).toBe(1);
  });

  it('o produto com livro de estoque NÃO é apagado (antes a cascata levava o histórico junto)', async () => {
    const before = await bypass<any>(() => db.stockMovement.count({ where: { companyId: A.companyId, productId: A.productId } }));
    expect(before).toBeGreaterThan(0);
    await expect(bypass<any>(() => db.product.delete({ where: { id: A.productId } }))).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    expect(await bypass<any>(() => db.stockMovement.count({ where: { companyId: A.companyId, productId: A.productId } }))).toBe(before);
  });

  it('a venda com pagamento NÃO é apagada; o caixa com movimento NÃO é apagado; a OS com histórico NÃO é apagada', async () => {
    const sale = await bypass<any>(() =>
      db.sale.create({
        data: { companyId: A.companyId, branchId: A.branchId, saleNumber: 9001, userId: A.userId, subtotal: 10, totalAmount: 10, status: 'PAID', cashRegisterId: A.cashRegisterId } as any,
      })
    );
    await bypass<any>(() => db.payment.create({ data: { companyId: A.companyId, saleId: sale.id, paymentMethod: 'CASH', status: 'APPROVED', amount: 10 } as any }));
    await expect(bypass<any>(() => db.sale.delete({ where: { id: sale.id } }))).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    expect(await bypass<any>(() => db.payment.count({ where: { saleId: sale.id } }))).toBe(1);

    await bypass<any>(() => db.cashMovement.create({ data: { cashRegisterId: A.cashRegisterId, movementType: 'DEPOSIT', amount: 5, userId: A.userId } }));
    await expect(bypass<any>(() => db.cashRegister.delete({ where: { id: A.cashRegisterId } }))).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    expect(await bypass<any>(() => db.cashMovement.count({ where: { cashRegisterId: A.cashRegisterId } }))).toBe(1);

    const os = await bypass<any>(() =>
      db.serviceOrder.create({
        data: {
          companyId: A.companyId,
          branchId: A.branchId,
          osNumber: 9001,
          customerId: A.customerId,
          motorcycleId: A.motorcycleId,
          entryDate: new Date(),
          entryKilometer: 1000,
          finalTotal: 0,
        } as any,
      })
    );
    await bypass<any>(() => db.serviceOrderStatusHistory.create({ data: { serviceOrderId: os.id, toStatus: 'ENTRADA', changedBy: A.userId } }));
    await expect(bypass<any>(() => db.serviceOrder.delete({ where: { id: os.id } }))).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    expect(await bypass<any>(() => db.serviceOrderStatusHistory.count({ where: { serviceOrderId: os.id } }))).toBe(1);
  });

  it('na aplicação: excluir filial com registros vira 409 BRANCH_IN_USE (RESTRICT chega ao Prisma sem código, não é erro interno)', async () => {
    const branch2 = await bypass<any>(() => db.branch.create({ data: { companyId: A.companyId, name: `Filial 2 ${stamp}`, isActive: true } }));
    await asCompany(A.companyId, () => prisma.partner.create({ data: { companyId: A.companyId, branchId: branch2.id, name: `P-${stamp}-f2`, discountValue: 1 } }));
    await expect(asCompany(A.companyId, () => branchService.delete(branch2.id, A.companyId))).rejects.toMatchObject({ statusCode: 409, code: 'BRANCH_IN_USE' });
    expect(await bypass<any>(() => db.branch.count({ where: { id: branch2.id } }))).toBe(1);
  });

  it('no tratador de erros: RESTRICT em exclusão → 409 RECORD_IN_USE com mensagem humana; FK inválida em gravação continua 400', async () => {
    let restrictErr: any;
    try {
      await bypass<any>(() => db.product.delete({ where: { id: A.productId } }));
    } catch (e) {
      restrictErr = e;
    }
    expect(restrictErr).toBeDefined();
    const fakeRes = () => {
      const r: any = { statusCode: 0, body: null };
      r.status = (c: number) => ((r.statusCode = c), r);
      r.json = (b: any) => ((r.body = b), r);
      r.setHeader = () => r;
      return r;
    };
    const res = fakeRes();
    errorHandler(restrictErr, { path: '/x', method: 'DELETE', originalUrl: '/x' } as any, res, (() => undefined) as any);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('RECORD_IN_USE');
    expect(res.body.message).not.toMatch(/RESTRICT|constraint/i);

    let fkErr: any;
    try {
      await asCompany(A.companyId, () => prisma.partner.create({ data: { companyId: A.companyId, branchId: B.branchId, name: `P-${stamp}-bad`, discountValue: 1 } }));
    } catch (e) {
      fkErr = e;
    }
    const res2 = fakeRes();
    errorHandler(fkErr, { path: '/x', method: 'POST', originalUrl: '/x' } as any, res2, (() => undefined) as any);
    expect(res2.statusCode).toBe(400);
    expect(res2.body.code).toBe('INVALID_REFERENCE');
  });

  it('estado do catálogo: as FKs novas existem e estão validadas (única exceção documentada: o recebível órfão legado do dev)', async () => {
    const rows = await bypass<Array<{ n: number }>>(() =>
      db.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conname LIKE '%\\_companyId\\_branchId\\_fkey' AND confdeltype = 'r'`
      )
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(55);
    const unvalidated = await bypass<Array<{ t: string }>>(() =>
      db.$queryRawUnsafe(`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`)
    );
    expect(unvalidated.map((r) => r.t).filter((t) => t !== 'accounts_receivable')).toEqual([]);
  });
});
