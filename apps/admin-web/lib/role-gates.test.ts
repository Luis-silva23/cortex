import { canImportData, canRegisterCustomer, isCompanyAdminOrAbove, isManagerOrAbove } from './role-gates';

describe('canImportData', () => {
  it.each(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'])('%s vê o botão (a permissão final é da API)', (role) => {
    expect(canImportData(role)).toBe(true);
  });
  it('VIEWER e papel desconhecido não veem "Importar" (a API recusa o VIEWER sempre)', () => {
    expect(canImportData('VIEWER')).toBe(false);
    expect(canImportData(null)).toBe(false);
    expect(canImportData(undefined)).toBe(false);
  });
});

describe('canRegisterCustomer', () => {
  it.each(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'])('%s cadastra cliente e moto', (role) => {
    expect(canRegisterCustomer(role)).toBe(true);
  });
  it('VIEWER e papel desconhecido não veem o botão (a API responderia 403)', () => {
    expect(canRegisterCustomer('VIEWER')).toBe(false);
    expect(canRegisterCustomer(null)).toBe(false);
  });
});

describe('isManagerOrAbove', () => {
  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('%s vê as ações gerenciais', (role) => {
    expect(isManagerOrAbove(role)).toBe(true);
  });

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])('%s não vê (a API responderia 403)', (role) => {
    expect(isManagerOrAbove(role)).toBe(false);
  });

  it('papel desconhecido ou ausente esconde a ação', () => {
    expect(isManagerOrAbove(null)).toBe(false);
    expect(isManagerOrAbove(undefined)).toBe(false);
    expect(isManagerOrAbove('')).toBe(false);
    expect(isManagerOrAbove('OUTRO')).toBe(false);
  });
});

describe('isCompanyAdminOrAbove', () => {
  it('só administradores enxergam a configuração fiscal', () => {
    expect(isCompanyAdminOrAbove('COMPANY_ADMIN')).toBe(true);
    expect(isCompanyAdminOrAbove('SUPER_ADMIN')).toBe(true);
    expect(isCompanyAdminOrAbove('MANAGER')).toBe(false);
    expect(isCompanyAdminOrAbove('OPERATOR')).toBe(false);
    expect(isCompanyAdminOrAbove(null)).toBe(false);
  });
});
