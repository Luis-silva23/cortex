import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';

/**
 * GET /discount-events?saleId=|serviceOrderId=|from=&to=&itemType=&requiredAuthorization=&limit=
 * Consulta dos descontos concedidos (relatório/auditoria — docs/CORTEX/policies/DESCONTO.md). Só leitura: a tabela é
 * append-only. Gerência+; usuário de filial vê só a própria filial (RLS + filtro explícito).
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

function parseDate(value: unknown, field: string, endOfDay = false): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const text = String(value);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) && endOfDay ? `${text}T23:59:59.999` : text);
  if (Number.isNaN(d.getTime())) throw new AppError(`${field}: data inválida`, 400, 'INVALID_DATE');
  return d;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    if (!user.companyId) throw new AppError('Empresa não identificada', 400, 'COMPANY_CONTEXT_REQUIRED');
    const q = req.query;
    const from = parseDate(q.from, 'from');
    const to = parseDate(q.to, 'to', true);
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const where: Prisma.DiscountEventWhereInput = {
      companyId: user.companyId,
      ...(user.branchId ? { branchId: user.branchId } : q.branchId ? { branchId: String(q.branchId) } : {}),
      ...(q.saleId ? { saleId: String(q.saleId) } : {}),
      ...(q.serviceOrderId ? { serviceOrderId: String(q.serviceOrderId) } : {}),
      ...(q.itemType ? { itemType: String(q.itemType) } : {}),
      ...(q.requiredAuthorization === 'true' ? { requiredAuthorization: true } : q.requiredAuthorization === 'false' ? { requiredAuthorization: false } : {}),
      ...(from || to ? { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
    };
    const events = await prisma.discountEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
    const userIds = [...new Set(events.flatMap((e) => [e.requestedBy, e.authorizedBy]).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds }, companyId: user.companyId }, select: { id: true, name: true, numericId: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return res.json({
      data: events.map((e) => ({
        ...e,
        originalAmount: Number(e.originalAmount),
        discountAmount: Number(e.discountAmount),
        discountPercent: Number(e.discountPercent),
        finalAmount: Number(e.finalAmount),
        freeLimitPercent: Number(e.freeLimitPercent),
        requestedByName: byId.get(e.requestedBy)?.name ?? null,
        authorizedByName: e.authorizedBy ? byId.get(e.authorizedBy)?.name ?? null : null,
      })),
    });
  } catch (error) {
    if (error instanceof AppError) return res.status(error.statusCode).json({ ...error.toJSON(), error: error.message });
    return next(error);
  }
});

export default router;
