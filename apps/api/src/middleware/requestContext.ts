import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestMetricsQueue } from '../config/queue';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Gera/propaga um Request ID (correlation ID) por requisição e enfileira
 * uma métrica assíncrona (método, rota, status, duração, tenant) para
 * alimentar a observabilidade do Super ADM TI — nunca loga corpo, headers,
 * senha, token ou qualquer dado sensível, só identificadores e timing.
 *
 * Precisa vir DEPOIS do roteamento para capturar `req.route` (o padrão da
 * rota, ex: "/products/:id", não a URL crua com o ID real) — por isso é
 * aplicado dentro de routes/index.ts, não antes do `app.use('/api', routes)`.
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incomingId = req.headers['x-request-id'];
  req.requestId = typeof incomingId === 'string' && incomingId.length > 0 ? incomingId : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const routePattern = req.route?.path
      ? `${req.baseUrl}${req.route.path}`.replace(/\/+/g, '/')
      : req.baseUrl || req.path;

    const device = (req.headers['x-device-type'] as string) || (req.headers['user-agent'] as string)?.slice(0, 100);

    requestMetricsQueue
      .add('request-log', {
        requestId: req.requestId,
        method: req.method,
        route: routePattern,
        statusCode: res.statusCode,
        durationMs,
        // Commerce API: não há usuário JWT; a empresa e a filial são as da credencial do canal.
        companyId: req.user?.companyId ?? req.channelPrincipal?.companyId ?? null,
        branchId: req.user?.branchId ?? req.channelPrincipal?.branchId ?? null,
        userId: req.user?.userId ?? null,
        device: device ?? null,
      })
      .catch((err: Error) => console.error('Failed to enqueue request metric', err.message));
  });

  next();
}
