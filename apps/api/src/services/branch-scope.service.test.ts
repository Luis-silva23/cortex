jest.mock('@ln-system/database', () => ({ prismaUnsafeBypassRLS: {}, contextStatement: jest.fn(), PLATFORM_CONTEXT: {} }));

import { computeBranchScope, isCompanyWideRole, resolveBranchScope } from './branch-scope.service';

describe('filiais autorizadas do usuário (principal + vínculos)', () => {
  it('papéis de empresa inteira são só SUPER_ADMIN e COMPANY_ADMIN', () => {
    expect(isCompanyWideRole('SUPER_ADMIN')).toBe(true);
    expect(isCompanyWideRole('COMPANY_ADMIN')).toBe(true);
    for (const t of ['MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER', 'CHANNEL', undefined]) expect(isCompanyWideRole(t as string)).toBe(false);
  });

  it('gerente da filial A: só A', () => {
    expect(computeBranchScope({ primary: 'A', extras: [] }, 'A')).toEqual({ branchIds: ['A'], activeBranchId: 'A' });
  });

  it('gerente de A e B: A e B (ordenadas, sem duplicar), e nenhuma outra', () => {
    const s = computeBranchScope({ primary: 'B', extras: ['A', 'B'] }, 'B');
    expect(s.branchIds).toEqual(['A', 'B']);
    expect(s.branchIds).not.toContain('C');
    expect(s.activeBranchId).toBe('B');
  });

  it('a filial ATIVA do token só vale se ainda estiver autorizada; senão volta para a principal do banco', () => {
    expect(computeBranchScope({ primary: 'B', extras: ['A'] }, 'A').activeBranchId).toBe('A');
    expect(computeBranchScope({ primary: 'B', extras: ['A'] }, 'C').activeBranchId).toBe('B'); // token com filial que não é mais dele
    expect(computeBranchScope({ primary: 'B', extras: [] }, undefined).activeBranchId).toBe('B');
  });

  it('principal removida mas com vínculo adicional: a ativa passa a ser a que sobrou; sem nada, null', () => {
    expect(computeBranchScope({ primary: null, extras: ['A', 'B'] }, 'Z')).toEqual({ branchIds: ['A', 'B'], activeBranchId: 'A' });
    expect(computeBranchScope({ primary: null, extras: [] }, 'A')).toEqual({ branchIds: [], activeBranchId: null });
  });

  it('resolveBranchScope usa o leitor com o usuário e a empresa DO TOKEN; sem empresa não lê nada', async () => {
    const read = jest.fn().mockResolvedValue({ primary: 'A', extras: ['B'], found: true });
    expect(await resolveBranchScope({ userId: 'u1', companyId: 'co1', branchId: 'A' }, read)).toEqual({ branchIds: ['A', 'B'], activeBranchId: 'A' });
    expect(read).toHaveBeenCalledWith('u1', 'co1');
    read.mockClear();
    expect(await resolveBranchScope({ userId: 'u1', companyId: undefined, branchId: 'A' }, read)).toEqual({ branchIds: [], activeBranchId: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('usuário que não existe mais (ou de outra empresa): escopo vazio, nunca o que o token afirma', async () => {
    const read = jest.fn().mockResolvedValue({ primary: null, extras: [], found: false });
    expect(await resolveBranchScope({ userId: 'u1', companyId: 'co1', branchId: 'A' }, read)).toEqual({ branchIds: [], activeBranchId: null });
  });

  it('falha do leitor propaga o erro (o middleware responde 503; não existe "escopo desconhecido vira acesso")', async () => {
    const read = jest.fn().mockRejectedValue(new Error('banco fora'));
    await expect(resolveBranchScope({ userId: 'u1', companyId: 'co1', branchId: 'A' }, read)).rejects.toThrow('banco fora');
  });
});
