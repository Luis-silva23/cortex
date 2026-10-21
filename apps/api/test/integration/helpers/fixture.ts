import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { assertDestroyable } from './destructive-guard';
import { purgeCompanyData } from './purge-company';

/**
 * Fixture real (não mockada) para a suíte de integração: cria empresa,
 * filial, operador, produto com estoque e um caixa aberto, tudo via Prisma
 * direto (sob bypass SUPER_ADMIN de RLS — mesmo padrão usado em scripts de
 * seed do projeto). Documento (CNPJ) usa um valor conhecido-válido reusado
 * em toda a sessão anterior de testes manuais deste projeto.
 */
export interface IntegrationFixture {
  companyId: string;
  branchId: string;
  userId: string;
  productId: string;
  cashRegisterId: string;
  customerId: string;
  motorcycleId: string;
  supplierId: string;
}

const VALID_CNPJ = '11222333000181';

// `document` é único. Antes só 3 dígitos variavam (900 combinações): com
// empresas de teste esquecidas no banco de dev e várias fixtures por rodada,
// uma colisão rara derrubava o `beforeAll` de uma suíte inteira. 6 dígitos
// aleatórios (1.000.000 combinações) mantêm o formato de 14 dígitos.
function randomCnpjLike(): string {
  return VALID_CNPJ.slice(0, -6) + String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export async function createFixture(label: string): Promise<IntegrationFixture> {
  return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    const company = await prisma.company.create({
      data: {
        name: `Integration Test Co ${label}`,
        document: randomCnpjLike(),
        email: `integration-${label}-${Date.now()}@test.local`,
        isActive: true,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        companyId: company.id,
        name: 'Matriz',
        isHeadquarter: true,
        isActive: true,
      },
    });

    const hashedPassword = await hashPassword('IntegrationTest123!');
    const user = await prisma.user.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        name: `Operador ${label}`,
        email: `operador-${label}-${Date.now()}@test.local`,
        password: hashedPassword,
        userType: 'OPERATOR',
        isActive: true,
      },
    });

    const product = await prisma.product.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        sku: `INT-${label}-${Date.now()}`,
        name: `Produto Integração ${label}`,
        costPrice: 5,
        salePrice: 10,
        isActive: true,
      },
    });

    // Estoque inicial generoso — o teste de concorrência precisa vender
    // várias unidades sem esbarrar em "estoque insuficiente", que não é o
    // que está sendo testado aqui.
    await prisma.stockMovement.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        productId: product.id,
        movementType: 'PURCHASE',
        quantity: 1000,
        userId: user.id,
      },
    });

    const cashRegister = await prisma.cashRegister.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        userId: user.id,
        registerNumber: 1,
        status: 'OPEN',
        openingAmount: 100,
      },
    });

    const customer = await prisma.customer.create({
      data: {
        companyId: company.id,
        name: `Cliente Integração ${label}`,
        isActive: true,
      },
    });

    const motorcycle = await prisma.motorcycle.create({
      data: {
        companyId: company.id,
        customerId: customer.id,
        brand: 'Honda',
        model: 'CG 160',
        kilometerReading: 1000,
        isActive: true,
      },
    });

    const supplier = await prisma.supplier.create({
      data: {
        companyId: company.id,
        name: `Fornecedor Integração ${label}`,
        document: randomCnpjLike(),
        isActive: true,
      },
    });

    return {
      companyId: company.id,
      branchId: branch.id,
      userId: user.id,
      productId: product.id,
      cashRegisterId: cashRegister.id,
      customerId: customer.id,
      motorcycleId: motorcycle.id,
      supplierId: supplier.id,
    };
  });
}

/**
 * Expurga os dados da empresa sintética (todas as tabelas, em ordem de FK — ver `purge-company.ts`), sem apagar a empresa.
 * Mantido com este nome porque os testes o chamam antes de apagar contas a receber/OS (FK Restrict) e convênios.
 */
export async function purgeNewDomainData(companyId: string): Promise<void> {
  await assertDestroyable(companyId);
  await purgeCompanyData(companyId);
}

/**
 * Expurgo SINALIZADO do livro de estoque de uma empresa sintética (e, opcionalmente, de um produto): o livro é append-only
 * (`stock_movements_purge` só aceita DELETE de Super Admin com `app.audit_purge = on` na mesma transação). Serve para o teste
 * partir de saldo controlado depois do estoque inicial que a fixture semeia.
 */
export async function purgeStockMovements(companyId: string, productId?: string): Promise<void> {
  await assertDestroyable(companyId);
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    await runInTransaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
      await tx.stockMovement.deleteMany({ where: { companyId, ...(productId ? { productId } : {}) } });
    });
  });
}

/**
 * Apaga agendamentos da empresa sintética (opcionalmente só a partir de uma data) COM os eventos: appointment_events → appointments é RESTRICT
 * (histórico não some em cascata). Para limpeza ENTRE testes; o teardown final já é coberto pelo expurgo de `destroyFixture`.
 */
export async function deleteAppointmentsOf(companyId: string, scheduledFrom: Date = new Date(0)): Promise<void> {
  await assertDestroyable(companyId);
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    await runInTransaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM appointment_events WHERE "appointmentId" IN (SELECT id FROM appointments WHERE "companyId" = ${companyId} AND "scheduledAt" >= ${scheduledFrom})`;
      await tx.$executeRaw`DELETE FROM appointments WHERE "companyId" = ${companyId} AND "scheduledAt" >= ${scheduledFrom}`;
    });
  });
}

/** Remove tudo que a fixture criou: dados em ordem de FK (guiada pelo catálogo) e, por último, a empresa. */
export async function destroyFixture(fixture: IntegrationFixture): Promise<void> {
  // NUNCA apagar sem um id válido de uma empresa SINTÉTICA ("Integration Test Co …"): com `companyId`
  // undefined, o expurgo viraria "apague a tabela inteira" (ver destructive-guard.ts).
  await assertDestroyable(fixture?.companyId);
  // A auditoria é gravada de forma ASSÍNCRONA (fila `audit-log`): uma linha pode chegar logo depois do expurgo e travar a exclusão da empresa
  // (audit_logs → companies é RESTRICT). Repete expurgo + exclusão, no máximo 5 vezes, só para esse caso (P2003); qualquer outro erro sobe.
  for (let attempt = 1; ; attempt++) {
    await purgeCompanyData(fixture.companyId);
    try {
      await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
        await prisma.company.delete({ where: { id: fixture.companyId } });
      });
      return;
    } catch (err: any) {
      const blockedByLateRows = /23001|P2003|violates RESTRICT/.test(`${err?.code ?? ''} ${err?.message ?? ''}`);
      if (!blockedByLateRows || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
