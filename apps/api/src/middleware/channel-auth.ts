import express, { Request, Response, NextFunction } from 'express';
import { runWithRLSContext } from '@ln-system/database';
import { openSecret } from '@ln-system/shared/utils/secret-box';
import type { ChannelCredentialScope } from '@prisma/client';
import moduleSettingsService from '../services/module-settings.service';
import { commerceError } from '../services/commerce/errors';
import { KEY_ID_PATTERN, findCredentialForAuth, isUsable, markChannelConnected, touchLastUsed } from '../services/commerce/credentials.service';
import { consumeCredential, isAuthBlocked, noteAuthFailure } from '../services/commerce/rate-limit';
import { verifyRequestSignature } from '../services/commerce/signature';

/**
 * Autenticação da Commerce API: um CANAL (servidor do site), não um usuário. A empresa, a filial e o canal vêm da CREDENCIAL guardada
 * no banco — nunca de corpo, query ou cabeçalho da requisição. Sequência: IP não bloqueado por falhas → credencial existe, não foi
 * revogada nem expirou → assinatura HMAC válida (janela de tempo + corpo + método + caminho) → canal ativo e módulo CANAIS ligado →
 * escopo exigido → limite por credencial. Qualquer falha de identidade responde o MESMO 401 (não diz se a chave existe).
 */
export interface ChannelPrincipal {
  companyId: string;
  branchId: string;
  channelId: string;
  credentialId: string;
  keyId: string;
  scopes: ChannelCredentialScope[];
  channelConfig: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      channelPrincipal?: ChannelPrincipal;
      rawBody?: Buffer;
    }
  }
}

/** Lê JSON com teto pequeno (256 KB) e guarda o corpo CRU: a assinatura é calculada sobre os bytes exatos que o canal enviou. */
export const commerceJson = express.json({
  limit: '256kb',
  type: ['application/json'],
  verify: (req, _res, buf) => {
    (req as Request).rawBody = buf;
  },
});

export function channelAuth(requiredScope: ChannelCredentialScope) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const ip = req.ip ?? 'unknown';
      if (await isAuthBlocked(ip)) return next(commerceError.rateLimited(60));

      const fail = async () => {
        await noteAuthFailure(ip);
        return next(commerceError.unauthorized());
      };

      const keyId = req.header('x-cortex-key');
      if (!keyId || !KEY_ID_PATTERN.test(keyId)) return fail();

      const credential = await findCredentialForAuth(keyId);
      if (!credential || !isUsable(credential)) return fail();

      const signature = verifyRequestSignature({
        secret: openSecret(credential.secretEncrypted),
        signatureHeader: req.header('x-cortex-signature'),
        timestampHeader: req.header('x-cortex-timestamp'),
        method: req.method,
        path: req.originalUrl,
        rawBody: req.rawBody,
      });
      if (!signature.ok) return fail();

      if (!credential.scopes.includes(requiredScope)) return next(commerceError.forbiddenScope(requiredScope));

      const branchId = credential.branchId ?? credential.channel.branchId;
      if (!branchId) return next(commerceError.channelBranchRequired());

      const limit = await consumeCredential(credential.keyId);
      res.setHeader('X-RateLimit-Limit', String(limit.limit));
      res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec));
        return next(commerceError.rateLimited(limit.retryAfterSec));
      }

      // A partir daqui toda consulta roda com o contexto do canal (RLS empresa + filial; tipo de usuário próprio, sem poder de empresa inteira).
      return runWithRLSContext({ companyId: credential.companyId, branchId, userType: 'CHANNEL' }, async () => {
        const enabled = await moduleSettingsService.isModuleEnabled(credential.companyId, branchId, 'CANAIS');
        if (!enabled || !credential.channel.isActive) return next(commerceError.channelDisabled());
        req.channelPrincipal = {
          companyId: credential.companyId,
          branchId,
          channelId: credential.channelId,
          credentialId: credential.id,
          keyId: credential.keyId,
          scopes: credential.scopes,
          channelConfig: (credential.channel.config as Record<string, unknown> | null) ?? {},
        };
        touchLastUsed(credential.id);
        if (credential.channel.connectionStatus !== 'CONNECTED') markChannelConnected(credential.channel, credential.keyId);
        return next();
      });
    } catch (err) {
      return next(err);
    }
  };
}
