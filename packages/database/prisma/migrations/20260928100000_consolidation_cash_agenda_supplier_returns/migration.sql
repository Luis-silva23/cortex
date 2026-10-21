-- Consolidação das políticas (2026-09-28): fechamento de caixa por forma de pagamento, convênio por filial, capacidade
-- da agenda e devolução ao fornecedor. Só acrescenta colunas/tabelas/valor de enum; nada existente muda de sentido.

-- 1. Caixa: resumo do fechamento e motivo da divergência -----------------------------------------------------------
ALTER TABLE "cash_registers" ADD COLUMN "closingSummary" JSONB;
ALTER TABLE "cash_registers" ADD COLUMN "differenceReason" TEXT;

-- 2. Convênios: filiais em que podem ser usados (vazio = todas) ---------------------------------------------------
ALTER TABLE "employee_agreements" ADD COLUMN "allowedBranchIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "agreement_companies" ADD COLUMN "allowedBranchIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 3. Agenda: duração, mecânico e indisponibilidades ---------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "durationMinutes" INTEGER;
ALTER TABLE "appointments" ADD COLUMN "mechanicId" TEXT;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_durationMinutes_check" CHECK ("durationMinutes" IS NULL OR "durationMinutes" BETWEEN 5 AND 1440);
CREATE INDEX "appointments_mechanicId_idx" ON "appointments"("mechanicId");

CREATE TABLE "agenda_unavailabilities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "mechanicId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agenda_unavailabilities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agenda_unavailabilities_window_check" CHECK ("endsAt" > "startsAt")
);
CREATE INDEX "agenda_unavailabilities_companyId_branchId_startsAt_idx" ON "agenda_unavailabilities"("companyId", "branchId", "startsAt");

-- 4. Estoque: saída por devolução ao fornecedor --------------------------------------------------------------------
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'SUPPLIER_RETURN';

-- 5. Devolução ao fornecedor ----------------------------------------------------------------------------------------
CREATE TABLE "supplier_returns" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "returnNumber" INTEGER NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "stockWithdrawnAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "shippingInfo" TEXT,
    "outcome" TEXT,
    "outcomeAmount" DECIMAL(12,2),
    "outcomeNotes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_returns_status_check" CHECK ("status" IN ('REQUESTED','APPROVED','REJECTED','SENT','CLOSED','CANCELLED')),
    CONSTRAINT "supplier_returns_reason_check" CHECK ("reason" IN ('DAMAGED','DEFECTIVE','WRONG_ITEM','NOT_ORDERED','OTHER')),
    CONSTRAINT "supplier_returns_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('CREDIT','REPLACEMENT','REFUND','REFUSED_BY_SUPPLIER')),
    CONSTRAINT "supplier_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "supplier_returns_companyId_returnNumber_key" ON "supplier_returns"("companyId", "returnNumber");
CREATE INDEX "supplier_returns_companyId_branchId_status_idx" ON "supplier_returns"("companyId", "branchId", "status");
CREATE INDEX "supplier_returns_supplierId_idx" ON "supplier_returns"("supplierId");

CREATE TABLE "supplier_return_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unitCost" DECIMAL(12,2),
    "notes" TEXT,
    "damageRecordId" TEXT,
    CONSTRAINT "supplier_return_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_return_items_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "supplier_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "supplier_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "supplier_return_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "supplier_return_items_returnId_idx" ON "supplier_return_items"("returnId");
CREATE INDEX "supplier_return_items_productId_idx" ON "supplier_return_items"("productId");

CREATE TABLE "supplier_return_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "userId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_return_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_return_events_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "supplier_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "supplier_return_events_returnId_createdAt_idx" ON "supplier_return_events"("returnId", "createdAt");

-- 6. RLS: empresa + filial ------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agenda_unavailabilities','supplier_returns','supplier_return_items','supplier_return_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_isolation', t);
  END LOOP;
END $$;
