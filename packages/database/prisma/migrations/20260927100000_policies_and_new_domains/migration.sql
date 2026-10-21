-- Políticas por empresa/filial e domínios novos (2026-09-27), decididos pelo dono do produto:
--   * políticas configuráveis (padrão da empresa + override da filial quando o catálogo permite), com histórico;
--   * cadastro da empresa/filial/cliente; horário de funcionamento e calendário;
--   * desconto auditado item a item; fechamento de caixa forçado; histórico de orçamento; conclusão de agendamento
--     sem confirmação com autorização; garantia de OS e ocorrências; convênio de funcionário e de empresa externa;
--     cobrança manual autorizada (sem robô de cobrança).
-- Só acrescenta tabelas e colunas (nulas ou com padrão): nada existente muda de significado.
-- ROLLBACK (migração reversa, nunca editar esta): DROP das tabelas novas; DROP COLUMN das colunas novas. Os valores novos do
-- enum "PaymentMethod" não podem ser removidos no Postgres (inofensivos se não usados).

-- 1. Formas de pagamento de convênio -------------------------------------------------------------------------------
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'EMPLOYEE_AGREEMENT';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'COMPANY_AGREEMENT';

-- 2. Cadastro: empresa, filial, cliente ---------------------------------------------------------------------------
ALTER TABLE "companies"
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "stateRegistration" TEXT,
  ADD COLUMN "municipalRegistration" TEXT,
  ADD COLUMN "taxRegime" TEXT,
  ADD COLUMN "whatsapp" TEXT,
  ADD COLUMN "contactName" TEXT,
  ADD COLUMN "zipCode" TEXT,
  ADD COLUMN "street" TEXT,
  ADD COLUMN "number" TEXT,
  ADD COLUMN "complement" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "state" TEXT;

ALTER TABLE "branches"
  ADD COLUMN "stateRegistration" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "whatsapp" TEXT,
  ADD COLUMN "street" TEXT,
  ADD COLUMN "number" TEXT,
  ADD COLUMN "complement" TEXT,
  ADD COLUMN "district" TEXT;

ALTER TABLE "customers"
  ADD COLUMN "whatsapp" TEXT,
  ADD COLUMN "preferredContact" "ContactChannel";

-- 3. Políticas ---------------------------------------------------------------------------------------------------------
CREATE TABLE "policy_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "policy_settings_pkey" PRIMARY KEY ("id")
);
-- um valor por (empresa, filial ou empresa inteira, chave)
CREATE UNIQUE INDEX "policy_settings_scope_key" ON "policy_settings"("companyId", COALESCE("branchId", ''), "key");
CREATE INDEX "policy_settings_companyId_idx" ON "policy_settings"("companyId");

CREATE TABLE "policy_changes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "key" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "policy_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "policy_changes_companyId_createdAt_idx" ON "policy_changes"("companyId", "createdAt");

-- 4. Horário de funcionamento e calendário -----------------------------------------------------------------------------
CREATE TABLE "business_hours" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "weekday" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" TEXT,
    "closesAt" TEXT,
    "breakStart" TEXT,
    "breakEnd" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "business_hours_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6)
);
CREATE UNIQUE INDEX "business_hours_scope_weekday" ON "business_hours"("companyId", COALESCE("branchId", ''), "weekday");

CREATE TABLE "business_calendar_exceptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "opensAt" TEXT,
    "closesAt" TEXT,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_calendar_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_calendar_exceptions_scope_date" ON "business_calendar_exceptions"("companyId", COALESCE("branchId", ''), "date");

-- 5. Desconto auditado item a item (append-only) ----------------------------------------------------------------------
CREATE TABLE "discount_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "saleId" TEXT,
    "serviceOrderId" TEXT,
    "quoteId" TEXT,
    "itemRef" TEXT,
    "itemType" TEXT NOT NULL,
    "description" TEXT,
    "originalAmount" DECIMAL(12,2) NOT NULL,
    "discountAmount" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(7,3) NOT NULL,
    "finalAmount" DECIMAL(12,2) NOT NULL,
    "freeLimitPercent" DECIMAL(7,3) NOT NULL,
    "requiredAuthorization" BOOLEAN NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "authorizedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discount_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discount_events_companyId_createdAt_idx" ON "discount_events"("companyId", "createdAt");
CREATE INDEX "discount_events_saleId_idx" ON "discount_events"("saleId");
CREATE INDEX "discount_events_serviceOrderId_idx" ON "discount_events"("serviceOrderId");

-- 6. Caixa: fechamento forçado -----------------------------------------------------------------------------------------
ALTER TABLE "cash_registers"
  ADD COLUMN "closeType" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "forcedReason" TEXT,
  ADD COLUMN "pendingSnapshot" JSONB;

-- 7. Orçamento: encerramento, reabertura e histórico ------------------------------------------------------------------
ALTER TABLE "quotes"
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "closedBy" TEXT,
  ADD COLUMN "closeReason" TEXT;

CREATE TABLE "quote_events" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "performedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quote_events_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "quote_events_quoteId_idx" ON "quote_events"("quoteId");

-- 8. Agenda: conclusão sem confirmação do cliente só com autorização ---------------------------------------------------
ALTER TABLE "appointments"
  ADD COLUMN "completedWithoutConfirmation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "completionAuthorizedBy" TEXT,
  ADD COLUMN "completionReason" TEXT;

