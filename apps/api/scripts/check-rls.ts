/**
 * Verificador de INVARIANTES de RLS — somente leitura (catálogo do Postgres), roda contra QUALQUER banco.
 *
 *   npm run db:check-rls                                   # banco do DATABASE_URL (dev)
 *   DATABASE_URL=postgresql://…/prod npm run db:check-rls   # staging/produção após `prisma migrate deploy`
 *
 * Motivo: uma correção crítica de RLS (ex.: 20260921120000_branch_rls_for_derived_financial) só vale se estiver
 * aplicada em TODOS os ambientes; `migrate deploy` aplica, mas nada conferia o resultado. Sai com código 1 se
 * qualquer invariante falhar. Também é usado pelo teste de integração rls-invariants.integration.test.ts.
 */
export interface QueryClient {
  $queryRawUnsafe: (sql: string) => Promise<any>;
}

const REQUIRED_FUNCTIONS = ['rls_company_match', 'rls_company_branch_match', 'is_super_admin', 'is_company_wide_role', 'get_current_company_id'];

export async function checkRlsInvariants(db: QueryClient): Promise<string[]> {
  const findings: string[] = [];
  const q = async <T = any>(sql: string): Promise<T[]> => (await db.$queryRawUnsafe(sql)) as T[];

  // 1) toda tabela (exceto o controle de migrações) com RLS habilitado E FORÇADO
  const noRls = await q<{ relname: string; rls: boolean; frc: boolean }>(`
    SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS frc
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity) ORDER BY 1`);
  for (const t of noRls) findings.push(`tabela ${t.relname}: RLS ${t.rls ? 'habilitado' : 'DESABILITADO'} / FORCE ${t.frc ? 'ativo' : 'AUSENTE'}`);

  // 2) toda tabela com coluna companyId tem ao menos uma policy
  const noPolicy = await q<{ table_name: string }>(`
    SELECT DISTINCT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'companyId' AND c.table_name <> '_prisma_migrations'
      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.table_name) ORDER BY 1`);
  for (const t of noPolicy) findings.push(`tabela ${t.table_name}: tem companyId mas NENHUMA policy`);

  // 3) a role de conexão não pode ignorar RLS
  const role = await q<{ usr: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT current_user AS usr, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  );
  if (role[0]?.rolsuper) findings.push(`a role de conexão "${role[0].usr}" é SUPERUSER: RLS não se aplica a ela`);
  if (role[0]?.rolbypassrls) findings.push(`a role de conexão "${role[0].usr}" tem BYPASSRLS: RLS não se aplica a ela`);

  // 4) funções que as policies usam
  const fns = await q<{ proname: string }>(
    `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN (${REQUIRED_FUNCTIONS.map((f) => `'${f}'`).join(',')})`
  );
  const have = new Set(fns.map((f) => f.proname));
  for (const f of REQUIRED_FUNCTIONS) if (!have.has(f)) findings.push(`função ${f} ausente`);

  // 5) migration 20260921120000: registros financeiros derivados isolam POR FILIAL
  const pol = await q<{ tablename: string; qual: string | null }>(
    `SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('payments','mechanic_commissions','accounts_payable','accounts_receivable')`
  );
  const expect: Record<string, RegExp> = {
    payments: /public\.sales|FROM sales/i,
    mechanic_commissions: /public\.service_orders|FROM service_orders/i,
    // a forma da policy mudou na migração 20261017100000 (helpers chamados como sub-select): vale a antiga ou a nova
    accounts_payable: /rls_company_branch_match|app_ctx\.branch_ids/i,
    accounts_receivable: /rls_company_branch_match|app_ctx\.branch_ids/i,
  };
  for (const [table, re] of Object.entries(expect)) {
    const rows = pol.filter((p) => p.tablename === table);
    if (rows.length === 0) findings.push(`${table}: sem policy`);
    else if (!rows.some((p) => re.test(p.qual ?? ''))) findings.push(`${table}: a policy NÃO isola por filial (migration 20260921120000 não aplicada?)`);
  }

  // 6) CONTEXTO DE RLS ASSINADO (decisão 151, migração 20261017100000)
  const status = await q<{ enforced: boolean; secret_slots: number }>(`SELECT enforced, secret_slots FROM app_ctx.status()`).catch(() => []);
  if (status.length === 0) findings.push('contexto de RLS assinado ausente: app_ctx.status() não existe (migração 20261017100000 não aplicada?)');
  else {
    const allowLegacy = process.env.CHECK_RLS_ALLOW_LEGACY === 'true';
    if (!status[0].enforced && !allowLegacy) findings.push('o banco NÃO exige contexto de RLS assinado (app_ctx.settings.enforced = false): rode `npm run db:provision-context` com RLS_CONTEXT_SECRET');
    if (status[0].enforced && Number(status[0].secret_slots) === 0) findings.push('o banco exige contexto assinado mas não há segredo provisionado: toda consulta é negada');

    // nenhuma policy chama helper ANTIGO (por linha, lento): tudo deve estar na forma de sub-select escalar de app_ctx.*
    const legacyRe = /(rls_company_(match|branch_match|branch_write)|is_super_admin|is_company_wide_role|get_current_(company_id|branch_id|user_type))\s*\(/;
    const allPolicies = await q<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'`
    );
    for (const p of allPolicies) {
      const text = `${p.qual ?? ''} ${p.with_check ?? ''}`.replace(/app_ctx\.[a-z_]+\(\)/g, '');
      if (legacyRe.test(text)) findings.push(`policy ${p.tablename}.${p.policyname} ainda chama um helper antigo por linha: rode SELECT app_ctx.rewrite_policies() no fim da migração`);
      if (/current_setting\(\s*'app\.(user_type|current_company_id|current_branch_id|current_branch_ids|user_id)'/.test(text)) {
        findings.push(`policy ${p.tablename}.${p.policyname} lê a variável de sessão CRUA (forjável): use app_ctx.*`);
      }
    }

    // o cofre e as funções administrativas não podem ser acessíveis ao PUBLIC (nem ao papel de execução)
    const vaultPublic = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.relnamespace IN ('app_ctx_vault'::regnamespace, 'app_ctx'::regnamespace) AND c.relkind = 'r' AND a.grantee = 0`
    ).catch(() => [{ n: 0 }]);
    if (Number(vaultPublic[0]?.n) > 0) findings.push('tabela do schema app_ctx/app_ctx_vault concedida ao PUBLIC (o segredo e a configuração não podem ser lidos pelo papel de execução)');
    const adminOpen = await q<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app_ctx'::regnamespace AND p.proname IN ('provision', 'retire_previous', 'rewrite_policies', '_inline_helpers')
         AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`
    ).catch(() => []);
    for (const f of adminOpen) findings.push(`função administrativa app_ctx.${f.proname} executável pelo PUBLIC (só o dono pode provisionar/reescrever)`);
    const unsafeDefiner = await q<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app_ctx'::regnamespace AND p.prosecdef AND NOT (coalesce(p.proconfig::text, '') LIKE '%search_path=%')`
    ).catch(() => []);
    for (const f of unsafeDefiner) findings.push(`função SECURITY DEFINER app_ctx.${f.proname} sem search_path fixo (sequestro por schema)`);
    // o papel de execução (conexão atual) não pode ler o cofre nem a configuração
    const canReadVault = await q<{ ok: boolean }>(`SELECT has_table_privilege(current_user, 'app_ctx_vault.secrets', 'SELECT') AS ok`).catch(() => [{ ok: false }]);
    if (canReadVault[0]?.ok && !role[0]?.rolsuper) {
      const owns = await q<{ ok: boolean }>(`SELECT (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app_ctx_vault.secrets'::regclass) = current_user AS ok`);
      if (!owns[0]?.ok) findings.push('o papel da conexão consegue LER o cofre de segredos do contexto de RLS (app_ctx_vault.secrets)');
    }
  }

  return findings;
}

async function main() {
  const dotenv = await import('dotenv');
  const path = await import('path');
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient();
  try {
    const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
    const findings = await checkRlsInvariants(client as unknown as QueryClient);
    if (findings.length === 0) {
      console.log(`[check-rls] "${dbName}": todas as invariantes de RLS OK`);
    } else {
      console.error(`[check-rls] "${dbName}": ${findings.length} problema(s):\n - ${findings.join('\n - ')}`);
      process.exitCode = 1;
    }
  } finally {
    await client.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
