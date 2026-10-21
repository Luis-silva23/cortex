import { prisma, runInTransaction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import { mfaService } from './MFAService';
import { revokeUserAccessTokens } from './access-token-revocation';
import { consumeTotp } from './mfa-consume';

/**
 * CICLO DE VIDA DO SEGUNDO FATOR (TOTP + códigos de recuperação) — decisão 123.
 *  - o segredo só existe cifrado (`enc:v1`) e só é mostrado UMA vez, na configuração; os códigos de recuperação só existem como hash;
 *  - nada aqui escreve segredo, código ou seed em log (o chamador audita o ATO, sem o valor);
 *  - um código TOTP vale uma vez: `mfaLastStep` guarda o último passo de 30 s consumido (atualização condicional atômica);
 *  - ativar exige um código válido do segredo recém-gerado (um QR mal escaneado não tranca ninguém);
 *  - reiniciar o fator (recuperação) apaga segredo e códigos e derruba as sessões.
 */

const INVALID_CODE = 'Código inválido. Confira o aplicativo autenticador e tente de novo.';

// O consumo de uso único (TOTP, código de recuperação, código SMS/e-mail) mora em ./mfa-consume — o mesmo ponto atende o login, a ativação
// e a dupla autorização de operações. Reexportado aqui para quem já importava daqui.
export { consumeTotp, consumeBackupCode, consumeStoredOtp, TOTP_REPLAY_MESSAGE } from './mfa-consume';

/** Gera um segredo novo (ainda NÃO ativo). Recusa quando o MFA já está ativo: trocar exige reiniciar o fator antes. */
export async function beginEnrollment(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, isActive: true, mfaEnabled: true } });
  if (!user || !user.isActive) throw new AppError('Conta indisponível.', 403, 'ACCOUNT_UNAVAILABLE');
  if (user.mfaEnabled) throw new AppError('A verificação em duas etapas já está ativa nesta conta.', 409, 'MFA_ALREADY_ENABLED');
  // Cada chamada gera um segredo NOVO e descarta o pendente: quem roubou a senha e deixou um segredo pendente não fica com um fator que o
  // administrador legítimo passe a usar (reaproveitar o pendente criaria essa porta dos fundos). A tela chama begin UMA vez por carregamento.
  const generated = mfaService.generateSecret(userId, user.email);
  await prisma.user.update({
    where: { id: userId },
    data: { mfaSecret: sealSecret(generated.secret), mfaBackupCodes: [], mfaLastStep: null },
  });
  return { secret: generated.secret, otpauthUrl: generated.qrCode };
}

/** Ativa o MFA com um código válido do segredo pendente e devolve os códigos de recuperação (únicos; só o hash fica guardado). */
export async function confirmEnrollment(userId: string, code: string): Promise<{ backupCodes: string[] }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true, mfaSecret: true, isActive: true } });
  if (!user || !user.isActive) throw new AppError('Conta indisponível.', 403, 'ACCOUNT_UNAVAILABLE');
  if (user.mfaEnabled) throw new AppError('A verificação em duas etapas já está ativa nesta conta.', 409, 'MFA_ALREADY_ENABLED');
  if (!user.mfaSecret) throw new AppError('Inicie a configuração antes de confirmar o código.', 400, 'MFA_NOT_STARTED');
  const result = await consumeTotp(userId, user.mfaSecret, code);
  if (!result.valid) {
    throw new AppError(result.error?.startsWith('Código já utilizado') ? result.error : INVALID_CODE, 400, 'MFA_CODE_INVALID');
  }
  const backupCodes = mfaService.generateBackupCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { mfaEnabled: true, mfaBackupCodes: backupCodes.map((c) => mfaService.hashBackupCode(c)) },
  });
  return { backupCodes };
}

/** Novos códigos de recuperação (os antigos deixam de valer). Exige um código TOTP válido (quem já tem o segundo fator). */
export async function regenerateBackupCodes(userId: string, code: string): Promise<{ backupCodes: string[] }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true, mfaSecret: true } });
  if (!user?.mfaEnabled || !user.mfaSecret) throw new AppError('A verificação em duas etapas não está ativa.', 400, 'MFA_NOT_ENABLED');
  const result = await consumeTotp(userId, user.mfaSecret, code);
  if (!result.valid) throw new AppError(result.error?.startsWith('Código já utilizado') ? result.error : INVALID_CODE, 400, 'MFA_CODE_INVALID');
  const backupCodes = mfaService.generateBackupCodes();
  await prisma.user.update({ where: { id: userId }, data: { mfaBackupCodes: backupCodes.map((c) => mfaService.hashBackupCode(c)) } });
  return { backupCodes };
}

/**
 * RECUPERAÇÃO / REVOGAÇÃO do fator: apaga segredo, códigos de recuperação e o marcador de reuso, e derruba TODAS as sessões do usuário
 * (refresh tokens e access tokens já emitidos). Quem tem perfil com MFA obrigatório precisa configurar de novo no próximo login.
 */
export async function resetFactor(userId: string): Promise<void> {
  await runInTransaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [], mfaLastStep: null } });
    await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
  });
  await revokeUserAccessTokens(userId);
}
