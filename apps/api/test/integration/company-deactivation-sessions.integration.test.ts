import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { AuthService } from '../../src/services/auth.service';
import { CompanyService } from '../../src/services/company.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Bloquear (desativar) EMPRESA × login e sessões — prova REAL (Postgres real).
 *
 * ACHADO DE AUDITORIA (relato do agente Super Admin, reproduzido): `POST /companies/:id/
 * toggle-active` invertia `Company.isActive`, mas NADA lia esse campo — o "bloqueio" da
 * empresa não tinha efeito: os usuários dela continuavam logando, renovando o acesso
 * (refresh) e operando. Um interruptor morto: suspender um cliente inadimplente ou um
 * tenant comprometido não funcionava.
 * Agora (mesmo padrão já adotado para usuário desativado): login e refresh recusam
 * usuário de empresa desativada, e desativar revoga todos os refresh tokens dela.
 * Reativar devolve o acesso; nenhum dado é apagado.
 */
describe('Desativar empresa derruba login e sessões (Postgres real)', () => {
  const authService = new AuthService();
  const companyService = new CompanyService();
  let fixture: IntegrationFixture;
  let other: IntegrationFixture;
  let userId: string;
  let numericId: number;
  const password = 'IntegrationTest123!';

  const asSuperAdmin = <T>(fn: () => Promise<T>) =>
    runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, fn);

  const activeRefreshTokens = async (forUserId: string) => {
    const r = await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.refreshToken.count({ where: { userId: forUserId, isRevoked: false } }) as any,
    ]);
    return r[1] as unknown as number;
  };

  const numericIdOf = async (id: string) => {
    const r = await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.user.findUnique({ where: { id }, select: { numericId: true } }) as any,
    ]);
    return (r[1] as any).numericId as number;
  };

  beforeAll(async () => {
    fixture = await createFixture('company-off');
    other = await createFixture('company-on');
    userId = fixture.userId;
    numericId = await numericIdOf(userId);
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
    await destroyFixture(other);
  }, 30000);

  it('desativar a empresa revoga TODOS os refresh tokens dos usuários dela e o refresh deixa de funcionar', async () => {
    const login1 = await authService.login({ numericId, password });
    const login2 = await authService.login({ numericId, password });
    expect(await activeRefreshTokens(userId)).toBe(2);

    const toggled = await asSuperAdmin(() => companyService.toggleActive(fixture.companyId));
    expect(toggled.isActive).toBe(false);

    expect(await activeRefreshTokens(userId)).toBe(0);
    await expect(authService.refreshToken((login1 as any).refreshToken)).rejects.toThrow();
    await expect(authService.refreshToken((login2 as any).refreshToken)).rejects.toThrow();
  });

  it('o login continua recusado (Empresa desativada) enquanto a empresa está bloqueada', async () => {
    await expect(authService.login({ numericId, password })).rejects.toThrow(/Empresa desativada/);
  });

  it('senha ERRADA em empresa bloqueada continua "Credenciais inválidas" (não revela o estado da empresa)', async () => {
    await expect(authService.login({ numericId, password: 'senha-errada-123' })).rejects.toThrow(/Credenciais inválidas/);
  });

  it('bloquear uma empresa NÃO afeta o login de outra empresa', async () => {
    const login = await authService.login({ numericId: await numericIdOf(other.userId), password });
    expect((login as any).user.id).toBe(other.userId);
  });

  it('defesa em profundidade: refresh token emitido ANTES do bloqueio (empresa desativada direto no banco, sem revogar) também é recusado', async () => {
    // reativa pelo caminho normal, loga, e desativa direto no banco (sessão pré-existente)
    await asSuperAdmin(() => companyService.toggleActive(fixture.companyId));
    const login = await authService.login({ numericId, password });

    await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.company.update({ where: { id: fixture.companyId }, data: { isActive: false } }) as any,
    ]);

    await expect(authService.refreshToken((login as any).refreshToken)).rejects.toThrow(/desativad|inativ/i);

    // volta ao normal para o próximo teste
    await prismaUnsafeBypassRLS.$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.company.update({ where: { id: fixture.companyId }, data: { isActive: true } }) as any,
    ]);
  });

  it('reativar devolve o acesso (novo login e refresh funcionam) — nada foi apagado', async () => {
    const login = await authService.login({ numericId, password });
    expect((login as any).user.id).toBe(userId);
    const refreshed = await authService.refreshToken((login as any).refreshToken);
    expect(refreshed.accessToken).toBeTruthy();
  });
});
