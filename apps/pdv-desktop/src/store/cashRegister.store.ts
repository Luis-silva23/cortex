import { create } from 'zustand';

// Guarda o caixa atualmente aberto do operador. Não é persistido: a cada
// carregamento do app o caixa aberto é buscado de novo no backend
// (CashRegisterPage.loadCurrentCashRegister), que é a fonte da verdade —
// isso evita que um caixa fechado em outra sessão/terminal fique "fantasma"
// aqui. Este store existe só para compartilhar o caixa aberto entre
// CashRegisterPage (onde é aberto/fechado) e o fluxo de venda (POSPage /
// PaymentModal), que precisa do cashRegisterId real para criar a venda.
interface CashRegisterState {
  currentCashRegister: any | null;
  setCurrentCashRegister: (cashRegister: any | null) => void;
}

export const useCashRegisterStore = create<CashRegisterState>((set) => ({
  currentCashRegister: null,
  setCurrentCashRegister: (cashRegister) => set({ currentCashRegister: cashRegister }),
}));
