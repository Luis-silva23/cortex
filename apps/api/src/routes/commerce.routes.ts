import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { channelAuth, commerceJson, ChannelPrincipal } from '../middleware/channel-auth';
import { idempotency } from '../middleware/idempotency';
import { requestContext } from '../middleware/requestContext';
import { commerceErrorHandler } from '../middleware/commerce-error-handler';
import { commerceError } from '../services/commerce/errors';
import catalogService from '../services/commerce/catalog.service';
import commerceOrderService from '../services/commerce/order.service';
import paymentEventsService from '../services/commerce/payment-events.service';
import { autoAcceptIfEnabled } from '../services/commerce/reservation.service';

/**
 * COMMERCE API (`/commerce/v1`) — a porta pública para um site/e-commerce falar com o CÓRTEX (docs/CORTEX/COMMERCE_API.md).
 * Superfície PRÓPRIA, separada da API administrativa (`/api`): quem chama é um CANAL (credencial de máquina assinada com HMAC), não
 * um usuário; empresa, filial e canal vêm da credencial; o canal nunca acessa o banco, só estes recursos. Escrita exige
 * `Idempotency-Key`. Erros têm código estável e nenhuma mensagem técnica. Falha aqui não toca o PDV.
 */
const router = Router();

router.use(requestContext);
router.use(commerceJson);

const principalOf = (req: Request): ChannelPrincipal => {
  if (!req.channelPrincipal) throw commerceError.unauthorized();
  return req.channelPrincipal;
};

const idempotencyKeyFormat = (req: Request, _res: Response, next: NextFunction) => {
  const key = req.header('Idempotency-Key');
  if (key !== undefined && !/^[A-Za-z0-9._:\-]{8,128}$/.test(key)) return next(commerceError.invalidRequest([{ path: 'Idempotency-Key', message: 'use de 8 a 128 caracteres: letras, números e . _ : -' }]));
  return next();
};
const requireIdempotency = [idempotencyKeyFormat, idempotency({ required: () => commerceError.idempotencyKeyRequired() })];

function parseQuery<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, query: unknown): T {
  const r = schema.safeParse(query);
  if (!r.success) throw commerceError.invalidRequest(r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(80).optional(),
});

const orderIdParam = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:\-]+$/);
const parseOrderId = (req: Request) => {
  const r = orderIdParam.safeParse(req.params.externalOrderId);
  if (!r.success) throw commerceError.invalidRequest([{ path: 'externalOrderId', message: 'identificador inválido' }]);
  return r.data;
};

const cancelBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();

// ---------------- catálogo (leitura) ----------------
router.get('/products', channelAuth('CATALOG_READ'), async (req, res, next) => {
  try {
    res.json(await catalogService.list(principalOf(req), parseQuery(listQuery, req.query)));
  } catch (e) {
    next(e);
  }
});

router.get('/products/:sku', channelAuth('CATALOG_READ'), async (req, res, next) => {
  try {
    const product = await catalogService.getBySku(principalOf(req), String(req.params.sku).slice(0, 80));
    if (!product) throw commerceError.notFound('Produto');
    res.json({ data: product });
  } catch (e) {
    next(e);
  }
});

router.get('/categories', channelAuth('CATALOG_READ'), async (req, res, next) => {
  try {
    res.json({ data: await catalogService.categories(principalOf(req)) });
  } catch (e) {
    next(e);
  }
});

// ---------------- pedidos ----------------
router.post('/orders', channelAuth('ORDERS_WRITE'), ...requireIdempotency, async (req, res, next) => {
  try {
    const principal = principalOf(req);
    const created = await commerceOrderService.create(principal, req.body, req.requestId);
    let order = created.order;
    // Aceite automático (opcional, desligado por padrão): reserva o estoque assim que o pedido chega.
    if (!created.replayed) order = (await autoAcceptIfEnabled(principal, created.order.cortexOrderId, req.requestId)) ?? order;
    res.status(created.replayed ? 200 : 201).json({ data: order, replayed: created.replayed });
  } catch (e) {
    next(e);
  }
});

router.get('/orders/:externalOrderId', channelAuth('ORDERS_READ'), async (req, res, next) => {
  try {
    res.json({ data: await commerceOrderService.get(principalOf(req), parseOrderId(req)) });
  } catch (e) {
    next(e);
  }
});

router.post('/orders/:externalOrderId/cancel', channelAuth('ORDERS_WRITE'), ...requireIdempotency, async (req, res, next) => {
  try {
    const body = cancelBody.safeParse(req.body ?? {});
    if (!body.success) throw commerceError.invalidRequest(body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    res.json({ data: await commerceOrderService.cancelByChannel(principalOf(req), parseOrderId(req), body.data.reason, req.requestId) });
  } catch (e) {
    next(e);
  }
});

// Evento de pagamento informado pelo canal/PSP. `eventId` já é a chave natural de idempotência; o cabeçalho é opcional aqui.
router.post('/orders/:externalOrderId/payment-events', channelAuth('PAYMENT_EVENTS_WRITE'), idempotencyKeyFormat, idempotency(), async (req, res, next) => {
  try {
    const result = await paymentEventsService.record(principalOf(req), parseOrderId(req), req.body, req.requestId);
    res.status(result.outcome === 'CREATED' ? 201 : 200).json({ data: result });
  } catch (e) {
    next(e);
  }
});

// ---------------- erros ----------------
router.use((_req: Request, _res: Response, next: NextFunction) => next(commerceError.notFound('Rota')));

// Qualquer falha NOSSA vira 500 genérico: o detalhe vai para o log (com o id da requisição), nunca para o canal.
router.use(commerceErrorHandler);

export default router;
