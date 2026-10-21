/**
 * AMOSTRADOR DE CONEXÕES DO POSTGRESQL — somente leitura, para investigar "Too many database connections opened" na suíte de integração.
 *
 *   npx tsx scripts/pg-sample.ts <arquivo-de-saida.log> [intervalo-ms=2000]
 *
 * A cada intervalo conta as conexões de CLIENTE (`backend_type = 'client backend'`) por banco e estado, guarda o máximo observado e
 * escreve uma linha no arquivo (data, total, máximo, por banco/estado). Não grava nada no banco, não lê dado de negócio (só
 * `pg_stat_activity`: nem o texto das consultas é lido). Use ao lado de `npm run test:integration` e encerre com Ctrl+C / SIGTERM.
 * Usa UMA conexão própria (connection_limit=1), que aparece na contagem.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const out = process.argv[2];
  const interval = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 2000;
  if (!out) throw new Error('Informe o arquivo de saída: tsx scripts/pg-sample.ts <arquivo> [intervalo-ms]');
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL ausente (apps/api/.env).');
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: `${base}${base.includes('?') ? '&' : '?'}connection_limit=1` } } });
  const limits = (await db.$queryRawUnsafe(`SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved`)) as { max: number; reserved: number }[];
  fs.appendFileSync(out, `# início ${new Date().toISOString()} max_connections=${limits[0].max} reservadas=${limits[0].reserved}\n`);
  let peak = 0;
  const timer = setInterval(async () => {
    try {
      const rows = (await db.$queryRawUnsafe(
        `SELECT coalesce(datname,'-') AS d, coalesce(state,'-') AS s, count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 1, 2`
      )) as { d: string; s: string; n: number }[];
      const total = rows.reduce((sum, r) => sum + r.n, 0);
      peak = Math.max(peak, total);
      fs.appendFileSync(out, `${new Date().toISOString()} total=${total} pico=${peak} ${rows.map((r) => `${r.d}/${r.s}=${r.n}`).join(' ')}\n`);
    } catch (error) {
      fs.appendFileSync(out, `${new Date().toISOString()} ERRO ${(error as Error).message.slice(0, 120)}\n`);
    }
  }, interval);
  const stop = async () => {
    clearInterval(timer);
    fs.appendFileSync(out, `# fim ${new Date().toISOString()} pico=${peak}\n`);
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
