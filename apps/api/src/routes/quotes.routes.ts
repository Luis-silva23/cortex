import { Router, Request, Response, NextFunction } from 'express';
import quoteService from '../services/quote.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import { AuditAction } from '@ln-system/database';
import { routeErrorMessage } from '../utils/route-error';

const router = Router();

// `new Date('lixo')` vira Invalid Date e o Prisma responde com erro cru —
// datas/números do corpo são convertidos aqui e recusados com 400 claro.
function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value as any);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid date`);
  }
  return date;
}

function toNumber(value: unknown): number {
  if (value === undefined || value === null || value === '') return NaN;
  return Number(value);
}

// Recusa de regra com o status do service (409 conflito de estado, 404, 400) e o `code` — a tela decide a partir do
// code (ex.: OPEN_QUOTE_EXISTS mostra o orçamento existente). Erro sem status (Error comum) continua 400, como antes.
function fail(res: Response, error: any) {
  const status = typeof error?.statusCode === 'number' ? error.statusCode : 400;
  return res.status(status).json({
    error: routeErrorMessage(error),
    ...(error?.code && typeof error.code === 'string' && !/^P\d{4}$/.test(error.code) ? { code: error.code } : {}),
    ...(error?.details && typeof error.details === 'object' ? error.details : {}),
  });
}

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('OFICINA'));

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await quoteService.list({
      companyId: (req as any).user.companyId,
      branchId: req.query.branchId as string,
      customerId: req.query.customerId as string,
      status: req.query.status as string,
      overdue: req.query.overdue === 'true' || req.query.overdue === '1',
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

// Cliente voltou com o mesmo veículo: orçamentos abertos e encerrados/recusados recentes (antes de /:id).
router.get('/related', async (req: Request, res: Response) => {
  try {
    const result = await quoteService.related((req as any).user.companyId, req.query.customerId, req.query.motorcycleId);
    return res.json(result);
  } catch (error: any) {
    return fail(res, error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quote = await quoteService.getById(req.params.id, (req as any).user.companyId);
    if (!quote) {
      return res.status(404).json({ error: 'Quote not found' });
    }
    return res.json(quote);
  } catch (error: any) {
    return next(error);
  }
});

// ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel —
// inclusive VIEWER conseguia criar/versionar/enviar/decidir/converter
// qualquer orçamento (convert cria uma Ordem de Serviço de verdade). Sem
// chamador em nenhum frontend hoje (admin-web/pdv-desktop/mobile), mas a
// API já responde a qualquer requisição autenticada — exclui só o VIEWER,
// mesmo padrão de appointments/follow-ups/revisions (OPERATOR/MECHANIC
// são os atores naturais deste módulo de oficina).
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'));

router.post('/', auditLog(AuditAction.CREATE, 'Quote'), async (req: Request, res: Response) => {
  try {
    const { branchId, customerId, motorcycleId, validUntil, notes, items, confirmNew } = req.body;
    const quote = await quoteService.create({
      companyId: (req as any).user.companyId,
      branchId,
      customerId,
      motorcycleId,
      validUntil: parseOptionalDate(validUntil, 'validUntil'),
      notes,
      createdBy: (req as any).user.userId,
      items,
      // Só um `true` literal confirma a criação de um segundo orçamento em aberto para o mesmo veículo.
      confirmNew: confirmNew === true,
    });
    res.status(201).json(quote);
  } catch (error: any) {
    fail(res, error);
  }
});

// Encerramento manual em lote (seleção múltipla): { ids[], reason } → resultado por item. Nunca apaga histórico.
router.post(
  '/close',
  idempotency(),
  auditLog(AuditAction.UPDATE, 'Quote', {
    describe: (_req, body) => ({
      entityId: null,
      newValue: { action: 'CLOSE_QUOTES', reason: body?.reason, summary: body?.summary, results: body?.results },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const result = await quoteService.close({
        companyId: (req as any).user.companyId,
        ids: req.body?.ids,
        reason: req.body?.reason,
        userId: (req as any).user.userId,
      });
      res.json(result);
    } catch (error: any) {
      fail(res, error);
    }
  }
);

router.post(
  '/:id/reopen',
  idempotency(),
  auditLog(AuditAction.UPDATE, 'Quote', {
    describe: (req, body) => ({ entityId: req.params.id, newValue: { action: 'REOPEN_QUOTE', reason: req.body?.reason, status: body?.status } }),
  }),
  async (req: Request, res: Response) => {
    try {
      const quote = await quoteService.reopen(req.params.id, (req as any).user.companyId, {
        reason: req.body?.reason,
        userId: (req as any).user.userId,
      });
      res.json(quote);
    } catch (error: any) {
      fail(res, error);
    }
  }
);

router.post('/:id/versions', auditLog(AuditAction.UPDATE, 'Quote'), async (req: Request, res: Response) => {
  try {
    const { validUntil, notes, items } = req.body;
    const version = await quoteService.addVersion(req.params.id, (req as any).user.companyId, {
      validUntil: parseOptionalDate(validUntil, 'validUntil'),
      notes,
      createdBy: (req as any).user.userId,
      items,
    });
    res.status(201).json(version);
  } catch (error: any) {
    fail(res, error);
  }
});

router.post('/:id/send', auditLog(AuditAction.UPDATE, 'Quote'), async (req: Request, res: Response) => {
  try {
    const { versionNumber } = req.body;
    const version = await quoteService.send(req.params.id, (req as any).user.companyId, toNumber(versionNumber));
    res.json(version);
  } catch (error: any) {
    fail(res, error);
  }
});

router.post('/:id/decide', auditLog(AuditAction.UPDATE, 'Quote'), async (req: Request, res: Response) => {
  try {
    const { versionNumber, approved, decisionNotes } = req.body;
    const version = await quoteService.decide(req.params.id, (req as any).user.companyId, {
      versionNumber: toNumber(versionNumber),
      approved,
      decidedBy: (req as any).user.userId,
      decisionNotes,
    });
    res.json(version);
  } catch (error: any) {
    fail(res, error);
  }
});

router.post('/:id/convert', auditLog(AuditAction.UPDATE, 'Quote'), async (req: Request, res: Response) => {
  try {
    const { branchId, entryKilometer, fuelLevel, visibleDamages, personalItems, entryNotes } = req.body;
    const serviceOrder = await quoteService.convertToServiceOrder(req.params.id, (req as any).user.companyId, {
      branchId,
      entryKilometer: toNumber(entryKilometer),
      userId: (req as any).user.userId,
      fuelLevel,
      visibleDamages,
      personalItems,
      entryNotes,
    });
    res.status(201).json(serviceOrder);
  } catch (error: any) {
    fail(res, error);
  }
});

export default router;
