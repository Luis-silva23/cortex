-- TROCA DE SENHA PELO PRÓPRIO USUÁRIO E SENHA TEMPORÁRIA (2026-10-18, decisão 157).
-- PROBLEMA: só um administrador redefinia senha. Quem criava a conta de um cliente conhecia a senha dele para sempre, e o usuário não tinha como trocá-la sozinho.
-- CORREÇÃO (aditiva): `users.mustChangePassword` marca a senha como TEMPORÁRIA (definida por um administrador) — a API não emite sessão enquanto ela não for trocada — e
-- `users.passwordChangedAt` registra quando a senha mudou pela última vez.
-- NÃO MIGRA nem altera dado algum: os dois campos nascem `false`/`NULL` para todos os usuários existentes (nada passa a ser exigido de quem já tem conta).
-- `ADD COLUMN` com valor padrão constante é só metadado no PostgreSQL (sem reescrita da tabela, sem bloqueio longo).
-- GATILHO: `users_guard_privileged_columns` já impedia papel de filial de mudar tipo, empresa, filial e situação de usuário; passa a impedir também a SENHA e os dois campos novos
-- (um gerente comprometido não pode redefinir a senha de um colega nem desligar a exigência de troca). SUPER_ADMIN/COMPANY_ADMIN e o contexto de plataforma da autenticação seguem livres.
-- ROLLBACK: ALTER TABLE "users" DROP COLUMN "mustChangePassword", DROP COLUMN "passwordChangedAt"; e recriar `users_guard_privileged_columns` com a definição da migração 20261016110000.

ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION users_guard_privileged_columns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (is_super_admin() OR is_company_wide_role()) AND (
       NEW."userType" IS DISTINCT FROM OLD."userType"
    OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
    OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
    OR NEW."isActive" IS DISTINCT FROM OLD."isActive"
    OR NEW."password" IS DISTINCT FROM OLD."password"
    OR NEW."mustChangePassword" IS DISTINCT FROM OLD."mustChangePassword"
    OR NEW."passwordChangedAt" IS DISTINCT FROM OLD."passwordChangedAt"
  ) THEN
    RAISE EXCEPTION 'papel de filial não altera tipo, empresa, filial, situação nem a senha de usuário' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
