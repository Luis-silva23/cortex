import { Router, Request, Response, NextFunction } from 'express';
import { commerceJson } from '../middleware/channel-auth';
import { commerceErrorHandler } from '../middleware/commerce-error-handler';
import { requestContext } from '../middleware/requestContext';
import { CommerceError, commerceError } from '../services/commerce/errors';
import { consumeCredential, isAuthBlocked, noteAuthFailure } from '../services/commerce/rate-limit';
import { verifyRequestSignature } from '../services/commerce/signature';
import { ingest, ingestSchema, ingestSecret } from '../services/monitoring-central/external-monitor.service';

/**
 * ENTRADA DO MONITOR INDEPENDENTE (`/monitor/v1`). Superfície PRÓPRIA de máquina, fora de `/api` e montada antes do CORS e do parser global (mesmo desenho da Commerce API):
 * sem JWT de usuário, sem CORS, corpo ≤ 256 KB lido cru para a assinatura HMAC, falha de assinatura conta no limite por IP e o sucesso tem limite global.
 * Segredo exclusivo `MONITOR_INGEST_SECRET` (≥ 32 caracteres): sem ele a entrada responde 503 e não grava nada. Resposta de falha de identidade é sempre o mesmo 401.
 */
const router = Router();

router.use(requestContext);
router.use(commerceJson);

async function monitorAuth(req: Request, res: Response, next: NextFunction) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const secret = ingestSecret();
    if (!secret) return next(new CommerceError(503, 'INGEST_DISABLED', 'A entrada do monitor externo não está configurada.'));
    const ip = req.ip ?? 'unknown';
    if (await isAuthBlocked(ip)) return next(commerceError.rateLimited(60));
    const check = verifyRequestSignature({
      secret,
      signatureHeader: req.header('x-cortex-signature'),
      timestampHeader: req.header('x-cortex-timestamp'),
      method: req.method,
      path: req.originalUrl,
      rawBody: req.rawBody,
    });
    if (!check.ok) {
      await noteAuthFailure(ip);
      return next(commerceError.unauthorized());
    }
    const limit = await consumeCredential('monitor-ingest');
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      return next(commerceError.rateLimited(limit.retryAfterSec));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

router.post('/ingest', monitorAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw commerceError.invalidRequest(parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const result = await ingest(parsed.data);
    res.json({ accepted: true, ...result, requestId: req.requestId });
  } catch (e) {
    next(e);
  }
});

router.use((_req: Request, _res: Response, next: NextFunction) => next(commerceError.notFound('Rota')));
router.use(commerceErrorHandler);

export default router;
