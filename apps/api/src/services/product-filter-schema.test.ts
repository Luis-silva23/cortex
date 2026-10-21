/**
 * ACHADO (revisão do admin-web): a tela de produtos tem os filtros "marca" e
 * "aplicação" e os envia na query, mas `productFilterSchema` (z.object) descarta
 * chaves que não conhece — o service (`listProducts`) suporta os dois filtros,
 * só que a rota nunca os recebia e digitar uma marca não filtrava nada.
 * Além disso `isActive` era `z.boolean()`: vindo da query string ("true") o
 * schema recusava e a rota respondia 400.
 */
import { productFilterSchema } from '@ln-system/shared/src/validators/pdv.validators';

describe('productFilterSchema — filtros vindos da query string', () => {
  it('mantém brand e application (antes eram descartados)', () => {
    const parsed = productFilterSchema.parse({ brand: 'Honda', application: 'CG 160', page: 1, limit: 20 });
    expect(parsed.brand).toBe('Honda');
    expect(parsed.application).toBe('CG 160');
  });

  it('isActive "true"/"false" (string da query) vira boolean', () => {
    expect(productFilterSchema.parse({ isActive: 'true' }).isActive).toBe(true);
    expect(productFilterSchema.parse({ isActive: 'false' }).isActive).toBe(false);
  });

  it('isActive ausente continua ausente (não filtra)', () => {
    expect(productFilterSchema.parse({}).isActive).toBeUndefined();
  });

  it('isActive com valor que não é true/false continua sendo recusado', () => {
    expect(() => productFilterSchema.parse({ isActive: 'talvez' })).toThrow();
  });

  it('o que já funcionava continua: search, categoryId e paginação com defaults', () => {
    const parsed = productFilterSchema.parse({ search: 'freio', categoryId: 'c1' });
    expect(parsed).toMatchObject({ search: 'freio', categoryId: 'c1', page: 1, limit: 20 });
  });
});
