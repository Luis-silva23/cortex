-- Fase 2 da Commerce API (2026-10-05): reserva de estoque, venda de canal sem caixa físico e fulfillment mínimo.
-- Aditiva. Venda física continua exigindo usuário e caixa: o CHECK só libera `userId`/`cashRegisterId` nulos quando há `channelId`
-- (todas as linhas existentes têm os dois preenchidos e nenhum canal, então satisfazem o CHECK).
-- ROLLBACK (nesta ordem): DROP TABLE fulfillments, stock_reservations;
--   ALTER TABLE external_payments DROP COLUMN method;
--   ALTER TABLE external_orders DROP CONSTRAINT external_orders_saleId_fkey, DROP COLUMN acceptedAt, acceptedBy, convertedAt;
--   ALTER TABLE sales DROP CONSTRAINT sales_physical_origin_check;
--   -- só se NENHUMA venda de canal existir: ALTER TABLE sales ALTER COLUMN "userId" SET NOT NULL, ALTER COLUMN "cashRegisterId" SET NOT NULL;
--   DROP TYPE "FulfillmentStatus", "FulfillmentType", "StockReservationStatus".
--   (O valor 'EXPIRED' de "ExternalOrderStatus" não é removível sem recriar o tipo.)

ALTER TYPE "ExternalOrderStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');
CREATE TYPE "FulfillmentType" AS ENUM ('PICKUP', 'OWN_DELIVERY', 'CHANNEL_DELIVERY');
CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING', 'READY', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED', 'CANCELLED');

-- Venda de canal: sem caixa físico e sem operador presumido (só com canal) ---------------------------------------------------
ALTER TABLE "sales" ALTER COLUMN "userId" DROP NOT NULL, ALTER COLUMN "cashRegisterId" DROP NOT NULL;
ALTER TABLE "sales" ADD CONSTRAINT "sales_physical_origin_check"
  CHECK ("channelId" IS NOT NULL OR ("cashRegisterId" IS NOT NULL AND "userId" IS NOT NULL));

ALTER TABLE "external_orders" ADD COLUMN "acceptedAt" TIMESTAMP(3),
ADD COLUMN "acceptedBy" TEXT,
ADD COLUMN "convertedAt" TIMESTAMP(3);
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "external_payments" ADD COLUMN "method" "PaymentMethod" NOT NULL DEFAULT 'OTHER';

CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_reservations_quantity_positive" CHECK ("quantity" > 0)
);

CREATE TABLE "fulfillments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "type" "FulfillmentType",
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusChangedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_reservations_orderId_productId_key" ON "stock_reservations"("orderId", "productId");
CREATE INDEX "stock_reservations_branchId_productId_status_idx" ON "stock_reservations"("branchId", "productId", "status");
CREATE INDEX "stock_reservations_status_expiresAt_idx" ON "stock_reservations"("status", "expiresAt");
CREATE INDEX "stock_reservations_companyId_idx" ON "stock_reservations"("companyId");
CREATE UNIQUE INDEX "fulfillments_orderId_key" ON "fulfillments"("orderId");
CREATE UNIQUE INDEX "fulfillments_saleId_key" ON "fulfillments"("saleId");
CREATE INDEX "fulfillments_companyId_status_idx" ON "fulfillments"("companyId", "status");

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "external_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "external_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: empresa + filial -------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_reservations','fulfillments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_isolation', t);
  END LOOP;
END $$;
