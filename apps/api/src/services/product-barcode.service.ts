import { prisma, runInTransaction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import cacheService from './cache.service';

/**
 * VÁRIOS CÓDIGOS DE BARRAS POR PRODUTO (tabela `product_barcodes`).
 *
 * Identidade: o produto continua sendo o `id` (UUID, estável — é o que vendas, estoque, compras e OS referenciam) e o SKU da
 * empresa. O código de barras é só um APELIDO de leitura; trocar, adicionar ou desativar códigos nunca muda a identidade nem o
 * histórico. `products.barcode` segue como código PRINCIPAL (compatibilidade com telas e integrações) e é mantido em sincronia
 * aqui: a aplicação nunca grava um sem passar por estas regras.
 *
 * Regras:
 *  - O código é TEXTO: zeros à esquerda e tamanho são preservados (nada de conversão numérica).
 *  - (empresa, código) é único: um código identifica UM produto. Em conflito, 409 `BARCODE_IN_USE` (nunca troca de dono em silêncio).
 *  - Desativar mantém a linha (histórico; o código não é reaproveitado por outro produto sem decisão explícita).
 *  - Duplicatas legadas em `products.barcode` continuam sendo tratadas como AMBÍGUAS na leitura (409 CODE_AMBIGUOUS).
 */
export const BARCODE_MAX_LENGTH = 64;

export function normalizeBarcode(input: unknown): string {
  if (typeof input !== 'string' && typeof input !== 'number') throw new AppError('Informe o código de barras.', 400, 'BARCODE_INVALID');
  // número aceito só para não quebrar integrações antigas; o texto é o que vale (um número já perdeu os zeros à esquerda)
  const code = String(input).trim();
  if (!code) throw new AppError('Informe o código de barras.', 400, 'BARCODE_INVALID');
  if (code.length > BARCODE_MAX_LENGTH) throw new AppError(`Código de barras com mais de ${BARCODE_MAX_LENGTH} caracteres.`, 400, 'BARCODE_INVALID');
  if ([...code].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw new AppError('Código de barras com caractere inválido.', 400, 'BARCODE_INVALID');
  return code;
}

type Tx = Pick<typeof prisma, 'productBarcode' | 'product'>;

async function assertFree(tx: Tx, companyId: string, code: string, exceptProductId?: string) {
  const row = await tx.productBarcode.findUnique({ where: { companyId_code: { companyId, code } }, select: { productId: true } });
  const owner =
    row && row.productId !== exceptProductId
      ? row.productId
      : (
          await tx.product.findFirst({
            where: { companyId, barcode: code, ...(exceptProductId ? { id: { not: exceptProductId } } : {}) },
            select: { id: true },
          })
        )?.id;
  if (!owner) return;
  const p = await tx.product.findUnique({ where: { id: owner }, select: { sku: true, name: true } });
  throw new AppError(
    `Este código de barras já pertence ao produto ${p?.sku ?? ''} ${p?.name ?? ''}`.trim() + '. Cada código identifica um único produto.',
    409,
    'BARCODE_IN_USE'
  );
}

/** Garante que `code` é um código ATIVO deste produto (cria ou reativa). Lança BARCODE_IN_USE se for de outro. */
async function ensureActive(tx: Tx, companyId: string, productId: string, code: string) {
  await assertFree(tx, companyId, code, productId);
  const existing = await tx.productBarcode.findUnique({ where: { companyId_code: { companyId, code } } });
  if (existing) {
    if (!existing.isActive) await tx.productBarcode.update({ where: { id: existing.id }, data: { isActive: true } });
    return;
  }
  await tx.productBarcode.create({ data: { companyId, productId, code, isActive: true } });
}

async function invalidate(companyId: string) {
  await cacheService.invalidate(`products:${companyId}:*`).catch(() => undefined);
}

export const productBarcodeService = {
  /**
   * Sincroniza o código PRINCIPAL (`products.barcode`) com a tabela. Chamado por criar/editar produto e pela importação,
   * DENTRO da transação que grava o produto. `previous` é o principal anterior (ao editar).
   */
  async syncPrimary(tx: Tx, companyId: string, productId: string, next: string | null | undefined, previous?: string | null) {
    const code = next === null || next === undefined || String(next).trim() === '' ? null : normalizeBarcode(next);
    const old = previous && previous.trim() ? previous.trim() : null;
    if (code) await ensureActive(tx, companyId, productId, code);
    if (old && old !== code) {
      await tx.productBarcode.updateMany({ where: { companyId, productId, code: old }, data: { isActive: false } });
    }
    return code;
  },

  async list(companyId: string, productId: string) {
    const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true, barcode: true } });
    if (!product) throw new AppError('Produto não encontrado.', 404, 'PRODUCT_NOT_FOUND');
    const rows = await prisma.productBarcode.findMany({ where: { companyId, productId }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
    return rows.map((r) => ({ id: r.id, code: r.code, isActive: r.isActive, isPrimary: r.isActive && r.code === product.barcode, createdAt: r.createdAt }));
  },

  async add(companyId: string, productId: string, rawCode: unknown) {
    const code = normalizeBarcode(rawCode);
    const result = await runInTransaction(async (tx: any) => {
      const product = await tx.product.findFirst({ where: { id: productId, companyId }, select: { id: true, barcode: true } });
      if (!product) throw new AppError('Produto não encontrado.', 404, 'PRODUCT_NOT_FOUND');
      await ensureActive(tx, companyId, productId, code);
      // primeiro código do produto vira o principal (as telas e integrações antigas leem `products.barcode`)
      if (!product.barcode) await tx.product.update({ where: { id: productId }, data: { barcode: code } });
      return tx.productBarcode.findUnique({ where: { companyId_code: { companyId, code } } });
    });
    await invalidate(companyId);
    return result!;
  },

  async setActive(companyId: string, productId: string, barcodeId: string, isActive: boolean) {
    const result = await runInTransaction(async (tx: any) => {
      const row = await tx.productBarcode.findFirst({ where: { id: barcodeId, companyId, productId } });
      if (!row) throw new AppError('Código de barras não encontrado neste produto.', 404, 'BARCODE_NOT_FOUND');
      if (row.isActive === isActive) return row;
      const updated = await tx.productBarcode.update({ where: { id: row.id }, data: { isActive } });
      const product = await tx.product.findUnique({ where: { id: productId }, select: { barcode: true } });
      if (!isActive && product?.barcode === row.code) {
        // o principal saiu de uso: o próximo código ativo assume (ou fica sem principal)
        const next = await tx.productBarcode.findFirst({ where: { companyId, productId, isActive: true, id: { not: row.id } }, orderBy: { createdAt: 'asc' } });
        await tx.product.update({ where: { id: productId }, data: { barcode: next?.code ?? null } });
      } else if (isActive && !product?.barcode) {
        await tx.product.update({ where: { id: productId }, data: { barcode: row.code } });
      }
      return updated;
    });
    await invalidate(companyId);
    return result;
  },
};

export default productBarcodeService;
