-- Dinheiro: valor recebido e troco por pagamento. `amount` passa a ser sempre o valor APLICADO à venda.
ALTER TABLE "payments" ADD COLUMN "receivedAmount" DECIMAL(10,2);
ALTER TABLE "payments" ADD COLUMN "changeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
