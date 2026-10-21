-- Exceções de pagamento: fato do provedor que conflita com o estado da venda (ex.: aprovado/capturado depois que a
-- venda foi cancelada ou devolvida). O pagamento registra a verdade (APPROVED); a venda fica como está; a exceção fica
-- aberta até alguém tratar. A regra comercial de tratamento é [DECISÃO NECESSÁRIA] (docs/CORTEX/BUSINESS_RULES.md).
CREATE TABLE "payment_exceptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "paymentId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "saleStatus" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "provider" TEXT,
    "providerStatus" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "notes" TEXT,
    CONSTRAINT "payment_exceptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_exceptions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "payment_exceptions_companyId_resolvedAt_idx" ON "payment_exceptions"("companyId", "resolvedAt");
-- no máximo uma exceção em aberto por pagamento (reconciliações concorrentes não duplicam)
CREATE UNIQUE INDEX "payment_exceptions_one_open" ON "payment_exceptions"("paymentId") WHERE "resolvedAt" IS NULL;

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_exceptions_isolation ON public.payment_exceptions
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
