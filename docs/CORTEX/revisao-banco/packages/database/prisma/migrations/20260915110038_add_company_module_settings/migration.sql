-- CreateEnum
CREATE TYPE "SystemModule" AS ENUM ('ESTOQUE', 'COMPRAS', 'VENDAS', 'FINANCEIRO', 'FISCAL', 'OFICINA', 'POS_VENDA');

-- CreateTable
CREATE TABLE "company_module_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "module" "SystemModule" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledBy" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "reenabledBy" TEXT,
    "reenabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_module_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_module_settings_companyId_idx" ON "company_module_settings"("companyId");

-- CreateIndex
CREATE INDEX "company_module_settings_companyId_branchId_idx" ON "company_module_settings"("companyId", "branchId");

-- Duas UNIQUE parciais (Prisma Schema não expressa `@@unique` com WHERE) —
-- mesmo padrão já usado para CashRegister/Inventory nesta sessão: no
-- máximo UMA linha company-wide (branchId NULL) por empresa+módulo, e no
-- máximo UMA linha por filial+módulo quando houver override específico.
CREATE UNIQUE INDEX "company_module_settings_one_company_wide_per_module"
  ON "company_module_settings"("companyId", "module")
  WHERE "branchId" IS NULL;

CREATE UNIQUE INDEX "company_module_settings_one_branch_override_per_module"
  ON "company_module_settings"("companyId", "branchId", "module")
  WHERE "branchId" IS NOT NULL;
