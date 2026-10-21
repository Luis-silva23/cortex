-- Imagem opcional do produto (decisão 122, 2026-10-14). ADITIVA: uma tabela nova; nenhum dado existente muda.
--  * No máximo UMA imagem por produto (productId único). O conteúdo (PNG/JPEG/WebP já validado e saneado pela aplicação: sem metadados,
--    sem bytes sobrando, dimensões e tamanho limitados) fica no banco sob RLS — a mesma arquitetura dos anexos do Suporte; não existe
--    armazenamento de arquivo externo no projeto. Só sai por rota autenticada da própria empresa.
--  * Apagar o produto apaga a imagem (cascata). Produto sem imagem continua exatamente como antes (cadastro e importação não mudam).
-- ROLLBACK (nenhum outro dado depende desta tabela):
--   DROP TABLE "product_images";

CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_images_mime_valid" CHECK ("mimeType" IN ('image/png', 'image/jpeg', 'image/webp')),
    CONSTRAINT "product_images_size_valid" CHECK ("byteSize" > 0 AND "byteSize" <= 1048576),
    CONSTRAINT "product_images_dimensions_valid" CHECK ("width" BETWEEN 1 AND 4096 AND "height" BETWEEN 1 AND 4096)
);

CREATE UNIQUE INDEX "product_images_productId_key" ON "product_images"("productId");
CREATE INDEX "product_images_companyId_idx" ON "product_images"("companyId");

ALTER TABLE "product_images" ADD CONSTRAINT "product_images_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public."product_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."product_images" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_images_isolation" ON public."product_images"
  USING (public.rls_company_match("companyId"))
  WITH CHECK (public.rls_company_match("companyId"));
