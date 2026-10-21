import { Request, Response, NextFunction } from 'express';

// Filtros de período usados em toda a API (vendas, financeiro, dashboard, auditoria, observabilidade). Os handlers
// fazem `new Date(req.query.startDate)` e passam ao Prisma: um valor inválido ("abc", "2026-13-45") virava
// PrismaClientValidationError e a resposta era 500 "Erro interno" em 13 rotas. Validado numa camada só (como o
// clampPaginationLimit) para uma rota nova não esquecer.
const DATE_QUERY_PARAMS = ['startDate', 'endDate'] as const;

export function rejectInvalidDateQuery(req: Request, res: Response, next: NextFunction) {
  for (const name of DATE_QUERY_PARAMS) {
    const value = req.query[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
      return res.status(400).json({ success: false, error: `Data inválida no filtro "${name}". Use o formato AAAA-MM-DD.` });
    }
  }
  return next();
}
