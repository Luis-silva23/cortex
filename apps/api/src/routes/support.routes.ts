import { Router, Request, Response, NextFunction } from 'express';
import { AuditAction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import { supportService, type SupportActor } from '../services/support.service';
import { supportKbService } from '../services/support-kb.service';
import { catalogView } from '../services/support-catalog';

/**
 * Central de Ajuda e Suporte (docs/CORTEX/SUPPORT.md).
 *
 *  /support        usuário de EMPRESA: abrir, listar, ver, responder, encerrar, reabrir, anexos. Empresa/filial/usuário
 *                  vêm do token; Super Admin não usa estas rotas (usa o console).
 *  /support-kb     base de conhecimento: todos os logados leem artigos publicados; catálogo de módulos/tipos.
 *  /support-admin  console da PLATAFORMA (SUPER_ADMIN): contexto RLS de plataforma explícito (requireSuperAdmin +
 *                  tenantIsolation), leitura do chamado auditada (READ), escrita auditada.
 */
const actorOf = (req: Request): SupportActor => {
  const u = (req as any).user;
  return { userId: u.userId, userType: u.userType, companyId: u.companyId ?? null, branchId: u.branchId ?? null };
};
const source = (req: Request) => String(req.headers['x-client-source'] ?? '').toUpperCase() || undefined;
const appVersion = (req: Request) => (req.headers['x-app-version'] as string | undefined) ?? null;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function sendFile(res: Response, file: { fileName: string; mimeType: string; data: Buffer }) {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(file.data);
}

const describeTicket = (action: string) => ({
  describe: (req: Request, body: any) => ({
    entityId: body?.id ?? req.params.id ?? null,
    newValue: {
      operacao: action,
      numero: body?.ticketNumber ?? null,
      situacao: body?.status ?? null,
      situacaoAnterior: body?.statusFrom ?? null,
      modulo: body?.module ?? null,
      prioridade: body?.priority ?? null,
      prioridadeAnterior: body?.priorityFrom ?? null,
      responsavel: body?.assignedTo?.name ?? null,
      responsavelAnterior: body?.assignedFrom ?? null,
      anexo: body?.fileName ?? null,
    },
  }),
});

// ------------------------------------------------------------------------------------------------------------ empresa
export const supportRoutes = Router();
supportRoutes.use(authMiddleware);
supportRoutes.use((req: Request, _res: Response, next: NextFunction) => {
  if ((req as any).user?.userType === 'SUPER_ADMIN') {
    return next(new AppError('A equipe de suporte atende pelo Console de Suporte (Super Admin).', 403, 'SUPPORT_USE_CONSOLE'));
  }
  return next();
});
supportRoutes.use(tenantIsolation);

supportRoutes.get('/tickets', wrap(async (req, res) => res.json(await supportService.list(actorOf(req), req.query as Record<string, unknown>))));
supportRoutes.get('/tickets/unread-count', wrap(async (req, res) => res.json(await supportService.unreadCount(actorOf(req)))));
supportRoutes.get('/context', wrap(async (req, res) => res.json(await supportService.contextPreview(actorOf(req), req.query))));
supportRoutes.post(
  '/tickets',
  idempotency(),
  auditLog(AuditAction.CREATE, 'SupportTicket', describeTicket('ABERTURA')),
  wrap(async (req, res) => res.status(201).json(await supportService.create(actorOf(req), req.body, { source: source(req), appVersion: appVersion(req) })))
);
supportRoutes.get('/tickets/:id', wrap(async (req, res) => res.json(await supportService.get(actorOf(req), req.params.id, req.query as Record<string, unknown>))));
supportRoutes.post(
  '/tickets/:id/messages',
  idempotency(),
  auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('RESPOSTA')),
  wrap(async (req, res) => res.status(201).json(await supportService.reply(actorOf(req), req.params.id, req.body, { source: source(req) })))
);
supportRoutes.post('/tickets/:id/close', auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('ENCERRAMENTO')), wrap(async (req, res) => res.json(await supportService.close(actorOf(req), req.params.id))));
supportRoutes.post('/tickets/:id/reopen', auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('REABERTURA')), wrap(async (req, res) => res.json(await supportService.reopen(actorOf(req), req.params.id))));
supportRoutes.post(
  '/tickets/:id/attachments',
  idempotency(),
  auditLog(AuditAction.CREATE, 'SupportTicketAttachment', describeTicket('ANEXO_INCLUIDO')),
  wrap(async (req, res) => res.status(201).json(await supportService.addAttachment(actorOf(req), req.params.id, req.body ?? {})))
);
supportRoutes.get('/attachments/:id', wrap(async (req, res) => sendFile(res, await supportService.download(actorOf(req), req.params.id))));
supportRoutes.delete('/attachments/:id', auditLog(AuditAction.DELETE, 'SupportTicketAttachment', describeTicket('ANEXO_REMOVIDO')), wrap(async (req, res) => res.json(await supportService.removeAttachment(actorOf(req), req.params.id))));

// ------------------------------------------------------------------------------------------------ base de conhecimento
export const supportKbRoutes = Router();
supportKbRoutes.use(authMiddleware);
supportKbRoutes.use(tenantIsolation);
supportKbRoutes.get('/catalog', (_req: Request, res: Response) => res.json(catalogView()));
supportKbRoutes.get('/categories', wrap(async (_req, res) => res.json(await supportKbService.categories())));
supportKbRoutes.get('/articles', wrap(async (req, res) => res.json(await supportKbService.search(req.query))));
supportKbRoutes.get('/articles/:slug', wrap(async (req, res) => res.json(await supportKbService.getBySlug(req.params.slug))));

