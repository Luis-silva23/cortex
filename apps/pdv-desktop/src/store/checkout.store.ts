import { create } from 'zustand';
import type { Attempt } from '../services/payment-flow';

/**
 * Venda em andamento no PDV (só memória, por operador). Antes vivia em estado local do PaymentModal: fechar o modal
 * (ESC, X, Cancelar) depois de a venda já ter sido criada no servidor — ex.: pagamento recusado ou sem rede — perdia a
 * referência, e "Finalizar Venda" de novo criava OUTRA venda (duplicada, com o estoque baixado duas vezes).
 *
 *  - `cartSignature`: assinatura do carrinho que gerou a venda. Mesma assinatura → a mesma venda é reaproveitada.
 *  - `saleAttempt`: chave de idempotência da criação da venda (reenvio após falta de resposta não cria outra).
 *  - `paymentAttempt`: chave da tentativa de pagamento atual (reenvio da MESMA tentativa não cobra de novo).
 *  - `pendingPayment`: pagamento que ficou sem confirmação (PIX/terminal) — a venda NÃO está concluída.
 */
export interface OpenSale {
  id: string;
  saleNumber?: number;
  totalAmount: number;
  raw: any;
}

interface CheckoutState {
  cartSignature: string | null;
  sale: OpenSale | null;
  saleAttempt: Attempt | null;
  paymentAttempt: Attempt | null;
  pendingPayment: any | null;
  setSaleAttempt: (attempt: Attempt | null) => void;
  setSale: (cartSignature: string, sale: OpenSale) => void;
  setPaymentAttempt: (attempt: Attempt | null) => void;
  setPendingPayment: (payment: any | null) => void;
  reset: () => void;
}

const initial = { cartSignature: null, sale: null, saleAttempt: null, paymentAttempt: null, pendingPayment: null };

export const useCheckoutStore = create<CheckoutState>((set) => ({
  ...initial,
  setSaleAttempt: (saleAttempt) => set({ saleAttempt }),
  setSale: (cartSignature, sale) => set({ cartSignature, sale, saleAttempt: null }),
  setPaymentAttempt: (paymentAttempt) => set({ paymentAttempt }),
  setPendingPayment: (pendingPayment) => set({ pendingPayment }),
  reset: () => set({ ...initial }),
}));
