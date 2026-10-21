import { useEffect, useState } from 'react';
import { AlertTriangle, Percent } from 'lucide-react';
import AuthorizerCredentialsForm, { AuthorizerCredentials, emptyAuthorizerCredentials } from './AuthorizerCredentialsForm';
import { useDiscountAuthorizationStore, DISCOUNT_ITEM_TYPE_LABEL } from '../store/discountAuthorization.store';
import { api } from '../services/api';

const REASON_MIN = 5;

/**
 * Autorização de desconto acima do limite livre (política da empresa/filial). Aberto por `api.createSale` quando a API
 * responde 409 DISCOUNT_AUTHORIZATION_REQUIRED. Quem autoriza é um gerente/administrador — outra pessoa, com as
 * próprias credenciais; o motivo é obrigatório e fica no registro do desconto (discount_events).
 */
function DiscountAuthorizationDialog() {
  const pending = useDiscountAuthorizationStore((s) => s.pending);
  const answer = useDiscountAuthorizationStore((s) => s.answer);
  const [reason, setReason] = useState('');
  const [credentials, setCredentials] = useState<AuthorizerCredentials>(emptyAuthorizerCredentials);
  const [localError, setLocalError] = useState('');
  const [limits, setLimits] = useState<{ product: number; service: number } | null>(null);

  useEffect(() => {
    if (!pending) return;
    // A cada novo pedido a senha é sempre redigitada (a tentativa anterior pode ter sido recusada).
    setCredentials((c) => ({ ...emptyAuthorizerCredentials, numericId: pending.error ? c.numericId : '' }));
    setReason(pending.reason ?? '');
    setLocalError('');
    api
      .getEffectivePolicies()
      .then(({ values }) =>
        setLimits({ product: Number(values?.['discount.productFreePercent'] ?? 5), service: Number(values?.['discount.serviceFreePercent'] ?? 0) })
      )
      .catch(() => setLimits(null));
  }, [pending]);

  if (!pending) return null;
  const { details } = pending;

  const submit = () => {
    if (reason.trim().length < REASON_MIN) {
      setLocalError(`Informe o motivo do desconto (mínimo ${REASON_MIN} caracteres)`);
      return;
    }
    if (!credentials.numericId || !credentials.password) {
      setLocalError('Informe o ID e a senha de quem autoriza');
      return;
    }
    answer({ reason: reason.trim(), ...credentials });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]" role="dialog" aria-modal="true" aria-labelledby="discount-auth-title">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-5">
        <h2 id="discount-auth-title" className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Percent size={24} className="text-primary-600" /> Autorização de desconto
        </h2>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800 flex items-start gap-2">
          <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
          <div>
            <p>
              Desconto de <strong>{details.requestedPercent}%</strong> em {DISCOUNT_ITEM_TYPE_LABEL[details.itemType] ?? 'itens'} passa o limite sem
              autorização{details.freeLimitPercent !== null ? ` (${details.freeLimitPercent}%)` : ''}.
            </p>
            {limits && (
              <p className="mt-1" data-testid="discount-free-limits">
                Limite sem autorização desta loja: {limits.product}% em produtos/peças e {limits.service}% em serviços.
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="discount-auth-reason" className="block text-sm font-medium text-gray-700 mb-2">
            Motivo do desconto
          </label>
          <textarea
            id="discount-auth-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Ex.: cliente antigo, produto com avaria na embalagem"
            className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none"
          />
        </div>

        <AuthorizerCredentialsForm value={credentials} onChange={setCredentials} />

        {(localError || pending.error) && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3" role="alert">
            {localError || pending.error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => answer(null)}
            className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors"
          >
            Voltar sem desconto autorizado
          </button>
          <button onClick={submit} className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors">
            Autorizar desconto
          </button>
        </div>
      </div>
    </div>
  );
}

export default DiscountAuthorizationDialog;
