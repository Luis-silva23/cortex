-- Confirmação do agendamento = aceite do CLIENTE/responsável pelo veículo. Antes só o funcionário ficava registrado
-- (performedBy); agora a confirmação guarda quem confirmou e por qual canal. Confirmações antigas ficam nulas.
ALTER TABLE "appointments" ADD COLUMN "confirmationChannel" "ContactChannel";
ALTER TABLE "appointments" ADD COLUMN "confirmedByName" TEXT;
