/**
 * Liga a exigência de CONTEXTO DE RLS ASSINADO num banco (decisão 151) provisionando o segredo.
 *
 *   PROVISION_DATABASE_URL=<url do DONO ou de superusuário> RLS_CONTEXT_SECRET=<base64 de 32 a 64 bytes> npm run db:provision-context
 *
 * Sem `PROVISION_DATABASE_URL` usa `DATABASE_URL` (em desenvolvimento o papel é dono; em produção use a URL do DONO — o papel de execução NÃO
 * tem permissão e a tentativa falha de propósito). Idempotente: se o banco já aceita a assinatura gerada com o segredo informado, não faz nada.
 * Rotação sem parada: gere um segredo novo, rode este comando com ele (o anterior fica no slot 2), reinicie as instâncias da API com o segredo
 * novo e só então `SELECT app_ctx.retire_previous();`. Imprime apenas o resultado — nunca o segredo nem a URL.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { ensureContextSecret } from './lib/rls-context-secret';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const url = process.env.PROVISION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Informe PROVISION_DATABASE_URL (ou DATABASE_URL).');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const result = await ensureContextSecret(db);
    console.log(`[provision-rls-context] ${result === 'already' ? 'o banco já aceita a assinatura deste segredo (nada a fazer)' : 'segredo provisionado; contexto assinado agora é EXIGIDO neste banco'}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error('[provision-rls-context] FALHOU:', (e instanceof Error ? e.message : String(e)).replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***'));
  process.exit(1);
});
