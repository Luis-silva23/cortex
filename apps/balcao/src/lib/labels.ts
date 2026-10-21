// Rótulos de exibição dos estados que o SERVIDOR define (nenhum estado é inventado aqui).

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Orçamento',
  SENT: 'Aguardando aprovação',
  APPROVED: 'Aprovado',
  REJECTED: 'Recusado',
  EXPIRED: 'Encerrado',
  CONVERTED: 'Convertido em OS',
};

export const OS_STATUS_LABEL: Record<string, string> = {
  ENTRADA: 'Entrada',
  DIAGNOSTICO: 'Diagnóstico',
  ORCAMENTO: 'Orçamento',
  APROVACAO: 'Aguardando aprovação',
  EXECUCAO: 'Em execução',
  PRONTO: 'Pronto',
  ENTREGA: 'Entrega',
  ENCERRADA: 'Encerrada',
  CANCELADA: 'Cancelada',
};

export const SALE_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  PARTIALLY_PAID: 'Parcialmente paga',
  PAID: 'Paga',
  CANCELLED: 'Cancelada',
  RETURNED: 'Devolvida',
};

export const ITEM_TYPE_LABEL: Record<string, string> = { SERVICE: 'Serviço', PART: 'Peça' };

export type Tone = 'neutral' | 'warning' | 'success' | 'danger';

export function quoteTone(status: string): Tone {
  if (status === 'SENT') return 'warning';
  if (status === 'APPROVED' || status === 'CONVERTED') return 'success';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function osTone(status: string): Tone {
  if (status === 'PRONTO' || status === 'ENTREGA' || status === 'ENCERRADA') return 'success';
  if (status === 'APROVACAO' || status === 'ORCAMENTO' || status === 'DIAGNOSTICO') return 'warning';
  if (status === 'CANCELADA') return 'danger';
  return 'neutral';
}

export const label = (map: Record<string, string>, key: string | null | undefined) => (key ? map[key] ?? key : '—');
