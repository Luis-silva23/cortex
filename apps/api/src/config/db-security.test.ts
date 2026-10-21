import { assertDatabaseSecurity, checkDatabaseSecurity, DbProbe } from './db-security';

const PROD = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv;

const probe = (over: Partial<{ status: Awaited<ReturnType<DbProbe['status']>>; accepted: boolean; superuser: boolean; bypassRls: boolean; owned: number }> = {}): DbProbe => ({
  status: async () => ('status' in over ? over.status! : { enforced: true, secretSlots: 1 }),
  signedContextAccepted: async () => over.accepted ?? true,
  role: async () => ({ superuser: over.superuser ?? false, bypassRls: over.bypassRls ?? false, ownedTables: over.owned ?? 0 }),
});

describe('segurança do banco na partida (contexto de RLS assinado e papel da conexão)', () => {
  it('banco exige a assinatura, aceita a da API e a conexão é papel sem posse: nada a reportar', async () => {
    expect(await checkDatabaseSecurity(probe(), PROD, true)).toEqual({ errors: [], warnings: [] });
  });

  it('banco que NÃO exige assinatura: erro em produção, aviso fora dela', async () => {
    const p = probe({ status: { enforced: false, secretSlots: 0 } });
    expect((await checkDatabaseSecurity(p, PROD, true)).errors.join(' ')).toContain('NÃO exige contexto de RLS assinado');
    const dev = await checkDatabaseSecurity(p, DEV, true);
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.join(' ')).toContain('NÃO exige contexto de RLS assinado');
  });

  it('migração ausente (sem app_ctx.status): erro em produção', async () => {
    expect((await checkDatabaseSecurity(probe({ status: null }), PROD, true)).errors.join(' ')).toContain('migração 20261017100000');
    const failing: DbProbe = { ...probe(), status: async () => { throw new Error('function app_ctx.status() does not exist'); } };
    expect((await checkDatabaseSecurity(failing, PROD, true)).errors.join(' ')).toContain('migração 20261017100000');
  });

  it('exigência ligada porém sem segredo (típico depois de restaurar um backup): erro, tudo seria negado', async () => {
    const r = await checkDatabaseSecurity(probe({ status: { enforced: true, secretSlots: 0 } }), PROD, true);
    expect(r.errors.join(' ')).toContain('não tem segredo provisionado');
  });

  it('API sem RLS_CONTEXT_SECRET ou banco que rejeita a assinatura: erro em produção', async () => {
    expect((await checkDatabaseSecurity(probe(), PROD, false)).errors.join(' ')).toContain('não tem RLS_CONTEXT_SECRET');
    expect((await checkDatabaseSecurity(probe({ accepted: false }), PROD, true)).errors.join(' ')).toContain('REJEITOU o contexto assinado');
    const throwing: DbProbe = { ...probe(), signedContextAccepted: async () => { throw new Error('boom'); } };
    expect((await checkDatabaseSecurity(throwing, PROD, true)).errors.join(' ')).toContain('REJEITOU');
  });

  it('API conectada como superusuário ou BYPASSRLS ignora a RLS: erro em produção, salvo exceção explícita (que ainda avisa)', async () => {
    expect((await checkDatabaseSecurity(probe({ superuser: true }), PROD, true)).errors.join(' ')).toContain('SUPERUSUÁRIO');
    expect((await checkDatabaseSecurity(probe({ bypassRls: true }), PROD, true)).errors.join(' ')).toContain('BYPASSRLS');
    const exception = await checkDatabaseSecurity(probe({ superuser: true }), { ...PROD, ALLOW_PRIVILEGED_DB_ROLE: 'true' } as unknown as NodeJS.ProcessEnv, true);
    expect(exception.errors).toEqual([]);
    expect(exception.warnings.join(' ')).toContain('papel privilegiado');
  });

  it('API dona das tabelas pode desligar a RLS: aviso, e erro quando REQUIRE_NON_OWNER_DB_ROLE=true em produção', async () => {
    const warn = await checkDatabaseSecurity(probe({ owned: 106 }), PROD, true);
    expect(warn.errors).toEqual([]);
    expect(warn.warnings.join(' ')).toContain('DONA de 106 tabelas');
    const strict = await checkDatabaseSecurity(probe({ owned: 106 }), { ...PROD, REQUIRE_NON_OWNER_DB_ROLE: 'true' } as unknown as NodeJS.ProcessEnv, true);
    expect(strict.errors.join(' ')).toContain('DONA de 106 tabelas');
  });

  it('assertDatabaseSecurity lança com todos os erros em produção e só registra fora dela', async () => {
    const log = { warn: jest.fn(), error: jest.fn() };
    const worst = probe({ status: { enforced: false, secretSlots: 0 }, superuser: true });
    await expect(assertDatabaseSecurity(worst, PROD, true, log)).rejects.toThrow(/Segurança do banco inválida para produção \(2\)/);
    expect(log.error).toHaveBeenCalledTimes(2);
    await expect(assertDatabaseSecurity(worst, DEV, true, log)).resolves.toBeDefined();
  });
});
