import { fieldFor, formatPolicyValue, parsePolicyInput } from './policies';

describe('apresentação das políticas', () => {
  it.each([
    ['discount.productFreePercent', 5, '5%'],
    ['discount.serviceFreePercent', 0, '0%'],
    ['quote.expirationDays', 5, '5 dias'],
    ['agenda.maxPerSlot', null, 'Sem limite'],
    ['warranty.defaultKmLimit', 3000, '3.000 km'],
    ['cash.blockCloseWithOpenSales', true, 'Sim'],
    ['discount.authorizerRoles', ['MANAGER', 'COMPANY_ADMIN'], 'Gerente, Administrador'],
    ['collection.channels', ['WHATSAPP'], 'WhatsApp'],
    ['warranty.defaultDurationUnit', 'MONTHS', 'Meses'],
    ['employeeAgreement.limitType', 'SALARY_PERCENT', 'Percentual do salário por mês'],
    ['fiscal.enabledOperations', [], 'Nenhum'],
  ])('%s = %p aparece como "%s"', (key, value, expected) => {
    expect(formatPolicyValue(key, value)).toBe(expected);
  });

  it('número aceita vírgula decimal, milhar brasileiro e ponto decimal', () => {
    const f = fieldFor('discount.productFreePercent', 5);
    expect(parsePolicyInput(f, '7,5')).toEqual({ value: 7.5 });
    expect(parsePolicyInput(f, '5.5')).toEqual({ value: 5.5 });
    expect(parsePolicyInput(fieldFor('employeeAgreement.limitValue', 0), '1.234,56')).toEqual({ value: 1234.56 });
    expect(parsePolicyInput(f, 'abc')).toEqual({ error: 'Informe um número' });
    expect(parsePolicyInput(f, '')).toEqual({ error: 'Informe um número' });
  });

  it('campo que admite "sem limite" vira null quando vazio; inteiro recusa fração', () => {
    expect(parsePolicyInput(fieldFor('agenda.maxPerSlot', null), '')).toEqual({ value: null });
    expect(parsePolicyInput(fieldFor('quote.expirationDays', 5), '2,5')).toEqual({ error: 'Use um número inteiro' });
  });

  it('chave nova sem configuração de tela é deduzida pelo padrão', () => {
    expect(fieldFor('x.novo', true)).toEqual({ kind: 'boolean' });
    expect(fieldFor('x.limite', null)).toEqual({ kind: 'number', nullable: true });
  });
});
