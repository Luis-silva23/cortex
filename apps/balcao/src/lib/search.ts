/**
 * Classifica o que o atendente digitou na busca única do balcão: placa (AAA1A23 ou AAA-1234), número (documento/telefone) ou
 * texto (nome). Só decide ONDE procurar (clientes e/ou veículos); a busca em si é do servidor.
 */
export type SearchKind = 'plate' | 'digits' | 'text' | 'empty';

const OLD_PLATE = /^[A-Za-z]{3}-?\d{4}$/;
const MERCOSUL_PLATE = /^[A-Za-z]{3}\d[A-Za-z]\d{2}$/;

export function classifySearch(raw: string): { kind: SearchKind; term: string } {
  const term = raw.trim();
  if (!term) return { kind: 'empty', term };
  const compact = term.replace(/\s+/g, '');
  if (OLD_PLATE.test(compact) || MERCOSUL_PLATE.test(compact)) return { kind: 'plate', term: compact.replace('-', '').toUpperCase() };
  if (/^[\d.\-()/\s+]+$/.test(term)) return { kind: 'digits', term: term.replace(/\D/g, '') };
  return { kind: 'text', term };
}

/** Mínimo de caracteres para buscar (evita consulta a cada letra e varredura ampla). */
export const MIN_SEARCH_LENGTH = 2;
export const canSearch = (term: string) => term.trim().length >= MIN_SEARCH_LENGTH;
