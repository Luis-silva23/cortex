import { create } from 'zustand';

/**
 * Pedido de autorização de desconto (docs/CORTEX/policies/DESCONTO.md). Quando a API recusa a venda com
 * 409 DISCOUNT_AUTHORIZATION_REQUIRED, `api.createSale` chama `requestDiscountAuthorization` e espera: o
 * DiscountAuthorizationDialog (montado no App) mostra o limite livre vigente e o percentual pedido, e colhe o motivo e as
 * credenciais de quem autoriza (gerente/administrador — outra pessoa). Cancelar resolve com null (venda não registrada).
 */
export interface DiscountAuthorizationDetails {
  freeLimitPercent: number | null;
  requestedPercent: number;
  itemType: 'PRODUCT' | 'PART' | 'SERVICE' | 'ORDER';
  violations?: Array<{ itemType: string; freeLimitPercent: number | null; requestedPercent: number; source: string }>;
}

export interface DiscountAuthorizationAnswer {
  reason: string;
  numericId: string;
  password: string;
  mfaCode: string;
}

interface PendingRequest {
  details: DiscountAuthorizationDetails;
  message: string;
  /** Recusa da tentativa anterior (autorizador inválido, sem perfil, o próprio solicitante...). */
  error?: string;
  /** Motivo já digitado na tentativa anterior (não se perde ao pedir de novo). */
  reason?: string;
  resolve: (answer: DiscountAuthorizationAnswer | null) => void;
}

interface DiscountAuthorizationState {
  pending: PendingRequest | null;
  answer: (answer: DiscountAuthorizationAnswer | null) => void;
}

export const useDiscountAuthorizationStore = create<DiscountAuthorizationState>((set, get) => ({
  pending: null,
  answer: (answer) => {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(answer);
  },
}));

export function requestDiscountAuthorization(input: { details: DiscountAuthorizationDetails; message: string; error?: string; reason?: string }) {
  return new Promise<DiscountAuthorizationAnswer | null>((resolve) => {
    // Um pedido por vez: um pedido anterior esquecido é encerrado como cancelado.
    useDiscountAuthorizationStore.getState().pending?.resolve(null);
    useDiscountAuthorizationStore.setState({ pending: { ...input, resolve } });
  });
}

export const DISCOUNT_ITEM_TYPE_LABEL: Record<string, string> = {
  PRODUCT: 'produtos',
  PART: 'peças',
  SERVICE: 'serviços/mão de obra',
  ORDER: 'desconto geral',
};
