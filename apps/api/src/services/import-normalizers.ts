/**
 * Normalização das linhas das importações em lote (produtos / clientes /
 * estoque) — funções puras, sem Prisma.
 *
 * ACHADOS DE AUDITORIA (importação, cada um provado por leitura do código e
 * por teste de integração com Postgres real):
 *
 * 1) PRODUTOS — a tela manda { name, price, stock, category, sku?, barcode? } e
 *    a rota lia { sku, costPrice, salePrice, categoryName, initialQuantity }.
 *    Pior: o template "básico" da tela NÃO tem coluna SKU, e a rota fazia
 *    `findFirst({ where: { companyId, sku: undefined } })` — o Prisma ignora
 *    `undefined` no where, então isso casava o PRIMEIRO produto da empresa e o
 *    UPDATE o sobrescrevia (nome trocado, minStock/maxStock/unit zerados), a
 *    cada linha do arquivo. Aqui: SKU é obrigatório (é o identificador que o
 *    modelo exige e a única chave segura para "atualizar"), e a atualização só
 *    mexe nos campos que vieram na linha — nunca aplica "padrão" em cima de um
 *    valor existente.
 * 2) ESTOQUE — a busca era `OR: [{ sku: item.sku }, { barcode: item.barcode }]`,
 *    que depende de como o Prisma trata um lado `undefined`. Testado neste
 *    ambiente: uma linha só com código de barras inexistente NÃO casava
 *    produto algum, então isto NÃO é um defeito confirmado. Mesmo assim a
 *    busca passa a ser explícita (SKU, depois código de barras) e a linha
 *    precisa de um identificador — não deixa comportamento implícito.
 * 3) CLIENTES — a tela manda `zipcode` (minúsculo) e a rota lia `zipCode`; e a
 *    rota gravava direto no Prisma, sem a normalização do cadastro normal
 *    (strings vazias, e-mail inválido).
 */

import { customerSchema } from '@ln-system/shared/src/validators/pdv.validators';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

// Excel/CSV entrega "99,90", "1.234,56" ou número. Aceita vírgula decimal.
function decimal(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'invalid';
  const raw = String(value).trim();
  if (raw === '') return undefined;
  // "1.234,56" → 1234.56 ; "99,90" → 99.90 ; "99.90" → 99.90
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

function first<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------

export interface NormalizedProductRow {
  sku: string;
  name?: string;
  description?: string;
  barcode?: string;
  unit?: string;
  categoryName?: string;
  salePrice?: number;
  costPrice?: number;
  minStock?: number;
  maxStock?: number;
  initialQuantity?: number;
  warnings: string[];
}

export function normalizeProductRow(raw: any): Result<NormalizedProductRow> {
  const row = raw && typeof raw === 'object' ? raw : {};

  const sku = text(row.sku);
  if (!sku) {
    return { ok: false, error: 'SKU é obrigatório (é ele que identifica o produto para criar ou atualizar)' };
  }

  const warnings: string[] = [];
  const out: NormalizedProductRow = { sku, warnings };

  out.name = text(row.name);
  out.description = text(row.description);
  out.barcode = text(row.barcode);
  out.unit = text(row.unit);
  out.categoryName = text(first(row.categoryName, row.category));

  const numeric = (label: string, value: unknown, { integer = false, min = 0 } = {}): number | undefined => {
    const parsed = decimal(value);
    if (parsed === undefined) return undefined;
    if (parsed === 'invalid' || parsed < min || (integer && !Number.isInteger(parsed))) {
      throw new Error(`${label} inválido (${String(value)})`);
    }
    return parsed;
  };

  try {
    // A tela chama o preço de venda de "price".
    out.salePrice = numeric('Preço de venda', first(row.salePrice, row.price));
    out.costPrice = numeric('Custo', first(row.costPrice, row.cost));
    out.minStock = numeric('Estoque mínimo', row.minStock, { integer: true });
    out.maxStock = numeric('Estoque máximo', row.maxStock, { integer: true });
  } catch (error: any) {
    return { ok: false, error: error.message };
  }

  // Estoque inicial: a tela já avisa que valor inválido "será ignorado".
  const initial = decimal(first(row.initialQuantity, row.stock, row.quantity));
  if (initial === 'invalid' || (typeof initial === 'number' && initial < 0)) {
    warnings.push(`Estoque inicial inválido (${String(first(row.initialQuantity, row.stock, row.quantity))}), ignorado`);
  } else if (typeof initial === 'number') {
    out.initialQuantity = initial;
  }

  return { ok: true, value: out };
}

// Campos que uma linha pode ALTERAR num produto existente: só os que vieram.
export function buildProductUpdate(row: NormalizedProductRow): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (row.name !== undefined) data.name = row.name;
  if (row.description !== undefined) data.description = row.description;
  if (row.barcode !== undefined) data.barcode = row.barcode;
  if (row.unit !== undefined) data.unit = row.unit;
  if (row.salePrice !== undefined) data.salePrice = row.salePrice;
  if (row.costPrice !== undefined) data.costPrice = row.costPrice;
  if (row.minStock !== undefined) data.minStock = row.minStock;
  if (row.maxStock !== undefined) data.maxStock = row.maxStock;
  return data;
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

export interface NormalizedStockRow {
  sku?: string;
  barcode?: string;
  quantity: number;
  reason?: string;
}

export function normalizeStockRow(raw: any): Result<NormalizedStockRow> {
  const row = raw && typeof raw === 'object' ? raw : {};
  const sku = text(row.sku);
  const barcode = text(row.barcode);
  if (!sku && !barcode) {
    return { ok: false, error: 'Informe SKU ou código de barras' };
  }
  const quantity = decimal(row.quantity);
  if (quantity === undefined || quantity === 'invalid' || quantity < 0) {
    return { ok: false, error: `Quantidade inválida (${String(row.quantity)})` };
  }
  return { ok: true, value: { sku, barcode, quantity, reason: text(row.reason) } };
}

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

export function normalizeCustomerRow(raw: any, companyId: string): Result<Record<string, any>> {
  const row = raw && typeof raw === 'object' ? { ...raw } : {};
  // Nomes usados pela tela / planilhas.
  if (row.zipCode === undefined && row.zipcode !== undefined) row.zipCode = row.zipcode;
  if (row.document === undefined && row.cpfCnpj !== undefined) row.document = row.cpfCnpj;
  if (row.mobile === undefined && row.cellphone !== undefined) row.mobile = row.cellphone;

  // `.partial()`: o template "atualizar" (CPF/CNPJ + telefone + e-mail) não tem
  // coluna de nome — o nome só é obrigatório para CRIAR um cliente novo, e essa
  // checagem fica na rota (que sabe se o documento já existe).
  const parsed = customerSchema.partial().safeParse({ ...row, companyId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'linha'}: ${i.message}`).join('; ') };
  }
  // Só o que veio preenchido (o schema já transforma '' em undefined).
  const value: Record<string, any> = {};
  for (const [key, val] of Object.entries(parsed.data)) {
    if (val !== undefined) value[key] = val;
  }
  return { ok: true, value };
}
