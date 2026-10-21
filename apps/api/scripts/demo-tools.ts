/**
 * Ferramentas do tenant de demonstração (banco de DESENVOLVIMENTO). Uso:
 *
 *   npm run demo:tools -- mint  <email|chave>   sessão pronta por app (JWT de 15 min + trechos de localStorage)
 *   npm run demo:tools -- totp                  código TOTP atual do SUPER_ADMIN de E2E (MFA)
 *   npm run demo:tools -- clear-ratelimit       apaga os contadores de rate limit (Redis de dev)
 *   npm run demo:tools -- unlock <email>        zera bloqueio de conta (loginAttempts/lockedUntil) de um usuário @demo.local
 *   npm run demo:tools -- list                  usuários e empresas do demo (sem senha)
 *
 * `mint` existe porque o login real tem rate limit (5 tentativas/15 min por IP): 14+ perfis de teste não cabem.
 * O fluxo de LOGIN em si continua sendo testado pela tela, com poucas tentativas. As credenciais ficam em
 * apps/api/.demo/credentials.json (ignorado pelo git). Só opera em usuários "@demo.local".
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

import { contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CREDENTIALS_FILE = path.resolve(__dirname, '../.demo/credentials.json');
const readCreds = () => {
  if (!fs.existsSync(CREDENTIALS_FILE)) throw new Error('rode `npm run demo:seed` primeiro');
  return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
};

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

async function bypassDb() {
  const { prismaUnsafeBypassRLS: db } = await import('@ln-system/database');
  const bypass = async <T>(q: () => any): Promise<T> => {
    const r = await db.$transaction([
      contextStatement(db, PLATFORM_CONTEXT),
      q(),
    ]);
    return r[1] as T;
  };
  return { db, bypass };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const creds = cmd === 'clear-ratelimit' ? null : readCreds();

  if (cmd === 'totp') {
    // Um código TOTP vale uma vez (anti-reuso, decisão 123): devolve o código de um passo MAIS NOVO que o último já consumido por este
    // usuário, esperando a virada do passo (até 30 s) se for preciso. Evita que suítes seguidas com o mesmo usuário de MFA recebam
    // "código já utilizado".
    const { db, bypass } = await bypassDb();
    const email = creds.users['sa.e2e']?.email;
    const user = email ? await bypass<any>(() => db.user.findUnique({ where: { email }, select: { mfaLastStep: true } })) : null;
    const step = (t: number) => Math.floor(t / 30000);
    const target = Math.max(step(Date.now()), (user?.mfaLastStep ?? -1) + 1);
    while (target > step(Date.now()) + 1) await new Promise((r) => setTimeout(r, 1000)); // o servidor aceita só o passo atual ±1
    console.log(totp(creds.saMfaSecret, target * 30000));
    await db.$disconnect();
    return;
  }

  if (cmd === 'list') {
    console.log(JSON.stringify({ companies: creds.companies, users: creds.users }, null, 2));
    return;
  }

  if (cmd === 'clear-ratelimit') {
    const Redis = (await import('ioredis')).default;
    const r = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: +(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD || undefined, db: +(process.env.REDIS_DB || 0) });
    const keys = await r.keys('ratelimit_*');
    if (keys.length) await r.del(...keys);
    console.log(`apagadas ${keys.length} chave(s) de rate limit`);
    r.disconnect();
    return;
  }

  const key = arg && creds.users[arg] ? arg : Object.keys(creds.users).find((k) => creds.users[k].email === arg);
  if (!key) throw new Error(`usuário demo não encontrado: ${arg} (veja \`list\`)`);
  const entry = creds.users[key];
  if (!entry.email.endsWith('@demo.local')) throw new Error('apenas usuários @demo.local');
  const { db, bypass } = await bypassDb();

  if (cmd === 'unlock') {
    const res = await bypass<{ count: number }>(() => db.user.updateMany({ where: { email: entry.email }, data: { loginAttempts: 0, lockedUntil: null } }));
    console.log(`desbloqueado(s): ${res.count} (${entry.email})`);
  } else if (cmd === 'mint') {
    // `require`, não `import()`: depois de carregar @ln-system/database, o import() dinâmico devolvia um
    // namespace VAZIO para este módulo (o mesmo arquivo já entrou pelo cache do CJS) -> "generateAccessToken is not a function".
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generateAccessToken } = require('@ln-system/shared/utils/token');
    const user = await bypass<any>(() =>
      db.user.findUnique({
        where: { email: entry.email },
        select: {
          id: true, numericId: true, name: true, email: true, userType: true, companyId: true, branchId: true,
          company: { select: { id: true, name: true, document: true, phone: true } },
          branch: { select: { id: true, name: true, address: true, phone: true } },
        },
      })
    );
    if (!user) throw new Error('usuário não existe no banco (rode demo:seed)');
    const token = generateAccessToken({ userId: user.id, email: user.email, companyId: user.companyId ?? undefined, branchId: user.branchId ?? undefined, userType: user.userType } as any);
    const safe = { id: user.id, numericId: user.numericId, name: user.name, email: user.email, userType: user.userType, companyId: user.companyId, branchId: user.branchId, company: user.company, branch: user.branch };
    console.log(JSON.stringify({
      who: `${key} (${user.userType}) numericId=${user.numericId}`,
      expiresInMinutes: 15,
      admin_web: `localStorage.setItem('token', ${JSON.stringify(token)})`,
      super_admin: `localStorage.setItem('accessToken', ${JSON.stringify(token)}); localStorage.setItem('refreshToken', 'x'); localStorage.setItem('user', ${JSON.stringify(JSON.stringify(safe))})`,
      pdv: `localStorage.setItem('pdv-auth-storage', ${JSON.stringify(JSON.stringify({ state: { user: safe, token, refreshToken: 'x', isAuthenticated: true, hasHydrated: true }, version: 0 }))})`,
      accessToken: token,
    }, null, 2));
  } else {
    throw new Error('comandos: mint <email|chave> | totp | clear-ratelimit | unlock <email> | list');
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
