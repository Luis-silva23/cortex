import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Bike, FilePlus, Phone } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  createMotorcycle,
  getCustomer,
  getCustomerStats,
  listMotorcycles,
  listQuotes,
  listServiceOrders,
} from '../api/endpoints';
import { toApiError } from '../api/http';
import { useAuthStore } from '../store/auth.store';
import { canSeeSales, canWrite } from '../lib/permissions';
import { formatBRL, parseInputNumber } from '../lib/money';
import { OS_STATUS_LABEL, QUOTE_STATUS_LABEL, SALE_STATUS_LABEL, label, osTone, quoteTone } from '../lib/labels';
import { AsyncBlock, Badge, Button, Card, ErrorBox, inputClass, useAsync, useSubmitOnce } from '../components/ui';

/** Visão consolidada do cliente: dados, veículos, orçamentos, OS e compras — cada bloco carrega e falha sozinho. */
export default function CustomerPage() {
  const { id = '' } = useParams();
  const user = useAuthStore((s) => s.user);
  const writer = canWrite(user?.userType);
  const customer = useAsync(() => getCustomer(id), [id]);
  const stats = useAsync(() => getCustomerStats(id), [id]);
  const bikes = useAsync(() => listMotorcycles({ customerId: id, limit: 50 }), [id]);
  const quotes = useAsync(() => listQuotes({ customerId: id, limit: 10 }), [id]);
  const orders = useAsync(() => listServiceOrders({ customerId: id, limit: 10 }), [id]);
  const { run, busy } = useSubmitOnce();
  const [form, setForm] = useState({ brand: '', model: '', licensePlate: '', km: '' });
  const [showForm, setShowForm] = useState(false);

  const addBike = (e: React.FormEvent) => {
    e.preventDefault();
    const km = parseInputNumber(form.km || '0');
    if (!form.brand.trim() || !form.model.trim() || km === null) return toast.error('Informe marca, modelo e uma quilometragem válida.');
    void run(async () => {
      try {
        await createMotorcycle({ customerId: id, brand: form.brand.trim(), model: form.model.trim(), licensePlate: form.licensePlate.trim() || undefined, kilometerReading: km });
        toast.success('Veículo cadastrado.');
        setForm({ brand: '', model: '', licensePlate: '', km: '' });
        setShowForm(false);
        await bikes.reload();
      } catch (err) {
        toast.error(toApiError(err).message);
      }
    });
  };

  return (
    <>
      <AsyncBlock state={customer}>
        {(c) => (
          <Card title="Cliente">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h1 className="text-xl font-bold">{c.name}</h1>
              {c.isActive === false && <Badge tone="danger">Inativo</Badge>}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-4 text-sm text-gray-600">
              {c.document && <span>{c.document}</span>}
              {(c.phone || c.mobile || c.whatsapp) && (
                <span className="flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5" /> {[c.phone, c.mobile, c.whatsapp].filter(Boolean).join(' · ')}
                </span>
              )}
              {c.email && <span>{c.email}</span>}
            </p>
            {c.notes && <p className="mt-2 rounded bg-primary-50 p-2 text-sm">{c.notes}</p>}
            {stats.data && (
              <p className="mt-3 text-sm text-gray-600">
                {stats.data.stats.totalSales} compra(s) · {formatBRL(stats.data.stats.totalPurchases)} no total
                {stats.data.stats.lastPurchase ? ` · última em ${new Date(stats.data.stats.lastPurchase).toLocaleDateString('pt-BR')}` : ''}
              </p>
            )}
          </Card>
        )}
      </AsyncBlock>

      <Card
        title="Veículos"
        action={
          writer && (
            <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'Fechar' : 'Novo veículo'}
            </Button>
          )
        }
      >
        {showForm && (
          <form onSubmit={addBike} className="mb-4 grid gap-3 rounded-lg bg-primary-50 p-3 sm:grid-cols-5">
            <input className={inputClass} placeholder="Marca" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} aria-label="Marca" />
            <input className={inputClass} placeholder="Modelo" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} aria-label="Modelo" />
            <input className={inputClass} placeholder="Placa" value={form.licensePlate} onChange={(e) => setForm({ ...form, licensePlate: e.target.value })} aria-label="Placa" />
            <input className={inputClass} placeholder="Km" inputMode="decimal" value={form.km} onChange={(e) => setForm({ ...form, km: e.target.value })} aria-label="Quilometragem" />
            <Button type="submit" loading={busy}>
              Cadastrar
            </Button>
          </form>
        )}
        <AsyncBlock state={bikes} isEmpty={(l) => l.length === 0} empty="Este cliente ainda não tem veículo cadastrado.">
          {(list) => (
            <ul className="divide-y divide-primary-100">
              {list.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link to={`/veiculos/${m.id}`} className="flex items-center gap-2 font-medium hover:underline">
                    <Bike className="h-4 w-4" /> {m.brand} {m.model} {m.year ? `· ${m.year}` : ''}
                    <span className="text-sm font-normal text-gray-500">{m.licensePlate ?? 'sem placa'}</span>
                  </Link>
                  {writer && (
                    <Link to={`/orcamentos/novo?customerId=${id}&motorcycleId=${m.id}`} className="flex items-center gap-1 text-sm font-semibold text-primary-500 hover:underline">
                      <FilePlus className="h-4 w-4" /> Novo orçamento
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </AsyncBlock>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Orçamentos">
          <AsyncBlock state={quotes} isEmpty={(d) => d.quotes.length === 0} empty="Sem orçamentos.">
            {(d) => (
              <ul className="divide-y divide-primary-100">
                {d.quotes.map((q) => (
                  <li key={q.id}>
                    <Link to={`/orcamentos/${q.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-primary-50">
                      <span>
                        #{q.quoteNumber} · {q.motorcycle ? `${q.motorcycle.brand} ${q.motorcycle.model}` : ''}
                      </span>
                      <span className="flex items-center gap-2">
                        {formatBRL(q.versions[q.versions.length - 1]?.totalAmount)}
                        <Badge tone={quoteTone(q.status)}>{label(QUOTE_STATUS_LABEL, q.status)}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncBlock>
        </Card>

        <Card title="Ordens de serviço">
          <AsyncBlock state={orders} isEmpty={(d) => d.orders.length === 0} empty="Sem ordens de serviço.">
            {(d) => (
              <ul className="divide-y divide-primary-100">
                {d.orders.map((o) => (
                  <li key={o.id}>
                    <Link to={`/os/${o.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-primary-50">
                      <span>
                        OS #{o.osNumber} · {o.motorcycle ? `${o.motorcycle.brand} ${o.motorcycle.model}` : ''}
                      </span>
                      <Badge tone={osTone(o.status)}>{label(OS_STATUS_LABEL, o.status)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncBlock>
        </Card>
      </div>

      {canSeeSales(user?.userType) ? (
        <AsyncBlock state={customer}>
          {(c) =>
            (c.sales ?? []).length === 0 ? null : (
              <Card title="Compras recentes">
                <ul className="divide-y divide-primary-100">
                  {(c.sales ?? []).map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                      <span>
                        Venda #{s.saleNumber} · {s.saleDate ? new Date(s.saleDate).toLocaleDateString('pt-BR') : ''}
                      </span>
                      <span className="flex items-center gap-2">
                        {formatBRL(s.totalAmount)} <Badge>{label(SALE_STATUS_LABEL, s.status)}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )
          }
        </AsyncBlock>
      ) : (
        <ErrorBox message="O histórico de compras não está disponível para o seu perfil." />
      )}
    </>
  );
}
