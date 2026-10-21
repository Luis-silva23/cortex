import { resolveListCompanyId } from './tenant-scope';

describe('resolveListCompanyId', () => {
  it.each(['COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'])(
    '%s: vale sempre a empresa do token — ?companyId de outra empresa é ignorado',
    (userType) => {
      expect(resolveListCompanyId({ userType, companyId: 'company-B' }, 'company-A')).toBe('company-B');
      expect(resolveListCompanyId({ userType, companyId: 'company-B' }, undefined)).toBe('company-B');
    }
  );

  it('SUPER_ADMIN pode escolher a empresa pela query', () => {
    expect(resolveListCompanyId({ userType: 'SUPER_ADMIN', companyId: undefined }, 'company-A')).toBe('company-A');
  });

  it('SUPER_ADMIN sem ?companyId: usa a do token, ou nenhuma (visão de plataforma)', () => {
    expect(resolveListCompanyId({ userType: 'SUPER_ADMIN', companyId: 'company-X' }, undefined)).toBe('company-X');
    expect(resolveListCompanyId({ userType: 'SUPER_ADMIN', companyId: null }, undefined)).toBeUndefined();
  });

  it('sem usuário nunca inventa uma empresa', () => {
    expect(resolveListCompanyId(undefined, 'company-A')).toBeUndefined();
  });
});
