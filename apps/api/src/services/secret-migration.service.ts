import { prisma, runWithRLSContext } from '@ln-system/database';
import { assertEncryptionKey, isSealed, sealSecret } from '@ln-system/shared/utils/secret-box';

export interface SecretMigrationSummary {
  mfaPlain: number;
  mfaSealed: number;
  fiscalPlain: number;
  fiscalSealed: number;
}

/**
 * Cifra (enc:v1) os segredos gravados em texto puro antes do secret-box: users.mfaSecret,
 * fiscal_configs.certificatePassword e fiscal_configs.cscToken. Idempotente (valor já cifrado é ignorado) e seguro com a
 * API no ar: cada linha só é atualizada se ainda tiver o MESMO valor lido (updateMany condicional), nunca sobrescrevendo
 * uma troca recente. `checkOnly` só conta. `companyId` restringe a uma empresa (o comando de operação roda em todas).
 * Usado por `npm run secrets:encrypt` (scripts/encrypt-secrets.ts).
 */
export async function encryptPlaintextSecrets(opts: { checkOnly?: boolean; companyId?: string } = {}): Promise<SecretMigrationSummary> {
  assertEncryptionKey();
  const scope = opts.companyId ? { companyId: opts.companyId } : {};
  return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    const counts: SecretMigrationSummary = { mfaPlain: 0, mfaSealed: 0, fiscalPlain: 0, fiscalSealed: 0 };

    const users = await prisma.user.findMany({ where: { ...scope, mfaSecret: { not: null } }, select: { id: true, mfaSecret: true } });
    for (const u of users) {
      if (!u.mfaSecret || isSealed(u.mfaSecret)) continue;
      counts.mfaPlain++;
      if (opts.checkOnly) continue;
      const r = await prisma.user.updateMany({ where: { id: u.id, mfaSecret: u.mfaSecret }, data: { mfaSecret: sealSecret(u.mfaSecret) } });
      counts.mfaSealed += r.count;
    }

    const configs = await prisma.fiscalConfig.findMany({ where: scope, select: { id: true, certificatePassword: true, cscToken: true } });
    for (const c of configs) {
      for (const field of ['certificatePassword', 'cscToken'] as const) {
        const value = c[field];
        if (!value || isSealed(value)) continue;
        counts.fiscalPlain++;
        if (opts.checkOnly) continue;
        const r = await prisma.fiscalConfig.updateMany({ where: { id: c.id, [field]: value }, data: { [field]: sealSecret(value) } });
        counts.fiscalSealed += r.count;
      }
    }
    return counts;
  });
}
