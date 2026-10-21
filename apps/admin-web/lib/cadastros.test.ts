import {
  buildProductCreatePayload,
  buildProductUpdatePayload,
  buildSupplierUpdatePayload,
  formatKilometers,
  numberToInput,
  statusFromIsActive,
  ProductFormFields,
} from './cadastros';
import { productSchema, updateProductSchema, updateSupplierSchema } from '@ln-system/shared/src/validators/pdv.validators';

const baseProduct: ProductFormFields = {
  name: 'Pastilha de freio',
  sku: 'PF-001',
  barcode: '',
  description: '',
  brand: 'Fras-le',
  application: 'CG 160',
  location: '',
  costPrice: '10.5',
  salePrice: '19.9',
  minStock: '',
  maxStock: '',
  unit: 'UN',
  categoryId: '',
};

describe('formatKilometers', () => {
  it('formata o Decimal serializado como string pela API', () => {
    expect(formatKilometers('12000.0')).toBe('12.000 km');
    expect(formatKilometers('0.0')).toBe('0 km');
  });

  it('mantém a casa decimal quando existe', () => {
    expect(formatKilometers('12000.5')).toBe('12.000,5 km');
  });

  it('aceita number', () => {
    expect(formatKilometers(1234567)).toBe('1.234.567 km');
  });

  it('trata null/undefined/vazio/lixo sem quebrar', () => {
    expect(formatKilometers(null)).toBe('-');
    expect(formatKilometers(undefined)).toBe('-');
    expect(formatKilometers('')).toBe('-');
    expect(formatKilometers('abc')).toBe('-');
  });
});

describe('numberToInput / statusFromIsActive', () => {
  it('numberToInput é null-safe (Product.maxStock é Int?)', () => {
    expect(numberToInput(null)).toBe('');
    expect(numberToInput(undefined)).toBe('');
    expect(numberToInput(0)).toBe('0');
    expect(numberToInput('10.50')).toBe('10.50');
  });

  it('statusFromIsActive lê o boolean real do produto', () => {
    expect(statusFromIsActive(true)).toBe('ACTIVE');
    expect(statusFromIsActive(false)).toBe('INACTIVE');
    // sem o campo (resposta antiga/parcial) não desativa por engano
    expect(statusFromIsActive(undefined)).toBe('ACTIVE');
    expect(statusFromIsActive(null)).toBe('ACTIVE');
  });
});

describe('buildProductCreatePayload', () => {
  it('omite categoryId quando nenhuma categoria foi escolhida (FK não aceita string vazia)', () => {
    const payload = buildProductCreatePayload(baseProduct);
    expect(payload).not.toHaveProperty('categoryId');
  });

  it('envia categoryId quando escolhida', () => {
    expect(buildProductCreatePayload({ ...baseProduct, categoryId: 'cat-1' })).toHaveProperty('categoryId', 'cat-1');
  });

  it('converte números e não fabrica maxStock quando vazio', () => {
    const payload = buildProductCreatePayload(baseProduct);
    expect(payload.costPrice).toBe(10.5);
    expect(payload.salePrice).toBe(19.9);
    expect(payload.minStock).toBe(0);
    expect(payload).not.toHaveProperty('maxStock');
  });

  it('envia maxStock quando preenchido', () => {
    expect(buildProductCreatePayload({ ...baseProduct, minStock: '2', maxStock: '50' })).toMatchObject({
      minStock: 2,
      maxStock: 50,
    });
  });
});

