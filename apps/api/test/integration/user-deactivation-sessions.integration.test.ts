import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { AuthService } from '../../src/services/auth.service';
import { UserService } from '../../src/services/user.service';
import { isAccessTokenRevoked } from '../../src/services/access-token-revocation';
import jwt from 'jsonwebtoken';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Desativar usuário × sessões — prova REAL (Postgres real).
 *
 * ACHADO DE AUDITORIA (segurança): `toggleActive` só mudava `isActive`. O
 * usuário "desativado" continuava com refresh tokens válidos e, como
 * `refreshToken()` nunca conferia `isActive` (só o login conferia), renovava o
 * acesso indefinidamente e seguia operando — desligar um funcionário não o
 * desligava do sistema. Agora desativar revoga as sessões, e o refresh recusa
 * conta inativa (defesa também para sessões emitidas antes da correção).
 */
describe('Desativar usuário derruba as sessões (Postgres real)', () => {
  const authService = new AuthService();
  const userService = new UserService();
  let fixture: IntegrationFixture;
  let userId: string;
  let numericId: number;

  const password = 'Deactivate123!';

  const activeRefreshTokens = async () =>
    prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.refreshToken.count({ where: { userId, isRevoked: false } }) as any,
    ]).then((r) => r[1] as unknown as number);

  const asCompanyAdmin = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: fixture.branchId }, fn);

  beforeAll(async () => {
    fixture = await createFixture('deactivation');
    const user = await asCompanyAdmin(() =>
      userService.create({
        companyId: fixture.companyId,
        branchId: fixture.branchId,
        name: 'Funcionário Desligado',
        email: `deactivation-${Date.now()}@test.local`,
        password,
        userType: 'OPERATOR',
        requirePasswordChange: false, // o teste é de sessões; a senha temporária tem o seu (password-change)
      } as any)
    );
    userId = user.id;
    numericId = user.numericId;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  it('desativar revoga TODOS os refresh tokens e o refresh deixa de funcionar', async () => {
    const login1 = await authService.login({ numericId, password });
    const login2 = await authService.login({ numericId, password });
    expect(await activeRefreshTokens()).toBe(2);

    const toggled = await asCompanyAdmin(() => userService.toggleActive(userId, fixture.companyId));
    expect(toggled.isActive).toBe(false);

    expect(await activeRefreshTokens()).toBe(0);
    await expect(authService.refreshToken((login1 as any).refreshToken)).rejects.toThrow();
    await expect(authService.refreshToken((login2 as any).refreshToken)).rejects.toThrow();
  });

  it('o login continua recusado enquanto a conta está desativada', async () => {
    await expect(authService.login({ numericId, password })).rejects.toThrow();
  });

  it('reativar devolve o acesso (novo login funciona) — o histórico da conta é preservado', async () => {
    const toggled = await asCompanyAdmin(() => userService.toggleActive(userId, fixture.companyId));
    expect(toggled.isActive).toBe(true);

    const login = await authService.login({ numericId, password });
    expect((login as any).user.id).toBe(userId);
    const refreshed = await authService.refreshToken((login as any).refreshToken);
    expect(refreshed.accessToken).toBeTruthy();
  });

  it('defesa em profundidade: refresh token emitido ANTES da correção (conta desativada sem revogar) também é recusado', async () => {
    const login = await authService.login({ numericId, password });

    // Desativa direto no banco, SEM passar por toggleActive — simula a sessão
    // que já existia quando a conta foi desativada pelo código antigo.
    await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.user.update({ where: { id: userId }, data: { isActive: false } }) as any,
    ]);

    await expect(authService.refreshToken((login as any).refreshToken)).rejects.toThrow(/desativad|inativ/i);
  });
  it('EXCLUIR (hard delete) também revoga o access token já emitido, não só o refresh', async () => {
    const doomed = await asCompanyAdmin(() =>
      userService.create({
        companyId: fixture.companyId,
        branchId: fixture.branchId,
        name: 'Funcionário Excluído',
        email: `deletion-${Date.now()}@test.local`,
        password,
        userType: 'OPERATOR',
        requirePasswordChange: false, // o teste é de sessões; a senha temporária tem o seu (password-change)
      } as any)
    );
    const login = await authService.login({ numericId: doomed.numericId, password });
    const token = (login as any).accessToken as string;
    const claims = jwt.decode(token) as { userId: string; companyId: string; iat: number };
    const probe = { userId: claims.userId, companyId: claims.companyId, iat: claims.iat };

    expect(await isAccessTokenRevoked(token, probe)).toBe(false);
    await asCompanyAdmin(() => userService.delete(doomed.id, fixture.companyId));
    expect(await isAccessTokenRevoked(token, probe)).toBe(true);
  });
});
