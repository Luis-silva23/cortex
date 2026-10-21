import { useEffect, useRef, useState } from 'react';
import { Search, Loader2, Lock } from 'lucide-react';
import { api } from '../services/api';
import { formatBRL } from '../services/money';
import { readableError } from '../services/payment-flow';

/**
 * Convênio no caixa (contrato do módulo de convênios):
 *  - Funcionário: busca por nome/CPF/matrícula; mostra limite, usado, disponível e parcelas máximas; escolhe parcelas.
 *  - Empresa: busca a conveniada; mostra disponível e prazo. Bloqueada/inativa aparece, mas não pode ser escolhida.
 * O servidor confere tudo de novo no pagamento (limite, bloqueio, política) — aqui é só para o operador decidir rápido.
 */
export type AgreementKind = 'EMPLOYEE' | 'COMPANY';

export interface AgreementSelection {
  kind: AgreementKind;
  id: string;
  label: string;
  detail: string;
  available: number | null;
  maxInstallments: number;
  installments: number;
  paymentTermDays?: number | null;
}

interface Props {
  kind: AgreementKind;
  total: number;
  value: AgreementSelection | null;
  onChange: (selection: AgreementSelection | null) => void;
  disabled?: boolean;
}

const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Ativo', BLOCKED: 'Bloqueado', INACTIVE: 'Inativo', SUSPENDED: 'Suspenso' };
const num = (v: any): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function AgreementPaymentPanel({ kind, total, value, onChange, disabled }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    setQuery('');
    setResults([]);
    setError('');
    setSearched(false);
    if (!value) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const rows = kind === 'EMPLOYEE' ? await api.lookupEmployeeAgreements(q) : await api.lookupAgreementCompanies(q);
        if (mine === seq.current) {
          setResults(rows);
          setSearched(true);
        }
      } catch (e: any) {
        if (mine !== seq.current) return;
        const status = e?.response?.status;
        setResults([]);
        setError(
          !e?.response
            ? 'Sem conexão com o servidor — não foi possível buscar o convênio.'
            : status === 404
              ? 'Busca de convênios indisponível neste servidor (rota não encontrada). Use outra forma de pagamento e avise o suporte.'
              : status === 403
                ? 'Seu perfil não pode consultar convênios. Chame a gerência.'
                : readableError(e.response.data) || 'Não foi possível buscar o convênio.'
        );
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, kind]);

  const toSelection = (row: any): AgreementSelection =>
    kind === 'EMPLOYEE'
      ? {
          kind,
          id: row.id,
          label: row.name,
          detail: [row.cpfMasked && `CPF ${row.cpfMasked}`, row.registration && `Matrícula ${row.registration}`].filter(Boolean).join(' · '),
          available: num(row.available),
          maxInstallments: Math.max(1, Number(row.maxInstallments) || 1),
          installments: 1,
        }
      : {
          kind,
          id: row.id,
          label: row.tradeName || row.legalName,
          detail: [row.tradeName && row.legalName !== row.tradeName ? row.legalName : null, row.cnpjMasked && `CNPJ ${row.cnpjMasked}`].filter(Boolean).join(' · '),
          available: num(row.available),
          maxInstallments: 1,
          installments: 1,
          paymentTermDays: num(row.paymentTermDays),
        };

  const blockReason = (row: any): string | null => {
    // Convênio que existe mas não vale nesta filial: fica na lista, cinza, com a mensagem da API.
    if (row.availableHere === false) return row.unavailableReason ?? 'Convênio não habilitado para esta filial. Entre em contato com o administrador.';
    if (row.status && row.status !== 'ACTIVE') return STATUS_LABEL[row.status] ?? row.status;
    const available = num(row.available);
    if (available !== null && available < total) return `Disponível ${formatBRL(available)} — menor que a venda`;
    return null;
  };

  if (value) {
    const insufficient = value.available !== null && value.available < total;
    return (
      <div className="rounded-lg border-2 border-primary-500 bg-primary-50 p-4 space-y-3" data-testid="agreement-selected">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-gray-900">{value.label}</p>
            {value.detail && <p className="text-sm text-gray-600">{value.detail}</p>}
            <p className="text-sm text-gray-700 mt-1">
              Disponível: <strong>{value.available === null ? 'sem limite definido' : formatBRL(value.available)}</strong>
              {value.kind === 'COMPANY' && value.paymentTermDays != null && <> · Prazo: <strong>{value.paymentTermDays} dias</strong></>}
            </p>
          </div>
          <button type="button" onClick={() => onChange(null)} disabled={disabled} className="text-sm text-primary-700 hover:underline disabled:opacity-50">
            Trocar
          </button>
        </div>
        {insufficient && <p className="text-sm text-red-700">Limite disponível menor que o total da venda.</p>}
        {value.kind === 'EMPLOYEE' && (
          <div>
            <label htmlFor="agreement-installments" className="block text-sm font-medium text-gray-700 mb-1">
              Parcelas (máximo {value.maxInstallments}x)
            </label>
            <select
              id="agreement-installments"
              value={value.installments}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, installments: parseInt(e.target.value, 10) })}
              className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 outline-none"
            >
              {Array.from({ length: value.maxInstallments }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}x de {formatBRL(total / n)} {n === 1 ? '(desconto único em folha)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label htmlFor="agreement-search" className="block text-sm font-medium text-gray-700">
        {kind === 'EMPLOYEE' ? 'Buscar funcionário conveniado (nome, CPF ou matrícula)' : 'Buscar empresa conveniada (nome ou CNPJ)'}
      </label>
      <div className="relative">
        <input
          id="agreement-search"
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          // Enter aqui escolhe o único resultado (leitura rápida), nunca confirma o pagamento sem conveniado.
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const usable = results.filter((r) => !blockReason(r));
            if (usable.length === 1) onChange(toSelection(usable[0]));
          }}
          placeholder="Digite ao menos 2 caracteres"
          className="w-full px-4 py-2 pl-10 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 outline-none"
        />
        {loading ? <Loader2 size={18} className="absolute left-3 top-2.5 animate-spin text-gray-400" /> : <Search size={18} className="absolute left-3 top-2.5 text-gray-400" />}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {searched && !error && results.length === 0 && <p className="text-sm text-gray-600">Nenhum convênio encontrado para "{query.trim()}".</p>}
      {results.length > 0 && (
        <ul className="max-h-56 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-200" aria-label="Convênios encontrados">
          {results.map((row) => {
            const reason = blockReason(row);
            const sel = toSelection(row);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  disabled={!!reason || disabled}
                  onClick={() => onChange(sel)}
                  className="w-full text-left px-3 py-2 hover:bg-primary-50 disabled:hover:bg-transparent disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">{sel.label}</span>
                    {reason ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-red-700">
                        <Lock size={12} /> {reason}
                      </span>
                    ) : (
                      <span className="text-xs font-semibold text-green-700">{STATUS_LABEL[row.status] ?? 'Ativo'}</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-600">
                    {sel.detail && <span>{sel.detail} · </span>}
                    {kind === 'EMPLOYEE' ? (
                      <span>
                        Limite {row.limit != null ? formatBRL(Number(row.limit)) : '—'} · Usado {row.used != null ? formatBRL(Number(row.used)) : '—'} · Disponível{' '}
                        {sel.available === null ? '—' : formatBRL(sel.available)} · até {sel.maxInstallments}x
                      </span>
                    ) : (
                      <span>
                        Disponível {sel.available === null ? 'sem limite definido' : formatBRL(sel.available)}
                        {sel.paymentTermDays != null && ` · Prazo ${sel.paymentTermDays} dias`}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default AgreementPaymentPanel;
