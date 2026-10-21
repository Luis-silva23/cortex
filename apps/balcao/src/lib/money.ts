const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Valor vindo da API (o Prisma serializa Decimal como STRING: "129.90") para número; inválido vira 0. */
export function toNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "R$ 1.234,56" — só exibição; nenhuma conta do Balcão é feita em reais com ponto flutuante. */
export function formatBRL(value: number | string | null | undefined): string {
  return BRL.format(toNumber(value));
}

/** Quantidade (até 3 casas) sem zeros à direita: "2", "1,5". */
export function formatQuantity(value: number | string | null | undefined): string {
  return toNumber(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Texto digitado ("12,5", "1.234,50", "12.50") para número, ou `null` se não for um número não negativo. */
export function parseInputNumber(text: string): number | null {
  let t = text.trim();
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); // formato brasileiro: ponto é milhar, vírgula é decimal
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
