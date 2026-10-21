import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Send, XCircle, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import { addQuoteVersion, convertQuote, decideQuote, getQuote, sendQuote } from '../api/endpoints';
import { toApiError } from '../api/http';
import type { Quote } from '../api/types';
import { useAuthStore } from '../store/auth.store';
import { canWrite } from '../lib/permissions';
import { formatBRL, formatQuantity, parseInputNumber } from '../lib/money';
import { ITEM_TYPE_LABEL, QUOTE_STATUS_LABEL, label, quoteTone } from '../lib/labels';
import { buildItemsPayload, linesFromItems, type Line } from '../lib/quote-lines';
import { AsyncBlock, Badge, Button, Card, ErrorBox, inputClass, useAsync, useSubmitOnce } from '../components/ui';
import ItemsBuilder from '../components/ItemsBuilder';
import HandoffCard from '../components/HandoffCard';

/**
 * Orçamento: consulta, revisão (nova versão), envio, decisão do cliente e conversão em OS. As regras de estado são do servidor
 * (a tela só mostra as ações que a situação atual permite; qualquer recusa volta como mensagem).
 */
export default function QuotePage() {
  const { id = '' } = useParams();
  const state = useAsync(() => getQuote(id), [id]);
  return (
    <AsyncBlock state={state}>
      {(quote) => <QuoteView quote={quote} reload={state.reload} />}
    </AsyncBlock>
  );
}

