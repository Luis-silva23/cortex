import { MODULE_DISABLED_MESSAGE, canAccessPath, getActiveHref, isRoleRestrictedPath, moduleForPath } from './navigation';

const HREFS = [
  '/dashboard',
  '/dashboard/products',
  '/dashboard/quotes',
  '/dashboard/service-orders',
  '/dashboard/settings',
];

describe('getActiveHref', () => {
  it('o Dashboard só fica ativo em /dashboard (antes acendia em todas as telas)', () => {
    expect(getActiveHref('/dashboard', HREFS)).toBe('/dashboard');
    expect(getActiveHref('/dashboard/quotes', HREFS)).toBe('/dashboard/quotes');
  });

  it('/dashboard/quotes/new é do fluxo de Orçamentos, não do Dashboard', () => {
    expect(getActiveHref('/dashboard/quotes/new', HREFS)).toBe('/dashboard/quotes');
  });

  it('subcaminhos com id e telas aninhadas ativam o item da seção', () => {
    expect(getActiveHref('/dashboard/quotes/abc-123', HREFS)).toBe('/dashboard/quotes');
    expect(getActiveHref('/dashboard/quotes/abc-123/versions/new', HREFS)).toBe('/dashboard/quotes');
    expect(getActiveHref('/dashboard/service-orders/xyz', HREFS)).toBe('/dashboard/service-orders');
  });

  it('não confunde prefixos que não são subcaminho (products x products-old)', () => {
    expect(getActiveHref('/dashboard/products-old', HREFS)).toBe('/dashboard');
  });

  it('barra final é ignorada', () => {
    expect(getActiveHref('/dashboard/settings/', HREFS)).toBe('/dashboard/settings');
    expect(getActiveHref('/dashboard/', HREFS)).toBe('/dashboard');
  });

  it('o item mais específico vence, qualquer que seja a ordem da lista', () => {
    expect(getActiveHref('/dashboard/quotes/new', [...HREFS].reverse())).toBe('/dashboard/quotes');
  });

  it('fora do menu não acende nada', () => {
    expect(getActiveHref('/login', HREFS)).toBeNull();
    expect(getActiveHref('/', HREFS)).toBeNull();
  });
});

describe('moduleForPath — a qual módulo pertence a tela (menu e bloqueio da URL direta usam a mesma regra)', () => {
  it.each([
    ['/dashboard/sales', 'VENDAS'],
    ['/dashboard/sales/abc', 'VENDAS'],
    ['/dashboard/discounts', 'VENDAS'],
    ['/dashboard/purchases/new', 'COMPRAS'],
    ['/dashboard/inventory', 'ESTOQUE'],
    ['/dashboard/damage', 'ESTOQUE'],
    ['/dashboard/fiscal', 'FISCAL'],
    ['/dashboard/financial', 'FINANCEIRO'],
    ['/dashboard/service-orders/123', 'OFICINA'],
    ['/dashboard/quotes/new', 'OFICINA'],
    ['/dashboard/mechanics', 'OFICINA'],
    ['/dashboard/post-sale', 'POS_VENDA'],
  ])('%s -> %s', (path, module) => {
    expect(moduleForPath(path)).toBe(module);
  });

  it.each(['/dashboard', '/dashboard/products', '/dashboard/customers', '/dashboard/settings', '/dashboard/sales-report-x'])(
    '%s não pertence a módulo desligável',
    (path) => {
      expect(moduleForPath(path)).toBeNull();
    }
  );
});

describe('canAccessPath — papel por tela (menu e URL digitada usam a mesma regra)', () => {
  it.each(['/dashboard/sales', '/dashboard/purchases/new', '/dashboard/fiscal', '/dashboard/financial'])('mecânico não acessa %s', (p) => {
    expect(isRoleRestrictedPath(p)).toBe(true);
    expect(canAccessPath(p, 'MECHANIC')).toBe(false);
    expect(canAccessPath(p, 'OPERATOR')).toBe(true);
  });

  it('conciliação (inconsistências de integração) só gerência+, dentro do módulo Financeiro', () => {
    expect(canAccessPath('/dashboard/financial/reconciliation', 'OPERATOR')).toBe(false);
    expect(canAccessPath('/dashboard/financial/reconciliation', 'MANAGER')).toBe(true);
    expect(canAccessPath('/dashboard/financial', 'OPERATOR')).toBe(true);
    expect(moduleForPath('/dashboard/financial/reconciliation')).toBe('FINANCEIRO');
  });

  it('descontos só gerência+; usuários só administradores', () => {
    expect(canAccessPath('/dashboard/discounts', 'OPERATOR')).toBe(false);
    expect(canAccessPath('/dashboard/discounts', 'MANAGER')).toBe(true);
    expect(canAccessPath('/dashboard/users', 'MANAGER')).toBe(false);
    expect(canAccessPath('/dashboard/users', 'COMPANY_ADMIN')).toBe(true);
  });

  it('telas sem restrição de papel e papel ainda não lido não bloqueiam', () => {
    expect(isRoleRestrictedPath('/dashboard/service-orders')).toBe(false);
    expect(canAccessPath('/dashboard/service-orders', 'MECHANIC')).toBe(true);
    expect(canAccessPath('/dashboard/financial', null)).toBe(true);
  });
});

it('texto de módulo desativado é exatamente o exigido pelo produto', () => {
  expect(MODULE_DISABLED_MESSAGE).toBe('Módulo desativado para esta filial ou empresa. Favor entrar em contato com o administrador.');
});
