import bcrypt from 'bcrypt';
import { hash as argon2Hash, Algorithm } from '@node-rs/argon2';
import {
  argon2Params,
  argon2ParamsOf,
  burnOtherAlgorithmCost,
  comparePassword,
  hashPassword,
  passwordHashAlgorithm,
  passwordNeedsRehash,
} from '@ln-system/shared/utils/password';

/**
 * Decisão 121 — Argon2id para senhas novas, bcrypt aceito para as antigas. Lógica pura (sem banco): identificação do formato,
 * parâmetros, necessidade de migrar e recusa segura de lixo. A migração no login (contra o PostgreSQL) está em
 * test/integration/password-hash-migration.integration.test.ts.
 */
const PASSWORD = 'Forte-Senha-2026-Xk!';
const saved = { ...process.env };
afterEach(() => {
  for (const k of ['PASSWORD_HASH_ALGORITHM', 'ARGON2_MEMORY_KIB', 'ARGON2_TIME_COST', 'ARGON2_PARALLELISM', 'PASSWORD_LEGACY_BCRYPT', 'BCRYPT_ROUNDS']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('hash de senha — Argon2id (padrão) e bcrypt (legado)', () => {
  it('senha nova é gravada em Argon2id (PHC), com sal aleatório e os parâmetros atuais', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b); // sal diferente a cada hash
    expect(a).not.toContain(PASSWORD);
    expect(passwordHashAlgorithm(a)).toBe('argon2id');
    expect(argon2ParamsOf(a)).toEqual({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(await comparePassword(PASSWORD, a)).toBe(true);
    expect(await comparePassword('outra-senha', a)).toBe(false);
  });

  it('hash bcrypt antigo continua sendo aceito e é marcado para migrar', async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);
    expect(passwordHashAlgorithm(legacy)).toBe('bcrypt');
    expect(await comparePassword(PASSWORD, legacy)).toBe(true);
    expect(await comparePassword('errada', legacy)).toBe(false);
    expect(passwordNeedsRehash(legacy)).toBe(true);
  });

  it('Argon2id com parâmetros mais fracos que os atuais é marcado para migrar; igual ou mais forte, não', async () => {
    const weak = await argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
    expect(passwordNeedsRehash(weak)).toBe(true);
    expect(await comparePassword(PASSWORD, weak)).toBe(true);
    const strong = await argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 32768, timeCost: 3, parallelism: 1 });
    expect(passwordNeedsRehash(strong)).toBe(false);
    expect(passwordNeedsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it('os parâmetros vêm do ambiente (com limites) e valem para os hashes novos', async () => {
    process.env.ARGON2_MEMORY_KIB = '9216';
    process.env.ARGON2_TIME_COST = '3';
    expect(argon2Params()).toEqual({ memoryCost: 9216, timeCost: 3, parallelism: 1 });
    expect(argon2ParamsOf(await hashPassword(PASSWORD))).toEqual({ memoryCost: 9216, timeCost: 3, parallelism: 1 });
    process.env.ARGON2_MEMORY_KIB = '12'; // abaixo do mínimo aceito: volta ao padrão
    process.env.ARGON2_TIME_COST = 'abc';
    expect(argon2Params()).toEqual({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
  });

  it('PASSWORD_HASH_ALGORITHM=bcrypt reverte a gravação e não migra de volta o que existe', async () => {
    process.env.PASSWORD_HASH_ALGORITHM = 'bcrypt';
    process.env.BCRYPT_ROUNDS = '4';
    const h = await hashPassword(PASSWORD);
    expect(h).toMatch(/^\$2[aby]\$04\$/);
    expect(await comparePassword(PASSWORD, h)).toBe(true);
    expect(passwordNeedsRehash(h)).toBe(false);
    delete process.env.PASSWORD_HASH_ALGORITHM;
    const argon = await hashPassword(PASSWORD);
    process.env.PASSWORD_HASH_ALGORITHM = 'bcrypt';
    expect(passwordNeedsRehash(argon)).toBe(false); // reversão ligada: nada é regravado sozinho
  });

  it('lixo, vazio, truncado ou de outro formato é recusado sem lançar e sem vazar nada', async () => {
    const good = await hashPassword(PASSWORD);
    for (const bad of ['', 'plain-text-password', '$argon2id$truncado', good.slice(0, 40), good.replace('$argon2id$', '$argon2i$'), '$2b$12$curto', null as unknown as string, undefined as unknown as string]) {
      await expect(comparePassword(PASSWORD, bad)).resolves.toBe(false);
      expect(passwordNeedsRehash(bad as string)).toBe(false);
    }
    expect(passwordHashAlgorithm(null)).toBe('unknown');
  });

  it('o custo extra que equaliza o tempo roda para conta inexistente e para os dois algoritmos, e pode ser desligado', async () => {
    const argon = await hashPassword(PASSWORD);
    const legacy = await bcrypt.hash(PASSWORD, 10);
    await expect(burnOtherAlgorithmCost('x', null)).resolves.toBeUndefined();
    await expect(burnOtherAlgorithmCost('x', argon)).resolves.toBeUndefined();
    await expect(burnOtherAlgorithmCost('x', legacy)).resolves.toBeUndefined();
    process.env.PASSWORD_LEGACY_BCRYPT = 'false';
    const started = Date.now();
    await burnOtherAlgorithmCost('x', null);
    expect(Date.now() - started).toBeLessThan(50); // desligado: não gasta nada
  });
});
