import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import transferService from '../../src/services/transfer.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Duplo clique em "Enviar"/"Receber" transferência (Postgres real, requisições simultâneas): send/receive
 * conferiam o status fora da transação e o update final não tinha condição de status. Dois envios lançavam dois
 * TRANSFER_OUT (a trava do produto só serializava; havendo saldo, os dois passavam) e dois recebimentos lançavam
 * dois TRANSFER_IN — estoque duplicado na filial de destino.
 */
describe('Transferência: envio/recebimento simultâneos não duplicam estoque (integração real)', () => {
  let fixture: IntegrationFixture;
  let branch2Id: string;

  const asCompany = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);

  const movements = async (transferId: string, type: 'TRANSFER_OUT' | 'TRANSFER_IN') => {
    const rows = await bypass<any[]>(() =>
      db.stockMovement.findMany({ where: { companyId: fixture.companyId, referenceId: transferId, movementType: type } })
    );
    return rows.reduce((s, r) => s + Number(r.quantity), 0);
  };

  async function approvedTransfer(transferNumber: number) {
    return bypass<any>(() =>
      db.transfer.create({
        data: {
          companyId: fixture.companyId,
          fromBranchId: fixture.branchId,
          toBranchId: branch2Id,
          transferNumber,
          status: 'PENDING',
          requestedBy: fixture.userId,
          approvedBy: fixture.userId,
          approvedAt: new Date(),
          items: { create: [{ productId: fixture.productId, requestedQuantity: 3 }] },
        },
        include: { items: true },
      })
    );
  }

  beforeAll(async () => {
    fixture = await createFixture('transferrace');
    branch2Id = (await bypass<any>(() => db.branch.create({ data: { companyId: fixture.companyId, name: 'Filial destino', isActive: true } }))).id;
    await bypass(() =>
      db.stockMovement.create({
        data: {
          companyId: fixture.companyId, branchId: fixture.branchId, productId: fixture.productId,
          movementType: 'PURCHASE', quantity: 10, userId: fixture.userId, notes: 'saldo inicial do teste',
        },
      })
    );
  });

  afterAll(async () => {
    if (fixture) {
      await bypass(() => db.transferItem.deleteMany({ where: { transfer: { companyId: fixture.companyId } } }));
      await bypass(() => db.transfer.deleteMany({ where: { companyId: fixture.companyId } }));
      await destroyFixture(fixture);
    }
  });

  it('dois "Enviar" simultâneos: só um TRANSFER_OUT, o outro é recusado', async () => {
    const t = await approvedTransfer(1);
    const send = () =>
      asCompany(() =>
        transferService.send({ transferId: t.id, companyId: fixture.companyId, sentBy: fixture.userId, items: [{ transferItemId: t.items[0].id, sentQuantity: 3 }] })
      );
    const results = await Promise.allSettled([send(), send()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await movements(t.id, 'TRANSFER_OUT')).toBe(-3);
  });

  it('dois "Receber" simultâneos: só um TRANSFER_IN, o outro é recusado', async () => {
    const t = await approvedTransfer(2);
    await asCompany(() =>
      transferService.send({ transferId: t.id, companyId: fixture.companyId, sentBy: fixture.userId, items: [{ transferItemId: t.items[0].id, sentQuantity: 3 }] })
    );
    const receive = () =>
      asCompany(() =>
        transferService.receive({ transferId: t.id, companyId: fixture.companyId, receivedBy: fixture.userId, items: [{ transferItemId: t.items[0].id, receivedQuantity: 3 }] })
      );
    const results = await Promise.allSettled([receive(), receive()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await movements(t.id, 'TRANSFER_IN')).toBe(3);
  });
});
