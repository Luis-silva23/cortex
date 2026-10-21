import { prisma } from '@ln-system/database';
import { comparePassword } from '@ln-system/shared/utils/password';
import { consumeBackupCode, consumeTotp } from './mfa-consume';
import { Logger, SystemLogContext } from './logger.service';

/**
 * Autorização de um segundo usuário para operações financeiras sensíveis
 * (retirada de caixa, cancelamento de venda já finalizada/paga, etc). O
 * autorizador se identifica com as PRÓPRIAS credenciais na mesma chamada —
 * não é um fluxo assíncrono de aprovação posterior, é presencial, no mesmo
 * instante. Extraído de CashRegisterService.requestWithdrawal (a primeira a
 * implementar essa regra) para ser reaproveitado por qualquer operação com
 * a mesma exigência, em vez de duplicar ~70 linhas de checagem de
 * segurança a cada nova operação sensível.
 */

export interface DualAuthorizationRequest {
  companyId: string;
  requesterId: string;
  authorizerNumericId: number;
  authorizerPassword: string;
  authorizerMfaCode?: string;
  allowedRoles: string[];
  /** Prefixo dos eventos de segurança, ex: 'WITHDRAWAL', 'SALE_CANCELLATION'. */
  actionEvent: string;
  /** Usado nas mensagens de erro, ex: 'withdrawal', 'sale cancellation'. */
  subjectLabel: string;
  securityContext?: SystemLogContext;
}

export async function verifyDualAuthorization(req: DualAuthorizationRequest) {
  const ctx = req.securityContext || {};

  const authorizer = await prisma.user.findFirst({
    where: { numericId: req.authorizerNumericId, companyId: req.companyId, isActive: true },
  });

  if (!authorizer) {
    Logger.security(`${req.actionEvent}_AUTHORIZATION_FAILED`, 'Autorizador não encontrado', ctx);
    throw new Error('Authorizer not found');
  }

  // Nunca a mesma pessoa solicitando e autorizando — é o núcleo do controle.
  if (authorizer.id === req.requesterId) {
    Logger.security(
      `${req.actionEvent}_SELF_AUTHORIZATION_BLOCKED`,
      `Tentativa de autoautorização (${req.subjectLabel})`,
      { ...ctx, authorizerId: authorizer.id }
    );
    throw new Error(`The requesting user cannot authorize their own ${req.subjectLabel}`);
  }

  if (!req.allowedRoles.includes(authorizer.userType)) {
    Logger.security(
      `${req.actionEvent}_AUTHORIZATION_FAILED`,
      'Usuário informado não tem perfil autorizado a aprovar esta operação',
      { ...ctx, authorizerId: authorizer.id, authorizerUserType: authorizer.userType }
    );
    throw new Error(`Authorizer does not have permission to approve this ${req.subjectLabel}`);
  }

  if (authorizer.lockedUntil && authorizer.lockedUntil > new Date()) {
    Logger.security(`${req.actionEvent}_AUTHORIZATION_FAILED`, 'Conta do autorizador está bloqueada', {
      ...ctx,
      authorizerId: authorizer.id,
    });
    throw new Error('Authorizer account is locked');
  }

  const passwordValid = await comparePassword(req.authorizerPassword, authorizer.password);
  if (!passwordValid) {
    Logger.security(`${req.actionEvent}_AUTHORIZATION_FAILED`, 'Senha do autorizador inválida', {
      ...ctx,
      authorizerId: authorizer.id,
    });
    throw new Error('Invalid authorizer credentials');
  }

  // MFA exigido sempre que o autorizador tem MFA habilitado — mesma
  // política já aplicada ao login (não é uma exigência nova/paralela).
  if (authorizer.mfaEnabled) {
    if (!req.authorizerMfaCode) {
      Logger.security(`${req.actionEvent}_AUTHORIZATION_FAILED`, 'Código MFA do autorizador não informado', {
        ...ctx,
        authorizerId: authorizer.id,
      });
      throw new Error('Authorizer MFA code is required');
    }

    // Uso ÚNICO: o código é CONSUMIDO no banco (passo TOTP via `mfaLastStep`, código de recuperação via compare-and-swap), de modo que duas
    // autorizações simultâneas — nesta ou em outra instância da API — com o mesmo código nunca passam as duas. Mesmo ponto do login.
    let mfaValid = false;
    let replayed = false;
    if (authorizer.mfaSecret) {
      const totp = await consumeTotp(authorizer.id, authorizer.mfaSecret, req.authorizerMfaCode);
      mfaValid = totp.valid;
      replayed = !totp.valid && !!totp.replay;
    }
    if (!mfaValid && !replayed && authorizer.mfaBackupCodes.length > 0) {
      mfaValid = (await consumeBackupCode(authorizer.id, req.authorizerMfaCode)).valid;
    }

    if (replayed) {
      Logger.security(`${req.actionEvent}_AUTHORIZATION_FAILED`, 'Código MFA do autorizador já utilizado (reuso recusado)', {
        ...ctx,
        authorizerId: authorizer.id,
      });
      throw new Error('Authorizer MFA code already used');
    }

    if (!mfaValid) {
      Logger.security(`${req.actionEvent}_AUTHORIZATION_FAILED`, 'Código MFA do autorizador inválido ou expirado', {
        ...ctx,
        authorizerId: authorizer.id,
      });
      throw new Error('Invalid or expired authorizer MFA code');
    }
  }

  Logger.security(`${req.actionEvent}_AUTHORIZED`, `Operação autorizada (${req.subjectLabel})`, {
    ...ctx,
    authorizerId: authorizer.id,
  });

  return authorizer;
}
