import type { QuoteItem, QuoteItemPayload } from '../api/types';
import { parseInputNumber, toNumber } from './money';

/**
 * Linhas do orçamento em edição na tela. Peça do catálogo (`productId`) tem preço do CATÁLOGO (o servidor usa o preço oficial e
 * ignora o enviado); serviço leva o preço digitado. A validação aqui só evita o round-trip óbvio — o servidor valida de verdade.
 */
export interface Line {
  key: string;
  itemType: 'SERVICE' | 'PART';
  productId?: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

export const MAX_QUANTITY = 9_999_999; // mesmos limites do schema (Decimal(10,3)) e de quote.service.ts
export const MAX_MONEY = 99_999_999.99;

export function linesFromItems(items: QuoteItem[]): Line[] {
  return items.map((i, n) => ({
    key: `${i.id ?? 'i'}-${n}`,
    itemType: i.itemType,
    productId: i.productId ?? undefined,
    description: i.description,
    quantity: String(toNumber(i.quantity)),
    unitPrice: String(toNumber(i.unitPrice)),
  }));
}

export function buildItemsPayload(lines: Line[]): { ok: true; items: QuoteItemPayload[] } | { ok: false; error: string } {
  if (lines.length === 0) return { ok: false, error: 'Adicione pelo menos um item ao orçamento.' };
  const items: QuoteItemPayload[] = [];
  for (const l of lines) {
    const quantity = parseInputNumber(l.quantity);
    const unitPrice = parseInputNumber(l.unitPrice);
    if (!l.description.trim()) return { ok: false, error: 'Todo item precisa de descrição.' };
    if (quantity === null || quantity <= 0 || quantity > MAX_QUANTITY) return { ok: false, error: `Quantidade inválida em “${l.description}”.` };
    if (unitPrice === null || unitPrice > MAX_MONEY) return { ok: false, error: `Preço inválido em “${l.description}”.` };
    if (l.itemType === 'SERVICE' && unitPrice <= 0) return { ok: false, error: `O serviço “${l.description}” precisa de um valor maior que zero.` };
    items.push({ itemType: l.itemType, productId: l.productId, description: l.description.trim(), quantity, unitPrice });
  }
  return { ok: true, items };
}
