import { PaymentGatewayAdapter } from './types';
import cashAdapter from './cash-adapter';
import manualCardAdapter from './manual-card-adapter';
import pendingManualAdapter from './pending-manual-adapter';

export * from './types';

/**
 * Provedores de pagamento por nome (configurados por empresa/filial em payment_settings). `MANUAL` é o comportamento
 * honesto sem integração: cartão confirmado pelo operador na maquininha, PIX pendente até conciliação. Um provedor real
 * (TEF/PSP) entra registrando aqui um adaptador com `external: true`; a configuração só aceita nomes registrados.
 */
export const MANUAL_PROVIDER = 'MANUAL';
const providers = new Map<string, { card?: PaymentGatewayAdapter; pix?: PaymentGatewayAdapter }>();

export function registerPaymentProvider(name: string, adapters: { card?: PaymentGatewayAdapter; pix?: PaymentGatewayAdapter }) {
  if (name === MANUAL_PROVIDER) throw new Error('MANUAL é reservado');
  providers.set(name, adapters);
}

/** Adaptador de um provedor registrado (reconciliação usa o provedor gravado no pagamento). */
export function providerAdapter(name: string, kind: 'card' | 'pix'): PaymentGatewayAdapter | undefined {
  return providers.get(name)?.[kind];
}

export function isRegisteredProvider(name: string, kind: 'card' | 'pix'): boolean {
  return name === MANUAL_PROVIDER || !!providers.get(name)?.[kind];
}

/**
 * Adaptador do método, segundo o provedor configurado. PIX/BANK_TRANSFER/CHECK/VOUCHER/OTHER sem provedor caem no
 * `pendingManualAdapter` (PENDING honesto: não há como confirmar que o dinheiro entrou). Provedor configurado mas não
 * registrado (removido do build) falha antes de cobrar.
 */
export function selectAdapter(paymentMethod: string, config: { cardProvider?: string; pixProvider?: string } = {}): PaymentGatewayAdapter {
  const provider = (name: string | undefined, kind: 'card' | 'pix') => {
    if (!name || name === MANUAL_PROVIDER) return undefined;
    const adapter = providers.get(name)?.[kind];
    if (!adapter) throw new Error(`Provedor de pagamento "${name}" indisponível neste servidor`);
    return adapter;
  };
  switch (paymentMethod) {
    case 'CASH':
      return cashAdapter;
    case 'DEBIT_CARD':
    case 'CREDIT_CARD':
      return provider(config.cardProvider, 'card') ?? manualCardAdapter;
    case 'PIX':
      return provider(config.pixProvider, 'pix') ?? pendingManualAdapter;
    default:
      return pendingManualAdapter;
  }
}

export { cashAdapter, manualCardAdapter, pendingManualAdapter };
