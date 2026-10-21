-- ÍNDICES DUPLICADOS (2026-10-15, revisão do banco — achado F-02). Cada par abaixo tem o MESMO conjunto de colunas: um índice único (que já
-- atende às buscas e à unicidade) e um índice comum idêntico, que só custa escrita e espaço. Mantém-se o ÚNICO e remove-se o comum;
-- o schema.prisma deixou de declarar o @@index correspondente. (O de refresh_tokens já saiu em 20261014170000.)
-- ROLLBACK: CREATE INDEX <nome> ON <tabela>(<colunas>) com as colunas do índice único correspondente.
DROP INDEX IF EXISTS "device_telemetry_deviceId_collectedAt_idx";
DROP INDEX IF EXISTS "fiscal_documents_accessKey_idx";
DROP INDEX IF EXISTS "invoices_accessKey_idx";
DROP INDEX IF EXISTS "payments_transactionId_idx";
DROP INDEX IF EXISTS "users_email_idx";
