-- Autorização de dispositivos (2026-10-06): enrolamento sem empresa, vínculo a licença e filial feito pelo administrador, chave do
-- equipamento (guardada só como hash) e sessão de login presa à sessão de equipamento.
-- Aditiva e compatível: os equipamentos existentes têm licença e ficam como estão (sem chave = legado, a reenrolar).
-- ROLLBACK (nesta ordem, só se NENHUM equipamento sem licença existir):
--   ALTER TABLE devices DROP CONSTRAINT devices_active_needs_license_check;
--   DROP INDEX "refresh_tokens_deviceSessionId_idx", "devices_enrollmentCode_key";
--   ALTER TABLE refresh_tokens DROP COLUMN "deviceSessionId";
--   ALTER TABLE devices DROP COLUMN "enrollmentCode", DROP COLUMN "secretHash", DROP COLUMN "branchId";
--   -- só sem equipamentos pendentes sem licença: ALTER TABLE devices ALTER COLUMN "licenseId" SET NOT NULL;

ALTER TABLE "devices" ALTER COLUMN "licenseId" DROP NOT NULL;
ALTER TABLE "devices" ADD COLUMN "branchId" TEXT, ADD COLUMN "secretHash" TEXT, ADD COLUMN "enrollmentCode" TEXT;
CREATE UNIQUE INDEX "devices_enrollmentCode_key" ON "devices"("enrollmentCode");

-- Equipamento sem licença só pode estar aguardando autorização (ou já recusado): ativo exige empresa (via licença).
ALTER TABLE "devices" ADD CONSTRAINT "devices_active_needs_license_check" CHECK ("status" <> 'ACTIVE' OR "licenseId" IS NOT NULL);

ALTER TABLE "refresh_tokens" ADD COLUMN "deviceSessionId" TEXT;
CREATE INDEX "refresh_tokens_deviceSessionId_idx" ON "refresh_tokens"("deviceSessionId");
