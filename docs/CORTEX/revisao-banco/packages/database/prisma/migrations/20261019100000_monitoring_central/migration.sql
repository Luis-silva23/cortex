-- CENTRAL DE MONITORAMENTO (2026-10-19) — estrutura ADITIVA do Super Admin: tratamento de alertas, amostras de saúde, funil comercial, entregas externas e ajustes.
-- PROBLEMA: o monitoramento existente (monitoring_alerts, health_incidents, thresholds) mostrava o estado ATUAL, mas (a) o alerta não tinha ciclo de tratamento
-- (reconhecer, assumir, resolver, histórico), (b) não havia série histórica de disponibilidade/latência/servidor da plataforma para os gráficos, (c) não existia
-- nenhum registro do funil comercial (interessado → cliente ativo), (d) nada limitava nem registrava envios a serviços externos (e-mail de alerta, erros) e
-- (e) os ajustes de coleta/notificação só existiam em variável de ambiente.
-- ESCOPO (só adiciona; nenhuma tabela existente perde coluna ou dado):
--   • monitoring_alerts: 6 colunas de tratamento (handling com padrão 'OPEN', assignedTo, acknowledgedAt/By, resolvedBy, resolutionNote). Alerta já encerrado continua
--     encerrado: o estado exposto é calculado (endedAt preenchido = RESOLVIDO), por isso NÃO há UPDATE de dados nesta migração.
--   • monitoring_alert_events (histórico imutável), service_health_samples (telemetria com retenção), commercial_leads + commercial_lead_events (funil),
--     external_deliveries (telemetria com retenção), monitoring_settings (ajustes).
-- SEGURANÇA: as 6 tabelas novas são de PLATAFORMA: RLS habilitada e FORÇADA, policy só para SUPER_ADMIN (mesma forma de access_revocations_platform, helper
-- app_ctx.is_super_admin() em sub-select). Os dois históricos (alert_events, lead_events) são append-only como os demais livros: sem policy de UPDATE; DELETE só com o
-- expurgo sinalizado (`app.audit_purge = 'on'`) em contexto de Super Admin. Nenhuma tabela de empresa muda de política; nenhum acesso de papel de empresa é aberto.
-- FK: commercial_leads.companyId → companies (RESTRICT) e commercial_lead_events.leadId → commercial_leads (RESTRICT). As tabelas de telemetria seguem a convenção de
-- monitoring_* (sem FK de propósito: retenção).
-- ROLLBACK: remover as 6 tabelas novas (monitoring_settings, external_deliveries, commercial_lead_events, commercial_leads, service_health_samples,
-- monitoring_alert_events) e as 6 colunas de monitoring_alerts (handling, assignedTo, acknowledgedAt, acknowledgedBy, resolvedBy, resolutionNote).

-- monitoring_alerts: tratamento ------------------------------------------------------------------------------------------------------------
ALTER TABLE "monitoring_alerts"
  ADD COLUMN "handling" TEXT NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "assignedTo" TEXT,
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "acknowledgedBy" TEXT,
  ADD COLUMN "resolvedBy" TEXT,
  ADD COLUMN "resolutionNote" TEXT;

-- monitoring_alert_events -------------------------------------------------------------------------------------------------------------------
CREATE TABLE "monitoring_alert_events" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "companyId" TEXT,
    "kind" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monitoring_alert_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "monitoring_alert_events_alertId_createdAt_idx" ON "monitoring_alert_events"("alertId", "createdAt");
CREATE INDEX "monitoring_alert_events_createdAt_idx" ON "monitoring_alert_events"("createdAt");

-- service_health_samples --------------------------------------------------------------------------------------------------------------------
CREATE TABLE "service_health_samples" (
    "id" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" DOUBLE PRECISION,
    "valuePct" DOUBLE PRECISION,
    "detail" TEXT,
    CONSTRAINT "service_health_samples_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "service_health_samples_service_sampledAt_idx" ON "service_health_samples"("service", "sampledAt");
CREATE INDEX "service_health_samples_sampledAt_idx" ON "service_health_samples"("sampledAt");

-- commercial_leads / commercial_lead_events -------------------------------------------------------------------------------------------------
CREATE TABLE "commercial_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "source" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'INTERESTED',
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT,
    "closedReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "commercial_leads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "commercial_leads_companyId_key" ON "commercial_leads"("companyId");
CREATE INDEX "commercial_leads_stage_stageEnteredAt_idx" ON "commercial_leads"("stage", "stageEnteredAt");
ALTER TABLE "commercial_leads" ADD CONSTRAINT "commercial_leads_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "commercial_lead_events" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "commercial_lead_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "commercial_lead_events_leadId_createdAt_idx" ON "commercial_lead_events"("leadId", "createdAt");
CREATE INDEX "commercial_lead_events_toStage_createdAt_idx" ON "commercial_lead_events"("toStage", "createdAt");
ALTER TABLE "commercial_lead_events" ADD CONSTRAINT "commercial_lead_events_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "commercial_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- external_deliveries -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE "external_deliveries" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "alertId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "external_deliveries_channel_createdAt_idx" ON "external_deliveries"("channel", "createdAt");
CREATE INDEX "external_deliveries_dedupeKey_createdAt_idx" ON "external_deliveries"("dedupeKey", "createdAt");

-- monitoring_settings -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE "monitoring_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monitoring_settings_pkey" PRIMARY KEY ("key")
);

-- RLS: plataforma (só SUPER_ADMIN) ----------------------------------------------------------------------------------------------------------
ALTER TABLE "monitoring_alert_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monitoring_alert_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "monitoring_alert_events_select" ON "monitoring_alert_events" FOR SELECT USING ((SELECT app_ctx.is_super_admin()));
CREATE POLICY "monitoring_alert_events_insert" ON "monitoring_alert_events" FOR INSERT WITH CHECK ((SELECT app_ctx.is_super_admin()));
CREATE POLICY "monitoring_alert_events_purge" ON "monitoring_alert_events" FOR DELETE USING ((SELECT app_ctx.is_super_admin()) AND current_setting('app.audit_purge', true) = 'on');

ALTER TABLE "service_health_samples" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_health_samples" FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_health_samples_platform" ON "service_health_samples" FOR ALL USING ((SELECT app_ctx.is_super_admin())) WITH CHECK ((SELECT app_ctx.is_super_admin()));

ALTER TABLE "commercial_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commercial_leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY "commercial_leads_platform" ON "commercial_leads" FOR ALL USING ((SELECT app_ctx.is_super_admin())) WITH CHECK ((SELECT app_ctx.is_super_admin()));

ALTER TABLE "commercial_lead_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commercial_lead_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "commercial_lead_events_select" ON "commercial_lead_events" FOR SELECT USING ((SELECT app_ctx.is_super_admin()));
CREATE POLICY "commercial_lead_events_insert" ON "commercial_lead_events" FOR INSERT WITH CHECK ((SELECT app_ctx.is_super_admin()));
CREATE POLICY "commercial_lead_events_purge" ON "commercial_lead_events" FOR DELETE USING ((SELECT app_ctx.is_super_admin()) AND current_setting('app.audit_purge', true) = 'on');

ALTER TABLE "external_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "external_deliveries_platform" ON "external_deliveries" FOR ALL USING ((SELECT app_ctx.is_super_admin())) WITH CHECK ((SELECT app_ctx.is_super_admin()));

ALTER TABLE "monitoring_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monitoring_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "monitoring_settings_platform" ON "monitoring_settings" FOR ALL USING ((SELECT app_ctx.is_super_admin())) WITH CHECK ((SELECT app_ctx.is_super_admin()));
