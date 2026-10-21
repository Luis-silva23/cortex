-- Provedor de cartão/PIX e terminal por empresa/filial; herança campo a campo (nulo = herda).
ALTER TABLE "payment_settings" ALTER COLUMN "cashDenominationControl" DROP NOT NULL;
ALTER TABLE "payment_settings" ALTER COLUMN "cashDenominationControl" DROP DEFAULT;
ALTER TABLE "payment_settings" ADD COLUMN "cardProvider" TEXT;
ALTER TABLE "payment_settings" ADD COLUMN "pixProvider" TEXT;
ALTER TABLE "payment_settings" ADD COLUMN "terminalId" TEXT;
