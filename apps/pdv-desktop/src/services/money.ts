const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** "R$ 1.234,56" — valores monetários exibidos ao operador (inputs numéricos seguem com ponto). */
export function formatBRL(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return BRL.format(Number.isFinite(n) ? n : 0);
}
