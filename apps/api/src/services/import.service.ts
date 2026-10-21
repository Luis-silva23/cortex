import { productBarcodeService } from './product-barcode.service';
import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { isValidDocument } from '@ln-system/shared/utils/validation';
import stockService from './stock.service';
import { buildProductUpdate, normalizeCustomerRow, normalizeProductRow, normalizeStockRow } from './import-normalizers';

/**
 * Importação em lote (produtos, clientes, estoque) com rastreabilidade:
 * - cada importação vira um LOTE (import_batches) com o resultado de CADA linha: criada, atualizada, sem alteração ou
 *   erro com o motivo — uma linha ruim não derruba as boas, mas nada fica "parcialmente importado" sem registro;
 * - cada linha roda na SUA transação (produto + estoque inicial juntos; antes o produto podia ficar criado com a
 *   linha reportada como erro);
 * - `dryRun`: mesma lógica numa transação desfeita no fim — devolve o que aconteceria, sem gravar e sem lote;
 * - duplicidade DENTRO da planilha é recusada (SKU / CPF-CNPJ / produto repetido) apontando a primeira linha;
 * - CPF/CNPJ comparado só pelos dígitos (com ou sem máscara) e com dígito verificador válido;
 * - movimentos de estoque apontam para o lote (referenceType 'ImportBatch').
 * Linhas numeradas como na PLANILHA (cabeçalho = linha 1, primeiro dado = linha 2).
 */
export const IMPORT_MAX_ROWS = 5000;
export type ImportType = 'PRODUCTS' | 'CUSTOMERS' | 'STOCK';
export type RowAction = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'ERROR';
export type RowResult = { row: number; key?: string; action: RowAction; id?: string; error?: string; warnings?: string[]; detail?: Record<string, unknown> };

class DryRunRollback extends Error {}
/** Erro de regra da linha: desfaz só a linha e vira ERROR com esta mensagem. */
class RowError extends Error {}

const sheetRow = (index: number) => index + 2;
const digits = (v: string) => v.replace(/\D/g, '');
function documentVariants(doc: string): string[] {
  const d = digits(doc);
  const out = new Set([doc.trim(), d]);
  if (d.length === 11) out.add(`${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`);
  if (d.length === 14) out.add(`${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`);
  return [...out];
}

