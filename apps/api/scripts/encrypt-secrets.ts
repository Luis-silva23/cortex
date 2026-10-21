/**
 * Cifra os segredos gravados em texto puro antes do secret-box: users.mfaSecret, fiscal_configs.certificatePassword e
 * fiscal_configs.cscToken. Idempotente (valor já cifrado é ignorado) e seguro para rodar com a API no ar: cada linha é
 * atualizada só se ainda tiver o MESMO valor lido (updateMany condicional), nunca sobrescrevendo uma troca recente.
 * A lógica está em src/services/secret-migration.service.ts (testada em secret-migration.integration.test.ts).
 *
 *   npm run secrets:encrypt            (usa apps/api/.env: DATABASE_URL e DATA_ENCRYPTION_KEY)
 *   npm run secrets:encrypt -- --check (só conta, não altera)
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const checkOnly = process.argv.includes('--check');
  // imports tardios: packages/database lê DATABASE_URL no import
  const { prisma } = await import('@ln-system/database');
  const { encryptPlaintextSecrets } = await import('../src/services/secret-migration.service');

  const summary = await encryptPlaintextSecrets({ checkOnly });

  console.log(
    checkOnly
      ? `Em texto puro: ${summary.mfaPlain} segredo(s) de MFA, ${summary.fiscalPlain} segredo(s) fiscal(is).`
      : `Cifrados: ${summary.mfaSealed}/${summary.mfaPlain} de MFA, ${summary.fiscalSealed}/${summary.fiscalPlain} fiscais.`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
