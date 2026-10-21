-- Anti-reuso de código TOTP (decisão 123, 2026-10-14). ADITIVA: uma coluna anulável; nada existente é alterado.
--  * users."mfaLastStep" guarda o último passo TOTP de 30 s já consumido; a aplicação recusa código de passo igual ou anterior
--    (atualização condicional atômica: duas requisições com o mesmo código não passam as duas).
-- ROLLBACK: ALTER TABLE "users" DROP COLUMN "mfaLastStep";
ALTER TABLE "users" ADD COLUMN "mfaLastStep" INTEGER;
