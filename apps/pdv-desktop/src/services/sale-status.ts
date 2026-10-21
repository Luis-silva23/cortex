export const SALE_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendente',
  PAID: 'Paga',
  PARTIALLY_PAID: 'Parcial',
  CANCELLED: 'Cancelada',
  RETURNED: 'Devolvida',
};

export const saleStatusLabel = (status: string) => SALE_STATUS_LABELS[status] ?? status;