async function runRow<T>(dryRun: boolean, fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> {
  if (!dryRun) return runInTransaction(fn);
  let result: T | undefined;
  try {
    await runInTransaction(async (tx) => {
      result = await fn(tx);
      throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return result as T;
}

/** Marca repetições dentro da planilha: devolve, por índice, a linha da primeira ocorrência (ou nada). */
function duplicates(keys: Array<string | undefined>): Map<number, number> {
  const first = new Map<string, number>();
  const dup = new Map<number, number>();
  keys.forEach((k, i) => {
    if (!k) return;
    if (first.has(k)) dup.set(i, sheetRow(first.get(k)!));
    else first.set(k, i);
  });
  return dup;
}

type Ctx = { companyId: string; branchId?: string; userId: string; dryRun: boolean; fileName?: string };

export class ImportService {
  private assertRows(rows: unknown, label: string): asserts rows is any[] {
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(`Nenhum ${label} para importar`, 400, 'EMPTY_IMPORT');
    if (rows.length > IMPORT_MAX_ROWS) {
      throw new AppError(`A planilha tem ${rows.length} linhas; o máximo por importação é ${IMPORT_MAX_ROWS}. Divida o arquivo.`, 413, 'IMPORT_TOO_LARGE');
    }
  }

  private async openBatch(ctx: Ctx, type: ImportType, totalRows: number) {
    if (ctx.dryRun) return null;
    return prisma.importBatch.create({
      data: { companyId: ctx.companyId, branchId: ctx.branchId ?? null, type, userId: ctx.userId, fileName: ctx.fileName?.slice(0, 200) ?? null, totalRows },
      select: { id: true },
    });
  }

  private async closeBatch(batchId: string | undefined, results: RowResult[]) {
    const summary = {
      importedRows: results.filter((r) => r.action === 'CREATED' || r.action === 'UPDATED').length,
      unchangedRows: results.filter((r) => r.action === 'UNCHANGED').length,
      failedRows: results.filter((r) => r.action === 'ERROR').length,
    };
    if (batchId) {
      await prisma.importBatch.update({ where: { id: batchId }, data: { ...summary, results: results as any, finishedAt: new Date() } });
    }
    return summary;
  }

  private async processRows(rows: any[], dupOf: Map<number, number>, keyOf: (i: number) => string | undefined, dupLabel: string, dryRun: boolean,
    handle: (tx: PrismaTransactionClient, raw: any, index: number) => Promise<Omit<RowResult, 'row'>>) {
    const results: RowResult[] = [];
    for (const [index, raw] of rows.entries()) {
      const row = sheetRow(index);
      if (dupOf.has(index)) {
        results.push({ row, key: keyOf(index), action: 'ERROR', error: `${dupLabel} repetido na planilha (primeira ocorrência na linha ${dupOf.get(index)})` });
        continue;
      }
      try {
        results.push({ row, ...(await runRow(dryRun, (tx) => handle(tx, raw, index))) });
      } catch (error: any) {
        results.push({ row, key: keyOf(index), action: 'ERROR', error: error instanceof RowError ? error.message : error?.message ?? 'Erro ao importar a linha' });
      }
    }
    return results;
  }

  async importProducts(rows: unknown, ctx: Ctx) {
    this.assertRows(rows, 'produto');
    const normalized = rows.map((r) => normalizeProductRow(r));
    const keyOf = (i: number) => (normalized[i].ok ? (normalized[i] as any).value.sku : rows[i]?.sku);
    const batch = await this.openBatch(ctx, 'PRODUCTS', rows.length);
    const results = await this.processRows(rows, duplicates(rows.map((_, i) => keyOf(i))), keyOf, 'SKU', ctx.dryRun, async (tx, _raw, i) => {
      const n = normalized[i];
      if (!n.ok) throw new RowError(n.error);
      const row = n.value;
      const warnings = [...row.warnings];
      const existing = await tx.product.findFirst({ where: { companyId: ctx.companyId, sku: row.sku }, select: { id: true, barcode: true } });
      if (existing) {
        const data = buildProductUpdate(row);
        if (Object.keys(data).length === 0) throw new RowError('Produto já existe e a linha não traz nenhum campo para atualizar');
        await tx.product.update({ where: { id: existing.id }, data });
        // código de barras da planilha: vira o principal e o anterior fica desativado (um código = um produto; conflito = erro da linha)
        if (row.barcode !== undefined) await productBarcodeService.syncPrimary(tx as any, ctx.companyId, existing.id, row.barcode, existing.barcode);
        return { key: row.sku, action: 'UPDATED', id: existing.id, warnings };
      }
      if (!row.name) throw new RowError('Nome é obrigatório para cadastrar um produto novo');
      if (row.salePrice === undefined) throw new RowError('Preço de venda é obrigatório para cadastrar um produto novo');
      if (row.costPrice === undefined) warnings.push('Custo não informado — produto cadastrado com custo 0');
      const initialQuantity = row.initialQuantity ?? 0;
      if (initialQuantity > 0 && !ctx.branchId) throw new RowError('Informe a filial para lançar o estoque inicial');

      let categoryId: string | null = null;
      if (row.categoryName) {
        const category =
          (await tx.category.findFirst({ where: { companyId: ctx.companyId, name: row.categoryName }, select: { id: true } })) ??
          (await tx.category.create({ data: { name: row.categoryName, companyId: ctx.companyId }, select: { id: true } }));
        categoryId = category.id;
      }
      const created = await tx.product.create({
        data: {
          name: row.name, sku: row.sku, barcode: row.barcode, description: row.description, costPrice: row.costPrice ?? 0, salePrice: row.salePrice,
          minStock: row.minStock ?? 0, maxStock: row.maxStock ?? 0, unit: row.unit || 'UN', categoryId, companyId: ctx.companyId, isActive: true,
        },
        select: { id: true },
      });
      await productBarcodeService.syncPrimary(tx as any, ctx.companyId, created.id, row.barcode, null);
      // Estoque inicial na MESMA transação do produto (saldo = ledger StockMovement).
      if (initialQuantity > 0) {
        await stockService.createMovementGuarded(tx, {
          companyId: ctx.companyId, branchId: ctx.branchId, productId: created.id, movementType: 'INVENTORY', quantity: initialQuantity,
          referenceType: 'ImportBatch', referenceId: batch?.id, notes: 'Estoque inicial via importação em lote', userId: ctx.userId,
        });
      }
      return { key: row.sku, action: 'CREATED', id: created.id, warnings };
    });
    return { batchId: batch?.id ?? null, dryRun: ctx.dryRun, results, ...(await this.closeBatch(batch?.id, results)) };
  }

  async importCustomers(rows: unknown, ctx: Ctx) {
    this.assertRows(rows, 'cliente');
    const normalized = rows.map((r) => normalizeCustomerRow(r, ctx.companyId));
    const docOf = (i: number) => {
      const n = normalized[i];
      const doc = n.ok ? n.value.document : undefined;
      return typeof doc === 'string' && digits(doc) ? digits(doc) : undefined;
    };
    const batch = await this.openBatch(ctx, 'CUSTOMERS', rows.length);
    const keyOf = (i: number) => docOf(i) ?? rows[i]?.name;
    const results = await this.processRows(rows, duplicates(rows.map((_, i) => docOf(i))), keyOf, 'CPF/CNPJ', ctx.dryRun, async (tx, _raw, i) => {
      const n = normalized[i];
      if (!n.ok) throw new RowError(n.error);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { companyId: _ignored, ...fields } = n.value;
      let existing: { id: string } | null = null;
      if (fields.document) {
        if (!isValidDocument(fields.document)) throw new RowError('CPF/CNPJ inválido (confira os dígitos)');
        // Compara pelos dígitos: "123.456.789-09" e "12345678909" são o mesmo cliente.
        existing = await tx.customer.findFirst({ where: { companyId: ctx.companyId, document: { in: documentVariants(fields.document) } }, select: { id: true } });
      }
      if (existing) {
        await tx.customer.update({ where: { id: existing.id }, data: fields });
        return { key: keyOf(i), action: 'UPDATED', id: existing.id };
      }
      if (!fields.name) throw new RowError('Nome é obrigatório para cadastrar um cliente novo');
      const created = await tx.customer.create({
        data: { ...fields, name: fields.name, customerType: fields.customerType || 'INDIVIDUAL', companyId: ctx.companyId },
        select: { id: true },
      });
      return { key: keyOf(i), action: 'CREATED', id: created.id };
    });
    return { batchId: batch?.id ?? null, dryRun: ctx.dryRun, results, ...(await this.closeBatch(batch?.id, results)) };
  }

  async importStock(rows: unknown, ctx: Ctx) {
    if (!ctx.branchId) throw new AppError('Informe a filial do ajuste de estoque', 400, 'BRANCH_REQUIRED');
    this.assertRows(rows, 'ajuste de estoque');
    const normalized = rows.map((r) => normalizeStockRow(r));
    const keyOf = (i: number) => {
      const n = normalized[i];
      return n.ok ? n.value.sku || n.value.barcode : rows[i]?.sku || rows[i]?.barcode;
    };
    const batch = await this.openBatch(ctx, 'STOCK', rows.length);
    const touched: string[] = [];
    const results = await this.processRows(rows, duplicates(rows.map((_, i) => keyOf(i))), keyOf, 'Produto', ctx.dryRun, async (tx, _raw, i) => {
      const n = normalized[i];
      if (!n.ok) throw new RowError(n.error);
      const item = n.value;
      const product =
        (item.sku ? await tx.product.findFirst({ where: { companyId: ctx.companyId, sku: item.sku }, select: { id: true, name: true, sku: true } }) : null) ??
        (item.barcode
          ? await tx.product.findFirst({
              // principal OU qualquer código ATIVO do produto (vários por produto)
              where: { companyId: ctx.companyId, OR: [{ barcode: item.barcode }, { barcodes: { some: { code: item.barcode, isActive: true } } }] },
              select: { id: true, name: true, sku: true },
            })
          : null);
      if (!product) throw new RowError('Produto não encontrado');
      const { movement, previousBalance } = await stockService.adjustStockInTx(tx, {
        companyId: ctx.companyId, branchId: ctx.branchId!, productId: product.id, newQuantity: item.quantity,
        reason: item.reason || 'Ajuste de inventário - Importação', userId: ctx.userId, referenceType: 'ImportBatch', referenceId: batch?.id,
      });
      if (movement) touched.push(product.id);
      return {
        key: keyOf(i), action: movement ? 'UPDATED' : 'UNCHANGED', id: product.id,
        detail: { product: product.name, sku: product.sku, oldQuantity: previousBalance, newQuantity: item.quantity },
      };
    });
    if (!ctx.dryRun) await Promise.all([...new Set(touched)].map((id) => stockService.invalidateStockCache(id)));
    return { batchId: batch?.id ?? null, dryRun: ctx.dryRun, results, ...(await this.closeBatch(batch?.id, results)) };
  }

  async listBatches(companyId: string, limit = 20) {
    return prisma.importBatch.findMany({
      where: { companyId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 100),
      select: { id: true, type: true, userId: true, fileName: true, totalRows: true, importedRows: true, unchangedRows: true, failedRows: true, startedAt: true, finishedAt: true, branchId: true },
    });
  }

  async getBatch(id: string, companyId: string) {
    return prisma.importBatch.findFirst({ where: { id, companyId } });
  }
}

export default new ImportService();
