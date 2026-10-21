-- Pedidos de titular — LGPD (decisão 120, 2026-10-14). ADITIVA: uma tabela nova e uma coluna anulável em customers.
--  * privacy_requests: registro durável do pedido (exportação ou anonimização de UM cliente): quem pediu, quando, por quê, o que foi
--    feito e o que foi retido (e por quê). Não guarda o dado anonimizado; o arquivo de exportação é cifrado pela aplicação (enc:v1),
--    vale só até exportExpiresAt e é apagado por rotina.
--  * customers."anonymizedAt": marca o cadastro anonimizado (irreversível: os dados originais não são guardados em lugar nenhum).
-- ROLLBACK (nenhum outro dado depende destes objetos):
--   DROP TABLE "privacy_requests";  ALTER TABLE "customers" DROP COLUMN "anonymizedAt";

ALTER TABLE "customers" ADD COLUMN "anonymizedAt" TIMESTAMP(3);

CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedBy" TEXT,
    "executedAt" TIMESTAMP(3),
    "plan" JSONB,
    "result" JSONB,
    "retainedUntil" TIMESTAMP(3),
    "exportPayload" TEXT,
    "exportSha256" TEXT,
    "exportExpiresAt" TIMESTAMP(3),
    "exportDownloads" INTEGER NOT NULL DEFAULT 0,
    "exportPurgedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "privacy_requests_type_valid" CHECK ("requestType" IN ('EXPORT', 'ANONYMIZE')),
    CONSTRAINT "privacy_requests_status_valid" CHECK ("status" IN ('PLANNED', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED')),
    CONSTRAINT "privacy_requests_justification_not_blank" CHECK (btrim("justification") <> '')
);

CREATE INDEX "privacy_requests_companyId_requestedAt_idx" ON "privacy_requests"("companyId", "requestedAt");
CREATE INDEX "privacy_requests_companyId_subjectId_idx" ON "privacy_requests"("companyId", "subjectId");
CREATE INDEX "privacy_requests_exportExpiresAt_idx" ON "privacy_requests"("exportExpiresAt");

ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public."privacy_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."privacy_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "privacy_requests_isolation" ON public."privacy_requests"
  USING (public.rls_company_match("companyId"))
  WITH CHECK (public.rls_company_match("companyId"));
