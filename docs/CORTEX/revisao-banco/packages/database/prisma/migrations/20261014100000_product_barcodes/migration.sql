-- Vários códigos de barras por produto (2026-10-14). ADITIVA: nenhuma coluna ou linha existente é alterada ou removida.
--  * `products.barcode` continua existindo (código "principal", usado por telas e integrações atuais) e é sincronizado com esta
--    tabela pela aplicação; o backfill abaixo copia os códigos já cadastrados.
--  * (companyId, code) é ÚNICO: um código de barras identifica UM produto na empresa. Desativar mantém a linha (histórico, e o
--    código não é reaproveitado em silêncio por outro produto); duplicatas LEGADAS em products.barcode não são descartadas —
--    só a primeira entra aqui e as demais continuam em products.barcode, onde a leitura as trata como ambíguas (409).
--  * O código é texto: zeros à esquerda são preservados.
-- ROLLBACK (nada mais depende desta tabela; products.barcode permanece intacto):
--   DROP TABLE "product_barcodes";

CREATE TABLE "product_barcodes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_barcodes_code_not_blank" CHECK (btrim("code") <> '')
);

CREATE UNIQUE INDEX "product_barcodes_companyId_code_key" ON "product_barcodes"("companyId", "code");
CREATE INDEX "product_barcodes_productId_idx" ON "product_barcodes"("productId");
CREATE INDEX "product_barcodes_companyId_idx" ON "product_barcodes"("companyId");

ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: o código principal de cada produto vira uma linha (duplicatas legadas na mesma empresa: só a primeira).
INSERT INTO "product_barcodes" ("id", "companyId", "productId", "code", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."companyId", p."id", btrim(p."barcode"), p."isActive", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "products" p
WHERE p."barcode" IS NOT NULL AND btrim(p."barcode") <> ''
ORDER BY p."createdAt", p."id"
ON CONFLICT ("companyId", "code") DO NOTHING;

-- RLS: empresa ----------------------------------------------------------------------------------------------------------------
ALTER TABLE public."product_barcodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."product_barcodes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_barcodes_isolation" ON public."product_barcodes"
  USING (public.rls_company_match("companyId"))
  WITH CHECK (public.rls_company_match("companyId"));
