/**
 * Prepara o banco DEDICADO da suíte de integração (idempotente):
 *   1. resolve o banco de teste (TEST_DATABASE_URL, ou o DATABASE_URL de dev com o banco trocado por
 *      `*_test`) e RECUSA se o nome não contiver "test";
 *   2. cria o banco se ainda não existir;
 *   3. aplica TODAS as migrações (`prisma migrate deploy`) — a cada execução isso também prova que a cadeia
 *      de migrações aplica do zero e que reaplicar é um no-op;
 *   4. provisiona o segredo do CONTEXTO DE RLS ASSINADO (RLS_CONTEXT_SECRET; decisão 151), idempotente.
 * Nunca toca no banco de desenvolvimento/demonstração.
 *
 * Uso: `npm run test:integration:prepare` (também roda antes de `npm run test:integration`).
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { CONTEXT_SET_CONFIG_SQL, contextSqlParams, PLATFORM_CONTEXT } from '@ln-system/database';
import { ensureContextSecret } from './lib/rls-context-secret';
import { assertIsTestDatabase, databaseNameOf, deriveTestDatabaseUrl } from '../test/integration/helpers/test-database';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl && !process.env.TEST_DATABASE_URL) {
    throw new Error('DATABASE_URL ausente (apps/api/.env) — não há de onde derivar o banco de teste.');
  }
  const testUrl = process.env.TEST_DATABASE_URL || deriveTestDatabaseUrl(devUrl!);
  assertIsTestDatabase(testUrl, devUrl);

  const name = databaseNameOf(testUrl);
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Nome de banco de teste inválido para criação automática: "${name}"`);
  }

  // conexão administrativa: o banco `postgres` do mesmo servidor
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const exists: Array<{ x: number }> = await admin.$queryRawUnsafe(`SELECT 1 AS x FROM pg_database WHERE datname = '${name}'`);
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      console.log(`[prepare-test-db] banco "${name}" criado`);
    } else {
      console.log(`[prepare-test-db] banco "${name}" já existe`);
    }
  } finally {
    await admin.$disconnect();
  }

  // cwd no pacote do banco (o Prisma acha prisma/schema.prisma sozinho): passar o caminho como argumento
  // quebra quando ele tem espaço ("Minha bagunça") e `shell: true` não o cita.
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '../../../packages/database'),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy falhou no banco de teste (código ${result.status})`);
  }
  // contexto de RLS ASSINADO (decisão 151): o banco de teste passa a exigir a assinatura; a suíte assina com RLS_CONTEXT_SECRET
  const ctxDb = new PrismaClient({ datasources: { db: { url: testUrl } } });
  try {
    console.log(`[prepare-test-db] segredo do contexto de RLS: ${await ensureContextSecret(ctxDb)}`);
  } finally {
    await ctxDb.$disconnect();
  }
  await sweepOrphansOfDeletedCompanies(testUrl);
}

/**
 * SÓ no banco de TESTE (o `assertIsTestDatabase` acima já recusou qualquer outro): suítes antigas apagavam a empresa sintética sem apagar as
 * linhas de tabelas que ainda não tinham FK para `companies` — sobraram linhas órfãs de empresas que NÃO EXISTEM MAIS. A migração das FKs de
 * empresa/filial não apaga nem associa nada por suposição: deixa a FK correspondente NOT VALID. Aqui (dado 100% sintético de teste) as órfãs são
 * removidas e as FKs validadas, para o banco de teste voltar ao estado íntegro. Repetível: sem órfãs, não faz nada.
 */
async function sweepOrphansOfDeletedCompanies(testUrl: string): Promise<void> {
  const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
  try {
    const notValid: Array<{ t: string; c: string }> = await db.$queryRawUnsafe(
      `SELECT conrelid::regclass::text AS t, conname AS c FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`
    );
    if (notValid.length === 0) return;
    const tables: Array<{ t: string }> = await db.$queryRawUnsafe(
      `SELECT c.relname AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname = 'companyId' AND a.attnotnull AND NOT a.attisdropped AND c.relname <> 'companies'`
    );
    const removed: Record<string, number> = {};
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(PLATFORM_CONTEXT));
        await tx.$executeRawUnsafe(`SELECT set_config('app.audit_purge', 'on', true)`);
        let todo = tables.map((r) => r.t);
        for (let pass = 0; pass < 6 && todo.length; pass++) {
          const failed: string[] = [];
          for (const t of todo) {
            await tx.$executeRawUnsafe('SAVEPOINT sweep');
            try {
              const n = await tx.$executeRawUnsafe(`DELETE FROM "${t}" x WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = x."companyId")`);
              if (n) removed[t] = (removed[t] ?? 0) + n;
              await tx.$executeRawUnsafe('RELEASE SAVEPOINT sweep');
            } catch {
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sweep');
              failed.push(t);
            }
          }
          if (failed.length === todo.length) break;
          todo = failed;
        }
        for (const { t, c } of notValid) await tx.$executeRawUnsafe(`ALTER TABLE ${t} VALIDATE CONSTRAINT "${c}"`);
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
    const summary = Object.entries(removed).map(([t, n]) => `${t}: ${n}`).join(', ') || 'nenhuma linha';
    console.log(`[prepare-test-db] órfãs de empresas inexistentes removidas (${summary}); ${notValid.length} FK(s) validada(s)`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
