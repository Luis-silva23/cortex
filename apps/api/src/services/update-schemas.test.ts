/**
 * ACHADO (revisão do admin-web): na EDIÇÃO, esvaziar um campo "salvava com
 * sucesso" e o valor antigo continuava — o schema convertia '' em `undefined` e
 * o Prisma ignora chave `undefined`. Nas edições, '' agora significa LIMPAR
 * (null); ausente continua significando "não mexe".
 */
import { updateCustomerSchema, updateProductSchema } from '@ln-system/shared/src/validators/pdv.validators';

describe('updateCustomerSchema — limpar campos', () => {
  it("'' e só espaços viram null (limpa) nos campos opcionais", () => {
    const parsed = updateCustomerSchema.parse({ phone: '', mobile: '   ', email: '', address: '', city: '', state: '', zipCode: '', notes: '', document: '' });
    expect(parsed).toEqual({ phone: null, mobile: null, email: null, address: null, city: null, state: null, zipCode: null, notes: null, document: null });
  });

  it('campo ausente NÃO aparece (não mexe no valor gravado)', () => {
    const parsed = updateCustomerSchema.parse({ name: 'Ana' });
    expect(parsed).toEqual({ name: 'Ana' });
    expect('phone' in parsed).toBe(false);
  });

  it('texto preenchido é aparado', () => {
    expect(updateCustomerSchema.parse({ phone: '  (11) 98765-4321 ' }).phone).toBe('(11) 98765-4321');
  });

  it('e-mail preenchido continua validado; nome, se vier, não pode ser vazio', () => {
    expect(() => updateCustomerSchema.parse({ email: 'nao-e-email' })).toThrow();
    expect(() => updateCustomerSchema.parse({ name: '   ' })).toThrow();
    expect(updateCustomerSchema.parse({ email: 'ana@example.com' }).email).toBe('ana@example.com');
  });

  it('não deixa trocar o dono do registro (companyId é descartado)', () => {
    expect('companyId' in updateCustomerSchema.parse({ companyId: 'outra', name: 'Ana' })).toBe(false);
  });

  it('isActive permite REATIVAR (antes era descartado e o PUT "salvava" sem efeito); precisa ser booleano', () => {
    expect(updateCustomerSchema.parse({ isActive: true }).isActive).toBe(true);
    expect(updateCustomerSchema.parse({ isActive: false }).isActive).toBe(false);
    expect(() => updateCustomerSchema.parse({ isActive: 'sim' })).toThrow();
    expect('isActive' in updateCustomerSchema.parse({ name: 'Ana' })).toBe(false);
  });
});

describe('updateProductSchema — limpar campos opcionais', () => {
  it("'' limpa barcode/description/brand/application/location (null) e null limpa maxStock", () => {
    const parsed = updateProductSchema.parse({ barcode: '', description: ' ', brand: '', application: '', location: '', maxStock: null });
    expect(parsed).toEqual({ barcode: null, description: null, brand: null, application: null, location: null, maxStock: null });
  });

  it('maxStock numérico segue como veio; minStock continua não anulável', () => {
    expect(updateProductSchema.parse({ maxStock: 100 }).maxStock).toBe(100);
    expect(() => updateProductSchema.parse({ minStock: null })).toThrow();
  });

  it('campo ausente não aparece', () => {
    expect('barcode' in updateProductSchema.parse({ name: 'Filtro' })).toBe(false);
  });
});
