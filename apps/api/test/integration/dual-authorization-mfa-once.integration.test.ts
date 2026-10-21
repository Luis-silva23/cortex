import * as crypto from 'crypto';
import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import redis from '../../src/config/redis';
import cashRegisterService from '../../src/services/cash-register.service';
import { verifyDualAuthorization } from '../../src/services/dual-authorization.service';
import { consumeStoredOtp } from '../../src/services/mfa-consume';
import { mfaService } from '../../src/services/MFAService';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * DUPLA AUTORIZAÇÃO COM MFA — o código vale UMA vez, mesmo com requisições simultâneas (Postgres e Redis reais).
 * Risco registrado: o mesmo código TOTP (e o mesmo código de recuperação) ainda era aceito mais de uma vez dentro da janela de 30 s, porque
 * a verificação lia o código e a aplicação decidia sozinha. Agora o consumo é feito no banco: passo TOTP em `users.mfaLastStep`
 * (atualização condicional) e código de recuperação por compare-and-swap da lista; o código SMS/e-mail do Redis é comparado e apagado por
 * um script atômico. As chamadas concorrentes abaixo simulam duas requisições (ou duas instâncias da API) com o mesmo código.
 */
function base32(buf: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('Dupla autorização: o código MFA do autorizador vale uma única vez (concorrência real)', () => {
  let F: IntegrationFixture;
  let authorizerId: string;
  let authorizerNumericId: number;
  let secret: string;
  let plainBackupCodes: string[];
  const stamp = Date.now();
  const PASSWORD = `Forte-${stamp}-Xk!`;
  const otpKeys: string[] = [];

  const inCompany = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: F.companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
  const authorize = (code: string) =>
    inCompany(() =>
      verifyDualAuthorization({
        companyId: F.companyId,
        requesterId: F.userId,
        authorizerNumericId,
        authorizerPassword: PASSWORD,
        authorizerMfaCode: code,
        allowedRoles: ['MANAGER', 'COMPANY_ADMIN'],
        actionEvent: 'WITHDRAWAL',
        subjectLabel: 'withdrawal',
      })
    );
  const authorizerRow = () => bypass<any>(() => db.user.findUnique({ where: { id: authorizerId } }));
  const resetStep = () => bypass(() => db.user.update({ where: { id: authorizerId }, data: { mfaLastStep: null } }));
  const reasons = (results: PromiseSettledResult<unknown>[]) => results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason));

  beforeAll(async () => {
    F = await createFixture('dualmfa');
    secret = base32(crypto.randomBytes(20));
    plainBackupCodes = mfaService.generateBackupCodes();
    const password = await hashPassword(PASSWORD);
    const user = await bypass<any>(() =>
      db.user.create({
        data: {
          companyId: F.companyId,
          branchId: F.branchId,
          name: 'Autorizador MFA',
          email: `dual-${stamp}@teste-cortex.local`,
          password,
          userType: 'MANAGER',
          isActive: true,
          mfaEnabled: true,
          mfaSecret: sealSecret(secret),
          mfaBackupCodes: plainBackupCodes.map((c) => mfaService.hashBackupCode(c)),
        },
      })
    );
    authorizerId = user.id;
    authorizerNumericId = user.numericId;
    await bypass(() => db.cashRegister.update({ where: { id: F.cashRegisterId }, data: { status: 'OPEN', expectedAmount: 1000, openingAmount: 1000 } }));
  });

  afterAll(async () => {
    for (const k of otpKeys) await redis.del(k);
    if (authorizerId) await bypass(() => db.user.deleteMany({ where: { id: authorizerId, companyId: F.companyId } }));
    if (F) await destroyFixture(F);
  });

  it('o mesmo código TOTP, duas vezes em sequência: a primeira passa, a segunda é recusada como "já utilizado"', async () => {
    await resetStep();
    const code = totp(secret);
    await expect(authorize(code)).resolves.toMatchObject({ id: authorizerId });
    await expect(authorize(code)).rejects.toThrow('Authorizer MFA code already used');
  });

  it('8 autorizações SIMULTÂNEAS com o mesmo código TOTP: exatamente UMA passa', async () => {
    await resetStep();
    const code = totp(secret);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => authorize(code)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = reasons(results);
    expect(rejected).toHaveLength(7);
    expect(rejected.every((m) => m.includes('already used'))).toBe(true);
  });

  it('o código do passo seguinte continua valendo (o controle não tranca o autorizador)', async () => {
    await resetStep();
    const current = totp(secret);
    await authorize(current);
    const next = totp(secret, Date.now() + 30_000);
    expect(next).not.toBe(current);
    await expect(authorize(next)).resolves.toMatchObject({ id: authorizerId });
    // e o código do passo anterior (já consumido) não volta a valer
    await expect(authorize(current)).rejects.toThrow(/already used|Invalid or expired/);
  });

  it('retirada de caixa de ponta a ponta: três retiradas simultâneas com o mesmo código geram UMA só movimentação', async () => {
    await resetStep();
    const code = totp(secret);
    const withdraw = () =>
      inCompany(() =>
        cashRegisterService.requestWithdrawal({
          cashRegisterId: F.cashRegisterId,
          companyId: F.companyId,
          branchId: F.branchId,
          requesterId: F.userId,
          requesterUserType: 'COMPANY_ADMIN',
          amount: 25,
          reason: 'Teste de uso único do código',
          authorizerNumericId,
          authorizerPassword: PASSWORD,
          authorizerMfaCode: code,
        })
      );
    const results = await Promise.allSettled([withdraw(), withdraw(), withdraw()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const movements = await bypass<any[]>(() => db.cashMovement.findMany({ where: { cashRegisterId: F.cashRegisterId, movementType: 'WITHDRAWAL' } }));
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].amount)).toBe(25);
  });

  it('código de recuperação: 6 usos simultâneos do mesmo código — exatamente UM passa e ele sai da lista', async () => {
    const code = plainBackupCodes[0];
    const before = (await authorizerRow()).mfaBackupCodes.length;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => authorize(code)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await authorizerRow()).mfaBackupCodes).toHaveLength(before - 1);
    expect(reasons(results).every((m) => m.includes('Invalid or expired'))).toBe(true);
    await expect(authorize(code)).rejects.toThrow('Invalid or expired authorizer MFA code');
  });

  it('três códigos de recuperação DIFERENTES ao mesmo tempo: os três passam (o compare-and-swap relê e tenta de novo)', async () => {
    const before = (await authorizerRow()).mfaBackupCodes.length;
    const codes = plainBackupCodes.slice(1, 4);
    const results = await Promise.allSettled(codes.map((c) => authorize(c)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await authorizerRow()).mfaBackupCodes).toHaveLength(before - 3);
  });

  it('código SMS/e-mail do Redis: 5 verificações simultâneas — exatamente UMA aceita; código errado NÃO queima o válido', async () => {
    const key = `mfa:sms:teste-${stamp}`;
    otpKeys.push(key);
    await redis.setex(key, 60, '123456');
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeStoredOtp(key, '123456')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await redis.get(key)).toBeNull();

    await redis.setex(key, 60, '654321');
    expect(await consumeStoredOtp(key, '000000')).toBe(false);
    expect(await redis.get(key)).toBe('654321');
    expect(await consumeStoredOtp(key, '654321')).toBe(true);
    expect(await consumeStoredOtp(key, '654321')).toBe(false);
  });
});
