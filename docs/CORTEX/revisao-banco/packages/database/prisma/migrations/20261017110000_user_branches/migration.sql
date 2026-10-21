-- VÍNCULOS DE FILIAL DO USUÁRIO (2026-10-17, decisão 153) — gerente de UMA ou de VÁRIAS filiais.
-- PROBLEMA: o modelo só tinha `users.branchId` (uma filial). Um gerente responsável por duas filiais precisava de dois usuários ou de acesso empresarial.
-- CORREÇÃO (aditiva): `user_branches` guarda as filiais ADICIONAIS autorizadas. O conjunto autorizado de quem NÃO é de empresa inteira passa a ser
-- `users.branchId` (principal, como sempre) + as linhas desta tabela. O servidor calcula o conjunto a cada requisição a partir do banco (nunca do cliente) e o
-- assina no contexto da RLS (migração 20261017100000), então remover o vínculo revoga o acesso na próxima requisição.
-- NÃO MIGRA nem altera dado algum: quem já existe continua com a filial principal e nada mais.
--   • FK composta (companyId, userId) → users e (companyId, branchId) → branches: o vínculo só existe dentro da MESMA empresa (referência cruzada é recusada pelo banco);
--     CASCADE: o vínculo é configuração, não histórico (apagar usuário ou filial remove o vínculo; a auditoria de quem concedeu/retirou fica em `audit_logs`).
--   • RLS (forma rápida da migração anterior): leitura = administração vê a empresa; o usuário vê só as PRÓPRIAS linhas; escrita só SUPER_ADMIN/COMPANY_ADMIN.
--   • Trigger: vínculo só para papéis de filial (SUPER_ADMIN/COMPANY_ADMIN já enxergam a empresa inteira — vínculo seria ruído e confusão de auditoria).
-- ROLLBACK: DROP TABLE "user_branches"; DROP FUNCTION user_branches_guard(); (os usuários voltam a ter só a filial principal.)

CREATE TABLE "user_branches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "user_branches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_branches_companyId_branchId_idx" ON "user_branches"("companyId", "branchId");
CREATE UNIQUE INDEX "user_branches_userId_branchId_key" ON "user_branches"("userId", "branchId");

ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_companyId_branchId_fkey" FOREIGN KEY ("companyId", "branchId") REFERENCES "branches"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_branches" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_branches_select" ON "user_branches" FOR SELECT USING (
  (SELECT app_ctx.is_super_admin())
  OR ("companyId" = (SELECT app_ctx.company_id()) AND ((SELECT app_ctx.is_company_wide()) OR "userId" = (SELECT app_ctx.user_id())))
);
CREATE POLICY "user_branches_insert" ON "user_branches" FOR INSERT WITH CHECK (
  (SELECT app_ctx.is_super_admin()) OR ("companyId" = (SELECT app_ctx.company_id()) AND (SELECT app_ctx.is_company_wide()))
);
CREATE POLICY "user_branches_update" ON "user_branches" FOR UPDATE
  USING ((SELECT app_ctx.is_super_admin()) OR ("companyId" = (SELECT app_ctx.company_id()) AND (SELECT app_ctx.is_company_wide())))
  WITH CHECK ((SELECT app_ctx.is_super_admin()) OR ("companyId" = (SELECT app_ctx.company_id()) AND (SELECT app_ctx.is_company_wide())));
CREATE POLICY "user_branches_delete" ON "user_branches" FOR DELETE USING (
  (SELECT app_ctx.is_super_admin()) OR ("companyId" = (SELECT app_ctx.company_id()) AND (SELECT app_ctx.is_company_wide()))
);

-- vínculo só para papel de filial; a lógica fica no banco para valer também para SQL direto
CREATE OR REPLACE FUNCTION user_branches_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  t "UserType";
BEGIN
  SELECT "userType" INTO t FROM users WHERE id = NEW."userId";
  IF t IS NULL THEN
    RAISE EXCEPTION 'usuário não encontrado para o vínculo de filial' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF t IN ('SUPER_ADMIN', 'COMPANY_ADMIN') THEN
    RAISE EXCEPTION 'usuário de empresa inteira (%) já enxerga todas as filiais: não recebe vínculo de filial', t USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "user_branches_guard" BEFORE INSERT OR UPDATE ON "user_branches" FOR EACH ROW EXECUTE FUNCTION user_branches_guard();
