// Regras puras das telas de cadastro do Admin Web (produtos, clientes,
// fornecedores e motos). Ficam fora dos componentes para poderem ser testadas
// sem renderizar React (o jest do admin-web só cobre lib/**).
//
// O gate de "quem pode editar" (PUT/DELETE de customers e POST/PUT/DELETE de
// suppliers/products/motorcycles exigem Gerência+) é `isManagerOrAbove` de
// lib/role-gates.ts — não duplicado aqui.

// `kilometerReading` é Decimal(10,1) no Prisma e a API serializa Decimal como
// STRING ("12000.0"). String#toLocaleString ignora a localidade, então a tela
// mostrava "12000.0 km" em vez de "12.000 km". Converte antes de formatar.
export function formatKilometers(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  const km = Number(value);
  if (!Number.isFinite(km)) return '-';
  return `${km.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
}

// Colunas opcionais (ex.: Product.maxStock é Int?) chegam como null — chamar
// `.toString()` direto estourava TypeError ao abrir a edição do produto.
export function numberToInput(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

// O produto não tem coluna `status`: o real é o boolean `isActive`. O select
// da tela continua com ACTIVE/INACTIVE, então convertemos nos dois sentidos.
export type ProductStatus = 'ACTIVE' | 'INACTIVE';

export function statusFromIsActive(isActive: boolean | null | undefined): ProductStatus {
  return isActive === false ? 'INACTIVE' : 'ACTIVE';
}

export interface ProductFormFields {
  name: string;
  sku: string;
  barcode: string;
  description: string;
  brand: string;
  application: string;
  location: string;
  costPrice: string;
  salePrice: string;
  minStock: string;
  maxStock: string;
  unit: string;
  categoryId: string;
}

export interface ProductEditFormFields extends ProductFormFields {
  status: string;
}

// maxStock é Int? no banco e a tela de estoque mostra null como "—". Mandar 0
// para "vazio" gravaria um máximo falso de 0, e mandar NaN (parseFloat('')) vira
// null no JSON e reprova o schema (`z.number().optional()` não aceita null).
// Vazio = campo omitido.
function optionalStock(raw: string): { maxStock?: number } {
  return raw.trim() === '' ? {} : { maxStock: parseFloat(raw) };
}

// POST /products. `categoryId: ''` chegava ao Prisma como string vazia e
// violava a FK de Category (400) — sem categoria escolhida o campo é omitido.
export function buildProductCreatePayload(form: ProductFormFields) {
  const { costPrice, salePrice, minStock, maxStock, categoryId, ...rest } = form;
  return {
    ...rest,
    costPrice: parseFloat(costPrice),
    salePrice: parseFloat(salePrice),
    minStock: parseFloat(minStock || '0'),
    ...optionalStock(maxStock),
    ...(categoryId ? { categoryId } : {}),
  };
}

// PUT /products/:id. `status` é só do formulário (a API não conhece esse campo):
// vira `isActive`. `categoryId: null` remove a categoria (vazio nunca vai como '').
// Na EDIÇÃO, maxStock vazio LIMPA o campo (null): omitir significaria "não mexer",
// e quem apaga o máximo 100 e salva continuaria com 100 (a API aceita null aqui).
// Os textos opcionais vazios ('') também limpam (updateProductSchema → null).
export function buildProductUpdatePayload(form: ProductEditFormFields) {
  const { status, costPrice, salePrice, minStock, maxStock, categoryId, ...rest } = form;
  return {
    ...rest,
    costPrice: parseFloat(costPrice),
    salePrice: parseFloat(salePrice),
    minStock: parseFloat(minStock || '0'),
    maxStock: maxStock.trim() === '' ? null : parseFloat(maxStock),
    categoryId: categoryId || null,
    isActive: status === 'ACTIVE',
  };
}

export interface SupplierFormFields {
  name: string;
  document: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
}

// PUT /suppliers/:id. `updateSupplierSchema` é o schema de criação em .partial():
// `email` usa `.email()`, que reprova '' — só vai quando preenchido. Os demais
// textos aceitam '' e o Prisma grava o valor recebido, então enviar '' é o que
// permite LIMPAR o campo (undefined significaria "não mexer").
export function buildSupplierUpdatePayload(form: SupplierFormFields) {
  const email = form.email.trim();
  return {
    name: form.name.trim(),
    document: form.document.trim(),
    ...(email !== '' ? { email } : {}),
    phone: form.phone.trim(),
    address: form.address.trim(),
    city: form.city.trim(),
    state: form.state.trim(),
    zipCode: form.zipCode.trim(),
  };
}
