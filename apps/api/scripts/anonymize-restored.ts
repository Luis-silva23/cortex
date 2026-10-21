/**
 * ANONIMIZA uma CÓPIA RESTAURADA do banco (decisão 155) para uso fora do ambiente seguro (homologação/suporte). Só aceita um banco isolado, de nome de cópia, que não seja o
 * DATABASE_URL nem o BACKUP_DATABASE_URL, e exige confirmação pelo nome. Detalhes e limites: scripts/lib/anonymize.ts e docs/CORTEX/BACKUP_RECUPERACAO.md.
 *
 *   npm run backup:anonymize -- <url-do-banco-restaurado-como-superusuario> --confirm=<nome-do-banco> [--strict]
 *
 * Fluxo recomendado: restaurar o backup em OUTRO servidor (ver `backup:drill` / pitr-restore.sh) → este comando → só então liberar a cópia. Nunca rode no banco de produção.
 * Nada de valor pessoal é impresso (só contagens e nomes de coluna). A URL nunca é impressa com senha.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { anonymizeDatabase, defaultPsql } from './lib/anonymize';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const url = args.find((a) => /^postgres(ql)?:\/\//.test(a));
const confirm = (args.find((a) => a.startsWith('--confirm=')) || '').slice('--confirm='.length);
const strict = args.includes('--strict');

if (!url) {
  console.error('uso: npm run backup:anonymize -- <url-do-banco-restaurado> --confirm=<nome-do-banco> [--strict]');
  process.exit(64);
}

try {
  const report = anonymizeDatabase({
    url,
    confirm,
    strict,
    psqlBin: defaultPsql(process.env.PG_BIN_DIR),
    protectedUrls: [process.env.DATABASE_URL || '', process.env.BACKUP_DATABASE_URL || '', process.env.RESTORE_PRODUCTION_URL || ''],
  });
  console.log(`anonimização concluída: ${report.updatedTables} tabelas atualizadas, ${report.deletedRows} linhas de sessão/idempotência removidas, contagem de linhas ${report.rowCountsEqual ? 'inalterada' : 'ALTERADA'}`);
  console.log(`varredura de vazamento: ${report.sampled} valores originais amostrados, ${report.leaks.length === 0 ? 'nenhum encontrado' : `ENCONTRADOS em ${report.leaks.join(', ')}`}`);
  if (report.missingColumns.length) console.log(`regras sem coluna no banco (esquema diferente): ${report.missingColumns.join(', ')}`);
  if (report.uncovered.length) console.log(`ATENÇÃO — colunas possivelmente sensíveis SEM regra (revise antes de compartilhar a cópia): ${report.uncovered.join(', ')}`);
  else console.log('cobertura: nenhuma coluna de nome sensível fora das regras/lista segura');
} catch (error: any) {
  console.error(`FALHA: ${String(error.message || error).replace(/(postgres(?:ql)?:\/\/[^:@/\s]+):[^@\s]+@/g, '$1:***@')}`);
  process.exit(1);
}
