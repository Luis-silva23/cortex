import { Request, Response, NextFunction } from 'express';
import { Logger } from '../services/logger.service';
import { CommerceError } from '../services/commerce/errors';

/**
 * Tratador de erros das superfícies PÚBLICAS de máquina (`/commerce/v1` e `/integrations/v1`): código estável, mensagem sem detalhe
 * técnico e `requestId` para o suporte. Falha nossa vira 500 genérico; o detalhe vai só para o log, com o id da requisição.
 */
export function commerceErrorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const body = (status: number, code: string, message: string, details?: unknown) =>
    res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) }, requestId: req.requestId });

  if (err instanceof CommerceError) return body(err.status, err.code, err.message, err.details);
  if (err?.type === 'entity.too.large') return body(413, 'PAYLOAD_TOO_LARGE', 'O corpo da requisição é grande demais.');
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return body(400, 'INVALID_JSON', 'O corpo da requisição não é um JSON válido.');
  Logger.error('Superfície pública: erro interno', err instanceof Error ? err : new Error(String(err)));
  return body(500, 'INTERNAL_ERROR', 'Erro interno. Informe o requestId ao suporte.');
}
