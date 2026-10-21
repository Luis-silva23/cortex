-- ÍNDICES "companyId" REDUNDANTES COM O ALVO DAS FKs COMPOSTAS (2026-10-15, revisão do banco — achado F-02, continuação).
-- As FKs compostas (companyId, X) -> pai(companyId, id) exigiram o índice ÚNICO (companyId, id) em cada pai (migration 20261014180000 e anteriores). Esse
-- índice já começa por companyId e atende exatamente às mesmas consultas (a RLS filtra por companyId = ?): o índice comum "<tabela>_companyId_idx" ficou
-- redundante (só custa escrita e espaço). Removidos apenas os 13 que ESTA revisão tornou redundantes; os demais prefixos (ex.: companyId, status) ficam
-- para decisão com medição de uso em staging. O @@index([companyId]) correspondente saiu do schema.prisma (sem deriva).
-- ROLLBACK: CREATE INDEX "<tabela>_companyId_idx" ON "<tabela>"("companyId");
DROP INDEX IF EXISTS "follow_ups_companyId_idx";
DROP INDEX IF EXISTS "revisions_companyId_idx";
DROP INDEX IF EXISTS "users_companyId_idx";
DROP INDEX IF EXISTS "service_orders_companyId_idx";
DROP INDEX IF EXISTS "quotes_companyId_idx";
DROP INDEX IF EXISTS "products_companyId_idx";
DROP INDEX IF EXISTS "payments_companyId_idx";
DROP INDEX IF EXISTS "motorcycles_companyId_idx";
DROP INDEX IF EXISTS "damage_records_companyId_idx";
DROP INDEX IF EXISTS "categories_companyId_idx";
DROP INDEX IF EXISTS "cash_registers_companyId_idx";
DROP INDEX IF EXISTS "branches_companyId_idx";
DROP INDEX IF EXISTS "accounts_receivable_companyId_idx";
