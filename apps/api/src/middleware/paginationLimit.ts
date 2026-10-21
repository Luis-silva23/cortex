import { Request, Response, NextFunction } from 'express';

// ACHADO DE AUDITORIA (Agente 11 — API/Rate Limiting/Traffic Engineering):
// ~20 rotas de listagem fazem `req.query.limit ? parseInt(...) : 20` sem
// NENHUM teto — um cliente podia mandar `?limit=999999999` e esse valor
// chegava direto no `take` do Prisma. Corrigido numa única camada global
// (em vez de editar cada rota individualmente, que seria fácil de
// esquecer numa rota nova): reescreve `req.query.limit` ANTES de qualquer
// handler ler o valor, então todo `parseInt(req.query.limit as string)`
// já existente continua funcionando sem mudança, só nunca mais vê um
// número fora do intervalo seguro.
const MAX_LIMIT = 100;
const DEFAULT_WHEN_INVALID = 20;
// `page` tinha o mesmo problema sem teto nenhum: `?page=0`, `-1` ou `abc` viravam `skip` negativo/NaN no Prisma —
// 500 em OS/orçamentos/fornecedores e erro cru do Prisma (com caminho de arquivo) em clientes. Página inválida vira a
// primeira; o teto só evita um `skip` fora do inteiro de 32 bits (100 000 × 100 = 10 milhões de linhas).
const MAX_PAGE = 100_000;

export function clampPaginationLimit(req: Request, _res: Response, next: NextFunction) {
  if (req.query.limit !== undefined) {
    const parsed = parseInt(req.query.limit as string, 10);
    const clamped = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_WHEN_INVALID;
    req.query.limit = String(clamped);
  }
  if (req.query.page !== undefined) {
    const parsed = parseInt(req.query.page as string, 10);
    req.query.page = String(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : 1);
  }
  next();
}
