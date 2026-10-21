-- CONTEXTO DE RLS ASSINADO (2026-10-17, decisão 151) — mitigação do risco "SQL arbitrário na conexão da API escolhe o contexto da RLS".
-- PROBLEMA (documentado na decisão 132 e provado antes): as policies leem variáveis de sessão (`app.user_type`, `app.current_company_id`, `app.current_branch_id`) que
-- qualquer comando SQL executado pelo papel de execução pode gravar com `set_config(...)`. Uma injeção de SQL (ou SQL cru com falha de filtro) virava
-- `set_config('app.user_type','SUPER_ADMIN',true)` e a RLS inteira deixava de valer.
-- CORREÇÃO: a aplicação ASSINA o contexto (HMAC-SHA256: empresa, filial ativa, filiais autorizadas, papel, usuário e instante) e o banco só o aceita se a assinatura conferir:
--   • `app_ctx_vault.secrets` guarda o segredo já derivado (ipad/opad do HMAC) num schema SEM privilégio para o papel de execução (nem leitura, nem escrita);
--   • `app_ctx._sig_ok()` (SECURITY DEFINER, search_path fixo) confere a assinatura, a janela de ±120 s (`transaction_timestamp()` × `iat`) e compara por hash (sem vazar prefixo por tempo);
--   • `app_ctx.company_id()/branch_id()/branch_ids()/user_type()/user_id()/is_super_admin()/is_company_wide()` devolvem o contexto SÓ se verificado (NULL/falso caso contrário ⇒ a RLS nega tudo);
--   • as 161 policies passam a chamar essas funções como sub-select escalar `(SELECT app_ctx.x())`, que o PostgreSQL avalia UMA vez por consulta (InitPlan) — medido: 200 mil linhas, 15 ms,
--     contra 4 300 ms se a verificação fosse repetida por linha; as funções antigas (`get_current_*`, `is_super_admin`, `rls_company_*`) continuam existindo e agora também VERIFICAM
--     (seguras, porém mais lentas por linha — uma policy nova deve chamar `SELECT app_ctx.rewrite_policies();` no fim da migração para ser reescrita na forma rápida).
--   • filiais autorizadas passam a ser um CONJUNTO (`app.current_branch_ids`, assinado); sem a lista, vale só a filial ativa (comportamento anterior).
-- ENFORCEMENT EM DOIS PASSOS (rollout seguro): esta migração NÃO liga a exigência. Enquanto `app_ctx.settings.enforced` for falso o banco aceita o contexto cru (comportamento de hoje).
-- A exigência liga quando o DONO executa `SELECT app_ctx.provision(<segredo>)` (passo operacional: docs/CORTEX/RLS_CONTEXTO_ASSINADO.md) — a API em produção RECUSA subir se não estiver ligada.
-- LIMITES: quem executa código DENTRO do processo da API tem o segredo; quem só injeta SQL numa requisição fica com o contexto daquela requisição (não vira outro usuário, papel ou empresa).
-- O segredo NÃO entra no backup (`pg_dump --exclude-schema=app_ctx_vault`): depois de restaurar é preciso `app_ctx.provision` de novo (até lá, tudo negado — falha fechada).
-- NÃO ALTERA dados de negócio, tabelas de negócio, módulos nem permissões; só funções, schemas novos e policies (mesma semântica, outra forma de escrever).
-- ROLLBACK: `UPDATE app_ctx.settings SET enforced = false;` (volta a aceitar contexto cru) e, para desfazer a forma das policies, recriá-las pelas migrações 0_init, 20261014162000,
-- 20261016100000 e 20261016110000; `DROP SCHEMA app_ctx CASCADE; DROP SCHEMA app_ctx_vault CASCADE;` só depois de recriar as funções antigas.

CREATE SCHEMA IF NOT EXISTS app_ctx;
CREATE SCHEMA IF NOT EXISTS app_ctx_vault;
REVOKE ALL ON SCHEMA app_ctx_vault FROM PUBLIC;
GRANT USAGE ON SCHEMA app_ctx TO PUBLIC;

