-- Rastreabilidade da importação em lote: cada importação vira um lote com o resultado de CADA linha (criada,
-- atualizada, sem alteração, erro + motivo). As linhas continuam independentes (uma linha ruim não derruba as boas),
-- mas nada fica parcialmente importado sem registro. Movimentos de estoque apontam para o lote (referenceId).
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "type" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "unchangedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "import_batches_companyId_startedAt_idx" ON "import_batches"("companyId", "startedAt");

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_isolation ON public.import_batches
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
