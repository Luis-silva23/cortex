import { runWithRLSContext } from '@ln-system/database';
import { UserService } from '../../src/services/user.service';
import { AuthService } from '../../src/services/auth.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Regressão real (Postgres real) para o achado de PRE-PRODUCTION HARDENING
 * (Banco/RLS): `User.email` é `@unique` case-sensitive no Postgres, mas os
 * formulários de login de admin-web/super-admin são `<input type="email">`
 * comuns — nenhum navegador normaliza a caixa digitada. Antes desta
 * correção, um usuário cadastrado como "Joao@Empresa.com" que digitasse
 * "joao@empresa.com" no login recebia "Credenciais inválidas" com a senha
 * certa. Corrigido em user.service.ts (create/update) e auth.service.ts
 * (login) via `normalizeEmail()` (packages/shared/utils/email.ts).
 */
describe('Login é case-insensitive para e-mail (regressão real)', () => {
  const userService = new UserService();
  const authService = new AuthService();
  let fixture: IntegrationFixture;
  let createdUserId: string;

  beforeAll(async () => {
    fixture = await createFixture('email-case');
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it('grava o e-mail em minúsculas mesmo quando o cliente envia caixa mista', async () => {
    const created = await runWithRLSContext(
      { companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: fixture.branchId },
      () =>
        userService.create({
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          name: 'Usuário Caixa Mista',
          email: `MisturaDeCaixa.${Date.now()}@Test.Local`,
          password: 'CaseTest123!',
          userType: 'OPERATOR',
          requirePasswordChange: false,
        } as any)
    );
    createdUserId = created.id;
    expect(created.email).toBe(created.email.toLowerCase());
  });

  it('permite login com uma caixa DIFERENTE da usada no cadastro', async () => {
    const created = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const { prisma } = await import('@ln-system/database');
      return prisma.user.findUniqueOrThrow({ where: { id: createdUserId } });
    });

    // O e-mail salvo já está em minúsculas — login com TODA maiúscula
    // precisa funcionar exatamente como o cadastro original.
    const result = await authService.login(
      { email: created.email.toUpperCase(), password: 'CaseTest123!' },
      '127.0.0.1',
      'jest-integration-test'
    );

    expect('accessToken' in result).toBe(true);
  });
});
