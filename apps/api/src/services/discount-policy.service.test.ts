/**
 * Política de desconto (docs/CORTEX/policies/DESCONTO.md): limite livre POR TIPO sobre o subtotal do tipo, combinação
 * com a DiscountRule do papel (só restringe mais), e o 409 com os dados para o PDV/Admin pedirem o autorizador.
 */
const effectiveMock = jest.fn();
jest.mock('./policy.service', () => ({ policyService: { effective: (...a: any[]) => effectiveMock(...a) } }));
const checkSaleDiscountMock = jest.fn();
jest.mock('./discount.service', () => ({ checkSaleDiscount: (...a: any[]) => checkSaleDiscountMock(...a) }));
const verifyMock = jest.fn();
jest.mock('./dual-authorization.service', () => ({ verifyDualAuthorization: (...a: any[]) => verifyMock(...a) }));

import { evaluateDiscount, authorizeDiscount, DiscountAuthorizationRequiredError } from './discount-policy.service';

const DEFAULTS = { 'discount.productFreePercent': 5, 'discount.serviceFreePercent': 0, 'discount.authorizerRoles': ['MANAGER', 'COMPANY_ADMIN'] };
const base = { companyId: 'co', branchId: 'br', userType: 'OPERATOR' };

describe('evaluateDiscount', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    effectiveMock.mockResolvedValue(DEFAULTS);
    checkSaleDiscountMock.mockResolvedValue({ allowed: true, requiresApproval: false });
  });

  it('peças até 5% do subtotal de peças: livre', async () => {
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 200, discount: 10 } } });
    expect(r.requiresAuthorization).toBe(false);
    expect(r.requestedPercent.PRODUCT).toBe(5);
  });

  it('meio centavo de tolerância: 5% de R$ 33,33 arredondado para R$ 1,67 é livre', async () => {
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 33.33, discount: 1.67 } } });
    expect(r.requiresAuthorization).toBe(false);
  });

  it('peças acima de 5%: exige autorização (PRODUCT, limite 5)', async () => {
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 100, discount: 5.01 } } });
    expect(r.requiresAuthorization).toBe(true);
    expect(r.violations[0]).toMatchObject({ itemType: 'PRODUCT', freeLimitPercent: 5, source: 'POLICY' });
  });

  it('qualquer desconto em serviço exige autorização (limite 0%), mesmo com peças dentro do limite', async () => {
    const r = await evaluateDiscount({
      ...base,
      productItemType: 'PART',
      buckets: { PRODUCT: { subtotal: 100, discount: 5 }, SERVICE: { subtotal: 300, discount: 1 } },
    });
    expect(r.bucketsOverLimit).toEqual(['SERVICE']);
    expect(r.violations).toEqual([expect.objectContaining({ itemType: 'SERVICE', freeLimitPercent: 0 })]);
  });

  it('o limite de cada tipo usa o subtotal DO TIPO (serviço não "cabe" nos 5% das peças)', async () => {
    // 4% do total geral (20 de 500), mas 20 de 100 em peças = 20% → exige autorização
    const r = await evaluateDiscount({ ...base, productItemType: 'PART', buckets: { PRODUCT: { subtotal: 100, discount: 20 }, SERVICE: { subtotal: 400, discount: 0 } } });
    expect(r.bucketsOverLimit).toEqual(['PRODUCT']);
    expect(r.violations[0]).toMatchObject({ itemType: 'PART', requestedPercent: 20 });
  });

  it('limite da filial (política) é respeitado', async () => {
    effectiveMock.mockResolvedValueOnce({ ...DEFAULTS, 'discount.productFreePercent': 12 });
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 100, discount: 10 } } });
    expect(r.requiresAuthorization).toBe(false);
    expect(effectiveMock).toHaveBeenCalledWith('co', 'br');
  });

  it('DiscountRule do papel restringe mais: dentro da política, mas acima da regra com aprovação → exige autorização', async () => {
    checkSaleDiscountMock.mockResolvedValueOnce({ allowed: false, requiresApproval: true, rule: { id: 'r', name: 'Operador 2%', maxDiscount: 2 } });
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 100, discount: 4 } } });
    expect(r.requiresAuthorization).toBe(true);
    expect(r.violations[0]).toMatchObject({ source: 'DISCOUNT_RULE', freeLimitPercent: 2 });
  });

  it('DiscountRule sem aprovação excedida → recusa definitiva (409 DISCOUNT_LIMIT_EXCEEDED), nem com autorizador', async () => {
    checkSaleDiscountMock.mockResolvedValueOnce({ allowed: false, requiresApproval: false, rule: { id: 'r', name: 'Operador 2%', maxDiscount: 2 } });
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 100, discount: 4 } } });
    await expect(authorizeDiscount(r, { companyId: 'co', requesterId: 'u1', authorizerNumericId: 1, authorizerPassword: 'x', reason: 'motivo ok', actionEvent: 'T' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DISCOUNT_LIMIT_EXCEEDED',
    });
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe('authorizeDiscount', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    effectiveMock.mockResolvedValue(DEFAULTS);
    checkSaleDiscountMock.mockResolvedValue({ allowed: true, requiresApproval: false });
  });
  const over = () => evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 100, discount: 10 } } });

  it('sem credenciais: 409 DISCOUNT_AUTHORIZATION_REQUIRED com limite livre, percentual pedido e tipo', async () => {
    const error = await authorizeDiscount(await over(), { companyId: 'co', requesterId: 'u1', actionEvent: 'T' }).catch((e) => e);
    expect(error).toBeInstanceOf(DiscountAuthorizationRequiredError);
    expect(error.statusCode).toBe(409);
    expect(error.toJSON()).toMatchObject({ code: 'DISCOUNT_AUTHORIZATION_REQUIRED', details: { freeLimitPercent: 5, requestedPercent: 10, itemType: 'PRODUCT' } });
  });

  it('com credenciais mas sem motivo: 400 DISCOUNT_REASON_REQUIRED, autorizador nem é consultado', async () => {
    await expect(authorizeDiscount(await over(), { companyId: 'co', requesterId: 'u1', authorizerNumericId: 5, authorizerPassword: 'x', reason: ' ', actionEvent: 'T' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'DISCOUNT_REASON_REQUIRED',
    });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('com credenciais e motivo: confere o autorizador com os perfis da política (solicitante ≠ autorizador fica no verifyDualAuthorization)', async () => {
    verifyMock.mockResolvedValueOnce({ id: 'mgr', name: 'Gerente' });
    const who = await authorizeDiscount(await over(), { companyId: 'co', requesterId: 'u1', authorizerNumericId: 5, authorizerPassword: 'x', reason: 'cliente fiel', actionEvent: 'SALE_DISCOUNT' });
    expect(who).toEqual({ id: 'mgr', name: 'Gerente' });
    expect(verifyMock).toHaveBeenCalledWith(expect.objectContaining({ requesterId: 'u1', allowedRoles: ['MANAGER', 'COMPANY_ADMIN'], actionEvent: 'SALE_DISCOUNT' }));
  });

  it('dentro do limite: não pede nada', async () => {
    const r = await evaluateDiscount({ ...base, buckets: { PRODUCT: { subtotal: 100, discount: 3 } } });
    await expect(authorizeDiscount(r, { companyId: 'co', requesterId: 'u1', actionEvent: 'T' })).resolves.toBeNull();
  });
});
