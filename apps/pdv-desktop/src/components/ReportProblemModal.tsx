import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, CheckCircle2, LifeBuoy } from 'lucide-react';
import { api, apiErrorMessage } from '../services/api';
import { useCashRegisterStore } from '../store/cashRegister.store';
import { useCheckoutStore } from '../store/checkout.store';
import { buildTicketContext, buildTicketPayload, REPORT_TYPES, shouldRenewIdempotencyKey, SUBJECT_MAX, validateReport } from '../services/support-report';

interface ReportProblemModalProps {
  isOpen: boolean;
  onClose: () => void;
  screen: string;
  saleId?: string | null;
  paymentId?: string | null;
}

// Empresa, filial e usuário vêm do token no servidor; aqui só vai o que a tela sabe (tela, caixa, venda/pagamento).
function ReportProblemModal({ isOpen, onClose, screen, saleId, paymentId }: ReportProblemModalProps) {
  const registerNumber = useCashRegisterStore((s) => s.currentCashRegister?.registerNumber);
  const [type, setType] = useState<string>('PROBLEMA');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [ticketNumber, setTicketNumber] = useState<number | null>(null);
  // Uma chave por abertura: reenviar depois de falta de resposta devolve o mesmo chamado, nunca um segundo.
  const idempotencyKey = useRef('');

  useEffect(() => {
    if (!isOpen) return;
    idempotencyKey.current = crypto.randomUUID();
    setType('PROBLEMA');
    setSubject('');
    setDescription('');
    setError('');
    setSending(false);
    setTicketNumber(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const submit = async () => {
    const invalid = validateReport({ subject, description });
    if (invalid) {
      setError(invalid);
      return;
    }
    setError('');
    setSending(true);
    try {
      const fromStore = useCheckoutStore.getState();
      const ctx = buildTicketContext({
        screen,
        saleId: saleId ?? fromStore.sale?.id ?? null,
        paymentId: paymentId ?? fromStore.pendingPayment?.id ?? null,
        registerNumber,
      });
      const ticket = await api.createSupportTicket(
        buildTicketPayload({ subject, description, type, context: ctx }),
        idempotencyKey.current,
      );
      setTicketNumber(ticket.ticketNumber);
    } catch (e: any) {
      if (shouldRenewIdempotencyKey(e?.response?.status)) idempotencyKey.current = crypto.randomUUID();
      setError(apiErrorMessage(e?.response?.data, 'Não foi possível enviar agora. Seu texto foi mantido — tente de novo.'));
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto" role="dialog" aria-label="Relatar problema">
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <LifeBuoy size={20} />
            <h2 className="text-xl font-bold text-gray-900">Relatar problema</h2>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
            <X size={20} />
          </button>
        </div>

        {ticketNumber !== null ? (
          <div className="p-6 space-y-4 text-center" data-testid="report-success">
            <CheckCircle2 size={40} className="mx-auto text-green-600" />
            <p className="text-lg font-semibold text-gray-900">Chamado #{ticketNumber} aberto</p>
            <p className="text-sm text-gray-600">O suporte responde pelo Admin Web (Ajuda e Suporte). A venda em andamento não foi alterada.</p>
            <button onClick={onClose} className="px-5 py-2 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-800">
              Fechar
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <p className="text-xs text-gray-500">
              Tela: {screen}
              {registerNumber ? ` · Caixa #${registerNumber}` : ''}. Não informe número de cartão, senha ou token.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="report-type">Tipo</label>
              <select id="report-type" value={type} onChange={(e) => setType(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                {REPORT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="report-subject">Assunto</label>
              <input
                id="report-subject"
                value={subject}
                maxLength={SUBJECT_MAX}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="report-description">O que aconteceu</label>
              <textarea
                id="report-description"
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button onClick={onClose} disabled={sending} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100">
                Cancelar
              </button>
              <button
                onClick={submit}
                disabled={sending}
                className="px-5 py-2 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-800 disabled:opacity-60 flex items-center gap-2"
              >
                {sending && <Loader2 size={16} className="animate-spin" />}
                Enviar chamado
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default ReportProblemModal;
