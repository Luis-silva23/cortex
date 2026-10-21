import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import activationService from '../../src/services/activation.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Aprovação de ativação (Postgres real): approveActivation só olhava o status da ATIVAÇÃO. Um dispositivo REVOGADO
 * ou BLOQUEADO que ainda tinha uma ativação pendente voltava a ACTIVE e recebia credencial nova (JWT de ~10 anos);
 * e duas aprovações simultâneas da mesma solicitação passavam ambas (status conferido fora da transação).
 */
describe('Dispositivo revogado/bloqueado não volta a ACTIVE por aprovação pendente (integração real)', () => {
  let fixture: IntegrationFixture;
  let licenseId: string;
  const stamp = `dev-${Date.now()}`;
  let seq = 0;

  const asSuperAdmin = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: null as any, userType: 'SUPER_ADMIN', branchId: null }, fn);

  async function deviceWithPendingActivation(status: 'REVOKED' | 'BLOCKED' | 'PENDING') {
    const device = await bypass<any>(() =>
      db.device.create({ data: { licenseId, deviceName: `${stamp}-${status}`, deviceType: 'POS', status } })
    );
    const activation = await bypass<any>(() =>
      db.activation.create({
        data: { licenseId, deviceId: device.id, userId: fixture.userId, activationCode: `${stamp}-${++seq}`, status: 'PENDING' },
      })
    );
    return { device, activation };
  }

  beforeAll(async () => {
    fixture = await createFixture('devicerevoke');
    licenseId = (await bypass<any>(() => db.license.create({ data: { companyId: fixture.companyId, licenseType: 'TRIAL' } }))).id;
  });

  afterAll(async () => {
    if (licenseId && fixture) {
      await bypass(() => db.activation.deleteMany({ where: { licenseId, license: { companyId: fixture.companyId } } }));
      await bypass(() => db.device.deleteMany({ where: { licenseId, license: { companyId: fixture.companyId } } }));
      await bypass(() => db.license.deleteMany({ where: { id: licenseId } }));
    }
    if (fixture) await destroyFixture(fixture);
  });

  it.each(['REVOKED', 'BLOCKED'] as const)('dispositivo %s: aprovação é recusada e ele continua bloqueado, sem credencial', async (status) => {
    const { device, activation } = await deviceWithPendingActivation(status);
    await expect(asSuperAdmin(() => activationService.approveActivation(activation.id, fixture.userId))).rejects.toThrow();

    const after = await bypass<any>(() => db.device.findUnique({ where: { id: device.id } }));
    expect(after.status).toBe(status);
  });

  it('duas aprovações simultâneas da mesma solicitação: só uma emite credencial', async () => {
    const { activation } = await deviceWithPendingActivation('PENDING');
    const approve = () => asSuperAdmin(() => activationService.approveActivation(activation.id, fixture.userId));
    const results = await Promise.allSettled([approve(), approve()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
