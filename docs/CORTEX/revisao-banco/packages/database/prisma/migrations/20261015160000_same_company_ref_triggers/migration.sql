-- MESMA EMPRESA NAS 3 REFERÊNCIAS QUE NÃO PODEM TER FK COMPOSTA (2026-10-15, revisão do banco — achado C-02, resíduo).
-- PROBLEMA: sales.partnerId (SET NULL; a aplicação apaga convênios), service_orders.mechanicId (SET NULL; a aplicação apaga usuários) e users.branchId
-- (companyId pode ser NULO para usuário de plataforma) têm FK SIMPLES — que não olha a empresa, e a RLS não passa pela checagem de FK: uma sessão da
-- empresa A conseguia gravar venda com convênio da B, OS com mecânico da B, usuário da A com filial da B. O Prisma não modela FK composta com SET NULL
-- parcial (anularia o companyId) e a exclusão precisa continuar anulando só a coluna da referência — por isso a regra vai num TRIGGER, não numa FK.
-- REGRA: BEFORE INSERT/UPDATE da coluna: se a linha tem empresa e a referência não é nula, o registro referenciado precisa existir NA MESMA empresa; senão
-- ERRO 23503 (foreign_key_violation → P2003 no Prisma), igual a uma FK. Roda como o chamador (a RLS vale): quem não enxerga o pai (outra empresa/filial) também recebe o erro.
-- GUARDA: se já houver linha violando a regra, a migração ABORTA listando as contagens (nunca corrige por suposição).
-- ROLLBACK: DROP TRIGGER <nome> ON <tabela>; DROP FUNCTION enforce_same_company_ref().

SELECT set_config('app.user_type', 'SUPER_ADMIN', true);

DO $$
DECLARE
  n bigint;
  total bigint := 0;
  msg text := '';
BEGIN
  SELECT count(*) INTO n FROM sales s WHERE s."partnerId" IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = s."companyId")
    AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.id = s."partnerId" AND p."companyId" = s."companyId");
  IF n > 0 THEN msg := msg || format('sales.partnerId: %s; ', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM service_orders o WHERE o."mechanicId" IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = o."companyId")
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o."mechanicId" AND u."companyId" = o."companyId");
  IF n > 0 THEN msg := msg || format('service_orders.mechanicId: %s; ', n); total := total + n; END IF;
  SELECT count(*) INTO n FROM users u WHERE u."branchId" IS NOT NULL AND u."companyId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = u."branchId" AND b."companyId" = u."companyId");
  IF n > 0 THEN msg := msg || format('users.branchId: %s; ', n); total := total + n; END IF;
  IF total > 0 THEN
    RAISE EXCEPTION 'triggers de mesma empresa abortados: % linha(s) já violam a regra — %. Corrija por procedimento documentado (nunca por suposição) e reaplique.', total, msg;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_same_company_ref() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  fk_col text := TG_ARGV[1];
  fk_val text := to_jsonb(NEW) ->> TG_ARGV[1];
  row_company text := to_jsonb(NEW) ->> 'companyId';
  parent_company text;
BEGIN
  IF fk_val IS NULL OR row_company IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT "companyId"::text FROM %I WHERE id = $1', parent_table) INTO parent_company USING fk_val;
  IF parent_company IS DISTINCT FROM row_company THEN
    RAISE EXCEPTION '% de % deve referenciar registro da MESMA empresa (% inexistente ou de outra empresa)', fk_col, TG_TABLE_NAME, parent_table
      USING ERRCODE = 'foreign_key_violation', TABLE = TG_TABLE_NAME, COLUMN = fk_col;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "sales_partner_same_company" BEFORE INSERT OR UPDATE OF "partnerId", "companyId" ON "sales"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_company_ref('partners', 'partnerId');
CREATE TRIGGER "service_orders_mechanic_same_company" BEFORE INSERT OR UPDATE OF "mechanicId", "companyId" ON "service_orders"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_company_ref('users', 'mechanicId');
CREATE TRIGGER "users_branch_same_company" BEFORE INSERT OR UPDATE OF "branchId", "companyId" ON "users"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_company_ref('branches', 'branchId');
