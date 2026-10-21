/**
 * Primeiro SUPER_ADMIN do ambiente de HOMOLOGAÇÃO isolado (banco `lnsystem_hml` na porta 5433).
 * Nenhuma rota cria o primeiro Super Admin (só um Super Admin cria outro), então este é o único passo que escreve
 * direto no banco; todo o resto (empresas, filiais, usuários, perfis, MFA) é feito pela API em apps/hml/bootstrap.js.
 *
 * Uso: node apps/hml/run.js --cwd apps/api -- npx tsx scripts/hml-seed-sa.ts
 * Recusa qualquer banco que não seja o de HML. A senha é aleatória e vai para apps/hml/.hml/credentials.json
 * (gitignorado) — nada de credencial em código nem em log.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { hashPassword } from '@ln-system/shared/utils/password';

import { contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
const CRED_FILE = path.resolve(__dirname, '../../hml/.hml/credentials.json');
const SA_EMAIL = 'ti.hml@hml.local';

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!/:5433\/lnsystem_hml\b/.test(url)) throw new Error('hml-seed-sa só roda no banco de homologação isolado (porta 5433, lnsystem_hml)');
  if (process.env.NODE_ENV === 'production') throw new Error('recusado em produção');

  const { prismaUnsafeBypassRLS: db } = await import('@ln-system/database');
  const bypass = async <T>(q: () => any): Promise<T> => {
    const r = await db.$transaction([
      contextStatement(db, PLATFORM_CONTEXT),
      q(),
    ]);
    return r[1] as T;
  };

  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  const cred = fs.existsSync(CRED_FILE) ? JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) : {};
  if (!cred.sa) cred.sa = { email: SA_EMAIL, password: `Sa${crypto.randomBytes(12).toString('base64url')}#7` };

  const existing = await bypass<{ id: string } | null>(() => db.user.findUnique({ where: { email: SA_EMAIL }, select: { id: true } }));
  if (existing) {
    console.log('[hml-seed-sa] Super Admin TI já existe; nada a fazer.');
  } else {
    const hashed = await hashPassword(cred.sa.password);
    const row = await bypass<{ numericId: number }>(() => db.user.create({
      data: { email: SA_EMAIL, name: 'Super ADM TI (HML)', password: hashed, userType: 'SUPER_ADMIN' as any, isActive: true } as any,
      select: { numericId: true },
    }));
    cred.sa.numericId = row.numericId;
    console.log(`[hml-seed-sa] Super Admin TI criado (ID numérico ${row.numericId}).`);
  }
  fs.writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2));
  await db.$disconnect();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
