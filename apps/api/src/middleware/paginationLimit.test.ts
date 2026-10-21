import { clampPaginationLimit } from './paginationLimit';

function mockReq(limit?: string) {
  return { query: limit === undefined ? {} : { limit } } as any;
}
const next = jest.fn();

describe('clampPaginationLimit', () => {
  beforeEach(() => next.mockClear());

  it('não mexe quando limit não foi informado', () => {
    const req = mockReq();
    clampPaginationLimit(req, {} as any, next);
    expect(req.query.limit).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('deixa passar um valor válido dentro do teto', () => {
    const req = mockReq('20');
    clampPaginationLimit(req, {} as any, next);
    expect(req.query.limit).toBe('20');
  });

  // REGRESSÃO (achado de auditoria — Agente 11): sem esta correção, este
  // valor chegava direto no `take` do Prisma em ~20 rotas de listagem.
  it('reduz um valor absurdamente grande para o teto (100)', () => {
    const req = mockReq('999999999');
    clampPaginationLimit(req, {} as any, next);
    expect(req.query.limit).toBe('100');
  });

  it('substitui um valor inválido (não numérico) pelo default (20)', () => {
    const req = mockReq('abc');
    clampPaginationLimit(req, {} as any, next);
    expect(req.query.limit).toBe('20');
  });

  it('substitui zero/negativo pelo default (20)', () => {
    const req = mockReq('-5');
    clampPaginationLimit(req, {} as any, next);
    expect(req.query.limit).toBe('20');
  });

  // Antes: page=0/-1/abc → skip negativo/NaN no Prisma → 500 (OS, orçamentos, fornecedores) ou erro cru do Prisma.
  it.each([
    ['0', '1'],
    ['-1', '1'],
    ['abc', '1'],
    ['3', '3'],
    ['999999999', '100000'],
  ])('page=%s vira %s', (page, expected) => {
    const req = { query: { page } } as any;
    clampPaginationLimit(req, {} as any, next);
    expect(req.query.page).toBe(expected);
  });

  it('sempre chama next()', () => {
    clampPaginationLimit(mockReq('50'), {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
