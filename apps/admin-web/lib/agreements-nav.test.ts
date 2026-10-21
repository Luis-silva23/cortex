import { canAccessPath, isRoleRestrictedPath } from './navigation';

// Convênios: cadastro com salário/limites e folha são de gerência+ (a API também recusa com 403).
describe('navegação — Convênios', () => {
  it('só gerência+ acessa /dashboard/agreements e subpáginas', () => {
    expect(isRoleRestrictedPath('/dashboard/agreements')).toBe(true);
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER']) {
      expect(canAccessPath('/dashboard/agreements/employees/abc', role)).toBe(true);
    }
    for (const role of ['OPERATOR', 'VIEWER', 'MECHANIC']) {
      expect(canAccessPath('/dashboard/agreements', role)).toBe(false);
    }
  });

  it('detalhe da conta a receber (cobrança) segue a regra do Financeiro: mecânico não entra', () => {
    expect(canAccessPath('/dashboard/financial/receivables/abc', 'MECHANIC')).toBe(false);
    expect(canAccessPath('/dashboard/financial/receivables/abc', 'MANAGER')).toBe(true);
  });
});
