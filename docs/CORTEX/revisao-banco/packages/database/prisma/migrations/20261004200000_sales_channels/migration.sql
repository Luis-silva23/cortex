-- Canais de venda (2026-10-04): módulo CANAIS (nasce desativado), canais configuráveis por empresa/filial, pedidos externos,
-- idempotência de eventos e origem da venda. Aditiva: nenhuma linha existente muda (venda sem canal = loja física).
-- ROLLBACK: DROP das 4 tabelas e dos 4 tipos; ALTER TABLE sales DROP COLUMN "channelId". (O valor 'CANAIS' do enum SystemModule não é removível.)

ALTER TYPE "SystemModule" ADD VALUE IF NOT EXISTS 'CANAIS';

CREATE TYPE "SalesChannelType" AS ENUM ('LOJA_FISICA', 'SITE_PROPRIO', 'IFOOD', 'MARKETPLACE', 'OUTRO');
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('NOT_CONFIGURED', 'UNVALIDATED', 'CONNECTED', 'ERROR');
CREATE TYPE "ExternalOrderStatus" AS ENUM ('RECEIVED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'CONVERTED');
CREATE TYPE "ExternalPaymentStatus" AS ENUM ('UNKNOWN', 'PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED');

CREATE TABLE "sales_channels" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "type" "SalesChannelType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "connectionStatus" "ChannelConnectionStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "externalAccountId" TEXT,
    "config" JSONB,
    "credentialsEncrypted" TEXT,
    "credentialsHint" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sales_channels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sales_channels_companyId_idx" ON "sales_channels"("companyId");
CREATE INDEX "sales_channels_companyId_branchId_idx" ON "sales_channels"("companyId", "branchId");

CREATE TABLE "channel_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "correlationId" TEXT,
    "actorId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "channel_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_events_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "channel_events_channelId_createdAt_idx" ON "channel_events"("channelId", "createdAt");
CREATE INDEX "channel_events_companyId_createdAt_idx" ON "channel_events"("companyId", "createdAt");

CREATE TABLE "external_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "status" "ExternalOrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "paymentStatus" "ExternalPaymentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "saleId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "external_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_orders_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "external_orders_saleId_key" ON "external_orders"("saleId");
CREATE UNIQUE INDEX "external_orders_channelId_externalOrderId_key" ON "external_orders"("channelId", "externalOrderId");
CREATE INDEX "external_orders_companyId_receivedAt_idx" ON "external_orders"("companyId", "receivedAt");

CREATE TABLE "channel_inbound_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "channel_inbound_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_inbound_events_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "channel_inbound_events_channelId_externalEventId_operation_key" ON "channel_inbound_events"("channelId", "externalEventId", "operation");
CREATE INDEX "channel_inbound_events_companyId_receivedAt_idx" ON "channel_inbound_events"("companyId", "receivedAt");

ALTER TABLE "sales" ADD COLUMN "channelId" TEXT;
ALTER TABLE "sales" ADD CONSTRAINT "sales_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: empresa + filial ----------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_channels','channel_events','external_orders','channel_inbound_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_isolation', t);
  END LOOP;
END $$;
