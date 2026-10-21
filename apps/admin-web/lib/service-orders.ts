// Regras puras da tela de detalhe da Ordem de Serviço (sem React/axios).

// O Prisma serializa Decimal como STRING no JSON ("129.90"), mas o schema da API
// exige `unitPrice` como número (z.number) — mandar a string direto dava 400
// sempre que uma peça do catálogo era adicionada. Aceita vírgula decimal também.
export function parseDecimal(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface CatalogProduct {
  id: string;
  salePrice?: number | string | null;
}

export interface AddItemDraft {
  itemType: 'SERVICE' | 'PART';
  // Produto do catálogo escolhido (só faz sentido para PART).
  product: CatalogProduct | null;
  description: string;
  quantity: string;
  unitPrice: string;
}

export interface AddItemPayload {
  itemType: 'SERVICE' | 'PART';
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export function buildAddItemPayload(
  draft: AddItemDraft
): { ok: true; payload: AddItemPayload } | { ok: false; error: string } {
  const quantity = parseDecimal(draft.quantity);
  if (!draft.description.trim() || quantity <= 0) {
    return { ok: false, error: 'Descrição e quantidade (maior que zero) são obrigatórias' };
  }
  const fromCatalog = draft.itemType === 'PART' && draft.product !== null;
  const manualPrice = parseDecimal(draft.unitPrice);
  if (draft.itemType === 'PART' && !fromCatalog && manualPrice <= 0) {
    return { ok: false, error: 'Peça avulsa (sem produto do catálogo) precisa de um preço maior que zero' };
  }
  return {
    ok: true,
    payload: {
      itemType: draft.itemType,
      productId: fromCatalog ? draft.product!.id : undefined,
      description: draft.description,
      quantity,
      // Ignorado pelo backend quando é PART com productId (o preço sempre vem
      // do catálogo); mandamos o mesmo valor só para a UI refletir o preço real.
      unitPrice: fromCatalog ? parseDecimal(draft.product!.salePrice) : manualPrice,
    },
  };
}

// O backend recusa item em OS encerrada/cancelada e também em OS já PAGA
// (o pagamento congela o valor cobrado e a comissão do mecânico).
export function canAddServiceOrderItem(os: { status?: string; isPaid?: boolean } | null | undefined): boolean {
  if (!os) return false;
  if (os.status === 'ENCERRADA' || os.status === 'CANCELADA') return false;
  return !os.isPaid;
}

export interface UserLike {
  id: string;
  name: string;
  userType?: string;
  isActive?: boolean;
}

// O backend só aceita userType MECHANIC como mecânico da OS ("Usuário informado
// não é um mecânico" → 400) — GET /users devolve todos os perfis, então filtra
// aqui. Inativos ficam de fora (não faz sentido atribuir a quem foi desligado).
export function pickMechanics(users: UserLike[] | null | undefined): Array<{ id: string; name: string }> {
  return (users ?? [])
    .filter((u) => u.userType === 'MECHANIC' && u.isActive !== false)
    .map((u) => ({ id: u.id, name: u.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
