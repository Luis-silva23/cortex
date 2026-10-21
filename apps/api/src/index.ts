// Precisa ser o primeiro import: módulos abaixo (rotas, config/queue,
// utils/token) leem process.env.JWT_SECRET/DATABASE_URL etc. no topo do
// arquivo, na hora do import — se dotenv.config() rodar depois desses
// imports (como estava antes), as variáveis ainda não existem e o processo
// derruba com "JWT_SECRET ausente ou fraca" mesmo com o .env correto.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import commerceRoutes from './routes/commerce.routes';
import integrationsRoutes from './routes/integrations.routes';
import { registerSandboxProviderIfAllowed } from './services/integrations/sandbox.provider';
import { errorHandler } from './middleware/errorHandler';
import { requireHttps } from './middleware/https';
import { clampPaginationLimit } from './middleware/paginationLimit';
import { rateLimitGeneral } from './middlewares/advancedRateLimit';
import { resolveDevCorsOrigins, resolveProductionCorsOrigins } from './config/cors';
import { Logger } from './services/logger.service';
import { swaggerOptions, swaggerUiOptions } from './config/swagger';
import { closeQueueInfra } from './config/queue'; // Inicializar queue worker
import { redis } from './config/redis'; // Inicializar Redis
import './config/scheduler'; // Inicializar scheduler
import { assertEnv, parseTrustProxy } from './config/env';
import { assertDatabaseSecurity } from './config/db-security';
import { registerGracefulShutdown } from './config/shutdown';
import { advancedRateLimiter } from './middlewares/advancedRateLimit';
import { assertEncryptionKey } from '@ln-system/shared/utils/secret-box';

// Sem a chave de cifra, o primeiro login com MFA quebraria em produção: falha aqui, na subida (como JWT_SECRET).
assertEncryptionKey();

// Configuração de produção inválida (variável ausente, senha de exemplo, TRUST_PROXY=true...) recusa a subida em vez de iniciar
// "meio configurada"; fora de produção só avisa. Nunca registra o VALOR de um segredo (docs/CORTEX/PRODUCAO.md §3).
try {
  assertEnv(process.env, Logger);
} catch (error) {
  Logger.error('API não iniciada: configuração inválida para produção', { error: (error as Error).message });
  process.exit(1);
}

// SEGURANÇA DO BANCO (decisões 148/151): em produção a API só sobe se o banco EXIGE o contexto de RLS assinado, aceita a assinatura desta API e a conexão
// NÃO é de superusuário/BYPASSRLS (que ignoram a RLS). Fora de produção só avisa. A verificação é assíncrona: roda assim que o pool abre a 1ª conexão.
void (async () => {
  const { prismaUnsafeBypassRLS: db, contextStatement, PLATFORM_CONTEXT, canSignContext } = await import('@ln-system/database');
  try {
    await assertDatabaseSecurity(
      {
        status: async () => {
          try {
            const rows = (await db.$queryRawUnsafe('SELECT enforced, secret_slots FROM app_ctx.status()')) as Array<{ enforced: boolean; secret_slots: number }>;
            return rows[0] ? { enforced: rows[0].enforced, secretSlots: Number(rows[0].secret_slots) } : null;
          } catch (error) {
            // banco RESTAURADO de um backup: o cofre do segredo fica fora do dump (decisão 151), então status() falha ao ler app_ctx_vault.secrets.
            // Equivale a "exige assinatura e não tem segredo": a guarda orienta a provisionar de novo (db:provision-context) em vez de culpar a migração.
            if (String((error as Error)?.message ?? error).includes('app_ctx_vault')) return { enforced: true, secretSlots: 0 };
            throw error;
          }
        },
        signedContextAccepted: async () => {
          const result = (await db.$transaction([contextStatement(db, PLATFORM_CONTEXT), db.$queryRawUnsafe('SELECT app_ctx.is_super_admin() AS ok')])) as [number, Array<{ ok: boolean }>];
          return result[1][0]?.ok === true;
        },
        role: async () => {
          const rows = (await db.$queryRawUnsafe(
            `SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass, (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owned FROM pg_roles r WHERE r.rolname = current_user`
          )) as Array<{ superuser: boolean; bypass: boolean; owned: number }>;
          return { superuser: !!rows[0]?.superuser, bypassRls: !!rows[0]?.bypass, ownedTables: Number(rows[0]?.owned ?? 0) };
        },
      },
      process.env,
      canSignContext(),
      Logger
    );
  } catch (error) {
    Logger.error('API não iniciada: segurança do banco inválida para produção', { error: (error as Error).message });
    process.exit(1);
  }
})();