-- 9. Garantia ----------------------------------------------------------------------------------------------------------
ALTER TABLE "service_orders" ADD COLUMN "warrantyDecision" TEXT;

CREATE TABLE "service_order_warranties" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "motorcycleId" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "durationValue" INTEGER NOT NULL,
    "durationUnit" TEXT NOT NULL,
    "kmLimit" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "startKm" DECIMAL(10,1),
    "kmUntil" DECIMAL(10,1),
    "coveredItems" JSONB,
    "conditions" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_order_warranties_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_order_warranties_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "service_order_warranties_serviceOrderId_key" ON "service_order_warranties"("serviceOrderId");
CREATE INDEX "service_order_warranties_companyId_validUntil_idx" ON "service_order_warranties"("companyId", "validUntil");
CREATE INDEX "service_order_warranties_motorcycleId_idx" ON "service_order_warranties"("motorcycleId");
CREATE INDEX "service_order_warranties_customerId_idx" ON "service_order_warranties"("customerId");

CREATE TABLE "warranty_claims" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "warrantyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "newServiceOrderId" TEXT,
    "description" TEXT NOT NULL,
    "kmAtClaim" DECIMAL(10,1),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "decisionNotes" TEXT,
    "openedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "warranty_claims_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warranty_claims_warrantyId_fkey" FOREIGN KEY ("warrantyId") REFERENCES "service_order_warranties"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "warranty_claims_warrantyId_idx" ON "warranty_claims"("warrantyId");

-- 10. Convênio de funcionário -----------------------------------------------------------------------------------------
CREATE TABLE "employee_agreements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "userId" TEXT,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "registration" TEXT,
    "salary" DECIMAL(12,2),
    "limitType" TEXT,
    "limitValue" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_agreements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employee_agreements_companyId_cpf_key" ON "employee_agreements"("companyId", "cpf");

CREATE TABLE "employee_agreement_charges" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "agreementId" TEXT NOT NULL,
    "saleId" TEXT,
    "paymentId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "firstCompetence" TEXT NOT NULL,
    "authorizedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_agreement_charges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_agreement_charges_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "employee_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "employee_agreement_charges_paymentId_key" ON "employee_agreement_charges"("paymentId");
CREATE INDEX "employee_agreement_charges_agreementId_idx" ON "employee_agreement_charges"("agreementId");

CREATE TABLE "employee_payroll_deductions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "chargeId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "competence" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "processedAt" TIMESTAMP(3),
    "processedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_payroll_deductions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_payroll_deductions_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "employee_agreement_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "employee_payroll_deductions_charge_installment" ON "employee_payroll_deductions"("chargeId", "installmentNumber");
CREATE INDEX "employee_payroll_deductions_agreement_competence_idx" ON "employee_payroll_deductions"("agreementId", "competence");

-- 11. Convênio com empresa externa -------------------------------------------------------------------------------------
CREATE TABLE "agreement_companies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "cnpj" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "zipCode" TEXT,
    "street" TEXT,
    "number" TEXT,
    "complement" TEXT,
    "district" TEXT,
    "city" TEXT,
    "state" TEXT,
    "commercialTerms" TEXT,
    "creditLimit" DECIMAL(12,2),
    "monthlyLimit" DECIMAL(12,2),
    "paymentTermDays" INTEGER NOT NULL DEFAULT 30,
    "interestPercentMonthly" DECIMAL(7,3),
    "finePercent" DECIMAL(7,3),
    "blockAfterDaysOverdue" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "blockedAt" TIMESTAMP(3),
    "blockedBy" TEXT,
    "blockedReason" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agreement_companies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agreement_companies_companyId_cnpj_key" ON "agreement_companies"("companyId", "cnpj");

ALTER TABLE "accounts_receivable"
  ADD COLUMN "agreementCompanyId" TEXT,
  ADD COLUMN "employeeAgreementId" TEXT;
CREATE INDEX "accounts_receivable_agreementCompanyId_idx" ON "accounts_receivable"("agreementCompanyId");

ALTER TABLE "payments"
  ADD COLUMN "agreementCompanyId" TEXT,
  ADD COLUMN "employeeAgreementId" TEXT;

-- 12. Cobrança manual autorizada (append-only) ------------------------------------------------------------------------
CREATE TABLE "collection_attempts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "receivableId" TEXT NOT NULL,
    "agreementCompanyId" TEXT,
    "channel" TEXT NOT NULL,
    "recipient" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "providerMessage" TEXT,
    "sentBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "collection_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "collection_attempts_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "accounts_receivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "collection_attempts_receivableId_idx" ON "collection_attempts"("receivableId");
CREATE INDEX "collection_attempts_companyId_createdAt_idx" ON "collection_attempts"("companyId", "createdAt");

-- 13. RLS: empresa + filial (linha da empresa inteira, branchId nulo, vale para todas as filiais dela) -----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy_settings','policy_changes','business_hours','business_calendar_exceptions',
    'quote_events','service_order_warranties','warranty_claims','employee_agreements','employee_agreement_charges',
    'employee_payroll_deductions','agreement_companies'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_isolation', t);
  END LOOP;
  -- Evidência que só cresce (como audit_logs): leitura e inclusão; sem UPDATE nem DELETE.
  FOREACH t IN ARRAY ARRAY['discount_events','collection_attempts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (public.rls_company_branch_match("companyId", "branchId"))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_insert', t);
  END LOOP;
END $$;
