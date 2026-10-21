-- Fase 3 (2026-10-06): Integration Gateway — caixa de entrada com reprocessamento (eventos fora de ordem), caixa de saída e cursor de consulta.
-- Aditiva: colunas novas anuláveis/com padrão, uma tabela nova e um enum novo. Nada existente muda de significado.
-- ROLLBACK (nesta ordem):
--   DROP TABLE channel_outbox; DROP TYPE "ChannelOutboxStatus";
--   DROP INDEX "channel_inbound_events_channelId_orderRef_outcome_idx", "channel_inbound_events_outcome_receivedAt_idx";
--   ALTER TABLE channel_inbound_events DROP COLUMN payload, DROP COLUMN "occurredAt", DROP COLUMN "orderRef", DROP COLUMN "correlationId",
--     DROP COLUMN attempts, DROP COLUMN "processedAt", DROP COLUMN "lastError";
--   ALTER TABLE sales_channels DROP COLUMN "inboundCursor";
--   (Perde só o que a Fase 3 gravou: eventos adiados e linhas pendentes de envio.)

ALTER TABLE "sales_channels" ADD COLUMN "inboundCursor" TEXT;

ALTER TABLE "channel_inbound_events"
  ADD COLUMN "payload" JSONB,
  ADD COLUMN "occurredAt" TIMESTAMP(3),
  ADD COLUMN "orderRef" TEXT,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT;

CREATE INDEX "channel_inbound_events_channelId_orderRef_outcome_idx" ON "channel_inbound_events"("channelId", "orderRef", "outcome");
CREATE INDEX "channel_inbound_events_outcome_receivedAt_idx" ON "channel_inbound_events"("outcome", "receivedAt");

CREATE TYPE "ChannelOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'DEAD', 'CANCELLED');

CREATE TABLE "channel_outbox" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ChannelOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorKind" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_outbox_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1)
);

CREATE UNIQUE INDEX "channel_outbox_channelId_dedupeKey_key" ON "channel_outbox"("channelId", "dedupeKey");
CREATE INDEX "channel_outbox_status_nextAttemptAt_idx" ON "channel_outbox"("status", "nextAttemptAt");
CREATE INDEX "channel_outbox_companyId_channelId_status_idx" ON "channel_outbox"("companyId", "channelId", "status");

ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: empresa + filial (mesma regra das demais tabelas de canais) -------------------------------------------------------------
ALTER TABLE public."channel_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."channel_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_outbox_isolation" ON public."channel_outbox"
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