function QuoteView({ quote, reload }: { quote: Quote; reload: () => void }) {
  const navigate = useNavigate();
  const { user, branchId } = useAuthStore();
  const writer = canWrite(user?.userType);
  const { run, busy } = useSubmitOnce();
  const [error, setError] = useState<string | null>(null);
  const [km, setKm] = useState('');
  const [revising, setRevising] = useState(false);
  const latest = quote.versions[quote.versions.length - 1];
  const [lines, setLines] = useState<Line[]>(() => linesFromItems(latest?.items ?? []));
  const items = latest?.items ?? [];

  const act = (fn: () => Promise<unknown>, okMessage: string) =>
    run(async () => {
      setError(null);
      try {
        await fn();
        toast.success(okMessage);
        await reload();
      } catch (e) {
        setError(toApiError(e).message);
      }
    });

  const convert = () => {
    const entryKm = parseInputNumber(km);
    if (entryKm === null) return setError('Informe a quilometragem de entrada do veículo.');
    void run(async () => {
      setError(null);
      try {
        const os = await convertQuote(quote.id, { branchId: quote.branchId, entryKilometer: entryKm });
        toast.success(`OS #${os.osNumber} criada.`);
        navigate(`/os/${os.id}`);
      } catch (e) {
        setError(toApiError(e).message);
      }
    });
  };

  const saveRevision = () => {
    const built = buildItemsPayload(lines);
    if (!built.ok) return setError(built.error);
    void act(async () => {
      await addQuoteVersion(quote.id, built.items);
      setRevising(false);
    }, 'Nova versão do orçamento criada.');
  };

  const handoff = useMemo(
    () => ({
      kind: 'ORCAMENTO' as const,
      number: quote.quoteNumber,
      status: label(QUOTE_STATUS_LABEL, quote.status),
      customerName: quote.customer?.name ?? '',
      customerPhone: quote.customer?.phone,
      vehicle: quote.motorcycle ? `${quote.motorcycle.brand} ${quote.motorcycle.model} ${quote.motorcycle.licensePlate ?? ''}`.trim() : null,
      items,
      totalAmount: latest?.totalAmount ?? 0,
      issuedAt: new Date(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quote.id, quote.status, latest?.versionNumber, latest?.totalAmount]
  );

  const canRevise = writer && (quote.status === 'DRAFT' || quote.status === 'SENT');

  return (
    <>
      <Card title={`Orçamento #${quote.quoteNumber}`} action={<Badge tone={quoteTone(quote.status)}>{label(QUOTE_STATUS_LABEL, quote.status)}</Badge>}>
        <p className="text-sm">
          Cliente{' '}
          {quote.customer ? (
            <Link to={`/clientes/${quote.customer.id}`} className="font-semibold text-primary-500 hover:underline">
              {quote.customer.name}
            </Link>
          ) : (
            '—'
          )}{' '}
          · Veículo{' '}
          {quote.motorcycle ? (
            <Link to={`/veiculos/${quote.motorcycle.id}`} className="font-semibold text-primary-500 hover:underline">
              {quote.motorcycle.brand} {quote.motorcycle.model} {quote.motorcycle.licensePlate ?? ''}
            </Link>
          ) : (
            '—'
          )}
        </p>
        {quote.overdue && <p className="mt-2 text-sm text-amber-700">Sem resposta do cliente além do prazo.</p>}
        {quote.notes && <p className="mt-2 rounded bg-primary-50 p-2 text-sm">{quote.notes}</p>}
      </Card>

      <Card title={`Itens (versão ${latest?.versionNumber ?? 1})`}>
        {revising ? (
          <div className="space-y-3">
            <ItemsBuilder lines={lines} onChange={setLines} branchId={branchId ?? quote.branchId} />
            <div className="flex gap-2">
              <Button loading={busy} onClick={saveRevision}>
                Salvar nova versão
              </Button>
              <Button variant="secondary" onClick={() => { setRevising(false); setLines(linesFromItems(items)); }}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-primary-500">
                <tr>
                  <th className="py-1">Item</th>
                  <th className="py-1 text-right">Qtd.</th>
                  <th className="py-1 text-right">Unitário</th>
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary-100">
                {items.map((i, n) => (
                  <tr key={i.id ?? n}>
                    <td className="py-1.5">
                      {i.description} <Badge>{label(ITEM_TYPE_LABEL, i.itemType)}</Badge>
                    </td>
                    <td className="py-1.5 text-right">{formatQuantity(i.quantity)}</td>
                    <td className="py-1.5 text-right">{formatBRL(i.unitPrice)}</td>
                    <td className="py-1.5 text-right">{formatBRL(i.totalPrice)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  <td className="pt-2" colSpan={3}>
                    Total
                  </td>
                  <td className="pt-2 text-right">{formatBRL(latest?.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
            {quote.versions.length > 1 && <p className="mt-2 text-xs text-gray-500">{quote.versions.length} versões; a última é a vigente.</p>}
          </>
        )}
      </Card>

      {error && <ErrorBox message={error} />}

      {writer && !revising && (
        <Card title="Ações">
          <div className="flex flex-wrap items-end gap-3">
            {quote.status === 'DRAFT' && (
              <Button loading={busy} onClick={() => void act(() => sendQuote(quote.id, latest.versionNumber), 'Orçamento enviado ao cliente.')}>
                <Send className="h-4 w-4" /> Enviar ao cliente
              </Button>
            )}
            {quote.status === 'SENT' && (
              <>
                <Button loading={busy} onClick={() => void act(() => decideQuote(quote.id, latest.versionNumber, true), 'Orçamento aprovado.')}>
                  <CheckCircle2 className="h-4 w-4" /> Cliente aprovou
                </Button>
                <Button variant="danger" loading={busy} onClick={() => void act(() => decideQuote(quote.id, latest.versionNumber, false), 'Orçamento recusado.')}>
                  <XCircle className="h-4 w-4" /> Cliente recusou
                </Button>
              </>
            )}
            {canRevise && (
              <Button variant="secondary" onClick={() => setRevising(true)}>
                Revisar itens (nova versão)
              </Button>
            )}
            {quote.status === 'APPROVED' && (
              <div className="flex items-end gap-2">
                <label className="text-sm font-medium">
                  Km de entrada
                  <input className={`${inputClass} mt-1 w-32`} inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} aria-label="Quilometragem de entrada" />
                </label>
                <Button loading={busy} onClick={convert}>
                  <Wrench className="h-4 w-4" /> Abrir OS
                </Button>
              </div>
            )}
            {quote.status === 'CONVERTED' && latest?.serviceOrder && (
              <Link to={`/os/${latest.serviceOrder.id}`} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">
                Ver OS #{latest.serviceOrder.osNumber}
              </Link>
            )}
            {!['DRAFT', 'SENT', 'APPROVED', 'CONVERTED'].includes(quote.status) && <span className="text-sm text-gray-500">Este orçamento está encerrado. Reabrir é feito no Web/Admin.</span>}
          </div>
        </Card>
      )}

      {(quote.status === 'APPROVED' || quote.status === 'CONVERTED') && <HandoffCard input={handoff} />}
    </>
  );
}