describe('buildProductUpdatePayload', () => {
  const edit = { ...baseProduct, status: 'ACTIVE' };

  it('converte o status do formulário em isActive e não vaza `status` para a API', () => {
    const active = buildProductUpdatePayload(edit);
    expect(active.isActive).toBe(true);
    expect(active).not.toHaveProperty('status');
    expect(buildProductUpdatePayload({ ...edit, status: 'INACTIVE' }).isActive).toBe(false);
  });

  it('sem categoria manda categoryId null (remove a categoria), nunca string vazia', () => {
    expect(buildProductUpdatePayload(edit).categoryId).toBeNull();
    expect(buildProductUpdatePayload({ ...edit, categoryId: 'cat-9' }).categoryId).toBe('cat-9');
  });

  it('maxStock vazio LIMPA o campo (null) — omitir significaria "não mexer" e o valor antigo continuaria', () => {
    const payload = buildProductUpdatePayload(edit);
    expect(payload.maxStock).toBeNull();
    expect(Object.values(payload).some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(false);
  });

  it('minStock vazio vira 0 e valores preenchidos são numéricos', () => {
    expect(buildProductUpdatePayload(edit).minStock).toBe(0);
    expect(buildProductUpdatePayload({ ...edit, minStock: '3', maxStock: '9' })).toMatchObject({
      minStock: 3,
      maxStock: 9,
    });
  });
});

// Contrato com os schemas REAIS da API (packages/shared): os testes acima só
// afirmam o formato do objeto; aqui o payload é validado por quem o recebe.
describe('payloads x schemas da API (packages/shared)', () => {
  const create = { ...baseProduct, companyId: 'company-A', sku: 'SKU-1', name: 'Filtro', costPrice: '5', salePrice: '10', unit: 'UN' };

  it('criar sem categoria e sem máximo passa em productSchema (categoryId/maxStock omitidos)', () => {
    const payload = buildProductCreatePayload({ ...baseProduct, sku: 'SKU-1', name: 'Filtro', costPrice: '5', salePrice: '10', unit: 'UN' } as any);
    const parsed = productSchema.parse({ ...payload, companyId: 'company-A' });
    expect(parsed.categoryId).toBeUndefined();
    expect(parsed.maxStock).toBeUndefined();
    expect(create.sku).toBe('SKU-1');
  });

  it('editar: "sem categoria" (null), isActive e maxStock vazio (null) passam em updateProductSchema e limpam', () => {
    const payload = buildProductUpdatePayload({ ...baseProduct, sku: 'SKU-1', name: 'Filtro', costPrice: '5', salePrice: '10', unit: 'UN', status: 'INACTIVE' } as any);
    const parsed = updateProductSchema.parse(payload);
    expect(parsed.categoryId).toBeNull();
    expect(parsed.isActive).toBe(false);
    expect(parsed.maxStock).toBeNull();
  });

  it('editar: textos opcionais vazios viram null (limpam) em vez de "salvar sem mudar nada"', () => {
    const payload = buildProductUpdatePayload({ ...baseProduct, sku: 'SKU-1', name: 'Filtro', costPrice: '5', salePrice: '10', unit: 'UN', status: 'ACTIVE', barcode: '', description: '' } as any);
    const parsed = updateProductSchema.parse(payload);
    expect(parsed.barcode).toBeNull();
    expect(parsed.description).toBeNull();
  });

  it('fornecedor: o payload de edição passa em updateSupplierSchema (e-mail vazio omitido)', () => {
    const payload = buildSupplierUpdatePayload({ name: 'Dist', document: '12.345.678/0001-90', email: '', phone: '', address: '', city: '', state: '', zipCode: '' });
    expect(() => updateSupplierSchema.parse(payload)).not.toThrow();
  });
});

describe('buildSupplierUpdatePayload', () => {
  const form = {
    name: '  Distribuidora Moto  ',
    document: ' 12.345.678/0001-90 ',
    email: '',
    phone: '',
    address: 'Rua A, 10',
    city: 'São Paulo',
    state: 'SP',
    zipCode: '',
  };

  it('omite e-mail vazio (o schema reprova string vazia em .email())', () => {
    expect(buildSupplierUpdatePayload(form)).not.toHaveProperty('email');
    expect(buildSupplierUpdatePayload({ ...form, email: ' a@b.com ' })).toHaveProperty('email', 'a@b.com');
  });

  it('envia string vazia nos demais textos para permitir limpar o campo', () => {
    const payload = buildSupplierUpdatePayload(form);
    expect(payload.phone).toBe('');
    expect(payload.zipCode).toBe('');
  });

  it('apara espaços de nome e documento', () => {
    const payload = buildSupplierUpdatePayload(form);
    expect(payload.name).toBe('Distribuidora Moto');
    expect(payload.document).toBe('12.345.678/0001-90');
  });
});
