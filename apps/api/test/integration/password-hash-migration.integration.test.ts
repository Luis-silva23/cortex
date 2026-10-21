import bcrypt from 'bcrypt';
import { hash as argon2Hash, Algorithm } from '@node-rs/argon2';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { AuthService } from '../../src/services/auth.service';
import { UserService } from '../../src/services/user.service';
import { Logger } from '../../src/services/logger.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * DECISÃO 121 — migração transparente de bcrypt para Argon2id no login (PostgreSQL real).
 * Prova: conta antiga entra com a MESMA senha e o hash é trocado sozinho; sessões existentes continuam valendo; senha errada não migra;
 * troca concorrente de senha não é desfeita; falha na troca não bloqueia o login; conta nova nasce em Argon2id; hash corrompido é recusa
 * (não erro 500); reversão por variável não migra; nenhum log traz senha ou hash.
 */
describe('Migração de hash de senha no login (decisão 121)', () => {
  const authService = new AuthService();
  const userService = new UserService();
  let A: IntegrationFixture;
  const stamp = Date.now();
  const PASSWORD = `Antiga-${stamp}-Xk!`;
  const created: string[] = [];
  const email = (label: string) => `hash-${label}-${stamp}@teste-cortex.local`;
  const logged: string[] = [];
  const spies: jest.SpyInstance[] = [];

  const makeUser = async (label: string, passwordHash: string) => {
    const user = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: `Hash ${label}`, email: email(label), password: passwordHash, userType: 'OPERATOR', isActive: true } })
    );
    created.push(user.id);
    return user;
  };
  const storedHash = async (label: string) => (await bypass<any>(() => db.user.findUnique({ where: { email: email(label) } }))).password as string;
  const login = (label: string, password = PASSWORD) => authService.login({ email: email(label), password });

  beforeAll(async () => {
    A = await createFixture('hashmig');
    for (const level of ['info', 'warn', 'error', 'security', 'debug'] as const) {
      if (typeof (Logger as any)[level] === 'function') {
        spies.push(jest.spyOn(Logger as any, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))));
      }
    }
  });

  afterEach(() => {
    delete process.env.PASSWORD_HASH_ALGORITHM;
  });

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    if (created.length) {
      await bypass(() => db.refreshToken.deleteMany({ where: { userId: { in: created }, companyId: A.companyId } }));
      await bypass(() => db.user.deleteMany({ where: { id: { in: created }, companyId: A.companyId } }));
    }
    if (A?.companyId) await destroyFixture(A);
  });

  it('conta com hash bcrypt entra com a mesma senha e o hash passa a ser Argon2id; as sessões abertas continuam valendo', async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);
    await makeUser('legacy', legacy);
    const first = (await login('legacy')) as any;
    expect(first.accessToken).toBeDefined();
    const after = await storedHash('legacy');
    expect(after).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(after).not.toBe(legacy);
    const second = (await login('legacy')) as any; // a mesma senha segue valendo
    expect(second.accessToken).toBeDefined();
    expect(await storedHash('legacy')).toBe(after); // já migrado: não regrava
    // a sessão aberta ANTES/DURANTE a migração não foi derrubada
    const renewed = await authService.refreshToken(first.refreshToken);
    expect(renewed.accessToken).toBeDefined();
  });

  it('senha errada NÃO migra o hash (nada é regravado sem prova da senha)', async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);
    await makeUser('wrongpw', legacy);
    await expect(login('wrongpw', 'senha-errada-qualquer')).rejects.toThrow(/Credenciais inválidas/);
    expect(await storedHash('wrongpw')).toBe(legacy);
  });

  it('Argon2id com parâmetros mais fracos que os atuais também é atualizado', async () => {
    const weak = await argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
    await makeUser('weak', weak);
    await login('weak');
    expect(await storedHash('weak')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('conta NOVA (criada pelo serviço de usuários) já nasce em Argon2id e entra', async () => {
    const user = await runWithRLSContext({ companyId: A.companyId, userType: 'COMPANY_ADMIN', branchId: A.branchId }, () =>
      userService.create({ companyId: A.companyId, branchId: A.branchId, name: 'Conta Nova', email: email('novo'), password: PASSWORD, userType: 'OPERATOR', requirePasswordChange: false } as any)
    );
    created.push(user.id);
    expect(await storedHash('novo')).toMatch(/^\$argon2id\$/);
    expect(((await login('novo')) as any).accessToken).toBeDefined();
  });

  it('uma troca de senha CONCORRENTE não é desfeita: a migração só vale se o hash ainda é o que foi conferido', async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);
    const user = await makeUser('race', legacy);
    const newer = await hashPassword('Senha-Nova-Redefinida-9!');
    await bypass(() => db.user.update({ where: { id: user.id }, data: { password: newer } })); // alguém redefiniu a senha no meio
    await (authService as any).upgradePasswordHashIfNeeded(user.id, legacy, PASSWORD);
    expect(await storedHash('race')).toBe(newer);
  });

  it('falha ao gravar o hash novo NÃO bloqueia o login (o hash antigo segue válido) e o registro não leva senha nem hash', async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);
    await makeUser('failwrite', legacy);
    const spy = jest.spyOn(prisma.user, 'updateMany').mockRejectedValueOnce(new Error('falha simulada'));
    try {
      expect(((await login('failwrite')) as any).accessToken).toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(await storedHash('failwrite')).toBe(legacy);
    // e nada do que foi registrado em todo o arquivo contém a senha ou algum hash
    const text = logged.join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/\$argon2id\$/);
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(text).toContain('PASSWORD_HASH_UPGRADED'); // a migração é registrada (só algoritmo de/para)
  });

  it('hash corrompido na conta: recusa (401), não 500', async () => {
    await makeUser('corrupt', '$argon2id$v=19$m=19456,t=2,p=1$lixo$lixo');
    await expect(login('corrupt')).rejects.toThrow(/Credenciais inválidas/);
    await makeUser('plain', 'senha-em-texto-puro');
    await expect(login('plain', 'senha-em-texto-puro')).rejects.toThrow(/Credenciais inválidas/);
  });

  it('PASSWORD_HASH_ALGORITHM=bcrypt (reversão): conta antiga entra e NÃO é migrada', async () => {
    process.env.PASSWORD_HASH_ALGORITHM = 'bcrypt';
    const legacy = await bcrypt.hash(PASSWORD, 10);
    await makeUser('revert', legacy);
    expect(((await login('revert')) as any).accessToken).toBeDefined();
    expect(await storedHash('revert')).toBe(legacy);
  });
});
