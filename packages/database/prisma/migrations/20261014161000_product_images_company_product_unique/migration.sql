-- Imagem do produto: chave única ("companyId","productId") (2026-10-14, continuação de 20261014160000_product_children_same_company).
-- O Prisma só aceita a relação 1:1 Product.image ↔ ProductImage pela FK composta (companyId, productId) se a tabela filha tiver ESSA chave
-- única declarada. É redundante com o índice único já existente em ("productId") — "no máximo uma imagem por produto" continua garantido por
-- ele —, não muda nenhum dado nem regra, e custa um índice pequeno (uma imagem por produto, no máximo).
-- ROLLBACK: DROP INDEX "product_images_companyId_productId_key";  (e remover o @@unique([companyId, productId]) do schema)

CREATE UNIQUE INDEX "product_images_companyId_productId_key" ON "product_images"("companyId", "productId");
