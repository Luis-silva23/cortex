// O contexto agora é aplicado por `$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(ctx))` (assinado); o mock devolve os parâmetros na ordem
// do contrato real: empresa, filial, filiais, papel, usuário, iat, assinatura.
jest.mock('@ln-system/database', () => ({
  CONTEXT_SET_CONFIG_SQL: 'SET_CTX',
  contextSqlParams: (c: any) => [c.companyId ?? '', c.branchId ?? '', (c.branchIds ?? []).join(','), c.userType, c.userId ?? '', '0', 'sig'],
}));

import { withCompanyWideRead } from './company-wide-read';

/** tx falso: guarda o contexto como o Postgres guardaria (set_config local) e registra cada troca. */
function fakeTx(ctx: { co: string | null; ut: string | null; br: string | null; brs?: string | null; uid?: string | null }) {
  const state = { co: ctx.co, ut: ctx.ut, br: ctx.br, brs: ctx.brs ?? '', uid: ctx.uid ?? '' };
  const sets: Array<Record<string, string>> = [];
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ ...state }]),
    $executeRawUnsafe: jest.fn(async (_sql: string, co: string, br: string, brs: string, ut: string, uid: string) => {
      state.co = co;
      state.br = br;
      state.brs = brs;
      state.ut = ut;
      state.uid = uid;
      sets.push({ ut, br });
      return 1;
    }),
  };
  return { tx, state, sets };
}

describe('withCompanyWideRead — única ampliação de leitura de filial para empresa', () => {
  it('usuário de filial: amplia só perfil/filial durante a leitura e restaura depois; empresa não muda', async () => {
    const { tx, state } = fakeTx({ co: 'company-A', ut: 'OPERATOR', br: 'branch-1' });
    const seen = await withCompanyWideRead(tx, 'company-A', async () => ({ ...state }));
    expect(seen).toMatchObject({ co: 'company-A', ut: 'COMPANY_ADMIN', br: '' });
    expect(state).toMatchObject({ co: 'company-A', ut: 'OPERATOR', br: 'branch-1' });
  });

  it('restaura o contexto mesmo quando a leitura falha', async () => {
    const { tx, state } = fakeTx({ co: 'company-A', ut: 'MANAGER', br: 'branch-2' });
    await expect(withCompanyWideRead(tx, 'company-A', async () => Promise.reject(new Error('falhou')))).rejects.toThrow('falhou');
    expect(state).toMatchObject({ co: 'company-A', ut: 'MANAGER', br: 'branch-2' });
  });

  it('empresa do contexto diferente da pedida (ou ausente): recusa sem ampliar nada', async () => {
    const other = fakeTx({ co: 'company-B', ut: 'OPERATOR', br: 'branch-9' });
    await expect(withCompanyWideRead(other.tx, 'company-A', async () => 1)).rejects.toThrow(/recusada/);
    expect(other.sets).toHaveLength(0);
    const none = fakeTx({ co: '', ut: 'OPERATOR', br: 'branch-9' });
    await expect(withCompanyWideRead(none.tx, 'company-A', async () => 1)).rejects.toThrow(/recusada/);
    expect(none.sets).toHaveLength(0);
  });

  it('administração já vê a empresa inteira: não mexe no contexto', async () => {
    const { tx, sets } = fakeTx({ co: 'company-A', ut: 'COMPANY_ADMIN', br: '' });
    await withCompanyWideRead(tx, 'company-A', async () => 1);
    expect(sets).toHaveLength(0);
  });

  it('gerente de várias filiais: a volta restaura a LISTA de filiais e o usuário, não só a filial ativa', async () => {
    const { tx, state } = fakeTx({ co: 'company-A', ut: 'MANAGER', br: 'branch-1', brs: 'branch-1,branch-2', uid: 'user-7' });
    const seen = await withCompanyWideRead(tx, 'company-A', async () => ({ ...state }));
    expect(seen).toMatchObject({ ut: 'COMPANY_ADMIN', br: '', brs: '', uid: 'user-7' });
    expect(state).toMatchObject({ co: 'company-A', ut: 'MANAGER', br: 'branch-1', brs: 'branch-1,branch-2', uid: 'user-7' });
  });
});
