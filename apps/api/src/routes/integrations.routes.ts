import { Router, Request, Response, NextFunction } from 'express';
import { commerceJson } from '../middleware/channel-auth';
import { commerceErrorHandler } from '../middleware/commerce-error-handler';
import { webhookAuth } from '../middleware/webhook-auth';
import { requestContext } from '../middleware/requestContext';
import { commerceError } from '../services/commerce/errors';
import { MAX_EVENTS_PER_DELIVERY, processEvents } from '../services/integrations/inbound.service';
import { sanitizeErrorMessage } from '../services/sales-channels/gateway';

/**
 * INTEGRATION GATEWAY — entrada de provedores (`/integrations/v1`). Superfície PRÓPRIA, separada da API administrativa e da Commerce API.
 * Hoje só o webhook: `POST /webhooks/:channelId`, assinado pelo provedor (HMAC com janela de tempo), idempotente por evento, com
 * correlação por requisição (`X-Request-Id`) e erros de código estável sem detalhe técnico. O provedor entrega eventos; o CÓRTEX os
 * valida e aplica pelas regras de negócio — o provedor nunca decide preço, estoque, venda nem pagamento.
 *
 * Resposta: 200 quando todos os eventos foram tratados (aplicados, repetidos, guardados fora de ordem ou recusados por regra de
 * negócio: repetir não adianta); 500 `TEMPORARY_FAILURE` quando alguma falha NOSSA e transitória impediu o tratamento: o provedor deve
 * reenviar (é seguro: cada evento é idempotente).
 */
const router = Router();

router.use(requestContext);
router.use(commerceJson);

router.post('/webhooks/:channelId', webhookAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channel, provider, rawBody } = req.webhook!;
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;

    let events: unknown[];
    try {
      events = provider.parseWebhook!({ rawBody, headers, ctx: { channelId: channel.id, companyId: channel.companyId, branchId: channel.branchId, provider: provider.key, externalAccountId: null, config: null, credentials: null } });
    } catch (err) {
      throw commerceError.invalidRequest([{ path: 'body', message: sanitizeErrorMessage(err, 120) }]);
    }
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_DELIVERY) throw commerceError.invalidRequest([{ path: 'events', message: `envie de 1 a ${MAX_EVENTS_PER_DELIVERY} eventos` }]);

    const results = await processEvents(channel, events, { correlationId: req.requestId });
    const failed = results.some((r) => r.outcome === 'FAILED');
    if (failed) {
      res.status(500).json({ error: { code: 'TEMPORARY_FAILURE', message: 'Falha temporária ao tratar o evento. Reenvie: o reenvio é seguro.' }, requestId: req.requestId, results });
      return;
    }
    res.json({ received: results.length, results, requestId: req.requestId });
  } catch (e) {
    next(e);
  }
});

router.use((_req: Request, _res: Response, next: NextFunction) => next(commerceError.notFound('Rota')));
router.use(commerceErrorHandler);

export default router;
