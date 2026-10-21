-- Configuração de pagamento (controle de cédulas opcional) e composição das cédulas por pagamento.
ALTER TABLE "payments" ADD COLUMN "cashBreakdown" JSONB;

CREATE TABLE "payment_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "cashDenominationControl" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_settings_companyId_idx" ON "payment_settings"("companyId");
CREATE UNIQUE INDEX "payment_settings_one_company_wide" ON "payment_settings"("companyId") WHERE "branchId" IS NULL;
CREATE UNIQUE INDEX "payment_settings_one_per_branch" ON "payment_settings"("companyId", "branchId") WHERE "branchId" IS NOT NULL;

ALTER TABLE public.payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_settings_isolation ON public.payment_settings
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
