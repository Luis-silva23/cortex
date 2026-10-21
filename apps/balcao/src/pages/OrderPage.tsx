import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getServiceOrder } from '../api/endpoints';
import type { ServiceOrder } from '../api/types';
import { formatBRL, formatQuantity } from '../lib/money';
import { ITEM_TYPE_LABEL, OS_STATUS_LABEL, label, osTone } from '../lib/labels';
import { AsyncBlock, Badge, Card, useAsync } from '../components/ui';
import HandoffCard from '../components/HandoffCard';

/**
 * Detalhe da OS para o balcão: situação, mecânico, itens e histórico. Quem muda a situação da OS é a oficina (mobile/Admin);
 * aqui o atendente acompanha e, com a OS pronta, encaminha ao caixa — a regra "OS só é paga em PRONTO ou ENTREGA" é do servidor.
 */
export default function OrderPage() {
  const { id = '' } = useParams();
  const state = useAsync(() => getServiceOrder(id), [id]);
  return <AsyncBlock state={state}>{(os) => <OrderView os={os} />}</AsyncBlock>;
}

function OrderView({ os }: { os: ServiceOrder }) {
  const handoff = useMemo(
    () => ({
      kind: 'OS' as const,
      number: os.osNumber,
      status: label(OS_STATUS_LABEL, os.status),
      customerName: os.customer?.name ?? '',
      customerPhone: os.customer?.phone,
      vehicle: os.motorcycle ? `${os.motorcycle.brand} ${os.motorcycle.model} ${os.motorcycle.licensePlate ?? ''}`.trim() : null,
      items: (os.items ?? []).map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, totalPrice: i.totalPrice })),
      totalAmount: os.finalTotal ?? 0,
      issuedAt: new Date(),
    }),
    [os]
  );
  const readyForPayment = os.status === 'PRONTO' || os.status === 'ENTREGA';

  return (
    <>
      <Card title={`OS #${os.osNumber}`} action={<Badge tone={osTone(os.status)}>{label(OS_STATUS_LABEL, os.status)}</Badge>}>
        <p className="text-sm">
          Cliente{' '}
          {os.customer ? (
            <Link to={`/clientes/${os.customer.id}`} className="font-semibold text-primary-500 hover:underline">
              {os.customer.name}
            </Link>
          ) : (
            '—'
          )}{' '}
          · Veículo{' '}
          {os.motorcycle ? (
            <Link to={`/veiculos/${os.motorcycle.id}`} className="font-semibold text-primary-500 hover:underline">
              {os.motorcycle.brand} {os.motorcycle.model} {os.motorcycle.licensePlate ?? ''}
            </Link>
          ) : (
            '—'
          )}
        </p>
        <p className="mt-1 text-sm text-gray-600">
          Mecânico: {os.mechanic?.name ?? 'não atribuído'}
          {os.estimatedDelivery ? ` · Previsão: ${new Date(os.estimatedDelivery).toLocaleDateString('pt-BR')}` : ''}
        </p>
      </Card>

      <Card title="Itens">
        {(os.items ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">Sem itens lançados.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-primary-100">
              {(os.items ?? []).map((i) => (
                <tr key={i.id}>
                  <td className="py-1.5">
                    {i.description} <Badge>{label(ITEM_TYPE_LABEL, i.itemType)}</Badge>
                  </td>
                  <td className="py-1.5 text-right">
                    {formatQuantity(i.quantity)} × {formatBRL(i.unitPrice)}
                  </td>
                  <td className="py-1.5 text-right font-medium">{formatBRL(i.totalPrice)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="pt-2" colSpan={2}>
                  Total
                </td>
                <td className="pt-2 text-right">{formatBRL(os.finalTotal)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      {(os.statusHistory ?? []).length > 0 && (
        <Card title="Histórico">
          <ol className="space-y-1 text-sm">
            {(os.statusHistory ?? []).map((h, n) => (
              <li key={h.id ?? n} className="flex justify-between">
                <span>{label(OS_STATUS_LABEL, h.toStatus)}{h.notes ? ` — ${h.notes}` : ''}</span>
                <span className="text-gray-500">{new Date(h.changedAt).toLocaleString('pt-BR')}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {readyForPayment ? (
        <HandoffCard input={handoff} />
      ) : (
        <p className="rounded-lg bg-primary-100 p-3 text-sm text-primary-600">A OS só segue para o caixa quando estiver Pronta ou em Entrega.</p>
      )}
    </>
  );
}
