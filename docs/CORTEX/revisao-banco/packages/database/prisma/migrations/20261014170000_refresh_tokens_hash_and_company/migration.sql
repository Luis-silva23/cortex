-- refresh_tokens: hash do token, empresa preenchida e RLS de verdade (2026-10-14, revisão do banco — achado D-01, gravidade Alta).
-- PROBLEMAS (provados antes): (1) a coluna "token" guardava o refresh token EM TEXTO — quem lesse a tabela ou um backup obtinha sessões
-- utilizáveis por 7 dias; (2) "companyId" era NULO em 100% das linhas (136/136 no dev) e a policy aceitava "companyId IS NULL" para qualquer
-- sessão: uma sessão de EMPRESA enxergava (e poderia alterar/apagar) as sessões de todas as empresas e as do Super Admin.
-- ESTRATÉGIA (sem derrubar sessão legítima — o mesmo token continua achando a mesma linha):
--   1. nova coluna "tokenHash" = SHA-256 (hex) do token, calculada em SQL com o MESMO algoritmo da aplicação
--      (encode(sha256(convert_to(token,'UTF8')),'hex') == createHash('sha256').update(token,'utf8').digest('hex'));
--   2. "companyId" preenchido SÓ a partir de users."companyId" (a única relação confiável: refresh_tokens.userId → users); sessão de usuário de
--      plataforma (users."companyId" nulo) continua com companyId nulo, visível só ao Super Admin. Nada é "adivinhado": se algum token já tiver
--      companyId diferente do usuário, a migration ABORTA (investigar), em vez de sobrescrever;
--   3. a coluna "token" (texto) é REMOVIDA depois de conferido que todas as linhas têm hash — é a remoção deliberada do segredo em texto;
--   4. FK "companyId" → companies (CASCADE: a sessão morre com a empresa) e FK composta ("companyId","userId") → users("companyId","id")
--      (a sessão de um usuário não pode ser gravada em empresa que não é a dele; a FK simples userId → users continua para as de plataforma);
--   5. policy: Super Admin OU a própria empresa (sem o ramo "companyId IS NULL").
-- A migration roda como DONO sob FORCE RLS: sem contexto o dono enxerga ZERO linhas (e a validação das FKs passaria em branco), por isso a
-- 1ª instrução põe o contexto de plataforma NESTA transação.
-- COMPATIBILIDADE: a aplicação nova busca por "tokenHash". Voltar o código sem o banco quebra a renovação das sessões abertas (precisariam
-- entrar de novo); o banco não volta ao texto — o hash não permite reconstruir o token.
-- ROLLBACK (parcial, sem recuperar o texto dos tokens — as sessões abertas caem e a pessoa entra de novo):
--   DROP POLICY "refresh_tokens_isolation" ON "refresh_tokens";
--   CREATE POLICY "refresh_tokens_isolation" ON "refresh_tokens" USING (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL)) WITH CHECK (is_super_admin() OR ("companyId" = get_current_company_id()) OR ("companyId" IS NULL));
--   ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_companyId_userId_fkey", DROP CONSTRAINT "refresh_tokens_companyId_fkey";
--   DROP INDEX "users_companyId_id_key";
--   ALTER TABLE "refresh_tokens" ADD COLUMN "token" TEXT; UPDATE "refresh_tokens" SET "token" = "id" || '-revogado'; UPDATE "refresh_tokens" SET "isRevoked" = true;
--   ALTER TABLE "refresh_tokens" ALTER COLUMN "token" SET NOT NULL; CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token"); CREATE INDEX "refresh_tokens_token_idx" ON "refresh_tokens"("token");
--   DROP INDEX "refresh_tokens_tokenHash_key"; ALTER TABLE "refresh_tokens" DROP COLUMN "tokenHash";

SELECT set_config('app.user_type', 'SUPER_ADMIN', true);

-- 1. hash do token (as sessões abertas continuam valendo)
ALTER TABLE "refresh_tokens" ADD COLUMN "tokenHash" TEXT;
UPDATE "refresh_tokens" SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');

-- 2. empresa: só a do usuário dono da sessão
UPDATE "refresh_tokens" rt SET "companyId" = u."companyId" FROM "users" u WHERE u."id" = rt."userId" AND rt."companyId" IS NULL AND u."companyId" IS NOT NULL;

-- 3. conferências: nada de linha sem hash, nada de empresa divergente do usuário, nenhuma sessão de empresa sem empresa
DO $$
DECLARE
  n_sem_hash integer;
  n_diverge integer;
  n_sem_empresa integer;
BEGIN
  SELECT count(*) INTO n_sem_hash FROM "refresh_tokens" WHERE "tokenHash" IS NULL OR length("tokenHash") <> 64;
  SELECT count(*) INTO n_diverge FROM "refresh_tokens" rt JOIN "users" u ON u."id" = rt."userId" WHERE rt."companyId" IS NOT NULL AND rt."companyId" IS DISTINCT FROM u."companyId";
  SELECT count(*) INTO n_sem_empresa FROM "refresh_tokens" rt JOIN "users" u ON u."id" = rt."userId" WHERE rt."companyId" IS NULL AND u."companyId" IS NOT NULL;
  IF n_sem_hash > 0 OR n_diverge > 0 OR n_sem_empresa > 0 THEN
    RAISE EXCEPTION 'refresh_tokens inconsistente: % sem hash, % com empresa diferente da do usuário, % de usuário de empresa ainda sem empresa — investigar antes de aplicar (nada foi alterado: a migration foi desfeita)', n_sem_hash, n_diverge, n_sem_empresa;
  END IF;
END $$;

ALTER TABLE "refresh_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- 3b. o segredo em texto sai do banco (leva junto os índices refresh_tokens_token_key e refresh_tokens_token_idx)
ALTER TABLE "refresh_tokens" DROP COLUMN "token";

-- 4. integridade empresa × usuário
CREATE UNIQUE INDEX "users_companyId_id_key" ON "users"("companyId", "id");
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_companyId_userId_fkey" FOREIGN KEY ("companyId", "userId") REFERENCES "users"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. RLS: Super Admin ou a própria empresa (sessão de plataforma, companyId nulo, só o Super Admin)
DROP POLICY "refresh_tokens_isolation" ON "refresh_tokens";
CREATE POLICY "refresh_tokens_isolation" ON "refresh_tokens" USING (rls_company_match("companyId")) WITH CHECK (rls_company_match("companyId"));
