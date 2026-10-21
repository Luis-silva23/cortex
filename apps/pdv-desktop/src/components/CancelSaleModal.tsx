import { useState } from 'react';
import { X, XCircle, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { formatBRL } from '../services/money';
import AuthorizerCredentialsForm, {
  AuthorizerCredentials,
  emptyAuthorizerCredentials,
} from './AuthorizerCredentialsForm';
import { saleStatusLabel } from '../services/sale-status';

interface CancelSaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale: any;
  onSuccess: (cancelledSale: any) => void;
}

type Step = 'reason' | 'auth' | 'success';

function CancelSaleModal({ isOpen, onClose, sale, onSuccess }: CancelSaleModalProps) {
  const [step, setStep] = useState<Step>('reason');
  const [reason, setReason] = useState('');
  const [credentials, setCredentials] = useState<AuthorizerCredentials>(emptyAuthorizerCredentials);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  if (!isOpen || !sale) return null;

  const resetAndClose = () => {
    setStep('reason');
    setReason('');
    setCredentials(emptyAuthorizerCredentials);
    setError('');
    setResult(null);
    onClose();
  };

  const handleContinueToAuth = () => {
    setError('');
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
      const response = await api.cancelSale(sale.id, {
        reason: reason.trim(),
        authorizerNumericId: parseInt(credentials.numericId, 10),
        authorizerPassword: credentials.password,
        authorizerMfaCode: credentials.mfaCode || undefined,
      });

      setResult(response.data);
      setStep('success');
      onSuccess(response.data);
    } catch (err: any) {
      // Mensagem exata devolvida pelo backend (verifyDualAuthorization /
      // cancelSale) — nunca parafraseada: auto-autorização bloqueada, perfil
      // sem permissão, senha/MFA inválidos, venda já cancelada/devolvida,
      // motivo curto demais, etc.
      const backendMessage = err.response?.data?.error;
      setError(backendMessage || 'Erro ao cancelar venda');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Um pagamento chegou a ser aprovado (dinheiro/cartão/PIX confirmado) se
  // havia algum payment com status APPROVED antes do cancelamento — é esse
  // total que o backend tenta estornar no caixa (cashAdjusted).
  const hadApprovedPayment = (sale.payments || []).some((p: any) => p.status === 'APPROVED');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <XCircle size={24} className="text-red-600" />
            Cancelar Venda #{sale.saleNumber}
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
          {step === 'reason' && (
            <>
              <div className="bg-gray-50 rounded-lg p-4 flex justify-between text-sm">
                <span className="text-gray-600">Total da venda:</span>
                <span className="font-bold text-gray-900">{formatBRL(Number(sale.totalAmount))}</span>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Motivo do Cancelamento</label>
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
                  placeholder="Ex.: Erro na venda, cliente desistiu..."
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none"
                  autoFocus
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
                  Voltar
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
                    setStep('reason');
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
                    'Autorizar Cancelamento'
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
                <h3 className="text-xl font-bold text-gray-900">VENDA CANCELADA</h3>
                <p className="text-gray-600 mt-1">
                  Venda #{result.saleNumber} — status: <span className="font-semibold">{saleStatusLabel(result.status)}</span>
                </p>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Autorizado por</span>
                  <span className="font-semibold text-gray-900">{result.authorizer.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Motivo</span>
                  <span className="font-semibold text-gray-900 text-right">{result.cancelReason}</span>
                </div>
              </div>

              {result.cashAdjusted ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
                  O caixa foi ajustado: o valor pago nesta venda foi estornado do saldo esperado.
                </div>
              ) : hadApprovedPayment ? (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
                  O caixa em que esta venda foi paga já está fechado, então o estorno não pôde ser
                  lançado automaticamente — é necessário um ajuste manual no caixa aberto atual.
                </div>
              ) : null}

              <button
                onClick={resetAndClose}
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

export default CancelSaleModal;
