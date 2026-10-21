import winston from 'winston';
import path from 'path';

/**
 * Formato customizado para logs
 */
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    
    return msg;
  })
);

/**
 * Transports (onde os logs serão salvos)
 */
const transports: winston.transport[] = [
  // Console (sempre ativo)
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      customFormat
    ),
  }),
];

// Em produção, adicionar arquivo de logs
if (process.env.NODE_ENV === 'production') {
  // Logs gerais
  transports.push(
    new winston.transports.File({
      filename: path.join('logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );

  // Logs de erro
  transports.push(
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

/**
 * Criar logger
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  transports,
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join('logs', 'exceptions.log'),
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join('logs', 'rejections.log'),
    }),
  ],
});

/**
 * Logger wrapper com métodos específicos
 */
export class Logger {
  /**
   * Log de informação geral
   */
  static info(message: string, meta?: any) {
    logger.info(message, meta);
  }

  /**
   * Log de erro
   */
  static error(message: string, error?: Error | any, meta?: any) {
    if (error instanceof Error) {
      logger.error(message, {
        error: {
          message: error.message,
          stack: error.stack,
          ...meta,
        },
      });
    } else {
      logger.error(message, { error, ...meta });
    }
  }

  /**
   * Log de warning
   */
  static warn(message: string, meta?: any) {
    logger.warn(message, meta);
  }

  /**
   * Log de debug
   */
  static debug(message: string, meta?: any) {
    logger.debug(message, meta);
  }

  /**
   * Log de requisição HTTP
   */
  static http(message: string, meta?: any) {
    logger.http(message, meta);
  }

  /**
   * Log de autenticação
   */
  static auth(action: string, userId?: string, success: boolean = true, meta?: any) {
    logger.info(`Auth: ${action}`, {
      userId,
      success,
      type: 'authentication',
      ...meta,
    });
  }

  /**
   * Log de operação de banco de dados
   */
  static database(operation: string, table: string, duration?: number, meta?: any) {
    logger.debug(`Database: ${operation}`, {
      table,
      duration,
      type: 'database',
      ...meta,
    });
  }

  /**
   * Log de auditoria
   */
  static audit(action: string, userId: string, entity: string, entityId: string, meta?: any) {
    logger.info(`Audit: ${action}`, {
      userId,
      entity,
      entityId,
      type: 'audit',
      timestamp: new Date().toISOString(),
      ...meta,
    });
  }

  /**
   * Log de performance
   */
  static performance(operation: string, duration: number, meta?: any) {
    const level = duration > 1000 ? 'warn' : 'info';
    
    logger.log(level, `Performance: ${operation}`, {
      duration,
      type: 'performance',
      ...meta,
    });
  }

  /**
   * Log de cache
   */
  static cache(operation: 'hit' | 'miss' | 'set' | 'invalidate', key: string, meta?: any) {
    logger.debug(`Cache ${operation}: ${key}`, {
      type: 'cache',
      ...meta,
    });
  }

  /**
   * Log de job/queue
   */
  static job(jobName: string, status: 'started' | 'completed' | 'failed', meta?: any) {
    const level = status === 'failed' ? 'error' : 'info';
    
    logger.log(level, `Job ${jobName}: ${status}`, {
      type: 'job',
      ...meta,
    });
  }

  /**
   * Log de integração externa
   */
  static integration(service: string, operation: string, success: boolean, meta?: any) {
    const level = success ? 'info' : 'error';
    
    logger.log(level, `Integration ${service}: ${operation}`, {
      type: 'integration',
      success,
      ...meta,
    });
  }

  /**
   * Log estruturado para análise
   */
  static structured(event: string, data: any) {
    logger.info(event, {
      type: 'structured',
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log de segurança — SEMPRE persistido em SystemLog (categoria 'security'),
   * além do console/arquivo, para alimentar a tela de Logs/observabilidade
   * do Super ADM TI (falhas de login, bloqueio de conta, IDOR bloqueado,
   * etc). Nunca inclua senha/token/segredo em `context` — este método não
   * sanitiza automaticamente, quem chama é responsável por só passar
   * identificadores (userId, email, ip), nunca credenciais.
   */
  static security(event: string, message: string, context?: SystemLogContext) {
    logger.warn(`Security: ${event}`, { type: 'security', event, ...context });
    persistSystemLog('WARN', 'security', event, message, context);
  }

  /**
   * Log de erro crítico de aplicação — persistido em SystemLog (categoria
   * 'application') para aparecer na tela de Logs do Super Admin, além do
   * console/arquivo via Logger.error.
   */
  static critical(event: string, message: string, context?: SystemLogContext) {
    logger.error(`Critical: ${event}`, { type: 'critical', event, ...context });
    persistSystemLog('FATAL', 'application', event, message, context);
  }

  /**
   * Mesmo efeito de `critical()`, mas devolve a Promise do enqueue — usada
   * só onde o chamador precisa aguardar a persistência antes de encerrar
   * (ex.: `process.on('uncaughtException')` em index.ts, que mata o
   * processo logo em seguida; sem aguardar, o log do próprio crash quase
   * nunca chegava a ser enfileirado de verdade). A Promise nunca rejeita
   * (mesmo tratamento de erro de `persistSystemLog`).
   */
  static criticalAsync(event: string, message: string, context?: SystemLogContext): Promise<void> {
    logger.error(`Critical: ${event}`, { type: 'critical', event, ...context });
    return persistSystemLog('FATAL', 'application', event, message, context);
  }

  /**
   * Log de integração externa — mesmo comportamento de `integration()`, mas
   * também persiste em SystemLog quando a integração falha (categoria
   * 'integration'), para a plataforma conseguir listar "falhas de
   * integração" sem depender de grep em arquivo de log.
   */
  static integrationPersisted(
    service: string,
    operation: string,
    success: boolean,
    context?: SystemLogContext
  ) {
    Logger.integration(service, operation, success, context);
    if (!success) {
      persistSystemLog(
        'ERROR',
        'integration',
        `${service}:${operation}`,
        `Falha na integração ${service} (${operation})`,
        context
      );
    }
  }
}

export interface SystemLogContext {
  requestId?: string;
  companyId?: string;
  branchId?: string;
  userId?: string;
  device?: string;
  durationMs?: number;
  errorMessage?: string;
  stackTrace?: string;
  [key: string]: unknown;
}

/**
 * Enfileira a persistência assíncrona em SystemLog. Usa `require` tardio
 * (não import no topo do módulo) de propósito: config/queue.ts já importa
 * este arquivo (Logger) para logar eventos de job — um import estático nos
 * dois sentidos criaria uma dependência circular no carregamento do módulo.
 * Mesmo padrão já usado em config/scheduler.ts para o mesmo problema.
 * Nunca deve lançar: uma falha ao enfileirar um log não pode derrubar a
 * requisição/operação que está sendo logada.
 */
function persistSystemLog(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL',
  category: 'application' | 'security' | 'integration' | 'performance',
  event: string,
  message: string,
  context?: SystemLogContext
): Promise<void> {
  try {
    const { systemLogQueue } = require('../config/queue');
    const { requestId, companyId, branchId, userId, device, durationMs, errorMessage, stackTrace, ...metadata } =
      context || {};
    return systemLogQueue
      .add('system-log', {
        level,
        category,
        service: 'api',
        event,
        message,
        requestId,
        companyId,
        branchId,
        userId,
        device,
        durationMs,
        errorMessage,
        stackTrace,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      })
      .then(() => undefined)
      .catch((err: Error) => {
        console.error('Failed to enqueue system log', err.message);
      });
  } catch (err) {
    console.error('Failed to enqueue system log', (err as Error).message);
    return Promise.resolve();
  }
}

export default Logger;

/**
 * Middleware para logar requisições HTTP
 */
export const requestLogger = (req: any, res: any, next: any) => {
  const start = Date.now();

  // Log quando a resposta é enviada
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    Logger.http('HTTP Request', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      userAgent: req.get('user-agent'),
      ip: req.ip,
      userId: req.user?.userId,
    });
  });

  next();
};

/**
 * Helper para medir performance de operações
 */
export async function measurePerformance<T>(
  operation: string,
  callback: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  
  try {
    const result = await callback();
    const duration = Date.now() - start;
    
    Logger.performance(operation, duration);
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    Logger.performance(`${operation} (failed)`, duration);
    throw error;
  }
}
