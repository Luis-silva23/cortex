// Guarda da anonimização da cópia restaurada (scripts/lib/anonymize.ts, decisão 155): o script NUNCA pode ser apontado para um banco que pareça (ou seja) o de produção.
// Sem banco: só as recusas, que disparam antes de qualquer conexão. A prova de efeito (varredura de vazamento, contagem de linhas) está em docs/CORTEX/BACKUP_RECUPERACAO.md
// e roda no `backup:drill` com um backup real.
import { assertIsolatedCopy, RULES, SAFE, DELETE_ALL } from './anonymize';

const url = (db: string, host = 'restore-host') => `postgresql://postgres:segredo@${host}:5432/${db}`;

describe('assertIsolatedCopy', () => {
  it('aceita um banco de cópia confirmado pelo nome', () => {
    expect(() => assertIsolatedCopy(url('lnsystem_restore_drill_1'), 'lnsystem_restore_drill_1')).not.toThrow();
    expect(() => assertIsolatedCopy(url('cortex_homolog_copia'), 'cortex_homolog_copia')).not.toThrow();
  });

  it('recusa sem confirmação ou com confirmação diferente do nome do banco', () => {
    expect(() => assertIsolatedCopy(url('lnsystem_restore_x'), '')).toThrow(/confirmação/);
    expect(() => assertIsolatedCopy(url('lnsystem_restore_x'), 'outro_banco')).toThrow(/confirmação/);
  });

  it('recusa banco sem nome de cópia (o de produção/desenvolvimento)', () => {
    expect(() => assertIsolatedCopy(url('lnsystem_db'), 'lnsystem_db')).toThrow(/nome de CÓPIA/);
    expect(() => assertIsolatedCopy(url('cortex'), 'cortex')).toThrow(/nome de CÓPIA/);
  });

  it('recusa nome que indica produção, mesmo contendo "restore"', () => {
    expect(() => assertIsolatedCopy(url('cortex_prod_restore'), 'cortex_prod_restore')).toThrow(/indica produção/);
    expect(() => assertIsolatedCopy(url('lnsystem_producao_restore'), 'lnsystem_producao_restore')).toThrow(/indica produção/);
  });

  it('recusa o mesmo servidor/banco de uma conexão protegida, mesmo com senha diferente', () => {
    const target = url('lnsystem_restore_x', 'db.interno');
    expect(() => assertIsolatedCopy(target, 'lnsystem_restore_x', ['postgresql://app:outra@db.interno:5432/lnsystem_restore_x?schema=public'])).toThrow(/MESMO banco/);
    expect(() => assertIsolatedCopy(target, 'lnsystem_restore_x', ['postgresql://app:x@outro-host:5432/lnsystem_restore_x', ''])).not.toThrow();
  });
});

describe('regras de anonimização', () => {
  it('cobrem as tabelas com dado pessoal e esvaziam sessões e chaves de idempotência', () => {
    for (const t of ['users', 'customers', 'companies', 'branches', 'suppliers', 'motorcycles', 'devices', 'fiscal_configs', 'audit_logs', 'system_logs']) {
      expect(RULES[t]).toBeDefined();
    }
    expect(RULES.users).toMatchObject({ email: 'email', password: 'secret', mfaSecret: 'null', lastLoginIp: 'null' });
    expect(RULES.fiscal_configs).toMatchObject({ certificatePassword: 'null', cscToken: 'null' });
    expect(DELETE_ALL).toEqual(expect.arrayContaining(['refresh_tokens', 'idempotency_keys']));
  });

  it('a lista de colunas seguras não contém nenhuma coluna que tenha regra (sem contradição)', () => {
    for (const entry of SAFE) {
      const [table, column] = entry.split('.');
      expect(RULES[table] && column in RULES[table]).toBeFalsy();
    }
  });
});
