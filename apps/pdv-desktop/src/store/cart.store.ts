import { create } from 'zustand';

interface CartItem {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  discountAmount: number;
  totalPrice: number;
}

interface Customer {
  id: string;
  name: string;
  document?: string;
  phone?: string;
}

interface Partner {
  id: string;
  name: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  maxDiscountAmount: number | null;
  stackable: boolean;
}

interface CartState {
  items: CartItem[];
  customer: Customer | null;
  discountPercent: number;
  discountAmount: number;
  // Convênio (ex.: "Posto Santa") selecionado no F4 — alternativa ao
  // desconto manual acima. O valor real do desconto é sempre recalculado
  // e validado pelo backend (partner.service.ts) a partir do cadastro em
  // banco; o cálculo aqui é só uma ESTIMATIVA para exibição na tela.
  partner: Partner | null;
  // Estimativa local do desconto do convênio, só para exibição — nunca
  // enviada ao backend (que recalcula do zero a partir do Partner em
  // banco). Ver partner.service.ts::validateAndComputeDiscount.
  partnerDiscountEstimate: number;
  subtotal: number;
  total: number;

  // Actions
  addItem: (product: any, quantity?: number) => void;
  removeItem: (itemId: string) => void;
  updateQuantity: (itemId: string, quantity: number) => void;
  applyItemDiscount: (itemId: string, discountPercent: number) => void;
  applyGlobalDiscount: (discountPercent: number) => void;
  setPartner: (partner: Partner | null) => void;
  setCustomer: (customer: Customer | null) => void;
  clearCart: () => void;
  calculateTotals: () => void;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  customer: null,
  discountPercent: 0,
  discountAmount: 0,
  partner: null,
  partnerDiscountEstimate: 0,
  subtotal: 0,
  total: 0,

  addItem: (product, quantity = 1) => {
    const state = get();
    const existingItem = state.items.find(item => item.productId === product.id);

    if (existingItem) {
      // Atualizar quantidade do item existente
      const updatedItems = state.items.map(item =>
        item.productId === product.id
          ? {
              ...item,
              quantity: item.quantity + quantity,
              totalPrice: (item.quantity + quantity) * item.unitPrice * (1 - item.discountPercent / 100),
            }
          : item
      );
      set({ items: updatedItems });
    } else {
      // Adicionar novo item
      const newItem: CartItem = {
        id: `${product.id}-${Date.now()}`,
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        quantity,
        unitPrice: Number(product.salePrice),
        discountPercent: 0,
        discountAmount: 0,
        totalPrice: quantity * Number(product.salePrice),
      };
      set({ items: [...state.items, newItem] });
    }
    get().calculateTotals();
  },

  removeItem: (itemId) => {
    set(state => ({
      items: state.items.filter(item => item.id !== itemId),
    }));
    get().calculateTotals();
  },

  updateQuantity: (itemId, quantity) => {
    if (quantity <= 0) {
      get().removeItem(itemId);
      return;
    }

    set(state => ({
      items: state.items.map(item =>
        item.id === itemId
          ? {
              ...item,
              quantity,
              totalPrice: quantity * item.unitPrice * (1 - item.discountPercent / 100),
            }
          : item
      ),
    }));
    get().calculateTotals();
  },

  applyItemDiscount: (itemId, discountPercent) => {
    set(state => ({
      items: state.items.map(item =>
        item.id === itemId
          ? {
              ...item,
              discountPercent,
              discountAmount: (item.quantity * item.unitPrice * discountPercent) / 100,
              totalPrice: item.quantity * item.unitPrice * (1 - discountPercent / 100),
            }
          : item
      ),
    }));
    get().calculateTotals();
  },

  applyGlobalDiscount: (discountPercent) => {
    const state = get();
    // Convênio não-empilhável + desconto manual é rejeitado pelo backend
    // (sale.service.ts) — limpar o convênio aqui em vez de deixar o
    // operador só descobrir o conflito depois de tentar finalizar a venda.
    const partner = discountPercent > 0 && state.partner && !state.partner.stackable ? null : state.partner;
    set({ discountPercent, partner });
    get().calculateTotals();
  },

  setPartner: (partner) => {
    const state = get();
    // Mesma regra no sentido inverso: escolher um convênio não-empilhável
    // limpa qualquer desconto manual já digitado.
    const shouldClearManualDiscount = !!partner && !partner.stackable && (state.discountPercent > 0 || state.discountAmount > 0);
    set({
      partner,
      ...(shouldClearManualDiscount ? { discountPercent: 0 } : {}),
    });
    get().calculateTotals();
  },

  setCustomer: (customer) => {
    set({ customer });
  },

  clearCart: () => {
    set({
      items: [],
      customer: null,
      discountPercent: 0,
      discountAmount: 0,
      partner: null,
      partnerDiscountEstimate: 0,
      subtotal: 0,
      total: 0,
    });
  },

  calculateTotals: () => {
    const state = get();
    const subtotal = state.items.reduce((sum, item) => sum + item.totalPrice, 0);
    const discountAmount = (subtotal * state.discountPercent) / 100;

    // Estimativa local do desconto do convênio — mesma fórmula do backend
    // (partner.service.ts), mas sobre o subtotal já líquido de descontos de
    // item (aproximação razoável para exibição; o valor real é sempre
    // recalculado no servidor a partir do bruto por item).
    let partnerDiscountEstimate = 0;
    if (state.partner) {
      partnerDiscountEstimate =
        state.partner.discountType === 'PERCENTAGE'
          ? (subtotal * Number(state.partner.discountValue)) / 100
          : Number(state.partner.discountValue);
      if (state.partner.maxDiscountAmount != null) {
        partnerDiscountEstimate = Math.min(partnerDiscountEstimate, Number(state.partner.maxDiscountAmount));
      }
      partnerDiscountEstimate = Math.min(partnerDiscountEstimate, subtotal);
    }

    const total = subtotal - discountAmount - partnerDiscountEstimate;

    set({
      subtotal,
      discountAmount,
      partnerDiscountEstimate,
      total,
    });
  },
}));
