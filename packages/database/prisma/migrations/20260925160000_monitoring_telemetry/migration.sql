-- Monitoramento: telemetria real dos equipamentos e histórico de incidentes de saúde. RLS FORCE por empresa/filial.
CREATE TABLE "device_telemetry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuLoadPct" DOUBLE PRECISION,
    "memUsedPct" DOUBLE PRECISION,
    "diskUsedPct" DOUBLE PRECISION,
    "apiRttMs" INTEGER,
    "packetLossPct" DOUBLE PRECISION,
    "appVersion" TEXT,
    "uptimeSec" INTEGER,
    CONSTRAINT "device_telemetry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "device_telemetry_deviceId_collectedAt_key" ON "device_telemetry"("deviceId", "collectedAt");
CREATE INDEX "device_telemetry_companyId_branchId_collectedAt_idx" ON "device_telemetry"("companyId", "branchId", "collectedAt");
CREATE INDEX "device_telemetry_deviceId_collectedAt_idx" ON "device_telemetry"("deviceId", "collectedAt");

CREATE TABLE "health_incidents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "health_incidents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "health_incidents_companyId_branchId_startedAt_idx" ON "health_incidents"("companyId", "branchId", "startedAt");
CREATE INDEX "health_incidents_endedAt_idx" ON "health_incidents"("endedAt");
-- no máximo um incidente em aberto por componente/filial
CREATE UNIQUE INDEX "health_incidents_one_open" ON "health_incidents"("companyId", COALESCE("branchId", ''), "component") WHERE "endedAt" IS NULL;

ALTER TABLE public.device_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_telemetry FORCE ROW LEVEL SECURITY;
CREATE POLICY device_telemetry_isolation ON public.device_telemetry
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

ALTER TABLE public.health_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY health_incidents_isolation ON public.health_incidents
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));
