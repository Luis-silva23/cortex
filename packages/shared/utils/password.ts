import bcrypt from 'bcrypt';
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';

/**
 * HASH DE SENHA — Argon2id para senhas novas, bcrypt aceito para as antigas (decisão 121, 2026-10-14).
 *
 *  - `hashPassword` grava Argon2id (PHC: `$argon2id$v=19$m=…,t=…,p=…$salt$hash`; o sal é aleatório e vai dentro do texto).
 *    `PASSWORD_HASH_ALGORITHM=bcrypt` volta ao algoritmo anterior (reversão sem mexer em dado: os dois formatos são lidos sempre).
 *  - `comparePassword` identifica o formato pelo prefixo (`$argon2id$` ou `$2a/$2b/$2y$`) — nunca por tentativa e erro — e confere.
 *    Formato desconhecido ou texto que não é hash = recusa (false), nunca exceção que vaze o valor.
 *  - `passwordNeedsRehash` diz se o hash guardado é bcrypt ou Argon2id com parâmetros MAIS FRACOS que os atuais: quem autentica com
 *    sucesso tem o hash trocado de forma transparente (ver auth.service). Ninguém precisa redefinir a senha; nenhuma sessão cai.
 *  - Parâmetros (ajustáveis por ambiente, padrão = mínimo recomendado pela OWASP: 19 MiB, 2 passadas, 1 faixa): ARGON2_MEMORY_KIB,
 *    ARGON2_TIME_COST, ARGON2_PARALLELISM. Cada login em andamento usa ARGON2_MEMORY_KIB de memória: dimensione pela concorrência de
 *    login da instalação e meça no hardware real (alvo usual: 50–100 ms por verificação).
 *  - Nada aqui escreve senha ou hash em log.
 */
const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function argon2Params() {
  return {
    memoryCost: intEnv('ARGON2_MEMORY_KIB', 19456, 8192, 4194304),
    timeCost: intEnv('ARGON2_TIME_COST', 2, 1, 20),
    parallelism: intEnv('ARGON2_PARALLELISM', 1, 1, 16),
  };
}

const bcryptRounds = () => intEnv('BCRYPT_ROUNDS', 12, 4, 31);
const useBcrypt = () => process.env.PASSWORD_HASH_ALGORITHM?.trim().toLowerCase() === 'bcrypt';

export type PasswordHashAlgorithm = 'argon2id' | 'bcrypt' | 'unknown';

/** Algoritmo do hash guardado, só pelo prefixo (não confere senha nenhuma). */
export function passwordHashAlgorithm(hash: string | null | undefined): PasswordHashAlgorithm {
  if (typeof hash !== 'string') return 'unknown';
  if (hash.startsWith('$argon2id$')) return 'argon2id';
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return 'bcrypt'; // 60 caracteres exatos: truncado/lixo não é "bcrypt"
  return 'unknown';
}

/** Parâmetros do hash Argon2id guardado (m, t, p) ou null se não for Argon2id legível. */
export function argon2ParamsOf(hash: string): { memoryCost: number; timeCost: number; parallelism: number } | null {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  return m ? { memoryCost: Number(m[1]), timeCost: Number(m[2]), parallelism: Number(m[3]) } : null;
}

export async function hashPassword(password: string): Promise<string> {
  if (useBcrypt()) return bcrypt.hash(password, bcryptRounds());
  return argon2Hash(password, { algorithm: Algorithm.Argon2id, ...argon2Params() });
}

// (plain, hash) — never the other order; every real call site in apps/api
// passes the just-typed password first and the stored User.password second.
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  switch (passwordHashAlgorithm(hash)) {
    case 'argon2id':
      try {
        return await argon2Verify(hash, password);
      } catch {
        return false; // hash corrompido: recusa, sem expor nada
      }
    case 'bcrypt':
      return bcrypt.compare(password, hash);
    default:
      return false;
  }
}

/** O hash guardado deve ser regravado após um login válido? (bcrypt, ou Argon2id mais fraco que os parâmetros atuais) */
export function passwordNeedsRehash(hash: string): boolean {
  const algorithm = passwordHashAlgorithm(hash);
  if (algorithm === 'unknown') return false; // não há o que migrar com segurança
  if (useBcrypt()) return false; // reversão ligada: o que existe fica como está
  if (algorithm === 'bcrypt') return true;
  const current = argon2Params();
  const stored = argon2ParamsOf(hash);
  if (!stored) return false;
  return stored.memoryCost < current.memoryCost || stored.timeCost < current.timeCost || stored.parallelism < current.parallelism;
}

/**
 * Gasta o custo do algoritmo que o hash REAL não usou. Sem isto, durante a migração o tempo da resposta diria quais contas já foram
 * migradas (bcrypt ≈ 200 ms, Argon2id ≈ 20 ms) e, pior, qual e-mail existe (conta inexistente não pagava o custo de nenhum). Com ele,
 * toda tentativa de login paga bcrypt + Argon2id: `realHash` = null (conta inexistente) gasta os DOIS. `PASSWORD_LEGACY_BCRYPT=false`
 * desliga quando não restar bcrypt no banco.
 */
let dummyBcryptHash: Promise<string> | undefined;
let dummyArgonHash: Promise<string> | undefined;
export async function burnOtherAlgorithmCost(password: string, realHash: string | null): Promise<void> {
  if (process.env.PASSWORD_LEGACY_BCRYPT?.trim().toLowerCase() === 'false') return;
  const used = realHash ? passwordHashAlgorithm(realHash) : 'unknown';
  if (used !== 'bcrypt') {
    dummyBcryptHash ??= bcrypt.hash(`descartavel-${Math.random()}`, bcryptRounds());
    await bcrypt.compare(password, await dummyBcryptHash);
  }
  if (used !== 'argon2id') {
    dummyArgonHash ??= argon2Hash(`descartavel-${Math.random()}`, { algorithm: Algorithm.Argon2id, ...argon2Params() });
    await argon2Verify(await dummyArgonHash, password).catch(() => false);
  }
}