CREATE TABLE app_ctx.settings (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enforced   boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_ctx.settings DEFAULT VALUES;
REVOKE ALL ON TABLE app_ctx.settings FROM PUBLIC;

CREATE TABLE app_ctx_vault.secrets (
  slot       smallint PRIMARY KEY CHECK (slot IN (1, 2)),
  ipad       bytea NOT NULL CHECK (length(ipad) = 64),
  opad       bytea NOT NULL CHECK (length(opad) = 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE app_ctx_vault.secrets FROM PUBLIC;

-- 1. verificação da assinatura ----------------------------------------------------------------------------------------------------------
-- mensagem = v1|iat|empresa|filial|filiais|papel|usuario (mesmo contrato de packages/database/src/context-signing.ts); HMAC = sha256(opad || sha256(ipad || msg)).
CREATE OR REPLACE FUNCTION app_ctx._sig_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE
    WHEN NOT (SELECT enforced FROM app_ctx.settings) THEN true
    ELSE coalesce((
      SELECT true
      FROM app_ctx_vault.secrets s
      WHERE CASE
              WHEN current_setting('app.ctx_sig', true) ~ '^[0-9a-f]{64}$' AND current_setting('app.ctx_iat', true) ~ '^[0-9]{9,12}$'
              THEN abs(extract(epoch FROM transaction_timestamp()) - current_setting('app.ctx_iat', true)::numeric) <= 120
                   AND sha256(decode(current_setting('app.ctx_sig', true), 'hex')) = sha256(sha256(s.opad || sha256(s.ipad || convert_to(
                         'v1|' || current_setting('app.ctx_iat', true)
                         || '|' || coalesce(current_setting('app.current_company_id', true), '')
                         || '|' || coalesce(current_setting('app.current_branch_id', true), '')
                         || '|' || coalesce(current_setting('app.current_branch_ids', true), '')
                         || '|' || coalesce(current_setting('app.user_type', true), '')
                         || '|' || coalesce(current_setting('app.user_id', true), ''), 'UTF8'))))
              ELSE false
            END
      LIMIT 1
    ), false)
  END
$fn$;

CREATE OR REPLACE FUNCTION app_ctx.company_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN NULLIF(current_setting('app.current_company_id', true), '') END $fn$;
CREATE OR REPLACE FUNCTION app_ctx.branch_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN NULLIF(current_setting('app.current_branch_id', true), '') END $fn$;
-- conjunto de filiais autorizadas: a lista assinada; sem lista, só a filial ativa (comportamento anterior); sem nenhuma, NULL
CREATE OR REPLACE FUNCTION app_ctx.branch_ids() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN
           CASE WHEN NULLIF(current_setting('app.current_branch_ids', true), '') IS NOT NULL THEN string_to_array(current_setting('app.current_branch_ids', true), ',')
                WHEN NULLIF(current_setting('app.current_branch_id', true), '') IS NOT NULL THEN ARRAY[current_setting('app.current_branch_id', true)]
           END
         END $fn$;
CREATE OR REPLACE FUNCTION app_ctx.user_type() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN NULLIF(current_setting('app.user_type', true), '') END $fn$;
CREATE OR REPLACE FUNCTION app_ctx.user_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN NULLIF(current_setting('app.user_id', true), '') END $fn$;
CREATE OR REPLACE FUNCTION app_ctx.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN coalesce(current_setting('app.user_type', true) = 'SUPER_ADMIN', false) ELSE false END $fn$;
CREATE OR REPLACE FUNCTION app_ctx.is_company_wide() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN app_ctx._sig_ok() THEN coalesce(current_setting('app.user_type', true) IN ('SUPER_ADMIN', 'COMPANY_ADMIN'), false) ELSE false END $fn$;

-- estado público (sem segredo): a API em produção confere antes de subir
CREATE OR REPLACE FUNCTION app_ctx.status() RETURNS TABLE (enforced boolean, secret_slots integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT s.enforced, (SELECT count(*)::integer FROM app_ctx_vault.secrets) FROM app_ctx.settings s $fn$;

-- 2. administração (SÓ o dono: sem EXECUTE para o papel de execução) ---------------------------------------------------------------------------
-- `provision`: grava o segredo (derivado em ipad/opad), mantém o anterior no slot 2 (rotação sem parada) e LIGA a exigência de assinatura.
CREATE OR REPLACE FUNCTION app_ctx.provision(p_secret bytea) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  k bytea; v_ipad bytea; v_opad bytea; i integer;
BEGIN
  IF p_secret IS NULL OR length(p_secret) < 32 OR length(p_secret) > 64 THEN
    RAISE EXCEPTION 'o segredo do contexto precisa ter entre 32 e 64 bytes';
  END IF;
  -- o cofre fica FORA do backup (`pg_dump --exclude-schema=app_ctx_vault`): depois de restaurar ele não existe — recria vazio, sem privilégio para ninguém
  CREATE SCHEMA IF NOT EXISTS app_ctx_vault;
  REVOKE ALL ON SCHEMA app_ctx_vault FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS app_ctx_vault.secrets (
    slot       smallint PRIMARY KEY CHECK (slot IN (1, 2)),
    ipad       bytea NOT NULL CHECK (length(ipad) = 64),
    opad       bytea NOT NULL CHECK (length(opad) = 64),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  REVOKE ALL ON TABLE app_ctx_vault.secrets FROM PUBLIC;
  k := p_secret || decode(repeat('00', 64 - length(p_secret)), 'hex');
  v_ipad := k; v_opad := k;
  FOR i IN 0..63 LOOP
    v_ipad := set_byte(v_ipad, i, get_byte(k, i) # 54);   -- 0x36
    v_opad := set_byte(v_opad, i, get_byte(k, i) # 92);   -- 0x5c
  END LOOP;
  -- idempotente: o mesmo segredo de novo (cada `up` do compose) não gira os slots
  IF EXISTS (SELECT 1 FROM app_ctx_vault.secrets WHERE slot = 1 AND ipad = v_ipad AND opad = v_opad) THEN
    UPDATE app_ctx.settings SET enforced = true, updated_at = now();
    RETURN;
  END IF;
  DELETE FROM app_ctx_vault.secrets WHERE slot = 2;
  UPDATE app_ctx_vault.secrets SET slot = 2 WHERE slot = 1;
  INSERT INTO app_ctx_vault.secrets (slot, ipad, opad) VALUES (1, v_ipad, v_opad);
  UPDATE app_ctx.settings SET enforced = true, updated_at = now();
END $fn$;

CREATE OR REPLACE FUNCTION app_ctx.retire_previous() RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $fn$
  DELETE FROM app_ctx_vault.secrets WHERE slot = 2 $fn$;

-- 3. forma rápida das policies ----------------------------------------------------------------------------------------------------------------
-- troca as chamadas dos helpers antigos por sub-selects escalares dos helpers verificados (InitPlan: uma verificação por consulta, não por linha)
CREATE OR REPLACE FUNCTION app_ctx._inline_helpers(p text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  t  text := p;
  nm constant text := '(?<![A-Za-z0-9_])(?<!app_ctx\.)(?:public\.)?';
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  t := regexp_replace(t, nm || 'rls_company_branch_match\(\s*([^(),]+?)\s*,\s*([^(),]+?)\s*\)',
       '((@@SA@@ OR \1 = @@CID@@) AND (@@SA@@ OR @@CW@@ OR \2 IS NULL OR \2 = ANY (@@BRS@@)))', 'g');
  t := regexp_replace(t, nm || 'rls_company_branch_write\(\s*([^(),]+?)\s*,\s*([^(),]+?)\s*\)',
       '((@@SA@@ OR \1 = @@CID@@) AND (@@SA@@ OR @@CW@@ OR (\2 IS NOT NULL AND \2 = ANY (@@BRS@@))))', 'g');
  t := regexp_replace(t, nm || 'rls_company_match\(\s*([^(),]+?)\s*\)', '(@@SA@@ OR \1 = @@CID@@)', 'g');
  t := regexp_replace(t, nm || 'is_super_admin\(\)', '@@SA@@', 'g');
  t := regexp_replace(t, nm || 'is_company_wide_role\(\)', '@@CW@@', 'g');
  t := regexp_replace(t, nm || 'get_current_company_id\(\)', '@@CID@@', 'g');
  t := regexp_replace(t, '=\s*' || nm || 'get_current_branch_id\(\)', '= ANY (@@BRS@@)', 'g');
  t := replace(t, '@@SA@@', '(SELECT app_ctx.is_super_admin())');
  t := replace(t, '@@CW@@', '(SELECT app_ctx.is_company_wide())');
  t := replace(t, '@@CID@@', '(SELECT app_ctx.company_id())');
  t := replace(t, '@@BRS@@', '(SELECT app_ctx.branch_ids())::text[]');
  IF regexp_replace(t, 'app_ctx\.[a-z_]+\(\)', '', 'g') ~ '(rls_company_[a-z_]+\(|is_super_admin\(|is_company_wide_role\(|get_current_[a-z_]+\()' THEN
    RAISE EXCEPTION 'policy com chamada de helper que não soube reescrever: %', left(t, 300);
  END IF;
  RETURN t;
END $fn$;

CREATE OR REPLACE FUNCTION app_ctx.rewrite_policies() RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  r record; q text; w text; stmt text; changed integer := 0;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname LOOP
    q := app_ctx._inline_helpers(r.qual);
    w := app_ctx._inline_helpers(r.with_check);
    IF q IS DISTINCT FROM r.qual OR w IS DISTINCT FROM r.with_check THEN
      stmt := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
      IF q IS NOT NULL THEN stmt := stmt || ' USING (' || q || ')'; END IF;
      IF w IS NOT NULL THEN stmt := stmt || ' WITH CHECK (' || w || ')'; END IF;
      EXECUTE stmt;
      changed := changed + 1;
    END IF;
  END LOOP;
  RETURN changed;
END $fn$;

REVOKE ALL ON FUNCTION app_ctx.provision(bytea), app_ctx.retire_previous(), app_ctx.rewrite_policies(), app_ctx._inline_helpers(text) FROM PUBLIC;

-- 4. helpers antigos: mesma assinatura, agora VERIFICADOS (usados por triggers e por SQL avulso; as policies já usam a forma rápida) ---------------------
CREATE OR REPLACE FUNCTION get_current_company_id() RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT app_ctx.company_id() $fn$;
CREATE OR REPLACE FUNCTION get_current_branch_id() RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT app_ctx.branch_id() $fn$;
CREATE OR REPLACE FUNCTION get_current_user_type() RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT app_ctx.user_type() $fn$;
CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT app_ctx.is_super_admin() $fn$;
CREATE OR REPLACE FUNCTION is_company_wide_role() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT app_ctx.is_company_wide() $fn$;
CREATE OR REPLACE FUNCTION rls_company_match(row_company_id text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT app_ctx.is_super_admin() OR row_company_id = app_ctx.company_id() $fn$;
CREATE OR REPLACE FUNCTION rls_company_branch_match(row_company_id text, row_branch_id text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT (app_ctx.is_super_admin() OR row_company_id = app_ctx.company_id())
     AND (app_ctx.is_super_admin() OR app_ctx.is_company_wide() OR row_branch_id IS NULL OR row_branch_id = ANY (app_ctx.branch_ids())) $fn$;
CREATE OR REPLACE FUNCTION rls_company_branch_write(row_company_id text, row_branch_id text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT (app_ctx.is_super_admin() OR row_company_id = app_ctx.company_id())
     AND (app_ctx.is_super_admin() OR app_ctx.is_company_wide() OR (row_branch_id IS NOT NULL AND row_branch_id = ANY (app_ctx.branch_ids()))) $fn$;

-- 5. reescreve as policies existentes na forma rápida -----------------------------------------------------------------------------------------
SELECT app_ctx.rewrite_policies();
