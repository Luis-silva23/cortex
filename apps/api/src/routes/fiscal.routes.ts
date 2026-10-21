import { Router, Request, Response, NextFunction } from 'express';
import fiscalService from '../services/fiscal.service';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction, FiscalDocumentStatus } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('FISCAL'));
// MECHANIC (oficina) não lê documentos fiscais (chave de acesso, valores, cliente).
router.use(denyUserTypes('MECHANIC'));

// Emitir e cancelar documento fiscal são ATOS com efeito legal: VIEWER (só
// leitura) e MECHANIC (oficina) não têm por que fazê-lo — antes qualquer
// usuário do tenant podia. Mesma lista das escritas de venda (o PDV emite).
// Se o CANCELAMENTO deve ser só de gerência é decisão de produto/compliance
// (docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md); aqui só se fecha o que não tem justificativa.
const FISCAL_WRITER_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'] as const;

/**
 * GET /api/fiscal/config
 * Retorna a configuração fiscal da filial (?branchId=). Apenas
 * COMPANY_ADMIN/SUPER_ADMIN podem visualizar (contém credenciais/CSC).
 */
router.get(
  '/config',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = req.query.branchId as string;
      if (!branchId) {
        return res.status(400).json({ error: 'branchId is required' });
      }
      const config = await fiscalService.getConfig((req as any).user.companyId, branchId);
      // Nunca devolve certificatePassword/cscToken — só se estão configurados.
      return res.json(fiscalService.toPublicConfig(config));
    } catch (error: any) {
      return next(error);
    }
  }
);

/**
 * POST /api/fiscal/config
 * Cria/atualiza a configuração fiscal da filial.
 */
router.post(
  '/config',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'FiscalConfig'),
  async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      if (!body.branchId) {
        return res.status(400).json({ error: 'branchId is required' });
      }
      const config = await fiscalService.upsertConfig({
        ...body,
        companyId: (req as any).user.companyId,
      });
      return res.status(201).json(fiscalService.toPublicConfig(config));
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

/**
 * POST /api/fiscal/documents
 * Emite (tenta emitir) um documento fiscal para uma venda. Sempre cria um
 * FiscalDocument registrando a tentativa, mesmo sem provedor configurado.
 */
router.post(
  '/documents',
  requireUserType(...FISCAL_WRITER_ROLES),
  auditLog(AuditAction.CREATE, 'FiscalDocument'),
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { saleId } = req.body || {};
      // Usuário de filial emite só na própria filial (nunca a do corpo); a administração informa a filial da venda.
      const branchId = user.branchId || req.body?.branchId;
      if (!saleId || !branchId) {
        return res.status(400).json({ error: 'saleId and branchId are required' });
      }
      const document = await fiscalService.emitDocument(saleId, user.companyId, branchId);
      return res.status(201).json(document);
    } catch (error: any) {
      // 409: FISCAL_SALE_CANCELLED, FISCAL_SALE_NOT_COMPLETED, FISCAL_OPERATION_DISABLED (ConflictError do service)
      return res
        .status(typeof error?.statusCode === 'number' ? error.statusCode : 400)
        .json({ error: error.message, ...(typeof error?.statusCode === 'number' && error.code ? { code: error.code } : {}) });
    }
  }
);

/**
 * GET /api/fiscal/documents
 * Lista documentos fiscais, filtrável por status/saleId/serviceOrderId/branchId.
 */
router.get('/documents', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await fiscalService.listDocuments({
      companyId: (req as any).user.companyId,
      branchId: req.query.branchId as string,
      status: req.query.status as FiscalDocumentStatus,
      saleId: req.query.saleId as string,
      serviceOrderId: req.query.serviceOrderId as string,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });
    return res.json(result);
  } catch (error: any) {
    return next(error);
  }
});

/**
 * GET /api/fiscal/documents/:id
 */
router.get('/documents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const document = await fiscalService.getDocumentById(req.params.id, (req as any).user.companyId);
    if (!document) {
      return res.status(404).json({ error: 'Fiscal document not found' });
    }
    return res.json(document);
  } catch (error: any) {
    return next(error);
  }
});

/**
 * POST /api/fiscal/documents/:id/cancel
 */
router.post(
  '/documents/:id/cancel',
  requireUserType(...FISCAL_WRITER_ROLES),
  auditLog(AuditAction.UPDATE, 'FiscalDocument'),
  async (req: Request, res: Response) => {
    try {
      const reason = req.body?.reason;
      const document = await fiscalService.cancelDocument(req.params.id, (req as any).user.companyId, reason);
      return res.json(document);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
