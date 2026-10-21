import { Request, Response, NextFunction } from 'express';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { isCompanyWideRole, resolveBranchScope } from '../services/branch-scope.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marca a rota como "de empresa" (dados de UMA empresa: clientes, produtos,
 * vendas, OS...). Montada em routes/index.ts antes do router de negócio.
 *
 * Sem marca (rotas de plataforma: empresas, licenças, dispositivos, backup,
 * observabilidade, auditoria, usuários, filiais, módulos) o SUPER_ADMIN segue
 * sem empresa — essas rotas tratam o alvo de forma explícita por conta própria.
 *
 * `except`: caminhos (relativos ao ponto de montagem) que continuam globais.
 */
export function companyScoped(opts: { except?: string[] } = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const exempt = (opts.except ?? []).some((p) => req.path === p || req.path.startsWith(`${p}/`));
    (req as any).companyScoped = !exempt;
    next();
  };
}

/**
 * SUPER_ADMIN em rota de empresa: o JWT dele NÃO tem empresa. Sem um alvo
 * explícito, `user.companyId` era `undefined`, o Prisma ignora `undefined` no
 * `where` e a consulta/gravação caía em "qualquer empresa" (listas misturando
 * todos os tenants, criação de registro sem dono, mensagens de erro do Prisma
 * com caminho de arquivo). Agora o alvo é obrigatório e validado: `?companyId=`
 * ou cabeçalho `X-Company-Id`, e a empresa precisa existir.
 */
async function resolveSuperAdminCompany(req: Request, res: Response, next: NextFunction) {
  const user = req.user!;
  const raw = (req.headers['x-company-id'] as string | undefined) || (req.query.companyId as string | undefined);
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({
      success: false,
      code: 'COMPANY_CONTEXT_REQUIRED',
      error: 'Super Admin precisa informar a empresa (?companyId= ou cabeçalho X-Company-Id) para operar dados de uma empresa',
    });
  }
  if (!UUID_RE.test(raw)) {
    return res.status(400).json({ success: false, code: 'INVALID_COMPANY_CONTEXT', error: 'companyId inválido' });
  }
  try {
    // `async` + `await` DENTRO do escopo: a PrismaPromise é preguiçosa e só roda quando
    // aguardada; devolvida crua ela executaria fora do contexto RLS (fail-closed → null).
    const company = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () =>
      await prisma.company.findUnique({ where: { id: raw }, select: { id: true } })
    );
    if (!company) {
      return res.status(404).json({ success: false, code: 'COMPANY_NOT_FOUND', error: 'Empresa não encontrada' });
    }
    // Só neste request: as rotas passam a enxergar a empresa-alvo como se fosse a do token.
    user.companyId = raw;
    return runWithRLSContext({ companyId: raw, userType: user.userType, branchId: null, userId: user.userId }, async () => next());
  } catch (error) {
    return next(error);
  }
}

/**
 * Middleware de isolamento multi-tenant
 * Garante que usuários só acessem dados da própria empresa
 *
 * Também popula o contexto de Row-Level Security do Postgres (ver
 * packages/database/rls-context.ts e a migration
 * 20260907200750_add_rls_company_branch_isolation) — SEMPRE a partir do
 * `req.user` já validado pelo JWT em authMiddleware, NUNCA de
 * companyId/branchId enviados pelo cliente no corpo/query/params. É essa
 * garantia (identidade vem da sessão, não da requisição) que faz o RLS
 * funcionar como camada real de defesa, e não apenas repetir o que o
 * cliente já afirmou.
 */
export async function tenantIsolation(req: Request, res: Response, next: NextFunction) {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }

  // Super Admin: rotas de plataforma sem empresa; rotas de empresa só com alvo explícito
  if (user.userType === 'SUPER_ADMIN') {
    if ((req as any).companyScoped) {
      return resolveSuperAdminCompany(req, res, next);
    }
    return runWithRLSContext(
      { companyId: null, userType: user.userType, branchId: null, userId: user.userId },
      async () => next()
    );
  }

  // Outros usuários devem ter companyId
  if (!user.companyId) {
    return res.status(403).json({
      success: false,
      error: 'Usuário não associado a uma empresa'
    });
  }

  // Empresa inteira (COMPANY_ADMIN): a RLS libera todas as filiais da própria empresa; não há lista de filiais.
  if (isCompanyWideRole(user.userType)) {
    user.branchIds = undefined;
    return runWithRLSContext(
      { companyId: user.companyId, userType: user.userType, branchId: user.branchId ?? null, userId: user.userId },
      async () => next()
    );
  }

  // Papéis de filial: o conjunto de filiais autorizadas vem dos VÍNCULOS gravados no banco (users.branchId + user_branches), recalculado a cada
  // requisição — nunca de claim do token nem de parâmetro do cliente. Remover o vínculo revoga o acesso na próxima requisição (decisão 153).
  let scope;
  try {
    scope = await resolveBranchScope(user);
  } catch {
    // Não dá para provar o escopo agora: não se aceita (nem se devolve 401/403 a quem não fez nada errado), como no authMiddleware.
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      success: false,
      error: 'Não foi possível verificar o escopo de filiais agora. Tente novamente em instantes.',
      code: 'AUTH_UNAVAILABLE',
    });
  }
  user.branchIds = scope.branchIds;
  user.branchId = scope.activeBranchId ?? undefined;
  return runWithRLSContext(
    { companyId: user.companyId, userType: user.userType, branchId: scope.activeBranchId, branchIds: scope.branchIds, userId: user.userId },
    async () => next()
  );
}

/**
 * Valida se o recurso pertence à empresa do usuário
 */
export function validateTenantAccess(resourceCompanyId?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ success: false, error: 'Não autenticado' });
    }

    // Super Admin tem acesso a tudo
    if (user.userType === 'SUPER_ADMIN') {
      return next();
    }

    // Validar se o recurso pertence à empresa do usuário
    if (resourceCompanyId && resourceCompanyId !== user.companyId) {
      return res.status(403).json({ 
        success: false, 
        error: 'Acesso negado ao recurso de outra empresa' 
      });
    }

    next();
  };
}
