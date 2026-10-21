import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, UserPlus, Bike } from 'lucide-react';
import { createCustomer, listMotorcycles, searchCustomers } from '../api/endpoints';
import { toApiError } from '../api/http';
import type { Customer, Motorcycle } from '../api/types';
import { useAuthStore } from '../store/auth.store';
import { canWrite } from '../lib/permissions';
import { canSearch, classifySearch } from '../lib/search';
import { Button, Card, EmptyState, ErrorBox, inputClass, Spinner, useSubmitOnce } from '../components/ui';
import toast from 'react-hot-toast';

/** Tela inicial do balcão: UMA busca (nome, documento, telefone ou placa) que leva ao cliente e ao veículo. */
export default function AtendimentoPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [bikes, setBikes] = useState<Motorcycle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const { run, busy } = useSubmitOnce();

  // Busca com atraso (não consulta a cada tecla) e descarta resposta de uma busca já superada.
  useEffect(() => {
    if (!canSearch(term)) {
      setCustomers([]);
      setBikes([]);
      setSearched(false);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { kind, term: q } = classifySearch(term);
        const [c, m] = await Promise.all([
          kind === 'plate' ? Promise.resolve([] as Customer[]) : searchCustomers(kind === 'digits' ? q : term.trim()),
          kind === 'digits' ? Promise.resolve([] as Motorcycle[]) : listMotorcycles({ search: q, limit: 10 }),
        ]);
        if (cancelled) return;
        setCustomers(c);
        setBikes(m);
        setSearched(true);
      } catch (e) {
        if (!cancelled) setError(toApiError(e).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const registerCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim().length < 2) return toast.error('Informe o nome do cliente.');
    void run(async () => {
      try {
        const created = await createCustomer({ name: newName.trim(), phone: newPhone.trim() || undefined });
        toast.success('Cliente cadastrado.');
        navigate(`/clientes/${created.id}`);
      } catch (err) {
        toast.error(toApiError(err).message);
      }
    });
  };

  const empty = searched && !loading && customers.length === 0 && bikes.length === 0;

  return (
    <>
      <Card title="Quem está sendo atendido?">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            autoFocus
            className={`${inputClass} pl-9 text-base`}
            placeholder="Nome, CPF/CNPJ, telefone ou placa"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Buscar cliente ou veículo"
          />
        </div>
        {term.length > 0 && !canSearch(term) && <p className="mt-2 text-xs text-gray-500">Digite pelo menos 2 caracteres.</p>}
        {loading && <Spinner label="Buscando…" />}
        {error && <div className="mt-3"><ErrorBox message={error} /></div>}
      </Card>

      {customers.length > 0 && (
        <Card title={`Clientes (${customers.length})`}>
          <ul className="divide-y divide-primary-100">
            {customers.map((c) => (
              <li key={c.id}>
                <Link to={`/clientes/${c.id}`} className="flex items-center justify-between py-2 hover:bg-primary-50">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-sm text-gray-500">{[c.document, c.phone ?? c.mobile].filter(Boolean).join(' · ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {bikes.length > 0 && (
        <Card title={`Veículos (${bikes.length})`}>
          <ul className="divide-y divide-primary-100">
            {bikes.map((m) => (
              <li key={m.id}>
                <Link to={`/veiculos/${m.id}`} className="flex items-center justify-between py-2 hover:bg-primary-50">
                  <span className="flex items-center gap-2 font-medium">
                    <Bike className="h-4 w-4" /> {m.brand} {m.model}
                  </span>
                  <span className="text-sm text-gray-500">{m.licensePlate ?? 'sem placa'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {empty && (
        <Card title="Nada encontrado">
          <EmptyState>Nenhum cliente ou veículo para “{term}”.</EmptyState>
          {canWrite(user?.userType) && (
            <form onSubmit={registerCustomer} className="mx-auto mt-2 max-w-md space-y-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-primary-600">
                <UserPlus className="h-4 w-4" /> Cadastrar cliente novo
              </p>
              <input className={inputClass} placeholder="Nome" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Nome do novo cliente" />
              <input className={inputClass} placeholder="Telefone (opcional)" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} aria-label="Telefone do novo cliente" />
              <Button type="submit" loading={busy}>
                Cadastrar e atender
              </Button>
            </form>
          )}
        </Card>
      )}
    </>
  );
}
