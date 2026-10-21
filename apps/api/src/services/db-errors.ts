/**
 * Classificação de erros de integridade referencial do PostgreSQL vistos pelo Prisma.
 *
 * O Prisma só mapeia `23503` (foreign_key_violation, FK `NO ACTION`/INSERT sem pai) para `P2003`. Uma FK declarada `ON DELETE RESTRICT`
 * (a regra das tabelas de histórico, migration `20261015110000_cascade_to_restrict_history`, e das FKs de empresa/filial) responde com
 * `23001` (restrict_violation), que o Prisma 5 devolve como `PrismaClientUnknownRequestError` SEM `code` — e a aplicação tratava isso como
 * erro interno (500). Este critério único reconhece os dois formatos: "o registro que você tentou excluir/alterar ainda é referenciado".
 */
export function isRestrictViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (e.code === 'P2003' || e.code === 'P2014') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /\b23001\b/.test(message) || /violates RESTRICT setting of foreign key constraint/i.test(message);
}

/** Mensagem humana única para "não pode excluir porque há registros vinculados" (HTTP 409, código RECORD_IN_USE). */
export const RECORD_IN_USE_MESSAGE = 'Não é possível excluir: existem registros vinculados a este item. Desative-o em vez de excluir.';
