-- ÍNDICE POR EMPRESA NO HISTÓRICO DE ALERTAS (2026-10-19) — complemento ADITIVO de 20261019100000_monitoring_central.
-- PROBLEMA: o teste de invariantes do banco (database-schema-invariants: "toda tabela com companyId tem índice que COMEÇA por companyId") apontou que
-- monitoring_alert_events guarda "companyId" (nulo para alerta da infraestrutura central) sem índice que o inicie; a consulta do histórico por empresa varreria a tabela.
-- ESCOPO: um único índice (companyId, createdAt). Não altera dado, coluna, política de RLS nem permissão. Tabela nova e vazia/pequena: criação imediata.
-- ROLLBACK: DROP INDEX "monitoring_alert_events_companyId_createdAt_idx";

CREATE INDEX "monitoring_alert_events_companyId_createdAt_idx" ON "monitoring_alert_events"("companyId", "createdAt");