// Inicializar Logger
// Logger é uma classe com métodos estáticos (não singleton com getInstance).
// Usamos a própria classe como valor — chamadas como logger.info(...) continuam
// funcionando porque métodos estáticos são acessíveis a partir da referência da classe.
const logger = Logger;

const app = express();

// Provedor SIMULADO do Integration Gateway: só fora de produção (ou em produção com CHANNEL_SANDBOX_PROVIDER=true de propósito).
// Nenhum provedor real é registrado aqui: integração real é fase própria, com credencial e homologação.
registerSandboxProviderIfAllowed();
const PORT = process.env.API_PORT || 3001;

// IP real atrás de proxy/balanceador (limite de tentativas, bloqueio por IP, auditoria). Só com configuração EXPLÍCITA e restrita
// (número de saltos ou IPs do proxy): `TRUST_PROXY=true` é recusado em produção porque deixaria qualquer cliente forjar o X-Forwarded-For.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

// Middlewares de segurança
app.use(helmet());
// HTTPS obrigatório em produção (426 para HTTP puro; só as sondas de saúde passam). Antes de TODA rota, inclusive Commerce/Integrations.
app.use(requireHttps());

// COMMERCE API (docs/CORTEX/COMMERCE_API.md): porta pública para sites/canais, FORA de `/api`. Montada ANTES do CORS global, do
// limite geral e do parser de 5 MB de propósito: tem autenticação por credencial de canal (HMAC), parser próprio de 256 KB, CORS
// próprio (nenhum: é servidor → servidor) e limite por credencial. Nada aqui usa o JWT de usuário.
app.use('/commerce/v1', commerceRoutes);
// INTEGRATION GATEWAY (Fase 3): entrada de provedores por webhook assinado. Mesma lógica de isolamento da Commerce API (superfície
// própria, parser de 256 KB, sem CORS, sem JWT de usuário, limite por canal e por IP em falha de assinatura).
app.use('/integrations/v1', integrationsRoutes);

// ACHADO DE AUDITORIA (PRE-PRODUCTION HARDENING, Infraestrutura): em
// produção, `origin` estava hardcoded para um domínio placeholder
// ('https://seu-dominio.com') que nunca existiu de verdade e nunca era lido
// de variável de ambiente — com NODE_ENV=production, TODA requisição
// cross-origin dos 3 frontends reais (admin-web, super-admin) seria
// bloqueada pelo navegador, mesmo com credenciais corretas. WEB_URL
// (admin-web) e SUPER_ADMIN_URL já existiam em .env.example e já eram
// usadas em outro lugar (notification.job.ts, para montar links de
// e-mail) — só não chegavam até aqui. Em produção sem nenhuma das duas
// definidas, a lista fica vazia (nenhuma origem é liberada) em vez de cair
// num domínio inventado que daria uma falsa sensação de que CORS está
// configurado.
const productionOrigins = resolveProductionCorsOrigins(process.env);
if (process.env.NODE_ENV === 'production' && productionOrigins.length === 0) {
  logger.warn(
    'CORS em produção sem SUPER_ADMIN_URL/WEB_URL definidos — nenhuma origem cross-origin será liberada até configurar essas variáveis.'
  );
}
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? productionOrigins
    : resolveDevCorsOrigins(process.env),
  credentials: true,
}));

