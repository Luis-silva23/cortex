import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { checkRlsInvariants } from '../../scripts/check-rls';

/**
 * Invariantes de RLS no banco de TESTE (migrado do zero por `prisma migrate deploy` — ver
 * scripts/prepare-test-db.ts): toda tabela com RLS habilitado e FORÇADO, toda tabela de tenant com policy, a
 * role de conexão sem SUPERUSER/BYPASSRLS, as funções `rls_*` presentes e a migration
 * 20260921120000 (pagamentos, comissões, contas a pagar/receber isolando por FILIAL) efetivamente aplicada.
 * O mesmo verificador roda contra staging/produção com `npm run db:check-rls`.
 */
describe('Invariantes de RLS (banco migrado do zero)', () => {
  it('nenhuma violação de RLS no banco de teste', async () => {
    const findings = await checkRlsInvariants(prismaUnsafeBypassRLS as any);
    expect(findings).toEqual([]);
  });

  it('o verificador REPROVA um banco sem a correção (prova de que ele detecta a ausência)', async () => {
    // banco simulado: as policies financeiras só isolam por empresa (estado anterior à migration 20260921120000)
    const fake = {
      $queryRawUnsafe: async (sql: string) => {
        if (/relrowsecurity/.test(sql)) return [];
        if (/information_schema/.test(sql)) return [];
        if (/pg_roles/.test(sql)) return [{ usr: 'x', rolsuper: false, rolbypassrls: false }];
        if (/pg_proc/.test(sql) && !/app_ctx/.test(sql)) {
          return ['rls_company_match', 'rls_company_branch_match', 'is_super_admin', 'is_company_wide_role', 'get_current_company_id'].map((proname) => ({ proname }));
        }
        // invariantes do contexto assinado (decisão 151): este banco simulado já tem a exigência ligada e nenhuma outra anomalia
        if (/app_ctx\.status/.test(sql)) return [{ enforced: true, secret_slots: 1 }];
        if (/policyname/.test(sql) || /aclexplode|has_table_privilege|prosecdef/.test(sql)) return [];
        return ['payments', 'mechanic_commissions', 'accounts_payable', 'accounts_receivable'].map((tablename) => ({
          tablename,
          qual: 'public.rls_company_match("companyId")',
        }));
      },
    };
    const findings = await checkRlsInvariants(fake);
    expect(findings).toHaveLength(4);
    expect(findings.join('\n')).toMatch(/NÃO isola por filial/);
  });
});
