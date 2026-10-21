-- Códigos de barras e imagem do produto: o produto tem que ser da MESMA empresa da linha (2026-10-14, revisão do banco).
-- PROBLEMA: product_barcodes e product_images tinham FK só em (productId) → products(id), e a policy RLS da linha filha só confere o
-- "companyId" da PRÓPRIA linha. A checagem de FK do PostgreSQL NÃO passa pela RLS: uma sessão da empresa A gravava
-- (companyId = A, productId = produto da empresa B) e a linha ficava "da A" apontando para o produto da B (provado por teste de integração:
-- product-children-same-company, que falhava antes desta migration).
-- CORREÇÃO (ADITIVA para os dados; troca de restrição): (1) chave única composta products("companyId","id") — redundante com a PK, mas é
-- o alvo que uma FK composta exige; (2) FK composta ("companyId","productId") → products("companyId","id") nas duas tabelas, com as MESMAS
-- regras de antes (código de barras: ON DELETE RESTRICT; imagem: ON DELETE CASCADE; ON UPDATE CASCADE); (3) as FKs simples antigas saem
-- (a composta já garante a existência do produto). Nenhuma linha é lida/alterada/apagada; as FKs para "companies" ficam como estão.
-- PRÉ-CHECAGEM: feita pela migration 20261014155900_guard_product_children_same_company (roda ANTES desta em banco novo/staging/produção).
-- ATENÇÃO — correção de uma nota anterior: o ADD CONSTRAINT abaixo, executado pelo dono da tabela sob FORCE ROW LEVEL SECURITY e sem contexto
-- de empresa, NÃO enxerga as linhas (a RLS as esconde) e "valida" em branco; por isso NÃO se pode contar com ele para detectar dado cruzado
-- (provado em experimento revertido). A detecção é a da migration-guarda, que lê com app.user_type = 'SUPER_ADMIN'. Consulta manual (como
-- Super Admin / papel que ignora RLS; os dois devem dar 0):
--   SELECT count(*) FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId";
--   SELECT count(*) FROM product_images   i JOIN products p ON p.id = i."productId" WHERE p."companyId" <> i."companyId";
-- BLOQUEIO: CREATE UNIQUE INDEX e ADD CONSTRAINT tomam lock curto (tabelas pequenas: catálogo de produtos); em tabela muito grande, criar
-- o índice antes com CREATE UNIQUE INDEX CONCURRENTLY (fora de transação) e depois aplicar esta migration.
-- ROLLBACK (nenhum dado depende das restrições novas):
--   ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
--   ALTER TABLE "product_images"   ADD CONSTRAINT "product_images_productId_fkey"   FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--   ALTER TABLE "product_barcodes" DROP CONSTRAINT "product_barcodes_companyId_productId_fkey";
--   ALTER TABLE "product_images"   DROP CONSTRAINT "product_images_companyId_productId_fkey";
--   DROP INDEX "products_companyId_id_key";

-- 1. alvo da FK composta
CREATE UNIQUE INDEX "products_companyId_id_key" ON "products"("companyId", "id");

-- 2. FKs compostas (adiciona ANTES de remover as antigas: não há janela sem proteção)
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_companyId_productId_fkey"
  FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_companyId_productId_fkey"
  FOREIGN KEY ("companyId", "productId") REFERENCES "products"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. FKs simples antigas (substituídas)
ALTER TABLE "product_barcodes" DROP CONSTRAINT "product_barcodes_productId_fkey";
ALTER TABLE "product_images" DROP CONSTRAINT "product_images_productId_fkey";
