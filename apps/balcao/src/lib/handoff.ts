import { formatBRL, formatQuantity, toNumber } from './money';

/**
 * FICHA DE ENCAMINHAMENTO AO CAIXA. O Balcão NÃO recebe pagamento nem abre caixa (isso é do PDV). A ficha leva ao caixa a
 * referência do atendimento (cliente, veículo, itens, total oficial do servidor e o número do documento) para o operador do PDV
 * localizar e cobrar. Importar o orçamento/OS direto no PDV é decisão pendente (docs/CORTEX/DECISIONS.md, 115): hoje a ficha é
 * a ponte, sem criar venda, pagamento nem movimento de caixa.
 */
export interface HandoffInput {
  kind: 'ORCAMENTO' | 'OS';
  number: number | string;
  status: string;
  customerName: string;
  customerPhone?: string | null;
  vehicle?: string | null;
  items: Array<{ description: string; quantity: number | string; unitPrice: number | string; totalPrice?: number | string }>;
  /** Total OFICIAL devolvido pelo servidor (nunca recalculado aqui). */
  totalAmount: number | string;
  issuedAt: Date;
}

export function buildHandoffText(input: HandoffInput): string {
  const doc = input.kind === 'OS' ? `OS nº ${input.number}` : `Orçamento nº ${input.number}`;
  const lines = [
    'CÓRTEX — ENCAMINHAMENTO AO CAIXA',
    `${doc} · ${input.status}`,
    `Cliente: ${input.customerName}${input.customerPhone ? ` · ${input.customerPhone}` : ''}`,
    ...(input.vehicle ? [`Veículo: ${input.vehicle}`] : []),
    '',
    ...input.items.map((i) => {
      const total = i.totalPrice !== undefined ? toNumber(i.totalPrice) : toNumber(i.quantity) * toNumber(i.unitPrice);
      return `- ${i.description} — ${formatQuantity(i.quantity)} x ${formatBRL(i.unitPrice)} = ${formatBRL(total)}`;
    }),
    '',
    `TOTAL: ${formatBRL(input.totalAmount)}`,
    '',
    'Pagamento: no CAIXA (PDV). Este documento não é comprovante de pagamento.',
    `Emitido em ${input.issuedAt.toLocaleString('pt-BR')}`,
  ];
  return lines.join('\n');
}
