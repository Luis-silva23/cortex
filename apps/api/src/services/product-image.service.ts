import { createHash } from 'crypto';
import { prisma } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { PRODUCT_IMAGE_LIMITS, sanitizeProductImage } from './product-image-sanitizer';

/**
 * IMAGEM OPCIONAL DO PRODUTO (decisão 122). No máximo uma por produto, guardada no banco sob RLS (mesma arquitetura dos anexos do
 * Suporte) e entregue só por rota autenticada da empresa dona. Produto sem imagem segue igual (cadastro e importação não mudam).
 * O produto é sempre procurado por `id` + `companyId`: o id de produto de outra empresa dá "não encontrado".
 */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

async function assertProduct(companyId: string, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!product) throw new AppError('Produto não encontrado.', 404, 'PRODUCT_NOT_FOUND');
}

const meta = (r: { mimeType: string; byteSize: number; width: number; height: number; sha256: string; updatedAt: Date }) => ({
  mimeType: r.mimeType,
  size: r.byteSize,
  width: r.width,
  height: r.height,
  sha256: r.sha256,
  updatedAt: r.updatedAt,
});

/** Grava (ou SUBSTITUI) a imagem do produto. `contentBase64` = arquivo; o tipo é decidido pelo conteúdo, nunca pelo que veio declarado. */
export async function putProductImage(companyId: string, productId: string, userId: string | undefined, contentBase64: unknown) {
  if (typeof contentBase64 !== 'string' || !contentBase64) throw new AppError('Envie o arquivo da imagem.', 400, 'IMAGE_REQUIRED');
  // teto antes de decodificar: base64 cresce ~33%; nada de alocar buffer gigante para depois recusar
  if (contentBase64.length > Math.ceil((PRODUCT_IMAGE_LIMITS.maxBytes * 4) / 3) + 8) {
    throw new AppError(`A imagem passa de ${Math.round(PRODUCT_IMAGE_LIMITS.maxBytes / 1024 / 1024)} MB.`, 413, 'IMAGE_TOO_LARGE');
  }
  const clean = contentBase64.replace(/^data:[^;]+;base64,/, '');
  if (!BASE64.test(clean) || clean.length % 4 === 1) throw new AppError('Arquivo de imagem inválido.', 400, 'IMAGE_INVALID');
  await assertProduct(companyId, productId);
  const sanitized = sanitizeProductImage(Buffer.from(clean, 'base64'));
  const sha256 = createHash('sha256').update(sanitized.data).digest('hex');
  const data = { mimeType: sanitized.mimeType, byteSize: sanitized.data.length, width: sanitized.width, height: sanitized.height, sha256, data: sanitized.data, createdBy: userId ?? null };
  const row = await prisma.productImage.upsert({
    where: { productId },
    create: { companyId, productId, ...data },
    update: data,
    select: { mimeType: true, byteSize: true, width: true, height: true, sha256: true, updatedAt: true },
  });
  return meta(row);
}

export async function getProductImage(companyId: string, productId: string) {
  const row = await prisma.productImage.findFirst({ where: { productId, companyId } });
  if (!row) throw new AppError('Este produto não tem imagem.', 404, 'IMAGE_NOT_FOUND');
  return { mimeType: row.mimeType, data: Buffer.from(row.data), sha256: row.sha256, updatedAt: row.updatedAt };
}

export async function getProductImageMeta(companyId: string, productId: string) {
  await assertProduct(companyId, productId);
  const row = await prisma.productImage.findFirst({ where: { productId, companyId }, select: { mimeType: true, byteSize: true, width: true, height: true, sha256: true, updatedAt: true } });
  return row ? meta(row) : null;
}

export async function deleteProductImage(companyId: string, productId: string) {
  await assertProduct(companyId, productId);
  const removed = await prisma.productImage.deleteMany({ where: { productId, companyId } });
  return { removed: removed.count };
}
