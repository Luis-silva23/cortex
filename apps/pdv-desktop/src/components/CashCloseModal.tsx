import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Lock, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, apiErrorMessage } from '../services/api';
import { formatBRL } from '../services/money';
import { closePayload, compareClose, DIFFERENCE_REASON_MIN, ExpectedRow, methodLabel, needsDifferenceReason } from '../services/cash-close';
import AuthorizerCredentialsForm, { AuthorizerCredentials, emptyAuthorizerCredentials } from './AuthorizerCredentialsForm';

/**
 * Fechamento de caixa (docs/CORTEX/policies/CAIXA.md). O esperado considera TODO o movimento do caixa — dinheiro,
 * cartão, PIX, convênios — e vem da API por forma de pagamento; o operador informa o realizado de cada forma (dinheiro
 * contado, relatório da maquininha, extrato do PIX…). Com diferença, a política pede o motivo.
 *
 * Pendências (pagamentos aguardando confirmação, vendas em aberto) aparecem já ao abrir; com a política bloqueando, o
 * fechamento normal dá 409 CASH_CLOSE_PENDING e a tela oferece o FECHAMENTO FORÇADO: motivo (mín. 10) e, se quem opera
 * não é gerente/administrador, as credenciais de um deles (outra pessoa). Nada é apagado.
 */
interface Pendencies {
  pendingPayments: Array<{ paymentId: string; saleNumber: number; paymentMethod: string; amount: number }>;
  openSales: Array<{ saleId: string; saleNumber: number; status: string; totalAmount: number; balance: number }>;
  totals: { pendingPaymentsCount: number; pendingPaymentsAmount: number; openSalesCount: number; openSalesBalance: number };
  blockedBy?: string[];
  normalCloseAllowed?: boolean;
  forceCloseRoles?: string[];
  expected?: { total: number; byMethod: ExpectedRow[] };
  requireDifferenceReason?: boolean;
}

const SALE_STATUS_LABEL: Record<string, string> = { PENDING: 'Pendente', PARTIALLY_PAID: 'Parcialmente paga' };
const FORCE_REASON_MIN = 10;

interface Props {
  register: { id: string; openingAmount: unknown; expectedAmount: unknown; registerNumber?: number };
  userType?: string;
  onClose: () => void;
  onClosed: () => void;
}

