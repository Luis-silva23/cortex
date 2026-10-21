import { Request, Response, NextFunction } from 'express';
import { AppError, isOperationalError } from '@ln-system/shared';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { Logger } from '../services/logger.service';
import { DATABASE_UNAVAILABLE_MESSAGE } from './translate-errors';
import { isRestrictViolation, RECORD_IN_USE_MESSAGE } from '../services/db-errors';
import { captureException } from '../services/monitoring-central/sentry.service';

/** ON DELETE RESTRICT (23001) chega ao Prisma como erro SEM código (não é P2003): é "ainda referenciado" (409), não erro interno. */
const isRestrictOnly = (err: any) => !(err instanceof AppError) && err?.code !== 'P2003' && err?.code !== 'P2014' && isRestrictViolation(err);

/**
 * Banco inacessível ou saturado (conexão fechada pelo servidor, falha de inicialização, pool esgotado, transação que não
 * iniciou): indisponibilidade temporária, nunca erro de quem chamou. Critério único usado aqui e no login.
 */
export function isDatabaseUnavailableError(err: any): boolean {
  return err instanceof Prisma.PrismaClientInitializationError || ['P1001', 'P1002', 'P1017', 'P2024', 'P2028'].includes(err?.code);
}

/**
 * Middleware de tratamento de erros centralizado
 * Converte todos os erros para formato padronizado
 */
const handleError = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  // Log do erro
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    userId: (req as any).user?.userId,
  });

  // Persistir em SystemLog (categoria 'application') só erros 5xx — 4xx são
  // erros de uso esperados (validação, não encontrado, etc), não incidentes
  // técnicos que a tela de observabilidade do Super Admin precisa listar.
  const resolvedStatus = err instanceof AppError ? err.statusCode : isRestrictOnly(err) ? 409 : err.statusCode || 500;
  if (resolvedStatus >= 500) {
    Logger.critical(err.code || err.name || 'UnhandledError', err.message || 'Erro interno não tratado', {
      requestId: (req as any).requestId,
      companyId: (req as any).user?.companyId,
      userId: (req as any).user?.userId,
      errorMessage: err.message,
      stackTrace: err.stack,
      route: req.originalUrl,
      method: req.method,
    });
    // Sentry (opcional, desligado sem SENTRY_DSN): fora do caminho da resposta, mascarado, amostrado e limitado; NUNCA lança nem atrasa a resposta.
    void captureException(err, { route: `${req.baseUrl}${req.route?.path ?? ''}` || req.path, method: req.method, statusCode: resolvedStatus, requestId: (req as any).requestId });
  }

  // Erro já é AppError
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  // Erro de validação Zod
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: 'Erro de validação',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: err.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Banco inacessível (caos controlado: Postgres parado com a API no ar) — antes 500 "Erro interno do servidor".
  // É indisponibilidade temporária, não defeito: 503 com Retry-After para o cliente tentar de novo.
  // P2024/P2028: pool de conexões esgotado ou transação que não iniciou a tempo (rajada) — nada foi gravado; é saturação
  // momentânea e não erro do cliente, então também é 503 com Retry-After.
  if (isDatabaseUnavailableError(err)) {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ message: DATABASE_UNAVAILABLE_MESSAGE, code: 'DATABASE_UNAVAILABLE', statusCode: 503 });
  }

  // Exclusão/alteração de registro ainda referenciado (FK RESTRICT): 409 com mensagem humana, nunca "Erro interno"
  if (isRestrictOnly(err)) {
    return res.status(409).json({ message: RECORD_IN_USE_MESSAGE, code: 'RECORD_IN_USE', statusCode: 409 });
  }

  // Erros do Prisma
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return handlePrismaError(err, res);
  }

  // Erro JWT
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      message: 'Token inválido',
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      message: 'Token expirado',
      code: 'TOKEN_EXPIRED',
      statusCode: 401,
    });
  }

  // Erro genérico
  const statusCode = err.statusCode || 500;
  const message = isOperationalError(err)
    ? err.message
    : 'Erro interno do servidor';

  return res.status(statusCode).json({
    message,
    code: err.code || 'INTERNAL_ERROR',
    statusCode,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

/**
 * Tratamento específico para erros do Prisma
 */
function handlePrismaError(err: Prisma.PrismaClientKnownRequestError, res: Response) {
  switch (err.code) {
    case 'P2002':
      // Violação de constraint unique
      const field = (err.meta?.target as string[])?.join(', ') || 'campo';
      return res.status(409).json({
        message: `${field} já existe`,
        code: 'DUPLICATE_ENTRY',
        statusCode: 409,
        details: { field },
      });

    case 'P2025':
      // Registro não encontrado
      return res.status(404).json({
        message: 'Registro não encontrado',
        code: 'NOT_FOUND',
        statusCode: 404,
      });

    case 'P2003':
      // Violação de foreign key
      return res.status(400).json({
        message: 'Referência inválida',
        code: 'INVALID_REFERENCE',
        statusCode: 400,
      });

    case 'P2014':
      // Violação de relação required
      return res.status(400).json({
        message: 'Relação obrigatória não fornecida',
        code: 'REQUIRED_RELATION',
        statusCode: 400,
      });

    default:
      return res.status(500).json({
        message: 'Erro de banco de dados',
        code: 'DATABASE_ERROR',
        statusCode: 500,
        ...(process.env.NODE_ENV === 'development' && { details: err.message }),
      });
  }
}

// ACHADO DE AUDITORIA: este handler responde { message, code, statusCode }, mas
// o resto da API (res.status().json({ error }), requireUserType...) e todas as
// telas do admin-web usam `error` — então a mensagem real (e-mail duplicado,
// módulo desativado, permissão negada, validação) se perdia e a tela mostrava
// o texto genérico. Acrescenta `error` (= message) SEM remover campo nenhum:
// quem já lê `message`/`code` continua funcionando.
export function withLegacyErrorField(body: any) {
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.message === 'string' && body.error === undefined) {
    return { ...body, error: body.message };
  }
  return body;
}

/**
 * Middleware de tratamento de erros centralizado (registrado no app).
 * Só encapsula res.json desta resposta para incluir o campo `error`.
 */
export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  const sendJson = res.json.bind(res);
  res.json = ((body?: any) => sendJson(withLegacyErrorField(body))) as Response['json'];
  return handleError(err, req, res, next);
};

/**
 * Wrapper para funções async que garante que erros sejam capturados
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
