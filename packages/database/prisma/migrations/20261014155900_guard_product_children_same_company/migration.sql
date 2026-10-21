-- GUARDA da migration 20261014160000_product_children_same_company (2026-10-14). Só LÊ; não altera nada. Aborta se houver dado que violaria a FK composta.
-- POR QUE EXISTE: o ADD CONSTRAINT de uma FK valida as linhas existentes COM A RLS DO DONO. As tabelas são FORCE ROW LEVEL SECURITY e a
-- migration roda como o dono (o mesmo papel da aplicação) SEM contexto de empresa: o dono enxerga ZERO linhas, o PostgreSQL "valida" uma
-- tabela aparentemente vazia e a FK é criada MESMO COM linha violando (provado em experimento revertido: com uma linha cruzada, o ADD
-- CONSTRAINT passou; com app.user_type = 'SUPER_ADMIN' ele falhou). A nota "esta migration falha se houver dado inconsistente" não valia
-- sozinha. Esta guarda faz a checagem EXPLÍCITA, em contexto de plataforma (visível: todas as linhas), antes de qualquer constraint.
-- ORDEM: o nome (155900) a coloca ANTES de 20261014160000 em banco novo/staging/produção. Nos bancos de dev/teste, onde a 160000 já tinha sido
-- aplicada (sem dado cruzado), ela roda depois e apenas confirma o estado.
-- SE FALHAR: corrija as linhas por procedimento documentado e rastreável (nunca apagando histórico) e reaplique:
--   SELECT b.id, b."companyId" AS barcode_company, p."companyId" AS product_company FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId";
--   (idem product_images). Depois de corrigir: prisma migrate resolve --rolled-back 20261014155900_guard_product_children_same_company e prisma migrate deploy.
-- ROLLBACK: nada a desfazer (não altera estrutura nem dado).

DO $$
DECLARE
  n_barcodes integer;
  n_images integer;
BEGIN
  -- contexto de plataforma SÓ nesta transação: sem ele a RLS (FORCE) esconderia as linhas do próprio dono
  PERFORM set_config('app.user_type', 'SUPER_ADMIN', true);
  SELECT count(*) INTO n_barcodes FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId";
  SELECT count(*) INTO n_images FROM product_images i JOIN products p ON p.id = i."productId" WHERE p."companyId" <> i."companyId";
  IF n_barcodes > 0 OR n_images > 0 THEN
    RAISE EXCEPTION 'Existem % código(s) de barras e % imagem(ns) de produto apontando para produto de OUTRA empresa; corrija por procedimento documentado antes de aplicar as FKs compostas (ver o cabeçalho desta migration).', n_barcodes, n_images;
  END IF;
END $$;
