import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * MESMA EMPRESA NAS REFERÊNCIAS SEM FK COMPOSTA (migration 20261015160000_same_company_ref_triggers, Postgres real).
 * sales.partnerId e service_orders.mechanicId (SET NULL — a aplicação apaga convênios e usuários) e users.branchId (companyId pode ser nulo) têm FK
 * simples, que não olha a empresa; a RLS não passa pela checagem de FK. Agora um trigger recusa (23503 → P2003) a referência a registro de outra empresa
 * e a exclusão do pai continua anulando só a coluna da referência.
 */
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

describe('referências sem FK composta: o trigger exige a MESMA empresa (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  const stamp = Date.now();
  let partnerA = '';
  let partnerB = '';
  let mechanicB = '';
  let mechanicA = '';

  beforeAll(async () => {
    A = await createFixture('sctA');
    B = await createFixture('sctB');
    partnerA = (await asCompany(A.companyId, () => prisma.partner.create({ data: { companyId: A.companyId, name: `PA-${stamp}`, discountValue: 5 } }))).id;
    partnerB = (await asCompany(B.companyId, () => prisma.partner.create({ data: { companyId: B.companyId, name: `PB-${stamp}`, discountValue: 5 } }))).id;
    mechanicA = A.userId;
    mechanicB = B.userId;
  });

  afterAll(async () => {
    if (A) await destroyFixture(A);
    if (B) await destroyFixture(B);
  });

  const saleData = (F: IntegrationFixture, n: number, partnerId: string | null) =>
    ({ companyId: F.companyId, branchId: F.branchId, saleNumber: n, userId: F.userId, subtotal: 10, totalAmount: 10, status: 'PENDING', cashRegisterId: F.cashRegisterId, partnerId }) as any;
  const osData = (F: IntegrationFixture, n: number, mechanicId: string | null) =>
    ({
      companyId: F.companyId,
      branchId: F.branchId,
      osNumber: n,
      customerId: F.customerId,
      motorcycleId: F.motorcycleId,
      entryDate: new Date(),
      entryKilometer: 1,
      finalTotal: 0,
      mechanicId,
    }) as any;

  it('venda: convênio da OUTRA empresa é recusado; o da própria empresa e nulo passam', async () => {
    await expect(bypass<any>(() => db.sale.create({ data: saleData(A, 8001, partnerB) }))).rejects.toMatchObject({ code: 'P2003' });
    const ok = await bypass<any>(() => db.sale.create({ data: saleData(A, 8002, partnerA) }));
    expect(ok.partnerId).toBe(partnerA);
    const none = await bypass<any>(() => db.sale.create({ data: saleData(A, 8003, null) }));
    expect(none.partnerId).toBeNull();
    // UPDATE para o convênio da outra empresa também é recusado e o valor antigo permanece
    await expect(bypass<any>(() => db.sale.update({ where: { id: ok.id }, data: { partnerId: partnerB } }))).rejects.toMatchObject({ code: 'P2003' });
    expect((await bypass<any>(() => db.sale.findUnique({ where: { id: ok.id } })))!.partnerId).toBe(partnerA);
  });

  it('OS: mecânico de OUTRA empresa é recusado; o da própria empresa passa', async () => {
    await expect(bypass<any>(() => db.serviceOrder.create({ data: osData(A, 8101, mechanicB) }))).rejects.toMatchObject({ code: 'P2003' });
    const ok = await bypass<any>(() => db.serviceOrder.create({ data: osData(A, 8102, mechanicA) }));
    expect(ok.mechanicId).toBe(mechanicA);
    await expect(bypass<any>(() => db.serviceOrder.update({ where: { id: ok.id }, data: { mechanicId: mechanicB } }))).rejects.toMatchObject({ code: 'P2003' });
  });

  it('usuário: filial de OUTRA empresa é recusada; usuário de plataforma (sem empresa) não é afetado', async () => {
    await expect(
      bypass<any>(() => db.user.create({ data: { companyId: A.companyId, branchId: B.branchId, name: `U-${stamp}`, email: `sct-${stamp}-x@test.local`, password: 'x', userType: 'OPERATOR', isActive: true } }))
    ).rejects.toMatchObject({ code: 'P2003' });
    const ok = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: `U-${stamp}-ok`, email: `sct-${stamp}-ok@test.local`, password: 'x', userType: 'OPERATOR', isActive: true } })
    );
    expect(ok.branchId).toBe(A.branchId);
    const platform = await bypass<any>(() =>
      db.user.create({ data: { companyId: null, name: `P-${stamp}`, email: `sct-${stamp}-plat@test.local`, password: 'x', userType: 'SUPER_ADMIN', isActive: true } })
    );
    expect(platform.companyId).toBeNull();
    await bypass<any>(() => db.user.deleteMany({ where: { id: platform.id, companyId: null, email: `sct-${stamp}-plat@test.local` } }));
  });

  it('a exclusão do pai continua anulando só a coluna da referência (SET NULL preservado)', async () => {
    const sale = await bypass<any>(() => db.sale.create({ data: saleData(A, 8004, partnerA) }));
    await bypass<any>(() => db.partner.delete({ where: { id: partnerA } }));
    const after = await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }));
    expect(after!.partnerId).toBeNull();
    expect(after!.companyId).toBe(A.companyId);
  });

  it('nenhuma linha existente viola a regra (a guarda da migration também conferiu na hora de aplicar)', async () => {
    const rows = await bypass<Array<{ n: number | bigint }>>(() =>
      db.$queryRawUnsafe(
        `SELECT ((SELECT count(*) FROM sales s WHERE s."partnerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.id = s."partnerId" AND p."companyId" = s."companyId"))
              + (SELECT count(*) FROM service_orders o WHERE o."mechanicId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o."mechanicId" AND u."companyId" = o."companyId"))
              + (SELECT count(*) FROM users u WHERE u."branchId" IS NOT NULL AND u."companyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = u."branchId" AND b."companyId" = u."companyId")))::int AS n`
      )
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
