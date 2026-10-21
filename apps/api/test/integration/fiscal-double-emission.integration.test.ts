import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import fiscalService from '../../src/services/fiscal.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Emissões simultâneas da MESMA venda (Postgres real): a checagem "já existe documento ativo" rodava fora de
 * transação e ignorava DRAFT (o estado entre criar o documento e o provedor responder). Duplo clique ou dois caixas
 * geravam dois documentos fiscais para uma venda — número de série consumido em dobro, nota duplicada.
 */
describe('Fiscal: uma venda nunca gera dois documentos em emissões simultâneas (integração real)', () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createFixture('fiscalrace');
    // Com configuração fiscal a numeração avança a cada emissão (sem ela o número fixo 1 colide e mascara a corrida).
    await bypass(() => db.fiscalConfig.create({ data: { companyId: fixture.companyId, branchId: fixture.branchId } }));
  });
  afterAll(async () => {
    if (fixture) {
      await bypass(() => db.fiscalDocument.deleteMany({ where: { companyId: fixture.companyId } }));
      await bypass(() => db.fiscalConfig.deleteMany({ where: { companyId: fixture.companyId } }));
      await destroyFixture(fixture);
    }
  });

  it('4 emissões em paralelo => 1 documento, as demais recusadas', async () => {
    const sale = await bypass<any>(() =>
      db.sale.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, saleNumber: 6001, customerId: fixture.customerId,
          userId: fixture.userId, cashRegisterId: fixture.cashRegisterId, status: 'PAID', subtotal: 50, totalAmount: 50,
        },
      })
    );
    const emit = () =>
      runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        fiscalService.emitDocument(sale.id, fixture.companyId, fixture.branchId)
      );
    const results = await Promise.allSettled([emit(), emit(), emit(), emit()]);

    const docs = await bypass<any[]>(() => db.fiscalDocument.findMany({ where: { companyId: fixture.companyId, saleId: sale.id } }));
    expect(docs).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
