import { isRestrictViolation, RECORD_IN_USE_MESSAGE } from './db-errors';

describe('isRestrictViolation', () => {
  it('reconhece os códigos do Prisma para FK (P2003, P2014)', () => {
    expect(isRestrictViolation({ code: 'P2003', message: 'x' })).toBe(true);
    expect(isRestrictViolation({ code: 'P2014', message: 'x' })).toBe(true);
  });

  it('reconhece ON DELETE RESTRICT (23001), que o Prisma devolve SEM código', () => {
    const err = new Error(
      'Invalid `prisma.branch.delete()` invocation: ConnectorError(... PostgresError { code: "23001", message: "update or delete on table \\"branches\\" violates RESTRICT setting of foreign key constraint \\"x\\" on table \\"y\\"" ...'
    );
    expect(isRestrictViolation(err)).toBe(true);
    // só o código SQLSTATE (mensagem traduzida pelo servidor) também basta
    expect(isRestrictViolation(new Error('ERRO: algo traduzido (SQLSTATE 23001)'))).toBe(true);
  });

  it('não confunde outros erros (unicidade, texto parecido, valores vazios)', () => {
    expect(isRestrictViolation({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
    expect(isRestrictViolation(new Error('timeout 123001 ms'))).toBe(false);
    expect(isRestrictViolation(new Error('qualquer outra coisa'))).toBe(false);
    expect(isRestrictViolation(null)).toBe(false);
    expect(isRestrictViolation(undefined)).toBe(false);
    expect(isRestrictViolation('texto')).toBe(false);
  });

  it('a mensagem humana não vaza detalhe técnico e orienta a desativar', () => {
    expect(RECORD_IN_USE_MESSAGE).toMatch(/Desative/);
    expect(RECORD_IN_USE_MESSAGE).not.toMatch(/constraint|RESTRICT|SQL/i);
  });
});
