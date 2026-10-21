-- Provedor externo que processou o pagamento (reconciliação consulta o mesmo provedor, mesmo que a configuração mude).
ALTER TABLE "payments" ADD COLUMN "provider" TEXT;