// Compression middleware para responder com gzip/deflate
app.use(compression({
  // Comprimir apenas se o tamanho for maior que 1KB
  threshold: 1024,
  // Níveis de compressão: 0 (nenhum) a 9 (máximo)
  level: 6,
  // Filtrar tipos de conteúdo que devem ser comprimidos
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// Middlewares gerais
// ACHADO DE AUDITORIA (Agente 11): sem `limit` explícito, tanto
// express.json quanto express.urlencoded usam o default do próprio
// Express (100kb) — pequeno demais para uma importação em lote real
// (import.routes.ts aceita centenas de produtos/clientes num único corpo
// JSON) e, mais importante, um valor que ninguém escolheu deliberadamente.
// 5mb é generoso o bastante para os maiores payloads legítimos do sistema
// (import em lote) sem abrir a porta pra um payload arbitrariamente
// grande — uploads de arquivo de verdade (nenhum encontrado nesta
// auditoria: sem multer/multipart) usariam um caminho separado, não este.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
// Mesma camada global do achado de paginação sem teto — ver
// middleware/paginationLimit.ts para o porquê de ser aqui e não em cada
// rota individualmente.
app.use(clampPaginationLimit);

// Request Logger com detecção de queries lentas
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // Log level baseado na duração
    // Rastreável sem dado sensível: id da requisição (o mesmo do X-Request-Id e dos eventos/auditoria), empresa, filial e usuário do
    // token já validado. O caminho vai SEM a query string (ela pode carregar filtro com dado pessoal ou identificador).
    const logData = {
      requestId: req.requestId,
      method: req.method,
      url: (req.originalUrl || req.url).split('?')[0],
      status: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      companyId: req.user?.companyId,
      branchId: req.user?.branchId,
      userId: req.user?.userId,
    };
    
    // Detectar requisições lentas (> 1 segundo)
    if (duration > 1000) {
      logger.warn('⚠️  Slow Request Detected', {
        ...logData,
        warning: 'Request took more than 1 second',
      });
    } else if (duration > 500) {
      logger.info('HTTP Request (Moderate)', logData);
    } else {
      logger.info('HTTP Request', logData);
    }
  });
  next();
});

// Redis-backed (rate-limiter-flexible), não `express-rate-limit`
// em memória: com múltiplas instâncias da API atrás de um load balancer
// (API-01/02/03), um limite em memória de processo é três limites
// independentes, não um só — cada instância deixaria passar até "max" por
// si mesma. auth/mfa (rotas mais sensíveis) já usavam o limiter Redis-
// backed desde antes; isto estende a mesma garantia ao limite geral.
app.use(rateLimitGeneral);

// Swagger Documentation
if (process.env.NODE_ENV !== 'production') {
  const swaggerSpec = swaggerJsdoc(swaggerOptions);
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
  logger.info('📚 Swagger documentation available at /api/docs');
}

// Rotas
app.use('/api', routes);

// Error handler (deve ser o último middleware)
app.use(errorHandler);

// Iniciar servidor
const server = app.listen(PORT, () => {
  logger.info('🚀 API Server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
  });
});

// DESLIGAMENTO ORDENADO (config/shutdown.ts): sai da rotação (a sonda de prontidão passa a 503), drena o HTTP, e só então fecha workers,
// filas, Redis e bancos, com prazo total. Antes havia dois handlers de SIGTERM disputando (este e o de config/queue.ts, que dava
// process.exit(0) assim que os workers fechavam e matava as requisições em andamento) e os workers/Redis nunca eram drenados.
registerGracefulShutdown({
  server,
  log: logger,
  closers: [
    { name: 'workers e filas (BullMQ)', close: closeQueueInfra },
    { name: 'limitador de requisições (Redis)', close: () => advancedRateLimiter.close() },
    { name: 'Redis (cache e sessão)', close: () => redis.quit().catch(() => redis.disconnect()) },
    {
      name: 'PostgreSQL',
      close: async () => {
        const { prisma, prismaUnsafeBypassRLS } = await import('@ln-system/database');
        await Promise.all([prisma.$disconnect(), prismaUnsafeBypassRLS.$disconnect()]);
      },
    },
  ],
});

// Tratamento de erros não capturados — antes só ia para o console/arquivo
// winston, nunca para SystemLog, então um crash não aparecia na tela de
// Logs do Super Admin (só em observabilidade externa ao processo, se
// houvesse). `Logger.critical` enfileira no Redis (BullMQ), não escreve
// direto no Postgres, então é seguro chamar aqui mesmo sem contexto de RLS
// (o worker que processa a fila já roda sob contexto SUPER_ADMIN).
process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled Rejection', { reason: error.message, promise });
  Logger.critical('UNHANDLED_REJECTION', error.message, { stackTrace: error.stack });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  // process.exit(1) mataria o processo antes do enqueue assíncrono (Redis)
  // completar — sem aguardar, o log do próprio crash quase nunca chegava a
  // ser persistido. Timeout curto: nunca trava o processo indefinidamente
  // caso o Redis também esteja fora do ar durante o crash.
  const persist = Logger.criticalAsync('UNCAUGHT_EXCEPTION', error.message, { stackTrace: error.stack });
  Promise.race([persist, new Promise((resolve) => setTimeout(resolve, 2000))]).finally(() => {
    process.exit(1);
  });
});
