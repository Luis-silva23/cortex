import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { createQuote, getCustomer, getMotorcycle } from '../api/endpoints';
import { ApiError, toApiError } from '../api/http';
import { useAuthStore } from '../store/auth.store';
import { canWrite } from '../lib/permissions';
import { buildItemsPayload, type Line } from '../lib/quote-lines';
import { AsyncBlock, Button, Card, ErrorBox, inputClass, useAsync, useSubmitOnce } from '../components/ui';
import ItemsBuilder from '../components/ItemsBuilder';

/** Novo orçamento: cliente + veículo (já escolhidos no atendimento) + itens. O total oficial é do servidor. */
export default function QuoteNewPage() {
  const [params] = useSearchParams();
  const customerId = params.get('customerId') ?? '';
  const motorcycleId = params.get('motorcycleId') ?? '';
  const { user, branchId } = useAuthStore();
  const navigate = useNavigate();
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [conflict, setConflict] = useState<{ message: string; existingQuoteId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useSubmitOnce();
  const customer = useAsync(() => getCustomer(customerId), [customerId]);
  const bike = useAsync(() => getMotorcycle(motorcycleId), [motorcycleId]);

  if (!customerId || !motorcycleId) return <Navigate to="/" replace />;
  if (!canWrite(user?.userType)) return <ErrorBox message="O seu perfil só consulta: não cria orçamento." />;

  const submit = (confirmNew: boolean) => {
    setError(null);
    const built = buildItemsPayload(lines);
    if (!built.ok) return setError(built.error);
    if (!branchId) return setError('Escolha a filial (no topo da tela) antes de salvar.');
    void run(async () => {
      try {
        const quote = await createQuote({ branchId, customerId, motorcycleId, items: built.items, notes: notes.trim() || undefined, confirmNew });
        toast.success(`Orçamento #${quote.quoteNumber} criado.`);
        navigate(`/orcamentos/${quote.id}`, { replace: true });
      } catch (e) {
        const err = toApiError(e);
        if (err instanceof ApiError && err.code === 'OPEN_QUOTE_EXISTS') {
          setConflict({ message: err.message, existingQuoteId: err.data?.existingQuoteId });
        } else {
          setError(err.message);
        }
      }
    });
  };

  return (
    <>
      <Card title="Novo orçamento">
        <AsyncBlock state={customer}>
          {(c) => (
            <AsyncBlock state={bike}>
              {(m) => (
                <p className="text-sm">
                  Cliente <strong>{c.name}</strong> · Veículo{' '}
                  <strong>
                    {m.brand} {m.model}
                  </strong>{' '}
                  {m.licensePlate ?? ''}
                </p>
              )}
            </AsyncBlock>
          )}
        </AsyncBlock>
      </Card>

      <Card title="Itens">
        <ItemsBuilder lines={lines} onChange={setLines} branchId={branchId} />
      </Card>

      <Card title="Observações">
        <textarea className={`${inputClass} min-h-[80px]`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações para o cliente (opcional)" aria-label="Observações" />
      </Card>

      {error && <ErrorBox message={error} />}
      {conflict && (
        <div role="alert" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p>{conflict.message}</p>
          <div className="flex flex-wrap gap-2">
            {conflict.existingQuoteId && (
              <Link to={`/orcamentos/${conflict.existingQuoteId}`} className="rounded-lg border border-primary-300 bg-white px-4 py-2 font-semibold text-primary-600">
                Abrir o orçamento existente
              </Link>
            )}
            <Button variant="secondary" loading={busy} onClick={() => submit(true)}>
              Criar outro mesmo assim
            </Button>
          </div>
        </div>
      )}
      <div className="flex gap-3">
        <Button loading={busy} onClick={() => submit(false)}>
          Salvar orçamento
        </Button>
        <Link to={`/clientes/${customerId}`} className="rounded-lg px-4 py-2 text-sm font-semibold text-primary-500 hover:underline">
          Cancelar
        </Link>
      </div>
    </>
  );
}
