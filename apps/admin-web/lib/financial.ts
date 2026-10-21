// Regras puras da tela Financeiro do Admin Web.

// O estorno de uma conta paga NUNCA reescreve o original: a API cria um novo
// lançamento negativo, já PAID, com referenceType 'Reversal' apontando para o
// original. Esse lançamento também aparece na listagem com status PAID — mas
// a API NÃO impede estornar o próprio estorno (financial.service.ts só exige
// status PAID e que o registro ainda não tenha sido estornado; o resultado seria
// um lançamento positivo "Estorno: Estorno: ..."). Se "desfazer um estorno" é uma
// operação de negócio válida é decisão de produto (docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md); até lá a
// tela não oferece "Estornar" nele.
export function isReversalRecord(account: { referenceType?: string | null } | null | undefined): boolean {
  return account?.referenceType === 'Reversal';
}

export function canReverseAccount(
  account: { status?: string; referenceType?: string | null } | null | undefined
): boolean {
  return account?.status === 'PAID' && !isReversalRecord(account);
}
