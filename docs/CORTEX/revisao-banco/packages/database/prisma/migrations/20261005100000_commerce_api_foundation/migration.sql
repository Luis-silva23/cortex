-- Commerce API, Fase 1 (2026-10-05): credenciais de canal (servidor -> servidor), publicação de produtos por canal, itens do pedido
-- externo e pagamento externo. Aditiva: nenhuma linha existente muda (colunas novas de `external_orders` têm padrão).
-- RISCO: nenhum. Estes objetos só são usados pela Commerce API (`/commerce/v1`), que nasce sem nenhuma credencial emitida.
-- ROLLBACK (nesta ordem): DROP TABLE external_payments, external_order_items, channel_product_links, channel_api_credentials;
--   ALTER TABLE external_orders DROP COLUMN totalAmount, channelTotal, source, correlationId, statusReason, statusChangedAt;
--   DROP TYPE "ChannelCredentialScope".
-- (As quatro tabelas só têm dados se a Commerce API foi usada; o rollback as descarta — exporte antes.)

CREATE TYPE "ChannelCredentialScope" AS ENUM ('CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE');

ALTER TABLE "external_orders" ADD COLUMN     "channelTotal" DECIMAL(12,2),
ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'WEBHOOK',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "totalAmount" DECIMAL(12,2);

CREATE TABLE "channel_api_credentials" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "secretHint" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scopes" "ChannelCredentialScope"[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_api_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_product_links" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "externalId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_product_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_order_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "channelUnitPrice" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "external_order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_order_items_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "external_order_items_prices_nonnegative" CHECK ("unitPrice" >= 0 AND "channelUnitPrice" >= 0 AND "lineTotal" >= 0)
);

CREATE TABLE "external_payments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "channelId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "status" "ExternalPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CHANNEL_REPORTED',
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_payments_amount_nonnegative" CHECK ("amount" >= 0)
);

CREATE UNIQUE INDEX "channel_api_credentials_keyId_key" ON "channel_api_credentials"("keyId");
CREATE INDEX "channel_api_credentials_channelId_idx" ON "channel_api_credentials"("channelId");
CREATE INDEX "channel_api_credentials_companyId_idx" ON "channel_api_credentials"("companyId");
CREATE INDEX "channel_product_links_companyId_idx" ON "channel_product_links"("companyId");
CREATE INDEX "channel_product_links_channelId_published_idx" ON "channel_product_links"("channelId", "published");
CREATE UNIQUE INDEX "channel_product_links_channelId_productId_key" ON "channel_product_links"("channelId", "productId");
CREATE INDEX "external_order_items_orderId_idx" ON "external_order_items"("orderId");
CREATE INDEX "external_order_items_productId_idx" ON "external_order_items"("productId");
CREATE INDEX "external_payments_orderId_idx" ON "external_payments"("orderId");
CREATE INDEX "external_payments_companyId_status_idx" ON "external_payments"("companyId", "status");
CREATE UNIQUE INDEX "external_payments_channelId_providerRef_key" ON "external_payments"("channelId", "providerRef");

ALTER TABLE "channel_api_credentials" ADD CONSTRAINT "channel_api_credentials_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "channel_product_links" ADD CONSTRAINT "channel_product_links_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "channel_product_links" ADD CONSTRAINT "channel_product_links_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_order_items" ADD CONSTRAINT "external_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "external_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_order_items" ADD CONSTRAINT "external_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_payments" ADD CONSTRAINT "external_payments_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_payments" ADD CONSTRAINT "external_payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "external_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: empresa + filial (mesma regra das tabelas de canal) ---------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_api_credentials','channel_product_links','external_order_items','external_payments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_isolation', t);
  END LOOP;
END $$;
