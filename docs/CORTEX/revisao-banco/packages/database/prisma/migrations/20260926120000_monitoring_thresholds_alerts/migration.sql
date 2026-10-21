-- Limites do monitoramento configuráveis (global → empresa → filial) com histórico, e alertas com deduplicação.

CREATE TABLE "monitoring_thresholds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "branchId" TEXT,
    "metric" TEXT NOT NULL,
    "attention" DOUBLE PRECISION NOT NULL,
    "critical" DOUBLE PRECISION NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monitoring_thresholds_pkey" PRIMARY KEY ("id")
);
-- um valor por escopo (global = empresa e filial nulas) e métrica
CREATE UNIQUE INDEX "monitoring_thresholds_scope_metric" ON "monitoring_thresholds"(COALESCE("companyId", ''), COALESCE("branchId", ''), "metric");

CREATE TABLE "monitoring_threshold_changes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "branchId" TEXT,
    "metric" TEXT NOT NULL,
    "oldAttention" DOUBLE PRECISION,
    "oldCritical" DOUBLE PRECISION,
    "newAttention" DOUBLE PRECISION,
    "newCritical" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monitoring_threshold_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "monitoring_threshold_changes_companyId_changedAt_idx" ON "monitoring_threshold_changes"("companyId", "changedAt");

CREATE TABLE "monitoring_alerts" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "companyId" TEXT,
    "branchId" TEXT,
    "deviceId" TEXT,
    "type" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "detail" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "monitoring_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "monitoring_alerts_companyId_startedAt_idx" ON "monitoring_alerts"("companyId", "startedAt");
CREATE INDEX "monitoring_alerts_endedAt_idx" ON "monitoring_alerts"("endedAt");
-- deduplicação: no máximo um alerta aberto por tipo e alvo
CREATE UNIQUE INDEX "monitoring_alerts_one_open" ON "monitoring_alerts"(COALESCE("companyId", ''), COALESCE("branchId", ''), COALESCE("deviceId", ''), "type") WHERE "endedAt" IS NULL;

-- Limites: todos leem o global e o da própria empresa; só SUPER_ADMIN grava (além da trava na API).
ALTER TABLE public.monitoring_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY monitoring_thresholds_read ON public.monitoring_thresholds FOR SELECT
  USING ("companyId" IS NULL OR public.rls_company_match("companyId"));
CREATE POLICY monitoring_thresholds_write ON public.monitoring_thresholds FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

ALTER TABLE public.monitoring_threshold_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_threshold_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY monitoring_threshold_changes_read ON public.monitoring_threshold_changes FOR SELECT
  USING ("companyId" IS NULL OR public.rls_company_match("companyId"));
CREATE POLICY monitoring_threshold_changes_write ON public.monitoring_threshold_changes FOR INSERT
  WITH CHECK (public.is_super_admin());

-- Alertas: da empresa/filial (central, sem empresa, só SUPER_ADMIN).
ALTER TABLE public.monitoring_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY monitoring_alerts_isolation ON public.monitoring_alerts
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
