import { useState, useEffect, useRef } from 'react';
import { DollarSign, TrendingUp, TrendingDown, Lock, Unlock, Banknote, PlusCircle } from 'lucide-react';
import { useAuthStore } from '../store/auth.store';
import { useCashRegisterStore } from '../store/cashRegister.store';
import { api } from '../services/api';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import WithdrawalModal from '../components/WithdrawalModal';
import CashCloseModal from '../components/CashCloseModal';
import { salesOfTheDay } from '../services/cash-summary';
import { formatBRL } from '../services/money';

// O número do caixa identifica o TERMINAL (a API aceita um caixa aberto por número por filial): fica no
// dispositivo, não no operador — quem troca de turno no mesmo PDV reabre o mesmo número.
const TERMINAL_KEY = 'pdv-register-number';

function readTerminalRegisterNumber(): string {
  try {
    const saved = Number(localStorage.getItem(TERMINAL_KEY));
    return Number.isInteger(saved) && saved >= 1 && saved <= 999 ? String(saved) : '1';
  } catch {
    return '1';
  }
}

function saveTerminalRegisterNumber(n: number) {
  try {
    localStorage.setItem(TERMINAL_KEY, String(n));
  } catch {
    /* armazenamento indisponível: o operador digita de novo na próxima abertura */
  }
}

