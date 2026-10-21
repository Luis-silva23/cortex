-- Fase 2 da Commerce API (2026-10-05): `stock_movements.userId` passa a aceitar nulo. Só o movimento SALE de uma venda de canal
-- convertida sem operador o usa; todo movimento físico (PDV, balcão, OS, transferência, ajuste…) continua gravando o usuário.
-- Aditiva: nenhuma linha existente muda.
-- ROLLBACK (só se nenhum movimento tiver userId nulo): ALTER TABLE "stock_movements" ALTER COLUMN "userId" SET NOT NULL;

ALTER TABLE "stock_movements" ALTER COLUMN "userId" DROP NOT NULL;