function CashCloseModal({ register, userType, onClose, onClosed }: Props) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [differenceReason, setDifferenceReason] = useState('');
  const [pendencies, setPendencies] = useState<Pendencies | null>(null);
  const [loadError, setLoadError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [forceMode, setForceMode] = useState(false);
  const [reason, setReason] = useState('');
  const [credentials, setCredentials] = useState<AuthorizerCredentials>(emptyAuthorizerCredentials);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Sem a prévia da API (versão antiga/sem rede) ainda dá para fechar pelo total: uma linha só, com o esperado do caixa.
  const expectedRows: ExpectedRow[] = useMemo(
    () => pendencies?.expected?.byMethod ?? [{ method: 'TOTAL', expected: Number(register.expectedAmount || 0) }],
    [pendencies, register.expectedAmount]
  );
  const comparison = useMemo(() => compareClose(expectedRows, inputs), [expectedRows, inputs]);
  const policyRequiresReason = pendencies?.requireDifferenceReason !== false;
  const reasonNeeded = needsDifferenceReason(comparison, policyRequiresReason);
  const hasPendencies = !!pendencies && (pendencies.pendingPayments.length > 0 || pendencies.openSales.length > 0);
  const forceRoles = pendencies?.forceCloseRoles ?? ['MANAGER', 'COMPANY_ADMIN'];
  const needsAuthorizer = !userType || (userType !== 'SUPER_ADMIN' && !forceRoles.includes(userType));
  const byMethodAvailable = !!pendencies?.expected;

  useEffect(() => {
    api
      .getCashRegisterPendencies(register.id)
      .then((p: Pendencies) => {
        setPendencies(p);
        setBlocked(p.normalCloseAllowed === false);
      })
      .catch((err: any) => {
        setPendencies(null);
        setLoadError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar o esperado por forma de pagamento. Confira a conexão; você ainda pode fechar pelo total.'));
      });
  }, [register.id]);

  /** Valida o que foi digitado; devolve o corpo do fechamento ou null (com a mensagem na tela). */
  const buildBody = () => {
    if (comparison.invalid.length > 0) {
      setError(`Valor inválido em: ${comparison.invalid.map(methodLabel).join(', ')}. Use números como 1.234,56.`);
      return null;
    }
    if (!comparison.complete) {
      setError('Informe o valor realizado de cada forma de pagamento (use 0 quando não houver).');
      return null;
    }
    if (reasonNeeded && differenceReason.trim().length < DIFFERENCE_REASON_MIN) {
      setError(`Há diferença de ${formatBRL(comparison.difference)} entre o informado e o esperado. Confira a contagem e, se estiver certa, informe o motivo (mínimo ${DIFFERENCE_REASON_MIN} caracteres).`);
      return null;
    }
    const body = closePayload(comparison, differenceReason);
    // Sem a prévia por forma, manda só o total (a API compara com o esperado de todas as formas).
    return byMethodAvailable ? body : { actualAmount: body.actualAmount, ...(body.differenceReason ? { differenceReason: body.differenceReason } : {}) };
  };

  const closeNormal = async () => {
    const body = buildBody();
    if (!body) return;
    setSubmitting(true);
    setError('');
    try {
      await api.closeCashRegister(register.id, body);
      toast.success('Caixa fechado com sucesso!');
      onClosed();
    } catch (err: any) {
      const data = err?.response?.data;
      if (err?.response?.status === 409 && data?.code === 'CASH_CLOSE_PENDING') {
        setPendencies((p) => ({ ...(p ?? {}), ...(data.details as Pendencies), normalCloseAllowed: false }));
        setBlocked(true);
      }
      setError(apiErrorMessage(data, 'Não foi possível fechar o caixa. Confira os valores e tente de novo.'));
    } finally {
      setSubmitting(false);
    }
  };

  const closeForced = async () => {
    const body = buildBody();
    if (!body) return;
    if (reason.trim().length < FORCE_REASON_MIN) {
      setError(`Informe o motivo do fechamento forçado (mínimo ${FORCE_REASON_MIN} caracteres)`);
      return;
    }
    if (needsAuthorizer && (!credentials.numericId || !credentials.password)) {
      setError('Informe o ID e a senha do gerente/administrador que autoriza');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.forceCloseCashRegister(register.id, {
        ...body,
        reason: reason.trim(),
        ...(needsAuthorizer
          ? {
              authorizerNumericId: parseInt(credentials.numericId, 10),
              authorizerPassword: credentials.password,
              authorizerMfaCode: credentials.mfaCode || undefined,
            }
          : {}),
      });
      toast.success('Caixa fechado (fechamento forçado registrado com as pendências)');
      onClosed();
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível forçar o fechamento'));
      setCredentials((c) => ({ ...c, password: '', mfaCode: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  const differenceTone = (d: number | null) =>
    d === null ? 'text-gray-400' : Math.abs(d) < 0.01 ? 'text-green-700' : 'text-amber-700 font-semibold';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="cash-close-title">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6">
        <h3 id="cash-close-title" className="text-2xl font-bold text-gray-900 mb-2 flex items-center gap-2">
          <Lock size={24} /> {forceMode ? 'Fechamento forçado' : 'Fechar Caixa'}
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          O esperado considera todo o movimento deste caixa: dinheiro, cartão, PIX e convênios. Informe o realizado de cada
          forma (dinheiro contado, relatório da maquininha, extrato do PIX).
        </p>

        <div className="space-y-4 mb-6">
          {loadError && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3" role="status">
              {loadError}
            </p>
          )}

          <table className="w-full text-sm" data-testid="cash-close-by-method">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="px-2 py-2 font-medium">Forma</th>
                <th className="px-2 py-2 font-medium text-right">Esperado</th>
                <th className="px-2 py-2 font-medium text-right">Informado</th>
                <th className="px-2 py-2 font-medium text-right">Diferença</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.method} className="border-b border-gray-100 align-top">
                  <td className="px-2 py-2">
                    <span className="font-medium text-gray-900">{row.method === 'TOTAL' ? 'Total do caixa' : methodLabel(row.method)}</span>
                    {row.method === 'CASH' && (
                      <span className="block text-xs text-gray-500">
                        fundo {formatBRL(row.opening ?? 0)} + vendas {formatBRL(row.sales ?? 0)} + reforços {formatBRL(row.deposits ?? 0)} − sangrias{' '}
                        {formatBRL(row.withdrawals ?? 0)} − estornos {formatBRL(row.refunds ?? 0)}
                      </span>
                    )}
                    {row.readOnly && <span className="block text-xs text-gray-500">Estorno cuja forma não foi identificada — entra no esperado.</span>}
                  </td>
                  <td className="px-2 py-2 text-right font-semibold">{formatBRL(row.expected)}</td>
                  <td className="px-2 py-2 text-right">
                    {row.readOnly ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <input
                        aria-label={`Informado — ${row.method === 'TOTAL' ? 'total do caixa' : methodLabel(row.method)}`}
                        inputMode="decimal"
                        value={inputs[row.method] ?? ''}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [row.method]: e.target.value }))}
                        disabled={submitting}
                        placeholder="0,00"
                        className="w-28 px-3 py-2 rounded-lg border border-gray-300 text-right focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                      />
                    )}
                  </td>
                  <td className={`px-2 py-2 text-right ${differenceTone(row.difference)}`}>{row.difference === null ? '—' : formatBRL(row.difference)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="px-2 py-2 font-semibold text-gray-900">Total</td>
                <td className="px-2 py-2 text-right font-bold">{formatBRL(comparison.expectedTotal)}</td>
                <td className="px-2 py-2 text-right font-bold">{formatBRL(comparison.informedTotal)}</td>
                <td className={`px-2 py-2 text-right ${differenceTone(comparison.complete ? comparison.difference : null)}`}>
                  {comparison.complete ? formatBRL(comparison.difference) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>

          {comparison.complete && reasonNeeded && (
            <div>
              <label htmlFor="cash-close-difference-reason" className="block text-sm font-medium text-gray-700 mb-2">
                Motivo da diferença (mínimo {DIFFERENCE_REASON_MIN} caracteres)
              </label>
              <textarea
                id="cash-close-difference-reason"
                value={differenceReason}
                onChange={(e) => setDifferenceReason(e.target.value)}
                rows={2}
                disabled={submitting}
                placeholder="Ex.: troco dado a mais; venda no cartão digitada como dinheiro"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none"
              />
              <p className="text-xs text-gray-500 mt-1">A diferença e o motivo ficam registrados no fechamento.</p>
            </div>
          )}

          {hasPendencies && pendencies && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-testid="cash-close-pendencies">
              <p className="font-semibold flex items-center gap-2">
                <AlertTriangle size={18} /> Pendências deste caixa
              </p>
              {pendencies.pendingPayments.length > 0 && (
                <div className="mt-2">
                  <p>
                    {pendencies.totals.pendingPaymentsCount} pagamento(s) aguardando confirmação — {formatBRL(pendencies.totals.pendingPaymentsAmount)}
                  </p>
                  <ul className="ml-4 list-disc">
                    {pendencies.pendingPayments.slice(0, 8).map((p) => (
                      <li key={p.paymentId}>
                        Venda Nº {p.saleNumber}: {methodLabel(p.paymentMethod)} {formatBRL(p.amount)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {pendencies.openSales.length > 0 && (
                <div className="mt-2">
                  <p>
                    {pendencies.totals.openSalesCount} venda(s) em aberto — saldo {formatBRL(pendencies.totals.openSalesBalance)}
                  </p>
                  <ul className="ml-4 list-disc">
                    {pendencies.openSales.slice(0, 8).map((s) => (
                      <li key={s.saleId}>
                        Venda Nº {s.saleNumber} ({SALE_STATUS_LABEL[s.status] ?? s.status}): falta {formatBRL(s.balance)}
                      </li>
                    ))}
                  </ul>
                  {pendencies.openSales.length > 8 && <p className="ml-4">… e mais {pendencies.openSales.length - 8}.</p>}
                </div>
              )}
              <p className="mt-2">
                {blocked
                  ? 'Pela política da loja, o fechamento normal fica bloqueado. Resolva as pendências (em Vendas) ou use o fechamento forçado.'
                  : 'A política da loja permite fechar com pendências; elas ficam registradas no fechamento.'}{' '}
                O fechamento nunca apaga venda, pagamento, sangria ou reforço.
              </p>
            </div>
          )}

          {forceMode && (
            <div className="space-y-4 rounded-lg border border-red-200 bg-red-50 p-4" data-testid="cash-force-close-form">
              <p className="text-sm text-red-800 flex items-start gap-2">
                <ShieldAlert size={18} className="flex-shrink-0 mt-0.5" />
                O fechamento forçado é registrado com o motivo, as pendências e os valores deste momento, quem pediu e quem autorizou.
              </p>
              <div>
                <label htmlFor="cash-force-reason" className="block text-sm font-medium text-gray-700 mb-2">
                  Motivo do fechamento forçado (mínimo {FORCE_REASON_MIN} caracteres)
                </label>
                <textarea
                  id="cash-force-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  disabled={submitting}
                  placeholder="Ex.: PIX do cliente não confirmou até o fim do turno"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none bg-white"
                />
              </div>
              {needsAuthorizer ? (
                <AuthorizerCredentialsForm value={credentials} onChange={setCredentials} disabled={submitting} />
              ) : (
                <p className="text-sm text-gray-700">Você tem perfil para forçar o fechamento: ficará registrado como autorizado por você.</p>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          {forceMode ? (
            <button
              onClick={closeForced}
              disabled={submitting}
              className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
            >
              {submitting ? 'Fechando...' : 'Confirmar fechamento forçado'}
            </button>
          ) : blocked ? (
            <button
              onClick={() => {
                setForceMode(true);
                setError('');
              }}
              className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition-colors"
            >
              Fechamento forçado
            </button>
          ) : (
            <button
              onClick={closeNormal}
              disabled={submitting}
              className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
            >
              {submitting ? 'Fechando...' : 'Fechar Caixa'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CashCloseModal;