// ------------------------------------------------------------------------------------------------ console da plataforma
export const supportAdminRoutes = Router();
supportAdminRoutes.use(authMiddleware, requireSuperAdmin, tenantIsolation);

supportAdminRoutes.get('/catalog', (_req: Request, res: Response) => res.json(catalogView()));
supportAdminRoutes.get('/dashboard', wrap(async (_req, res) => res.json(await supportService.platformDashboard())));
supportAdminRoutes.get('/agents', wrap(async (_req, res) => res.json(await supportService.platformAgents())));
supportAdminRoutes.get('/companies', wrap(async (_req, res) => res.json(await supportService.platformCompanies())));
supportAdminRoutes.get('/tickets', wrap(async (req, res) => res.json(await supportService.platformList(req.query as Record<string, unknown>))));
// Leitura do chamado de uma empresa pela plataforma: ampliação explícita → auditada.
supportAdminRoutes.get(
  '/tickets/:id',
  auditLog(AuditAction.READ, 'SupportTicket', {
    describe: (req: Request, body: any) => ({ entityId: req.params.id, newValue: { operacao: 'LEITURA_PELA_PLATAFORMA', numero: body?.ticket?.ticketNumber ?? null, empresa: body?.ticket?.company?.id ?? null } }),
  }),
  wrap(async (req, res) => res.json(await supportService.platformGet(actorOf(req), req.params.id, req.query as Record<string, unknown>)))
);
supportAdminRoutes.post('/tickets/:id/messages', idempotency(), auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('RESPOSTA_DO_SUPORTE')), wrap(async (req, res) => res.status(201).json(await supportService.platformReply(actorOf(req), req.params.id, req.body))));
supportAdminRoutes.post('/tickets/:id/assign', auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('ATRIBUICAO')), wrap(async (req, res) => res.json(await supportService.platformAssign(actorOf(req), req.params.id, req.body ?? {}))));
supportAdminRoutes.post('/tickets/:id/status', auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('SITUACAO')), wrap(async (req, res) => res.json(await supportService.platformSetStatus(actorOf(req), req.params.id, req.body ?? {}))));
supportAdminRoutes.post('/tickets/:id/priority', auditLog(AuditAction.UPDATE, 'SupportTicket', describeTicket('PRIORIDADE')), wrap(async (req, res) => res.json(await supportService.platformSetPriority(actorOf(req), req.params.id, req.body ?? {}))));
supportAdminRoutes.post(
  '/tickets/:id/attachments',
  idempotency(),
  auditLog(AuditAction.CREATE, 'SupportTicketAttachment', describeTicket('ANEXO_INCLUIDO')),
  wrap(async (req, res) => res.status(201).json(await supportService.addAttachment(actorOf(req), req.params.id, req.body ?? {}, true)))
);
supportAdminRoutes.get('/attachments/:id', wrap(async (req, res) => sendFile(res, await supportService.download(actorOf(req), req.params.id, true))));
supportAdminRoutes.delete('/attachments/:id', auditLog(AuditAction.DELETE, 'SupportTicketAttachment', describeTicket('ANEXO_REMOVIDO')), wrap(async (req, res) => res.json(await supportService.removeAttachment(actorOf(req), req.params.id, true))));

const describeArticle = (action: string) => ({
  describe: (req: Request, body: any) => ({
    entityId: body?.article?.id ?? body?.id ?? req.params.id ?? null,
    newValue: { operacao: action, titulo: body?.article?.title ?? body?.title ?? null, situacao: body?.article?.status ?? body?.status ?? null, situacaoAnterior: body?.statusFrom ?? null },
  }),
});
supportAdminRoutes.get('/kb/articles', wrap(async (req, res) => res.json(await supportKbService.adminList(req.query))));
supportAdminRoutes.get('/kb/articles/:id', wrap(async (req, res) => res.json(await supportKbService.adminGet(req.params.id))));
supportAdminRoutes.post(
  '/kb/articles',
  auditLog(AuditAction.CREATE, 'SupportKbArticle', describeArticle('CRIACAO')),
  wrap(async (req, res) => {
    const u = (req as any).user;
    return res.status(201).json(await supportKbService.create({ id: u.userId, name: u.name ?? u.email ?? 'Equipe CÓRTEX' }, req.body));
  })
);
supportAdminRoutes.patch('/kb/articles/:id', auditLog(AuditAction.UPDATE, 'SupportKbArticle', describeArticle('EDICAO')), wrap(async (req, res) => res.json(await supportKbService.update(req.params.id, req.body))));
supportAdminRoutes.post('/kb/articles/:id/status', auditLog(AuditAction.UPDATE, 'SupportKbArticle', describeArticle('PUBLICACAO')), wrap(async (req, res) => res.json(await supportKbService.setStatus(req.params.id, req.body?.status))));
supportAdminRoutes.get('/kb/categories', wrap(async (_req, res) => res.json(await supportKbService.adminCategories())));
supportAdminRoutes.post('/kb/categories', auditLog(AuditAction.CREATE, 'SupportKbCategory'), wrap(async (req, res) => res.status(201).json(await supportKbService.createCategory(req.body))));
supportAdminRoutes.patch('/kb/categories/:id', auditLog(AuditAction.UPDATE, 'SupportKbCategory'), wrap(async (req, res) => res.json(await supportKbService.updateCategory(req.params.id, req.body))));
