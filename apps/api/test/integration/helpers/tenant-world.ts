import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture, purgeNewDomainData } from './fixture';
import { assertDestroyable } from './destructive-guard';

/**
 * Mundo multi-empresa / multi-filial para a bateria de isolamento:
 *
 *   EMPRESA A  →  FILIAL A1, FILIAL A2
 *   EMPRESA B  →  FILIAL B1, FILIAL B2
 *
 * Cada filial tem os SEUS registros (venda + pagamento, OS + comissão,
 * orçamento, pedido de compra, caixa, agenda, revisão, follow-up, avaria,
 * inventário, contas a pagar/receber, produto). Cada empresa tem os seus
 * cadastros de empresa inteira (cliente, moto, fornecedor, categoria, convênio).
 * Tudo com ids DISTINTOS, para provar quem enxerga o quê.
 */

export type CoKey = 'A' | 'B';
export type BranchKey = 1 | 2;

export interface BranchData {
  branchId: string;
  userId: string;
  productId: string;
  saleId: string;
  paymentTx: string;
  paymentId: string;
  serviceOrderId: string;
  commissionId: string;
  quoteId: string;
  purchaseOrderId: string;
  cashRegisterId: string;
  appointmentId: string;
  revisionId: string;
  followUpId: string;
  damageId: string;
  inventoryId: string;
  payableId: string;
  receivableId: string;
}

export interface CompanyData {
  key: CoKey;
  fixture: IntegrationFixture;
  companyId: string;
  customerId: string;
  motorcycleId: string;
  supplierId: string;
  categoryId: string;
  partnerId: string;
  branches: Record<BranchKey, BranchData>;
}

export type World = Record<CoKey, CompanyData>;

export async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

const db = prismaUnsafeBypassRLS;
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

async function seedBranch(co: { companyId: string; customerId: string; motorcycleId: string; supplierId: string }, key: CoKey, b: BranchKey, branchId: string, userId: string): Promise<BranchData> {
  const n = (key === 'A' ? 100 : 200) + b * 10; // números únicos por empresa/filial
  const product = await bypass<any>(() =>
    db.product.create({ data: { companyId: co.companyId, branchId, sku: `TW-${key}${b}-${uniq()}`, name: `Produto ${key}${b}`, costPrice: 5, salePrice: 10, isActive: true } })
  );
  const cashRegister = await bypass<any>(() =>
    db.cashRegister.create({ data: { companyId: co.companyId, branchId, userId, registerNumber: n, status: 'CLOSED', openingAmount: 0 } })
  );
  const sale = await bypass<any>(() =>
    db.sale.create({
      data: { companyId: co.companyId, branchId, saleNumber: n, customerId: co.customerId, userId, cashRegisterId: cashRegister.id, status: 'PAID', subtotal: 10, totalAmount: 10 },
    })
  );
  const paymentTx = `tx-${key}${b}-${uniq()}`;
  const payment = await bypass<any>(() =>
    db.payment.create({ data: { companyId: co.companyId, saleId: sale.id, paymentMethod: 'CASH', status: 'APPROVED', amount: 10, transactionId: paymentTx, nsuHost: `NSU-${key}${b}` } })
  );
  const os = await bypass<any>(() =>
    db.serviceOrder.create({
      data: { companyId: co.companyId, branchId, osNumber: n, customerId: co.customerId, motorcycleId: co.motorcycleId, entryDate: new Date(), entryKilometer: 1000, finalTotal: 0 },
    })
  );
  const commission = await bypass<any>(() =>
    db.mechanicCommission.create({
      data: { companyId: co.companyId, serviceOrderId: os.id, mechanicId: userId, ruleSnapshot: {}, baseAmount: 100, percentage: 10, commissionAmount: 10 + b },
    })
  );
  const quote = await bypass<any>(() =>
    db.quote.create({
      data: { companyId: co.companyId, branchId, customerId: co.customerId, motorcycleId: co.motorcycleId, quoteNumber: n, createdBy: userId, versions: { create: { versionNumber: 1, createdBy: userId } } },
    })
  );
  const po = await bypass<any>(() =>
    db.purchaseOrder.create({ data: { companyId: co.companyId, branchId, poNumber: n, supplierId: co.supplierId, subtotal: 10, totalAmount: 10 } })
  );
  const appointment = await bypass<any>(() =>
    db.appointment.create({ data: { companyId: co.companyId, branchId, customerId: co.customerId, scheduledAt: new Date(Date.now() + 86_400_000), proposedBy: userId } })
  );
  const revision = await bypass<any>(() =>
    db.revision.create({
      data: {
        companyId: co.companyId, branchId, customerId: co.customerId, motorcycleId: co.motorcycleId,
        performedAt: new Date(), kilometerAtService: 1000, servicesPerformed: 'Revisão', nextDueDate: new Date(Date.now() + 86_400_000 * 90), recordedBy: userId,
      },
    })
  );
  const followUp = await bypass<any>(() =>
    db.followUp.create({ data: { companyId: co.companyId, branchId, customerId: co.customerId, motorcycleId: co.motorcycleId, dueDate: new Date(Date.now() + 86_400_000), createdBy: userId } })
  );
  const damage = await bypass<any>(() =>
    db.damageRecord.create({ data: { companyId: co.companyId, branchId, productId: product.id, quantity: 1, reason: 'DAMAGED', approvedBy: userId, recordedBy: userId } })
  );
  const inventory = await bypass<any>(() =>
    db.inventory.create({ data: { companyId: co.companyId, branchId, inventoryNumber: n, startedBy: userId } })
  );
  const payable = await bypass<any>(() =>
    db.accountsPayable.create({ data: { companyId: co.companyId, branchId, description: `Conta a pagar ${key}${b}`, amount: 100 + b, dueDate: new Date(Date.now() + 86_400_000 * 5) } })
  );
  const receivable = await bypass<any>(() =>
    db.accountsReceivable.create({ data: { companyId: co.companyId, branchId, description: `Conta a receber ${key}${b}`, amount: 200 + b, dueDate: new Date(Date.now() + 86_400_000 * 5) } })
  );

  return {
    branchId, userId, productId: product.id, saleId: sale.id, paymentTx, paymentId: payment.id, serviceOrderId: os.id, commissionId: commission.id,
    quoteId: quote.id, purchaseOrderId: po.id, cashRegisterId: cashRegister.id, appointmentId: appointment.id, revisionId: revision.id,
    followUpId: followUp.id, damageId: damage.id, inventoryId: inventory.id, payableId: payable.id, receivableId: receivable.id,
  };
}

