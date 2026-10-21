import { prisma } from '@ln-system/database';
import { openSecret } from '@ln-system/shared/utils/secret-box';
import { mfaService } from './MFAService';

/**
 * CONSUMO DE USO ÚNICO dos segundos fatores — o ponto único onde um código MFA deixa de valer depois de aceito.
 * Todo caminho que aceita um código (login, ativação, dupla autorização de operação financeira, verificação avulsa) passa por aqui, para
 * que "um código vale uma vez" seja garantido pelo BANCO (ou pelo Redis), e não por uma leitura seguida de gravação na aplicação — que duas
 * requisições simultâneas (ou duas instâncias da API) vencem juntas.
 *
 *  - TOTP: `users.mfaLastStep` guarda o último passo de 30 s consumido; a atualização é condicional (`mfaLastStep` nulo ou menor que o passo),
 *    então só UMA das requisições concorrentes com o mesmo código afeta a linha.
 *  - Código de recuperação: compare-and-swap sobre a lista inteira (`mfaBackupCodes = <lista lida>`); quem perde a corrida relê a lista e, se o
 *    código já saiu dela, é recusado.
 *  - Código SMS/e-mail (Redis): comparar e apagar num único script atômico.
 * Nada aqui escreve código, segredo ou hash em log.
 */

export const TOTP_REPLAY_MESSAGE = 'Código já utilizado. Aguarde o próximo código do aplicativo.';

/** Confere o código TOTP contra o segredo cifrado e o CONSOME (recusa o mesmo passo, ou anterior, uma segunda vez). */
export async function consumeTotp(userId: string, sealedSecret: string, code: string): Promise<{ valid: boolean; error?: string; replay?: boolean }> {
  const verification = mfaService.verifyCode(openSecret(sealedSecret), code);
  if (!verification.valid || verification.step === undefined) return { valid: false, error: verification.error };
  const consumed = await prisma.user.updateMany({
    where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: verification.step } }] },
    data: { mfaLastStep: verification.step },
  });
  if (consumed.count === 0) return { valid: false, error: TOTP_REPLAY_MESSAGE, replay: true };
  return { valid: true };
}

/** Confere um código de recuperação e o CONSOME de forma atômica (compare-and-swap da lista); cada código vale uma única vez. */
export async function consumeBackupCode(userId: string, code: string): Promise<{ valid: boolean; error?: string; matchedHash?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaBackupCodes: true } });
    const codes = user?.mfaBackupCodes ?? [];
    const verification = mfaService.verifyBackupCode(codes, code);
    if (!verification.valid || !verification.matchedHash) return { valid: false, error: verification.error };
    const swapped = await prisma.user.updateMany({
      where: { id: userId, mfaBackupCodes: { equals: codes } },
      data: { mfaBackupCodes: codes.filter((hash) => hash !== verification.matchedHash) },
    });
    if (swapped.count === 1) return { valid: true, matchedHash: verification.matchedHash };
    // Outra requisição alterou a lista no meio: relê e confere de novo (se este código já saiu da lista, a próxima leitura o recusa).
  }
  return { valid: false, error: 'Não foi possível confirmar o código agora. Tente novamente.' };
}

const COMPARE_AND_DELETE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Código enviado por SMS/e-mail guardado no Redis: confere e apaga numa operação atômica (código errado NÃO queima o código válido). */
export async function consumeStoredOtp(key: string, code: string): Promise<boolean> {
  if (!code) return false;
  // Importado só aqui: a conexão com o Redis não deve nascer em quem apenas importa o consumo de TOTP/código de recuperação.
  const { default: redis } = await import('../config/redis');
  const deleted = await (redis as unknown as { eval: (script: string, keys: number, ...args: string[]) => Promise<number> }).eval(COMPARE_AND_DELETE, 1, key, code);
  return Number(deleted) === 1;
}
