-- Versão do runtime (Electron/Node/Chrome) separada da versão do app CÓRTEX: o PDV não empacotado reportava a
-- versão do Electron (28.3.3) em `appVersion`.
ALTER TABLE "device_telemetry" ADD COLUMN "runtimeVersion" TEXT;