async function seedCompany(key: CoKey): Promise<CompanyData> {
  const fixture = await createFixture(`world-${key}`);
  const branch2 = await bypass<any>(() => db.branch.create({ data: { companyId: fixture.companyId, name: `Filial ${key}2`, isActive: true } }));
  const user2 = await bypass<any>(() =>
    db.user.create({
      data: {
        companyId: fixture.companyId, branchId: branch2.id, name: `Operador ${key}2`, email: `op-${key}2-${uniq()}@test.local`,
        password: 'not-a-real-hash', userType: 'OPERATOR', isActive: true,
      },
    })
  );
  const supplierId = fixture.supplierId;
  const category = await bypass<any>(() => db.category.create({ data: { companyId: fixture.companyId, name: `Categoria ${key}` } }));
  const partner = await bypass<any>(() => db.partner.create({ data: { companyId: fixture.companyId, name: `Convênio ${key}`, discountValue: 5 } }));

  const base = { companyId: fixture.companyId, customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, supplierId };
  const b1 = await seedBranch(base, key, 1, fixture.branchId, fixture.userId);
  const b2 = await seedBranch(base, key, 2, branch2.id, user2.id);

  return { key, fixture, companyId: fixture.companyId, customerId: fixture.customerId, motorcycleId: fixture.motorcycleId, supplierId, categoryId: category.id, partnerId: partner.id, branches: { 1: b1, 2: b2 } };
}

export async function createWorld(): Promise<World> {
  const A = await seedCompany('A');
  const B = await seedCompany('B');
  return { A, B };
}

export async function destroyWorld(world: World): Promise<void> {
  // valida as DUAS empresas antes de apagar qualquer coisa (id válido + empresa sintética)
  for (const co of [world?.A, world?.B]) await assertDestroyable(co?.companyId);
  for (const co of [world.A, world.B]) {
    const id = co.companyId;
    // expurgo guiado pelas FKs (purge-company.ts): cobre garantias, cobranças, OS, contas e demais domínios
    await purgeNewDomainData(id);
    await destroyFixture(co.fixture);
  }
}

/** Token de um usuário da empresa/filial dada. `branch` null = sem filial (papel de empresa inteira). */
export function tokenFor(co: CompanyData, branch: BranchKey | null, userType: string): string {
  const b = branch ? co.branches[branch] : null;
  return generateAccessToken({
    userId: b ? b.userId : co.fixture.userId,
    email: `${userType.toLowerCase()}@test.local`,
    companyId: co.companyId,
    branchId: (b ? b.branchId : undefined) as any,
    userType,
  });
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
