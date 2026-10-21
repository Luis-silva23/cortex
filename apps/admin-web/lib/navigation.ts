// Regras puras da navegação lateral do Admin Web.

// Espelha o enum SystemModule do backend (requireModuleEnabled).
export type SystemModule = 'ESTOQUE' | 'COMPRAS' | 'VENDAS' | 'FINANCEIRO' | 'FISCAL' | 'OFICINA' | 'POS_VENDA' | 'CANAIS';

// Telas que pertencem a um módulo desligável. Fonte única para o menu (esconder o item) e para a moldura
// do dashboard (URL digitada de um módulo desligado mostra "módulo desativado", não um erro genérico).
export const MODULE_ROUTES: ReadonlyArray<{ href: string; module: SystemModule }> = [
  { href: '/dashboard/sales', module: 'VENDAS' },
  { href: '/dashboard/discounts', module: 'VENDAS' },
  { href: '/dashboard/purchases', module: 'COMPRAS' },
  // Devolução ao fornecedor: /api/supplier-returns tem requireModuleEnabled('COMPRAS').
  { href: '/dashboard/purchases/returns', module: 'COMPRAS' },
  { href: '/dashboard/inventory', module: 'ESTOQUE' },
  { href: '/dashboard/damage', module: 'ESTOQUE' },
  { href: '/dashboard/fiscal', module: 'FISCAL' },
  { href: '/dashboard/financial', module: 'FINANCEIRO' },
  { href: '/dashboard/service-orders', module: 'OFICINA' },
  { href: '/dashboard/quotes', module: 'OFICINA' },
  { href: '/dashboard/mechanics', module: 'OFICINA' },
  { href: '/dashboard/post-sale', module: 'POS_VENDA' },
  // Canais de venda: o módulo CANAIS nasce desativado (a API responde 403 MODULE_DISABLED até a empresa ligar).
  { href: '/dashboard/channels', module: 'CANAIS' },
];

// Texto exigido pelo produto para módulo desativado (o mesmo da API, middleware/module.ts).
export const MODULE_DISABLED_MESSAGE = 'Módulo desativado para esta filial ou empresa. Favor entrar em contato com o administrador.';

export type UserType = 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'MANAGER' | 'OPERATOR' | 'MECHANIC' | 'VIEWER';

const NON_MECHANIC: UserType[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'];

// Telas cujo backend INTEIRO é restrito a esses papéis (denyUserTypes/requireUserType no arquivo de rotas). Fonte
// única para o menu (esconder o item) e para a moldura (URL digitada mostra "acesso restrito", não a tela com
// botões e um erro genérico). Só UX: a API continua sendo a autoridade.
export const ROLE_ROUTES: ReadonlyArray<{ href: string; roles: UserType[] }> = [
  { href: '/dashboard/sales', roles: NON_MECHANIC },
  { href: '/dashboard/purchases', roles: NON_MECHANIC },
  // Devolução ao fornecedor: API nega MECHANIC; VIEWER consulta (escrita a API recusa).
  { href: '/dashboard/purchases/returns', roles: NON_MECHANIC },
  { href: '/dashboard/fiscal', roles: NON_MECHANIC },
  { href: '/dashboard/financial', roles: NON_MECHANIC },
  // Conciliação (inconsistências de integração de pagamento): GET /payments/exceptions é de gerência+.
  { href: '/dashboard/financial/reconciliation', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] },
  { href: '/dashboard/discounts', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] },
  // Convênios (funcionário/empresa conveniada, folha): cadastro com salário e limites — API de gerência+.
  { href: '/dashboard/agreements', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] },
  { href: '/dashboard/users', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
  // Canais de venda (credenciais de integração): administração da empresa.
  { href: '/dashboard/channels', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
  // Pedidos de titular (LGPD: exportar/anonimizar dados de um cliente): só o administrador da empresa (API: /privacy, COMPANY_ADMIN).
  { href: '/dashboard/privacy', roles: ['COMPANY_ADMIN'] },
];

function roleRouteFor(pathname: string) {
  const href = getActiveHref(
    pathname,
    ROLE_ROUTES.map((r) => r.href)
  );
  return ROLE_ROUTES.find((r) => r.href === href) ?? null;
}

/** Papel conhecido e fora da lista da tela = sem acesso. Papel ainda não lido (null) não decide. */
export function canAccessPath(pathname: string, userType: string | null): boolean {
  const route = roleRouteFor(pathname);
  return !route || !userType || route.roles.includes(userType as UserType);
}

export function isRoleRestrictedPath(pathname: string): boolean {
  return roleRouteFor(pathname) !== null;
}

export function moduleForPath(pathname: string): SystemModule | null {
  const href = getActiveHref(
    pathname,
    MODULE_ROUTES.map((r) => r.href)
  );
  return MODULE_ROUTES.find((r) => r.href === href)?.module ?? null;
}

// Qual item do menu representa a página atual: o de href MAIS ESPECÍFICO que
// case (igual ao caminho ou prefixo de seus subcaminhos). Antes cada item era
// "ativo" se o caminho começasse com o seu href — e como o Dashboard é
// `/dashboard`, ele ficava destacado em TODAS as telas (`/dashboard/quotes/new`
// aparecia com "Dashboard" e "Orçamentos" acesos ao mesmo tempo, sugerindo que
// o fluxo de orçamento é uma tela interna do Dashboard).
//
// Recebe TODOS os hrefs do menu (inclusive os ocultos por papel/módulo): quem
// abre a URL de um módulo desabilitado não deve ver o "Dashboard" aceso por
// engano — nesse caso nenhum item visível fica ativo.
export function getActiveHref(pathname: string, hrefs: string[]): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = path === href || path.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) {
      best = href;
    }
  }
  return best;
}
