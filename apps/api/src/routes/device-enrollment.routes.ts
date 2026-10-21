import { Router, Request, Response, NextFunction } from 'express';
import { AppError } from '@ln-system/shared';
import { deviceEnrollmentService } from '../services/device-enrollment.service';
import { consumeEnroll, isStatusBlocked, noteStatusFailure } from '../services/device-enrollment-limit';
import { isDatabaseUnavailableError } from '../middleware/errorHandler';
import { DATABASE_UNAVAILABLE_MESSAGE } from '../middleware/translate-errors';
import { logger } from '../utils/logger';

/**
 * ENTRADA DE EQUIPAMENTO NOVO (público — o equipamento ainda não tem identidade). Docs: docs/CORTEX/DISPOSITIVOS.md.
 *  POST /api/device/enroll  → cria o equipamento PENDENTE (sem empresa/filial) e devolve a chave (uma vez) + código curto.
 *  POST /api/device/status  → o "bootstrap" do aplicativo: estado do equipamento (exige id + chave).
 * Nenhuma das duas lê nem devolve dado de empresa, filial, produto, cliente, estoque, venda, caixa, OS, usuário ou integração antes da
 * autorização. Limite por IP; erro uniforme na credencial; cabeçalho no-store (a chave nunca é guardada em cache).
 */
const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';

router.post('/enroll', async (req, res, next) => {
  try {
    const wait = await consumeEnroll(ipOf(req));
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ success: false, error: 'Muitos pedidos de enrolamento deste endereço. Tente mais tarde.', code: 'ENROLL_RATE_LIMITED' });
    }
    const data = await deviceEnrollmentService.enroll(req.body, ipOf(req));
    logger.info('Equipamento enrolado (aguardando autorização)', { deviceId: data.deviceId });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return next(error);
  }
});

router.post('/status', async (req, res, next) => {
  try {
    const ip = ipOf(req);
    if (await isStatusBlocked(ip)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ success: false, error: 'Muitas tentativas inválidas. Aguarde um minuto.', code: 'STATUS_RATE_LIMITED' });
    }
    try {
      const data = await deviceEnrollmentService.status(req.body ?? {});
      return res.json({ success: true, data });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) await noteStatusFailure(ip);
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

// Erros próprios desta rota (a rota pública não usa o tratador global para não vazar detalhe de erro interno).
router.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (isDatabaseUnavailableError(error)) {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ success: false, error: DATABASE_UNAVAILABLE_MESSAGE, code: 'DATABASE_UNAVAILABLE' });
  }
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
  }
  logger.error('Falha na rota pública de equipamento', { message: error?.message });
  return res.status(500).json({ success: false, error: 'Não foi possível processar o pedido.', code: 'INTERNAL_ERROR' });
});

export default router;
