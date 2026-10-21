import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { AuthService } from '../../src/services/auth.service';
import { UserService } from '../../src/services/user.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Regressão real (Postgres real) para o achado de PRE-PRODUCTION HARDENING
 * (Autenticação): `refreshToken()` já rotacionava o token (revoga o antigo,
 * emite um novo) mas não detectava REUSO de um token já revogado — o sinal
 * clássico de roubo de refresh token. Um atacante que usasse um token
 * roubado antes do dono legítimo ganhava uma sessão válida sem nenhuma
 * resposta defensiva do sistema. Corrigido: apresentar um refresh token já
 * revogado agora revoga TODAS as sessões daquele usuário como precaução.
 */
describe('Detecção de reuso de refresh token (regressão real)', () => {
  const authService = new AuthService();
  const userService = new UserService();
  let fixture: IntegrationFixture;
  let userNumericId: number;

  beforeAll(async () => {
    fixture = await createFixture('refresh-reuse');
    const user = await runWithRLSContext(
      { companyId: fixture.companyId, userType: 'COMPANY_ADMIN', branchId: fixture.branchId },
      () =>
        userService.create({
          companyId: fixture.companyId,
          branchId: fixture.branchId,
          name: 'Usuário Refresh Reuse',
          email: `refresh-reuse-${Date.now()}@test.local`,
          password: 'RefreshReuse123!',
          userType: 'OPERATOR',
          requirePasswordChange: false, // este teste é do refresh token; a senha temporária tem o seu (password-change)
        } as any)
    );
    userNumericId = user.numericId;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  async function countActiveRefreshTokens(userId: string) {
    // Leitura de verificação com bypass total — mesmo padrão já
    // estabelecido em rbac.integration.test.ts (evita a instabilidade de
    // runWithRLSContext sequencial já documentada nesta sessão).
    const [, rows] = await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.refreshToken.findMany({ where: { userId, isRevoked: false } }) as any,
    ]);
    return (rows as any[]).length;
  }

  it('reapresentar um refresh token já revogado revoga TODAS as sessões do usuário', async () => {
    const login1 = await authService.login({ numericId: userNumericId, password: 'RefreshReuse123!' });
    const login2 = await authService.login({ numericId: userNumericId, password: 'RefreshReuse123!' });
    const rt1 = (login1 as any).refreshToken as string;
    const rt2 = (login2 as any).refreshToken as string;

    const userId = (login1 as any).user.id as string;
    expect(await countActiveRefreshTokens(userId)).toBe(2);

    // Uso normal do primeiro refresh token — rotaciona (revoga rt1, emite
    // um novo). Continua havendo 2 sessões ativas (a nova + rt2).
    const refreshed = await authService.refreshToken(rt1);
    expect(await countActiveRefreshTokens(userId)).toBe(2);

    // Reapresentar rt1 (já revogado pela rotação acima) — simula o token
    // roubado sendo usado depois que o dono legítimo já rotacionou.
    await expect(authService.refreshToken(rt1)).rejects.toThrow('Refresh token inválido');

    // Resposta defensiva: TODAS as sessões do usuário foram revogadas,
    // inclusive a rt2 (login2) e o token novo da rotação legítima acima —
    // nenhuma sessão sobrevive a um sinal de reuso.
    expect(await countActiveRefreshTokens(userId)).toBe(0);

    // O token novo emitido pela rotação legítima também não funciona mais.
    await expect(authService.refreshToken(refreshed.refreshToken)).rejects.toThrow('Refresh token inválido');
    await expect(authService.refreshToken(rt2)).rejects.toThrow('Refresh token inválido');
  });

  it('logins e renovações SIMULTÂNEOS não colidem na coluna UNIQUE token (achado de carga HML: 500 no login)', async () => {
    const logins = await Promise.allSettled(
      Array.from({ length: 12 }, () => authService.login({ numericId: userNumericId, password: 'RefreshReuse123!' }))
    );
    expect(logins.filter((r) => r.status === 'rejected').map((r: any) => String(r.reason?.message ?? r.reason))).toEqual([]);
    const tokens = logins.map((r: any) => r.value.refreshToken as string);
    expect(new Set(tokens).size).toBe(12);

    const renewals = await Promise.allSettled(tokens.slice(0, 6).map((t) => authService.refreshToken(t)));
    expect(renewals.filter((r) => r.status === 'rejected').map((r: any) => String(r.reason?.message ?? r.reason))).toEqual([]);
  }, 60000);
});
