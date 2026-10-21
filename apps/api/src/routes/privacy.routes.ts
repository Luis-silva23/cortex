import { Router, Response } from 'express';
import { AppError } from '@ln-system/shared';
import { comparePassword } from '@ln-system/shared/utils/password';
import { AuditAction, prisma } from '@ln-system/database';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { createAuditLog } from '../middleware/audit';
import { rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import { logger } from '../utils/logger';
import {
  downloadExport,
  executeAnonymization,
  getRequest,
  listRequests,
  requestAnonymization,
  requestExport,
} from '../services/privacy/privacy.service';

/**
 * PEDIDOS DE TITULAR (LGPD) — /api/privacy. Só COMPANY_ADMIN da empresa dona do cadastro. Exportar e executar a anonimização exigem a
 * SENHA do próprio administrador (reautenticação: sessão roubada sozinha não leva dado pessoal nem apaga cadastro) e uma
 * justificativa. Tudo é auditado (ids e ato; nunca o dado pessoal). Ver docs/CORTEX/SECURITY.md e docs/privacidade/TITULARES_E_INCIDENTES.md.
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireUserType('COMPANY_ADMIN'));

const fail = (res: Response, error: any) => {
  if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
  logger.error('Privacy route error', { error: error?.name });
  return res.status(500).json({ success: false, error: 'Não foi possível concluir o pedido.', code: 'PRIVACY_ERROR' });
};

const actorOf = (req: any) => ({ userId: req.user.userId as string, companyId: req.user.companyId as string });

/** Reautenticação: a senha do administrador logado (erros contam no balde do autorizador: 3 por 5 min). */
async function confirmPassword(req: any, res: Response): Promise<boolean> {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 256) {
    res.status(400).json({ success: false, error: 'Informe a sua senha para confirmar.', code: 'PASSWORD_REQUIRED' });
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { password: true, isActive: true } });
  if (!user?.isActive || !(await comparePassword(password, user.password))) {
    res.status(401).json({ success: false, error: 'Senha incorreta.', code: 'WRONG_PASSWORD' });
    return false;
  }
  return true;
}

const audit = (req: any, action: AuditAction, entityId: string, newValue: Record<string, unknown>) =>
  createAuditLog({
    companyId: req.user.companyId,
    userId: req.user.userId,
    action,
    entity: 'PrivacyRequest',
    entityId,
    newValue: JSON.stringify(newValue),
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers?.['user-agent'] || null,
  }).catch((error) => logger.error('Failed to write privacy audit log', { error: error?.name }));

router.get('/requests', async (req, res) => {
  try {
    return res.json({ success: true, data: await listRequests(req.user!.companyId!) });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    return res.json({ success: true, data: await getRequest(req.user!.companyId!, req.params.id) });
  } catch (error) {
    return fail(res, error);
  }
});

/** Cria o pedido: EXPORT (exige senha; já gera o arquivo) ou ANONYMIZE (só planeja: mostra o que muda e o que é retido). */
router.post('/requests', rateLimitAuthorizer, async (req, res) => {
  try {
    const { type, customerId, justification } = req.body ?? {};
    if (type !== 'EXPORT' && type !== 'ANONYMIZE') return res.status(400).json({ success: false, error: 'Tipo de pedido inválido (EXPORT ou ANONYMIZE).', code: 'REQUEST_TYPE_INVALID' });
    if (type === 'EXPORT') {
      if (!(await confirmPassword(req, res))) return undefined;
      const data = await requestExport(actorOf(req), customerId, justification);
      await audit(req, AuditAction.READ, data.id, { operation: 'PRIVACY_EXPORT_CREATED', subjectId: data.subjectId });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({ success: true, data });
    }
    const data = await requestAnonymization(actorOf(req), customerId, justification);
    await audit(req, AuditAction.CREATE, data.id, { operation: 'PRIVACY_ANONYMIZATION_PLANNED', subjectId: data.subjectId });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

/** Executa a anonimização planejada (irreversível): exige a senha do administrador. */
router.post('/requests/:id/execute', rateLimitAuthorizer, async (req, res) => {
  try {
    if (!(await confirmPassword(req, res))) return undefined;
    const data = await executeAnonymization(actorOf(req), req.params.id);
    await audit(req, AuditAction.UPDATE, data.id, { operation: 'PRIVACY_ANONYMIZATION_EXECUTED', subjectId: data.subjectId, status: data.status, retainedUntil: data.retainedUntil });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

/** Entrega o JSON da exportação (validade e número de downloads limitados; nunca em cache nem em disco). */
router.get('/requests/:id/download', async (req, res) => {
  try {
    const file = await downloadExport(actorOf(req), req.params.id);
    await audit(req, AuditAction.READ, req.params.id, { operation: 'PRIVACY_EXPORT_DOWNLOADED' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Content-SHA256', file.sha256);
    return res.send(file.content);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
