import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUS_VARIANT,
  SALE_STATUS_LABEL,
  SALE_STATUS_VARIANT,
  buildCancelPayload,
  canCancelSale,
  canRequestSaleReversal,
  emptyCancelForm,
  validateAuthorizer,
  validateReason,
} from './sales';

// Estados reais do backend (enums SaleStatus / PaymentStatus / PaymentMethod
// em packages/database/prisma/schema.prisma). A tela antiga usava
// COMPLETED — que não existe — e quebrava com qualquer venda paga.
const SALE_STATUSES = ['PENDING', 'PAID', 'PARTIALLY_PAID', 'CANCELLED', 'RETURNED'];
const PAYMENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED'];
const PAYMENT_METHODS = ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'PIX', 'BANK_TRANSFER', 'CHECK', 'VOUCHER', 'OTHER'];

describe('rótulos cobrem todo o enum do backend', () => {
  it.each(SALE_STATUSES)('status de venda %s tem rótulo e variante', (status) => {
    expect(SALE_STATUS_LABEL[status]).toBeTruthy();
    expect(SALE_STATUS_VARIANT[status]).toBeTruthy();
  });

  it.each(PAYMENT_STATUSES)('status de pagamento %s tem rótulo e variante', (status) => {
    expect(PAYMENT_STATUS_LABEL[status]).toBeTruthy();
    expect(PAYMENT_STATUS_VARIANT[status]).toBeTruthy();
  });

  it.each(PAYMENT_METHODS)('forma de pagamento %s tem rótulo', (method) => {
    expect(PAYMENT_METHOD_LABEL[method]).toBeTruthy();
  });

  it('não existe o status fantasma COMPLETED da tela antiga', () => {
    expect(SALE_STATUS_LABEL.COMPLETED).toBeUndefined();
  });

  it('cor semântica: concluída verde, cancelada vermelha, em aberto amarela, devolvida neutra', () => {
    expect(SALE_STATUS_VARIANT.PAID).toBe('success');
    expect(SALE_STATUS_VARIANT.CANCELLED).toBe('error');
    expect(SALE_STATUS_VARIANT.PENDING).toBe('warning');
    expect(SALE_STATUS_VARIANT.PARTIALLY_PAID).toBe('warning');
    expect(SALE_STATUS_VARIANT.RETURNED).toBe('secondary');
  });
});

describe('quem pode pedir o cancelamento (espelha o gate de sales.routes.ts)', () => {
  it.each(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'])('%s pode', (role) => {
    expect(canRequestSaleReversal(role)).toBe(true);
  });

  it.each(['VIEWER', 'MECHANIC', '', null, undefined])('%s não pode', (role) => {
    expect(canRequestSaleReversal(role as any)).toBe(false);
  });
});

describe('canCancelSale', () => {
  it.each(['PENDING', 'PAID', 'PARTIALLY_PAID'])('venda %s pode ser cancelada por gerente', (status) => {
    expect(canCancelSale({ status }, 'MANAGER')).toBe(true);
  });

  it.each(['CANCELLED', 'RETURNED'])('venda %s nunca (o backend recusa)', (status) => {
    expect(canCancelSale({ status }, 'MANAGER')).toBe(false);
  });

  it('VIEWER não vê o botão nem em venda paga', () => {
    expect(canCancelSale({ status: 'PAID' }, 'VIEWER')).toBe(false);
  });
});

describe('formulário de cancelamento', () => {
  it('motivo com menos de 3 caracteres (após trim) é recusado', () => {
    expect(validateReason('')).toMatch(/mínimo 3/);
    expect(validateReason('  a ')).toMatch(/mínimo 3/);
    expect(validateReason('abc')).toBeNull();
  });

  it('autorizador: ID tem de ser inteiro positivo e a senha não pode ser vazia', () => {
    expect(validateAuthorizer({ numericId: '', password: 'x' })).toMatch(/ID numérico/);
    expect(validateAuthorizer({ numericId: '12.5', password: 'x' })).toMatch(/ID numérico/);
    expect(validateAuthorizer({ numericId: '-3', password: 'x' })).toMatch(/ID numérico/);
    expect(validateAuthorizer({ numericId: '0', password: 'x' })).toMatch(/ID numérico/);
    expect(validateAuthorizer({ numericId: 'abc', password: 'x' })).toMatch(/ID numérico/);
    expect(validateAuthorizer({ numericId: '1001', password: '' })).toMatch(/senha/);
    expect(validateAuthorizer({ numericId: ' 1001 ', password: 'x' })).toBeNull();
  });

  it('payload: motivo aparado, ID numérico e MFA só quando informado', () => {
    expect(
      buildCancelPayload({ reason: '  Erro na venda ', numericId: ' 1001', password: 's3nha', mfaCode: '' })
    ).toEqual({ reason: 'Erro na venda', authorizerNumericId: 1001, authorizerPassword: 's3nha' });

    expect(
      buildCancelPayload({ reason: 'Cliente desistiu', numericId: '7', password: 'p', mfaCode: ' 123456 ' })
    ).toEqual({ reason: 'Cliente desistiu', authorizerNumericId: 7, authorizerPassword: 'p', authorizerMfaCode: '123456' });
  });

  it('a senha nunca é aparada (pode ter espaço de propósito)', () => {
    expect(buildCancelPayload({ ...emptyCancelForm, reason: 'abc', numericId: '1', password: ' s ' }).authorizerPassword).toBe(' s ');
  });
});
