import { useState } from 'react';
import { X, Banknote, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { formatBRL } from '../services/money';
import AuthorizerCredentialsForm, {
  AuthorizerCredentials,
  emptyAuthorizerCredentials,
} from './AuthorizerCredentialsForm';

interface WithdrawalModalProps {
  isOpen: boolean;
  onClose: () => void;
  cashRegisterId: string;
  registerLabel: string;
  operatorName: string;
  onSuccess: () => void;
}

type Step = 'amount' | 'auth' | 'success';

function WithdrawalModal({
  isOpen,
  onClose,
  cashRegisterId,
  registerLabel,
  operatorName,
  onSuccess,
}: WithdrawalModalProps) {
  const [step, setStep] = useState<Step>('amount');
  const [amount, setAmount] = useState('0.00');
  const [reason, setReason] = useState('');
  const [credentials, setCredentials] = useState<AuthorizerCredentials>(emptyAuthorizerCredentials);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  if (!isOpen) return null;

  const parsedAmount = parseFloat(amount) || 0;

  const resetAndClose = () => {
    setStep('amount');
    setAmount('0.00');
    setReason('');
    setCredentials(emptyAuthorizerCredentials);
    setError('');
    setResult(null);
    onClose();
  };

  // Passo 1 -> 2, mesma função usada pelo botão "Continuar" e pelo ENTER
  // dentro dos campos de valor/motivo.
  const handleContinueToAuth = () => {
    setError('');
    if (!(parsedAmount > 0)) {
      setError('Informe um valor maior que zero');
      return;
    }
    if (!reason || reason.trim().length < 3) {
      setError('Motivo deve ter no mínimo 3 caracteres');
      return;
    }
    setStep('auth');
  };

  const handleSubmit = async () => {
    if (!credentials.numericId || !credentials.password) {
      setError('Informe o ID e a senha do autorizador');
      return;
    }

    setIsSubmitting(true);
    setError('');
    try {
      const response = await api.requestWithdrawal(cashRegisterId, {
        amount: parsedAmount,
        reason: reason.trim(),
        authorizerNumericId: parseInt(credentials.numericId, 10),
        authorizerPassword: credentials.password,
        authorizerMfaCode: credentials.mfaCode || undefined,
      });

      setResult(response.data);
      setStep('success');
      onSuccess();
    } catch (err: any) {
      // Mensagem exata devolvida pelo backend (verifyDualAuthorization /
      // requestWithdrawal) — nunca parafraseada, é o que o operador precisa
      // ler para saber exatamente o que falhou (senha errada, MFA inválido,
      // auto-autorização bloqueada, perfil sem permissão, etc).
      const backendMessage = err.response?.data?.error;
      setError(backendMessage || 'Erro ao registrar retirada de caixa');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinish = () => {
    resetAndClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Banknote size={24} className="text-red-600" />
            Retirada de Caixa
          </h2>
          {step !== 'success' && (
            <button
              onClick={resetAndClose}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
            >
              <X size={24} />
            </button>
          )}
        </div>

        <div className="p-6 space-y-6">
          {step === 'amount' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Valor a Retirar</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleContinueToAuth()}
                  min="0"
                  step="0.01"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Motivo</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleContinueToAuth();
                    }
                  }}
                  rows={3}
                  placeholder="Ex.: Pagamento de fornecedor, depósito bancário..."
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none"
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
                  <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={resetAndClose}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleContinueToAuth}
                  className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition-colors"
                >
                  Continuar
                </button>
              </div>
            </>
          )}

          {step === 'auth' && (
            <>
              <div className="bg-gray-50 rounded-lg p-4 flex justify-between text-sm">
                <span className="text-gray-600">Valor da retirada:</span>
                <span className="font-bold text-gray-900">{formatBRL(parsedAmount)}</span>
              </div>

              <AuthorizerCredentialsForm value={credentials} onChange={setCredentials} disabled={isSubmitting} autoFocus />

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
                  <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setError('');
                    setStep('amount');
                  }}
                  disabled={isSubmitting}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors disabled:opacity-50"
                >
                  Voltar
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={20} className="animate-spin" />
                      Autorizando...
                    </>
                  ) : (
                    'Autorizar Retirada'
                  )}
                </button>
              </div>
            </>
          )}

          {step === 'success' && result && (
            <>
              <div className="text-center py-2">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 size={32} className="text-green-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-900">RETIRADA REGISTRADA</h3>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Ordem de retirada nº</span>
                  <span className="font-semibold text-gray-900">{String(result.movement.id).slice(0, 8)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Valor</span>
                  <span className="font-semibold text-gray-900">{formatBRL(Number(result.movement.amount))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Responsável pela retirada</span>
                  <span className="font-semibold text-gray-900">{operatorName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Autorizado por</span>
                  <span className="font-semibold text-gray-900">{result.authorizer.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">MFA</span>
                  <span className="font-semibold text-gray-900">
                    {credentials.mfaCode ? 'autorizado' : 'não exigido'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Caixa</span>
                  <span className="font-semibold text-gray-900">{registerLabel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Data/Hora</span>
                  <span className="font-semibold text-gray-900">
                    {new Date(result.movement.createdAt || Date.now()).toLocaleString('pt-BR')}
                  </span>
                </div>
              </div>

              {!result.drawerSupported && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
                  Este PDV não possui gaveta de dinheiro integrada — retire o valor manualmente do caixa físico.
                </div>
              )}

              <button
                onClick={handleFinish}
                autoFocus
                className="w-full px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors"
              >
                Fechar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default WithdrawalModal;
