import { Request, Response, NextFunction } from 'express';
import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { openSecret } from '@ln-system/shared/utils/secret-box';
import moduleSettingsService from '../services/module-settings.service';
import { commerceError } from '../services/commerce/errors';
import { consumeCredential, isAuthBlocked, noteAuthFailure } from '../services/commerce/rate-limit';
import { providerRegistry, verifyWebhookSignature, type ChannelProvider } from '../services/sales-channels/gateway';
import type { GatewayChannel } from '../services/integrations/inbound.service';

/**
 * Autenticação do WEBHOOK de um provedor (`/integrations/v1/webhooks/:channelId`). Quem chama é o provedor, não um usuário, e o corpo
 * é dado externo não confiável. Sequência: IP não bloqueado por falhas → canal existe, tem provedor com webhook e segredo guardado
 * → assinatura HMAC válida DENTRO da janela de tempo (anti-repetição) sobre os bytes exatos do corpo → limite por canal → canal ativo e
 * módulo ligado. Qualquer falha de identidade responde o MESMO 401 (não diz se o canal existe nem por que falhou). A empresa e a
 * filial são as do CANAL no banco, nunca do corpo ou de cabeçalho. O segredo é o campo `webhookSecret` da credencial cifrada do canal.
 */
export interface WebhookContext {
  channel: GatewayChannel;
  provider: ChannelProvider;
  rawBody: string;
}

declare global {
  namespace Express {
    interface Request {
      webhook?: WebhookContext;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Única consulta sem RLS desta superfície: um canal por id exato, antes de existir contexto de empresa. */
export async function findChannelForWebhook(channelId: string) {
  const [, row] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.salesChannel.findUnique({
      where: { id: channelId },
      select: { id: true, companyId: true, branchId: true, provider: true, isActive: true, config: true, credentialsEncrypted: true },
    }),
  ]);
  return row;
}

export async function webhookAuth(req: Request, res: Response, next: NextFunction) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const ip = `wh:${req.ip ?? 'unknown'}`;
    if (await isAuthBlocked(ip)) return next(commerceError.rateLimited(60));

    const fail = async () => {
      await noteAuthFailure(ip);
      return next(commerceError.unauthorized());
    };

    const channelId = String(req.params.channelId ?? '');
    if (!UUID.test(channelId)) return fail();
    const channel = await findChannelForWebhook(channelId);
    const provider = providerRegistry.get(channel?.provider);
    if (!channel || !provider?.webhook || !provider.parseWebhook || !channel.credentialsEncrypted) return fail();

    let secret: string | undefined;
    try {
      secret = (JSON.parse(openSecret(channel.credentialsEncrypted)) as Record<string, string>).webhookSecret;
    } catch {
      return fail();
    }
    if (!secret) return fail();

    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const check = verifyWebhookSignature({ secret, rawBody, header: req.header(provider.webhook.signatureHeader), toleranceSec: provider.webhook.toleranceSec });
    if (!check.ok) return fail();

    const limit = await consumeCredential(`wh:${channel.id}`);
    res.setHeader('X-RateLimit-Limit', String(limit.limit));
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      return next(commerceError.rateLimited(limit.retryAfterSec));
    }
    if (!channel.branchId) return next(commerceError.channelBranchRequired());
    if (!rawBody) return next(commerceError.invalidRequest([{ path: 'body', message: 'corpo vazio' }]));

    // A partir daqui tudo roda com o contexto do CANAL (RLS empresa + filial; sem poder de empresa inteira).
    return runWithRLSContext({ companyId: channel.companyId, branchId: channel.branchId, userType: 'CHANNEL' }, async () => {
      const enabled = await moduleSettingsService.isModuleEnabled(channel.companyId, channel.branchId, 'CANAIS');
      if (!enabled || !channel.isActive) return next(commerceError.channelDisabled());
      req.webhook = {
        channel: { id: channel.id, companyId: channel.companyId, branchId: channel.branchId, provider: channel.provider, config: channel.config },
        provider,
        rawBody,
      };
      return next();
    });
  } catch (err) {
    return next(err);
  }
}
