/**
 * INVENTÁRIO DO BANCO — somente leitura (catálogo do PostgreSQL), roda contra QUALQUER banco.
 *
 *   npm run db:inventory                          # tabelas do DATABASE_URL (dev), em Markdown
 *   npm run db:inventory -- --json                # o mesmo em JSON
 *
 * Para cada tabela: colunas, chave primária, chaves estrangeiras (e a regra ao apagar), colunas de escopo (empresa/filial), RLS
 * habilitado/forçado, quantidade de policies e de índices. É a base de docs/CORTEX/BANCO_DE_DADOS.md (que acrescenta a FINALIDADE e as
 * funcionalidades que usam cada tabela). Não grava nada, não lê linha de dado de negócio (só o catálogo).
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface TableInfo {
  table: string;
  columns: number;
  primaryKey: string;
  scope: string;
  foreignKeys: { column: string; references: string; onDelete: string }[];
  rls: { enabled: boolean; forced: boolean };
  policies: number;
  indexes: number;
}

const ON_DELETE: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const q = async <T = any>(sql: string): Promise<T[]> => (await db.$queryRawUnsafe(sql)) as T[];
  try {
    const tables = await q<{ relname: string; rls: boolean; frc: boolean; oid: number }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS frc, c.oid::int AS oid
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' ORDER BY c.relname`
    );
    const cols = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
    );
    const pks = await q<{ relname: string; cols: string }>(
      `SELECT c.relname, string_agg(a.attname, ', ' ORDER BY a.attnum) AS cols FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'p' AND c.relnamespace = 'public'::regnamespace GROUP BY c.relname`
    );
    const fks = await q<{ relname: string; col: string; ref: string; del: string }>(
      `SELECT c.relname, a.attname AS col, r.relname AS ref, k.confdeltype AS del FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class r ON r.oid = k.confrelid
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
        WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace ORDER BY c.relname, a.attname`
    );
    const pol = await q<{ tablename: string; n: number }>(`SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename`);
    const idx = await q<{ tablename: string; n: number }>(`SELECT tablename, count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' GROUP BY tablename`);

    const info: TableInfo[] = tables.map((t) => {
      const mine = cols.filter((c) => c.table_name === t.relname).map((c) => c.column_name);
      return {
        table: t.relname,
        columns: mine.length,
        primaryKey: pks.find((p) => p.relname === t.relname)?.cols ?? '—',
        scope: [mine.includes('companyId') ? 'empresa' : null, mine.includes('branchId') ? 'filial' : null].filter(Boolean).join('+') || 'plataforma/global',
        foreignKeys: fks.filter((f) => f.relname === t.relname).map((f) => ({ column: f.col, references: f.ref, onDelete: ON_DELETE[f.del] ?? f.del })),
        rls: { enabled: t.rls, forced: t.frc },
        policies: pol.find((p) => p.tablename === t.relname)?.n ?? 0,
        indexes: idx.find((i) => i.tablename === t.relname)?.n ?? 0,
      };
    });

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    console.log(`# Inventário do banco (${info.length} tabelas) — gerado do catálogo do PostgreSQL\n`);
    console.log('| Tabela | Colunas | Chave | Escopo | RLS (forçado) | Policies | Índices | Relacionamentos (coluna → tabela, ao apagar) |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const t of info) {
      const rel = t.foreignKeys.map((f) => `${f.column} → ${f.references} (${f.onDelete})`).join('; ') || '—';
      console.log(`| \`${t.table}\` | ${t.columns} | ${t.primaryKey} | ${t.scope} | ${t.rls.enabled ? 'sim' : 'NÃO'} (${t.rls.forced ? 'sim' : 'NÃO'}) | ${t.policies} | ${t.indexes} | ${rel} |`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