function CashRegisterPage() {
  // O caixa aberto fica no store compartilhado (não em state local) para que
  // POSPage/PaymentModal consigam ler o cashRegisterId real ao finalizar uma
  // venda, em vez do placeholder fixo que existia antes.
  const { currentCashRegister, setCurrentCashRegister } = useCashRegisterStore();
  const [isLoading, setIsLoading] = useState(true);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showWithdrawalModal, setShowWithdrawalModal] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [openingAmount, setOpeningAmount] = useState('0.00');
  const [registerNumber, setRegisterNumber] = useState(() => readTerminalRegisterNumber());
  const [depositAmount, setDepositAmount] = useState('0.00');
  const [depositNotes, setDepositNotes] = useState('');
  const [isSubmittingDeposit, setIsSubmittingDeposit] = useState(false);
  // Trava síncrona (o state só muda no próximo render): Enter repetido não dispara dois envios. A chave de
  // idempotência é a mesma para o MESMO reforço digitado — um reenvio não lança outro reforço no servidor.
  const depositLock = useRef(false);
  const depositKey = useRef<string | null>(null);
  const { user } = useAuthStore();

  useEffect(() => {
    loadCurrentCashRegister();
  }, []);

  // `background`: recarrega sem trocar a página pelo spinner. A retirada chama isto no sucesso com o modal ainda
  // aberto; com o spinner o modal era desmontado e reabria vazio, sumindo com o comprovante — e o operador,
  // achando que falhou, repetia a retirada.
  const loadCurrentCashRegister = async (background = false) => {
    if (!background) setIsLoading(true);
    try {
      const result = await api.getCurrentCashRegister(user?.branchId);
      setCurrentCashRegister(result);
    } catch (error: any) {
      if (error.response?.status !== 404) {
        console.error('Load cash register error:', error);
      }
      // 404 = nenhum caixa aberto (ou o caixa que estava no store acabou de
      // ser fechado) — sem isto o store ficava com o caixa antigo "preso" e
      // a UI continuava mostrando "Caixa Aberto" mesmo depois do fechamento.
      setCurrentCashRegister(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenCashRegister = async () => {
    const amount = parseFloat(openingAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Valor inicial inválido');
      return;
    }
    const terminal = Number(registerNumber);
    if (!Number.isInteger(terminal) || terminal < 1 || terminal > 999) {
      toast.error('Número do caixa deve ser um inteiro de 1 a 999');
      return;
    }

    try {
      await api.openCashRegister({
        branchId: user?.branchId,
        registerNumber: terminal,
        openingAmount: amount,
      });
      saveTerminalRegisterNumber(terminal);
      toast.success(`Caixa nº ${terminal} aberto com sucesso!`);
      setShowOpenModal(false);
      loadCurrentCashRegister();
    } catch (error: any) {
      console.error('Open cash register error:', error);
    }
  };

  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: a página já convidava o operador a
  // "registrar sangrias e reforços durante o dia", mas só a retirada
  // (sangria) tinha botão/modal — reforço não tinha NENHUMA UI, e a própria
  // função do client (api.addCashMovement) chamava uma URL que não existia
  // no backend (404), então mesmo implementando o botão sem corrigir isso
  // primeiro o reforço continuaria quebrado. Diferente da retirada, reforço
  // não exige dupla autorização (o backend só recusa WITHDRAWAL nesta rota,
  // não DEPOSIT) — por isso é um modal simples de um passo, no mesmo padrão
  // dos modais de Abrir/Fechar Caixa já existentes nesta página, em vez do
  // fluxo multi-etapa do WithdrawalModal.
  const handleAddDeposit = async () => {
    if (!currentCashRegister || depositLock.current) return;

    const amount = parseFloat(depositAmount);
    if (!(amount > 0)) {
      toast.error('Informe um valor maior que zero');
      return;
    }

    depositLock.current = true;
    setIsSubmittingDeposit(true);
    depositKey.current = depositKey.current ?? `PDV-DEPOSIT-${currentCashRegister.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await api.addCashMovement(currentCashRegister.id, {
        amount,
        notes: depositNotes.trim() || undefined,
        idempotencyKey: depositKey.current,
      });
      depositKey.current = null;
      toast.success('Reforço registrado com sucesso!');
      setShowDepositModal(false);
      setDepositAmount('0.00');
      setDepositNotes('');
      loadCurrentCashRegister();
    } catch (error: any) {
      // O interceptor da API já mostrou o erro (antes a tela mostrava um segundo toast igual). Erro de regra (4xx)
      // encerra esta chave; sem resposta, mantém (reenvio seguro).
      if (error?.response) depositKey.current = null;
      console.error('Add cash deposit error:', error);
    } finally {
      depositLock.current = false;
      setIsSubmittingDeposit(false);
    }
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Carregando...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Gerenciamento de Caixa</h1>
          <p className="text-gray-600 mt-1">Operador: {user?.name}</p>
        </div>

        {!currentCashRegister ? (
          /* No Cash Register Open */
          <div className="bg-white rounded-lg shadow-sm p-12 text-center">
            <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <Lock size={48} className="text-gray-600" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Caixa Fechado</h2>
            <p className="text-gray-600 mb-8">
              Você precisa abrir o caixa para iniciar as vendas
            </p>
            <button
              onClick={() => setShowOpenModal(true)}
              className="px-8 py-4 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-bold text-lg transition-colors inline-flex items-center gap-2"
            >
              <Unlock size={24} />
              Abrir Caixa
            </button>
          </div>
        ) : (
          /* Cash Register Open */
          <div className="space-y-6">
            {/* Status Card */}
            <div className="bg-primary-600 rounded-lg shadow-sm p-6 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <Unlock size={32} />
                    <h2 className="text-2xl font-bold">Caixa Aberto</h2>
                  </div>
                  <p className="opacity-90">
                    Aberto em: {format(new Date(currentCashRegister.openedAt), "dd/MM/yyyy 'às' HH:mm")}
                  </p>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowDepositModal(true)}
                    className="px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/30 text-white rounded-lg font-bold transition-colors flex items-center gap-2"
                  >
                    <PlusCircle size={20} />
                    Reforço de Caixa
                  </button>
                  <button
                    onClick={() => setShowWithdrawalModal(true)}
                    className="px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/30 text-white rounded-lg font-bold transition-colors flex items-center gap-2"
                  >
                    <Banknote size={20} />
                    Retirada de Caixa
                  </button>
                  <button
                    onClick={() => setShowCloseModal(true)}
                    className="px-6 py-3 bg-white text-primary-600 rounded-lg font-bold hover:bg-gray-100 transition-colors"
                  >
                    Fechar Caixa
                  </button>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                    <DollarSign size={24} className="text-gray-700" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Valor Inicial</p>
                    <p className="text-2xl font-bold text-gray-900">
                      {formatBRL(Number(currentCashRegister.openingAmount))}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                    <TrendingUp size={24} className="text-gray-700" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Vendas do Dia</p>
                    <p className="text-2xl font-bold text-gray-900">
                      {/* Só vendas recebidas neste caixa (menos estornos de cancelamento/devolução). Antes era
                          expectedAmount − abertura, que somava reforços e subtraía sangrias como se fossem venda. */}
                      {formatBRL(salesOfTheDay(currentCashRegister.movements))}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                    <TrendingDown size={24} className="text-gray-700" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Saldo Esperado</p>
                    <p className="text-2xl font-bold text-gray-900">
                      {/* Antes somava openingAmount + expectedAmount, contando o
                          valor inicial em dobro (expectedAmount já o inclui). */}
                      {formatBRL(Number(currentCashRegister.expectedAmount || 0))}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Info */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <p className="text-gray-800">
                <strong>Dica:</strong> Registre sangrias e reforços durante o dia para manter o controle preciso do caixa.
              </p>
            </div>
          </div>
        )}

        {/* Open Modal */}
        {showOpenModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-2xl shadow-lg w-full max-w-md p-6">
              <h3 className="text-2xl font-bold text-gray-900 mb-6">Abrir Caixa</h3>

              <div className="mb-4">
                <label htmlFor="register-number" className="block text-sm font-medium text-gray-700 mb-2">
                  Número do caixa (este terminal)
                </label>
                <input
                  id="register-number"
                  type="number"
                  inputMode="numeric"
                  value={registerNumber}
                  onChange={(e) => setRegisterNumber(e.target.value)}
                  min="1"
                  max="999"
                  step="1"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
                />
                <p className="text-sm text-gray-500 mt-2">
                  Cada PDV da filial usa um número próprio. Fica salvo neste computador.
                </p>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Valor Inicial
                </label>
                <input
                  type="number"
                  value={openingAmount}
                  onChange={(e) => setOpeningAmount(e.target.value)}
                  min="0"
                  step="0.01"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
                  autoFocus
                />
                <p className="text-sm text-gray-500 mt-2">
                  Digite o valor em dinheiro disponível no caixa para início das operações.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowOpenModal(false)}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleOpenCashRegister}
                  className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors"
                >
                  Abrir Caixa
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Fechamento (normal ou forçado, com as pendências do caixa) — docs/CORTEX/policies/CAIXA.md */}
        {showCloseModal && currentCashRegister && (
          <CashCloseModal
            register={currentCashRegister}
            userType={user?.userType}
            onClose={() => setShowCloseModal(false)}
            onClosed={() => {
              setShowCloseModal(false);
              loadCurrentCashRegister();
            }}
          />
        )}

        {/* Deposit Modal (Reforço de Caixa) */}
        {showDepositModal && currentCashRegister && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-2xl shadow-lg w-full max-w-md p-6">
              <h3 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                <PlusCircle size={24} className="text-primary-600" />
                Reforço de Caixa
              </h3>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Valor do Reforço</label>
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddDeposit()}
                  min="0"
                  step="0.01"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
                  autoFocus
                />
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Observação (opcional)</label>
                <textarea
                  value={depositNotes}
                  onChange={(e) => setDepositNotes(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Troco adicional para o dia"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDepositModal(false)}
                  disabled={isSubmittingDeposit}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleAddDeposit}
                  disabled={isSubmittingDeposit}
                  className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
                >
                  {isSubmittingDeposit ? 'Registrando...' : 'Registrar Reforço'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Withdrawal Modal (Retirada de Caixa) */}
        {currentCashRegister && (
          <WithdrawalModal
            isOpen={showWithdrawalModal}
            onClose={() => setShowWithdrawalModal(false)}
            cashRegisterId={currentCashRegister.id}
            registerLabel={`#${currentCashRegister.registerNumber}`}
            operatorName={user?.name || '—'}
            onSuccess={() => loadCurrentCashRegister(true)}
          />
        )}
      </div>
    </div>
  );
}

export default CashRegisterPage;
