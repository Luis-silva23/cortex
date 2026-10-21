import { useEffect, useRef, useState } from 'react';
import { X, CreditCard, Banknote, Smartphone, Loader2, AlertTriangle, Users, Building2, CheckCircle2, XCircle, Clock, WifiOff, LifeBuoy } from 'lucide-react';
import ReportProblemModal from './ReportProblemModal';
import { useAuthStore } from '../store/auth.store';
import { useCheckoutStore } from '../store/checkout.store';
import { api } from '../services/api';
import { printerService } from '../services/printer.service';
import toast from 'react-hot-toast';
import { formatBRL } from '../services/money';
import { installmentPreview } from '../services/installment-preview';
import {
  PaymentPhase,
  attemptFor,
  classifyApiError,
  closeAttempt,
  isUncertain,
  phaseFromPaymentStatus,
  stableSignature,
} from '../services/payment-flow';
import AuthorizerCredentialsForm, {
  AuthorizerCredentials,
  emptyAuthorizerCredentials,
} from './AuthorizerCredentialsForm';
import AgreementPaymentPanel, { AgreementSelection } from './AgreementPaymentPanel';

type PaymentMethod = 'CASH' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'PIX' | 'EMPLOYEE_AGREEMENT' | 'COMPANY_AGREEMENT';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Débito',
  CREDIT_CARD: 'Crédito',
  PIX: 'PIX',
  EMPLOYEE_AGREEMENT: 'Convênio funcionário',
  COMPANY_AGREEMENT: 'Convênio empresa',
};

/** Resultado entregue ao POS para o aviso "última venda" (troco, cupom, pendência). */
export interface SaleCompletion {
  saleNumber?: number;
  total: number;
  methodLabel: string;
  change: number;
  printNote: string;
  pending?: boolean;
}

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  total: number;
  // Desconto manual global e convênio aplicados no carrinho (cart.store.ts)
  // — precisam chegar à venda de verdade, não só refletir no `total`
  // exibido em tela (ver bug documentado: TASK-008).
  subtotal: number;
  discountAmount: number;
  discountPercent: number;
  partnerId?: string;
  items: any[];
  customer: any;
  cashRegisterId?: string;
  onSuccess: (result?: SaleCompletion) => void;
}

// Cédulas e moedas do Real (mesma lista validada no servidor).
const DENOMINATIONS = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05];
type Step = 'payment' | 'auth';
// Perfis que podem pedir ao servidor para consultar o provedor de novo (POST /payments/:id/reconcile).
const RECONCILE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'];

// Motivo do "não confirmado": pagamento pendente no servidor (PIX/terminal) ou nenhuma resposta do servidor.
type UnconfirmedReason = 'PENDING' | 'NO_RESPONSE';
interface StatusInfo {
  message: string;
  reason?: UnconfirmedReason;
  checkedAt?: string;
}

function PaymentModal({
  isOpen,
  onClose,
  total,
  subtotal,
  discountAmount,
  discountPercent,
  partnerId,
  items,
  customer,
  cashRegisterId,
  onSuccess,
}: PaymentModalProps) {
  const [step, setStep] = useState<Step>('payment');
  const [phase, setPhase] = useState<PaymentPhase>('FORM');
  const [statusInfo, setStatusInfo] = useState<StatusInfo | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [paidAmount, setPaidAmount] = useState(total.toFixed(2));
  const [installments, setInstallments] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  // Trava SÍNCRONA contra duplo clique / Enter repetido: o `isProcessing` do React só vale no próximo render,
  // então dois eventos no mesmo quadro passavam os dois e disparavam duas cobranças.
  const busyRef = useRef(false);
  // Preenchido só quando o backend recusa a venda por o desconto/convênio
  // exigir aprovação de um Gerente/Admin (sale.service.ts) — mesmo padrão
  // de dupla autorização já usado em CancelSaleModal/WithdrawalModal.
  const [authError, setAuthError] = useState('');
  const [credentials, setCredentials] = useState<AuthorizerCredentials>(emptyAuthorizerCredentials);
  const { user } = useAuthStore();
  // Controle de cédulas (configuração da empresa/filial): quando ligado, o valor recebido vem da contagem das notas.
  const [cashControl, setCashControl] = useState(false);
  // Cartão sem TEF integrado (provedor MANUAL): o operador passa na maquininha e confirma aqui o que ela respondeu.
  const [manualCard, setManualCard] = useState(true);
  const [cardAuthCode, setCardAuthCode] = useState('');
  const [notes, setNotes] = useState<Record<number, number>>({});
  const [policies, setPolicies] = useState<Record<string, any>>({});
  const [policiesFailed, setPoliciesFailed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [agreement, setAgreement] = useState<AgreementSelection | null>(null);
  // Última tentativa enviada: "Verificar de novo" após falta de resposta reenvia EXATAMENTE a mesma (mesma chave).
  const lastPaymentData = useRef<any>(null);
  const saleRef = useRef<any>(null);

  const checkout = useCheckoutStore();

  // Assinatura do carrinho: a venda criada só é reaproveitada para o MESMO carrinho.
  const cartSignature = stableSignature({
    items: items.map((i) => [i.productId, i.quantity, i.unitPrice, i.discountPercent]),
    customerId: customer?.id ?? null,
    discountPercent,
    discountAmount,
    partnerId: partnerId ?? null,
    cashRegisterId: cashRegisterId ?? null,
  });
  const staleSale = checkout.sale && checkout.cartSignature !== cartSignature ? checkout.sale : null;
  const reusableSale = checkout.sale && checkout.cartSignature === cartSignature ? checkout.sale : null;

  useEffect(() => {
    if (!isOpen) return;
    setNotes({});
    setStep('payment');
    setCardAuthCode('');
    setAgreement(null);
    // Reabrir com um pagamento pendente desta mesma venda volta direto ao estado "não confirmado".
    const cs = useCheckoutStore.getState();
    if (cs.pendingPayment && cs.sale && cs.cartSignature === cartSignature) {
      saleRef.current = cs.sale.raw;
      setPhase('UNCONFIRMED');
      setStatusInfo({ reason: 'PENDING', message: pendingMessage(cs.pendingPayment) });
    } else {
      setPhase('FORM');
      setStatusInfo(null);
    }
    api
      .getPaymentSettings()
      .then((s: any) => {
        setCashControl(!!s.cashDenominationControl);
        setManualCard(!s.cardProvider || s.cardProvider === 'MANUAL');
      })
      .catch(() => {
        setCashControl(false);
        setManualCard(true);
      });
    api
      .getEffectivePolicies()
      .then((p) => {
        setPolicies(p?.values ?? {});
        setPoliciesFailed(false);
      })
      .catch(() => {
        setPolicies({});
        setPoliciesFailed(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const notesTotal = DENOMINATIONS.reduce((sum, value) => sum + value * (notes[value] || 0), 0);
  useEffect(() => {
    if (cashControl) setPaidAmount(notesTotal.toFixed(2));
  }, [cashControl, notesTotal]);

  // ESC do modal: fecha só quando isso não esconde uma cobrança em andamento/incerta (o POS não fecha mais por fora).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!isOpen) return null;

  const saleTotal = Number(reusableSale?.totalAmount ?? saleRef.current?.totalAmount ?? total);
  const change = parseFloat(paidAmount) - saleTotal;
  const isCard = paymentMethod === 'DEBIT_CARD' || paymentMethod === 'CREDIT_CARD';
  const isAgreement = paymentMethod === 'EMPLOYEE_AGREEMENT' || paymentMethod === 'COMPANY_AGREEMENT';
  const employeeAgreementOn = policies['employeeAgreement.enabled'] === true;
  const companyAgreementOn = policies['companyAgreement.enabled'] === true;

  // Convênio desligado para esta filial: aparece cinza, com o motivo (existe, mas não pode ser usado aqui). O operador
  // não habilita nem autoriza — a API recusa do mesmo jeito (docs/CORTEX/policies/CONVENIOS.md).
  const agreementOff = policiesFailed
    ? 'Não foi possível verificar os convênios desta filial. Feche e abra o pagamento de novo.'
    : 'Convênio não habilitado para esta filial. Entre em contato com o administrador.';
  const paymentMethods: Array<{ value: PaymentMethod; label: string; icon: any; unavailable?: string }> = [
    { value: 'CASH', label: 'Dinheiro', icon: Banknote },
    { value: 'DEBIT_CARD', label: 'Débito', icon: CreditCard },
    { value: 'CREDIT_CARD', label: 'Crédito', icon: CreditCard },
    { value: 'PIX', label: 'PIX', icon: Smartphone },
    { value: 'EMPLOYEE_AGREEMENT', label: 'Convênio funcionário', icon: Users, ...(employeeAgreementOn ? {} : { unavailable: agreementOff }) },
    { value: 'COMPANY_AGREEMENT', label: 'Convênio empresa', icon: Building2, ...(companyAgreementOn ? {} : { unavailable: agreementOff }) },
  ];

  // Mensagem crua devolvida pelo backend quando o desconto manual e/ou o
  // convênio selecionado excede o limite do operador (checkSaleDiscount)
  // ou o convênio exige aprovação (Partner.requiresApproval) — ver
  // sale.service.ts::createSale. Nunca parafraseada: é ela que diz qual
  // regra/limite foi violado.
  const isApprovalRequiredError = (message: string) => /requer autoriza|exige autoriza/i.test(message || '');

  const buildSaleData = (auth?: { numericId: string; password: string; mfaCode: string }) => ({
    customerId: customer?.id || null,
    branchId: user?.branchId || null,
    items: items.map(item => ({
      productId: item.productId,
      productName: item.productName,
      productSku: item.productSku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      discountAmount: item.discountAmount,
      totalPrice: item.totalPrice,
    })),
    subtotal,
    discountAmount,
    discountPercent,
    partnerId: partnerId || undefined,
    totalAmount: total,
    cashRegisterId,
    ...(auth
      ? {
          discountAuthorizerNumericId: parseInt(auth.numericId, 10),
          discountAuthorizerPassword: auth.password,
          discountAuthorizerMfaCode: auth.mfaCode || undefined,
        }
      : {}),
  });

  // Uma venda por carrinho: reaproveita a já criada (mesmo depois de fechar e reabrir o modal) e, se a resposta da
  // criação se perder, o reenvio usa a mesma Idempotency-Key — o servidor devolve a venda existente em vez de outra.
  const ensureSale = async (saleData: ReturnType<typeof buildSaleData>) => {
    const cs = useCheckoutStore.getState();
    if (cs.sale && cs.cartSignature === cartSignature) return cs.sale.raw;
    if (cs.sale) {
      toast(
        `A venda Nº ${cs.sale.saleNumber ?? '?'} (itens anteriores) ficou registrada SEM pagamento. Ela aparece como Pendente no Histórico — o cancelamento exige a gerência.`,
        { icon: '⚠️', duration: 8000 }
      );
      cs.reset();
    }
    const attempt = attemptFor(useCheckoutStore.getState().saleAttempt, stableSignature(saleData), 'SALE');
    useCheckoutStore.getState().setSaleAttempt(attempt);
    try {
      const sale = await api.createSale(saleData, { idempotencyKey: attempt.key });
      useCheckoutStore.getState().setSale(cartSignature, {
        id: sale.id,
        saleNumber: sale.saleNumber,
        totalAmount: Number(sale.totalAmount ?? total),
        raw: sale,
      });
      return sale;
    } catch (error) {
      // Erro de regra (4xx) é definitivo para ESTE corpo: a próxima tentativa (ex.: depois de abrir o caixa) usa
      // chave nova — reusar devolveria o mesmo erro gravado. Sem resposta/5xx: mantém a chave (reenvio seguro).
      if (!isUncertain(classifyApiError(error).kind)) {
        useCheckoutStore.getState().setSaleAttempt(closeAttempt(attempt));
      }
      throw error;
    }
  };

  function pendingMessage(payment: any): string {
    const label = PAYMENT_METHOD_LABELS[payment?.paymentMethod as PaymentMethod] ?? payment?.paymentMethod ?? '';
    return `${formatBRL(Number(payment?.amount ?? saleTotal))} em ${label} registrado, mas SEM confirmação de recebimento. A venda só é concluída quando o pagamento for confirmado. Verificar de novo consulta o MESMO pagamento (não cobra outra vez).`;
  }

  const buildPaymentData = (sale: any) => {
    const paid = parseFloat(paidAmount);
    return {
      saleId: sale.id,
      paymentMethod,
      // o total que vale é o calculado pelo servidor (desconto/convênio recalculados lá)
      amount: Number(sale.totalAmount ?? total),
      // Dinheiro: o backend registra o recebido e calcula o troco (o caixa só ganha o valor da venda).
      ...(paymentMethod === 'CASH' ? { receivedAmount: paid } : {}),
      ...(paymentMethod === 'CASH' && cashControl
        ? { cashBreakdown: DENOMINATIONS.filter((v) => (notes[v] || 0) > 0).map((value) => ({ value, quantity: notes[value] })) }
        : {}),
      installments:
        paymentMethod === 'CREDIT_CARD' ? installments : paymentMethod === 'EMPLOYEE_AGREEMENT' ? agreement?.installments ?? 1 : 1,
      ...(isCard && cardAuthCode.trim() ? { authorizationCode: cardAuthCode.trim() } : {}),
      ...(paymentMethod === 'EMPLOYEE_AGREEMENT' && agreement ? { employeeAgreementId: agreement.id } : {}),
      ...(paymentMethod === 'COMPANY_AGREEMENT' && agreement ? { agreementCompanyId: agreement.id } : {}),
    };
  };

  // Aprovado → imprime (sem nunca desfazer a venda) → entrega o resumo ao POS.
  const complete = async (sale: any, payment: any, data: any) => {
    setPhase('APPROVED');
    const finalTotal = Number(sale.totalAmount ?? total);
    const changeAmount =
      data?.paymentMethod === 'CASH' ? Number(payment?.changeAmount ?? Math.max(0, Number(data.receivedAmount ?? finalTotal) - finalTotal)) : 0;
    const methodLabel = PAYMENT_METHOD_LABELS[data?.paymentMethod as PaymentMethod] ?? data?.paymentMethod ?? '';
    const { note } = await printerService.printSaleReceipt({
      saleId: sale.id,
      numericId: sale.saleNumber ?? 0,
      date: new Date(sale.saleDate || Date.now()).toLocaleString('pt-BR'),
      items: items.map((item) => ({
        name: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.totalPrice,
      })),
      subtotal: Number(sale.subtotal ?? subtotal),
      discount: Number(sale.discountAmount ?? discountAmount),
      total: finalTotal,
      changeAmount: changeAmount > 0 ? changeAmount : undefined,
      payments: [{ method: methodLabel, amount: Number(data?.receivedAmount ?? payment?.amount ?? finalTotal) }],
      customer: customer ? { name: customer.name, cpfCnpj: customer.document } : undefined,
      seller: { name: user?.name || '—' },
      company: user?.company
        ? {
            name: user.company.name,
            cnpj: user.company.document,
            address: user.branch?.address || '',
            phone: user.company.phone || user.branch?.phone || '',
          }
        : undefined,
    });
    useCheckoutStore.getState().reset();
    toast.success(`Venda Nº ${sale.saleNumber ?? ''} concluída — pagamento aprovado`);
    onSuccess({ saleNumber: sale.saleNumber, total: finalTotal, methodLabel, change: changeAmount, printNote: note });
  };

  // Situação devolvida pelo servidor → estado da tela. Só APPROVED conclui.
  const handlePaymentResult = async (payment: any, sale: any, data: any) => {
    const cs = useCheckoutStore.getState();
    const next = phaseFromPaymentStatus(payment?.status);
    if (next === 'APPROVED') {
      cs.setPendingPayment(null);
      cs.setPaymentAttempt(closeAttempt(cs.paymentAttempt));
      await complete(sale, payment, data ?? payment);
      return;
    }
    if (next === 'UNCONFIRMED') {
      cs.setPendingPayment(payment);
      setStatusInfo({ reason: 'PENDING', message: pendingMessage(payment), checkedAt: new Date().toLocaleTimeString('pt-BR') });
      setPhase('UNCONFIRMED');
      return;
    }
    cs.setPendingPayment(null);
    cs.setPaymentAttempt(closeAttempt(cs.paymentAttempt));
    setStatusInfo({
      message:
        next === 'DECLINED'
          ? 'O pagamento foi recusado. Nada foi cobrado por esta tentativa.'
          : 'O pagamento foi cancelado. A venda continua aberta, sem pagamento.',
    });
    setPhase(next);
  };

  // A resposta de uma tentativa anterior se perdeu e o servidor diz que a venda já está paga/reservada: consulta a
  // venda e mostra o que realmente aconteceu (nunca cobra de novo, nunca inventa "concluída").
  const recoverFromSale = async (sale: any, fallbackMessage: string) => {
    try {
      const fresh = await api.getSaleById(sale.id);
      const payments: any[] = fresh?.payments ?? [];
      if (fresh?.status === 'PAID') {
        const approved = payments.filter((p) => p.status === 'APPROVED').pop();
        await complete(fresh, approved, approved);
        return;
      }
      const pending = payments.find((p) => p.status === 'PENDING');
      if (pending) {
        await handlePaymentResult(pending, fresh, pending);
        return;
      }
    } catch {
      /* sem como confirmar: cai no aviso abaixo */
    }
    setStatusInfo({ message: fallbackMessage });
    setPhase('DECLINED');
  };

  const sendPayment = async (sale: any, data: any) => {
    const cs = useCheckoutStore.getState();
    const attempt = attemptFor(cs.paymentAttempt, stableSignature(data), 'PAY');
    cs.setPaymentAttempt(attempt);
    lastPaymentData.current = data;
    saleRef.current = sale;
    setPhase('PROCESSING');
    try {
      const payment = await api.processPayment({ ...data, transactionId: attempt.key }, attempt.key);
      await handlePaymentResult(payment, sale, data);
    } catch (error) {
      const c = classifyApiError(error);
      if (isUncertain(c.kind)) {
        // Sem resposta / 5xx / em processamento: a tentativa continua ABERTA — "Verificar de novo" reenvia a mesma.
        setStatusInfo({ reason: 'NO_RESPONSE', message: c.message, checkedAt: new Date().toLocaleTimeString('pt-BR') });
        setPhase('UNCONFIRMED');
        return;
      }
      useCheckoutStore.getState().setPaymentAttempt(closeAttempt(attempt));
      if (c.kind === 'ALREADY_PAID' || c.kind === 'COMMITTED_BY_PENDING') {
        await recoverFromSale(sale, c.message);
        return;
      }
      setStatusInfo({ message: c.message });
      setPhase('DECLINED');
    }
  };

  // Com trava síncrona: só uma operação por vez, qualquer que seja o botão/tecla.
  const runExclusive = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsProcessing(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setIsProcessing(false);
    }
  };

  const validateForm = (): boolean => {
    const paid = parseFloat(paidAmount);
    if (paymentMethod === 'CASH' && !(paid >= saleTotal)) {
      toast.error('Valor recebido menor que o total');
      return false;
    }
    if (isAgreement && !agreement) {
      toast.error(paymentMethod === 'EMPLOYEE_AGREEMENT' ? 'Selecione o funcionário conveniado' : 'Selecione a empresa conveniada');
      return false;
    }
    if (isAgreement && agreement && agreement.available !== null && agreement.available < saleTotal) {
      toast.error('Limite disponível do convênio menor que o total da venda');
      return false;
    }
    // Operação crítica de pagamento nunca pode prosseguir sem um caixa
    // aberto de verdade — sem isto a venda era criada com um
    // cashRegisterId placeholder ('TEMP_CASH_ID'), que o backend sempre
    // rejeitava (nem é um UUID válido, e mesmo que fosse, não existiria
    // um CashRegister aberto com esse id).
    if (!cashRegisterId) {
      toast.error('Nenhum caixa aberto. Abra o caixa antes de receber pagamentos.');
      return false;
    }
    return true;
  };

  // Venda criada → cartão manual pede a resposta da maquininha; o resto vai direto ao servidor.
  const proceedWithSale = async (sale: any) => {
    saleRef.current = sale;
    if (isCard && manualCard) {
      setPhase('CARD_CONFIRM');
      return;
    }
    await sendPayment(sale, buildPaymentData(sale));
  };

  const handleConfirmPayment = () =>
    runExclusive(async () => {
      if (!validateForm()) return;
      try {
        const saleData = buildSaleData();
        const sale = await ensureSale(saleData);
        await proceedWithSale(sale);
      } catch (error: any) {
        const backendMessage = error.response?.data?.error;
        if (
          (backendMessage && isApprovalRequiredError(backendMessage)) ||
          error.response?.data?.code === 'DISCOUNT_AUTHORIZATION_REQUIRED'
        ) {
          // Desconto/convênio excede o limite do operador — precisa de um
          // segundo usuário (Gerente/Admin) autorizando com as próprias
          // credenciais, mesmo padrão de CancelSaleModal/WithdrawalModal.
          // A venda NÃO foi criada — o axios interceptor já mostrou o toast
          // de erro genérico; aqui só direcionamos para o passo de auth.
          setAuthError(backendMessage);
          setStep('auth');
        } else {
          console.error('Payment error:', error);
        }
        setPhase('FORM');
      }
    });

  const handleAuthorizedSubmit = () =>
    runExclusive(async () => {
      if (!credentials.numericId || !credentials.password) {
        setAuthError('Informe o ID e a senha do autorizador');
        return;
      }

      setAuthError('');
      try {
        const saleData = buildSaleData(credentials);
        const sale = await ensureSale(saleData);
        setStep('payment');
        await proceedWithSale(sale);
      } catch (error: any) {
        // Mesmo critério de CancelSaleModal: mostrar a mensagem exata do
        // backend (auto-autorização bloqueada, perfil sem permissão,
        // senha/MFA inválidos etc.), nunca parafraseada.
        const backendMessage = error.response?.data?.error;
        setAuthError(backendMessage || 'Erro ao autorizar desconto');
      }
    });

  // Cartão manual: o operador informa o que a maquininha respondeu.
  const handleCardApproved = () => runExclusive(async () => sendPayment(saleRef.current, buildPaymentData(saleRef.current)));
  const handleCardDeclined = () => {
    setStatusInfo({ message: 'A maquininha recusou o cartão. Nada foi registrado no sistema.' });
    setPhase('DECLINED');
  };

  // "Verificar de novo": sem resposta → reenvia a MESMA tentativa (mesma chave: não cobra de novo);
  // pendente → gerência pede ao servidor para consultar o provedor; operador consulta a situação gravada.
  const handleCheckAgain = () =>
    runExclusive(async () => {
      const sale = saleRef.current ?? useCheckoutStore.getState().sale?.raw;
      if (statusInfo?.reason === 'NO_RESPONSE' && lastPaymentData.current && sale) {
        await sendPayment(sale, lastPaymentData.current);
        return;
      }
      const pending = useCheckoutStore.getState().pendingPayment;
      if (!pending) return;
      try {
        const current =
          user && RECONCILE_ROLES.includes(user.userType)
            ? await api.reconcilePayment(pending.id)
            : await api.getPaymentStatus(pending.transactionId);
        if (phaseFromPaymentStatus(current?.status) === 'UNCONFIRMED') {
          setStatusInfo({ reason: 'PENDING', message: pendingMessage(current), checkedAt: new Date().toLocaleTimeString('pt-BR') });
          toast('Ainda sem confirmação do pagamento', { icon: '⏳' });
          return;
        }
        await handlePaymentResult(current, sale, current);
      } catch (error) {
        const c = classifyApiError(error);
        setStatusInfo((s) => ({ ...(s ?? { reason: 'PENDING' as const }), message: `Não foi possível verificar agora: ${c.message}`, checkedAt: new Date().toLocaleTimeString('pt-BR') }));
      }
    });

  const handleCancelPending = () =>
    runExclusive(async () => {
      const pending = useCheckoutStore.getState().pendingPayment;
      if (!pending) return;
      if (!confirm(`Cancelar o pagamento pendente de ${formatBRL(Number(pending.amount))}? A venda continua aberta para receber de outra forma.`)) return;
      try {
        const cancelled = await api.cancelPayment(pending.id);
        await handlePaymentResult(cancelled, saleRef.current, cancelled);
      } catch (error: any) {
        const c = classifyApiError(error);
        const msg =
          c.kind === 'FORBIDDEN'
            ? 'Seu perfil não pode cancelar pagamentos (exige permissão de estorno). Chame a gerência para cancelar, ou saia deixando a venda pendente.'
            : c.message;
        setStatusInfo((s) => ({ ...(s ?? { reason: 'PENDING' as const }), message: msg }));
      }
    });

  // Sair com a venda pendente: registrada no servidor, sem pagamento confirmado → NÃO concluída.
  const leavePending = () => {
    const cs = useCheckoutStore.getState();
    const sale = cs.sale;
    toast(`Venda Nº ${sale?.saleNumber ?? ''} NÃO concluída: pagamento pendente. Acompanhe no Histórico.`, { icon: '⏳', duration: 6000 });
    cs.reset();
    onSuccess({
      saleNumber: sale?.saleNumber,
      total: Number(sale?.totalAmount ?? total),
      methodLabel: PAYMENT_METHOD_LABELS[cs.pendingPayment?.paymentMethod as PaymentMethod] ?? '',
      change: 0,
      printNote: 'Cupom não impresso: pagamento não confirmado.',
      pending: true,
    });
  };

  const backToForm = () => {
    setStatusInfo(null);
    setPhase('FORM');
  };

  // Fechar (X, Cancelar, ESC). Nunca durante processamento, com resposta da maquininha em aberto ou com pagamento
  // sem confirmação — aí o operador decide pelos botões do painel.
  function requestClose() {
    if (busyRef.current || phase === 'PROCESSING') {
      toast('Aguarde: o pagamento está sendo processado.', { icon: '⏳' });
      return;
    }
    if (phase === 'CARD_CONFIRM') {
      toast('Informe o que a maquininha respondeu (aprovado ou recusado), ou use "Voltar".', { icon: '💳' });
      return;
    }
    if (phase === 'UNCONFIRMED') {
      toast('Pagamento sem confirmação: use "Verificar de novo", "Cancelar pagamento pendente" ou "Sair".', { icon: '⏳' });
      return;
    }
    const sale = useCheckoutStore.getState().sale;
    if (sale) {
      toast(`Venda Nº ${sale.saleNumber ?? ''} registrada e NÃO paga. Ao finalizar de novo este carrinho, a mesma venda é usada (sem duplicar).`, {
        icon: 'ℹ️',
        duration: 6000,
      });
    }
    onClose();
  }

  const locked = isProcessing || phase !== 'FORM';
  const currentSale = saleRef.current ?? reusableSale?.raw;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-slide-in" role="dialog" aria-label="Pagamento">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Pagamento</h2>
            {currentSale?.saleNumber && <p className="text-sm text-gray-600">Venda Nº {currentSale.saleNumber}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setReportOpen(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <LifeBuoy size={18} />
              Relatar problema
            </button>
            <button
              onClick={requestClose}
              aria-label="Fechar"
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
            >
              <X size={24} />
            </button>
          </div>
        </div>
        <ReportProblemModal
          isOpen={reportOpen}
          onClose={() => setReportOpen(false)}
          screen="Pagamento"
          saleId={currentSale?.id}
          paymentId={checkout.pendingPayment?.id}
        />

        <div className="p-6 space-y-6">
          {/* Total */}
          <div className="bg-primary-50 rounded-lg p-6 text-center">
            <p className="text-sm text-gray-600 mb-2">Total a Pagar</p>
            <p className="text-4xl font-bold text-primary-600">{formatBRL(saleTotal)}</p>
            {customer && (
              <p className="text-sm text-gray-600 mt-2">Cliente: {customer.name}{customer.document ? ` · ${customer.document}` : ''}</p>
            )}
          </div>

          {step === 'auth' && (
            <>
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800 flex items-start gap-2">
                <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
                <span>{authError || 'Este desconto/convênio precisa da autorização de um Gerente/Admin.'}</span>
              </div>

              <AuthorizerCredentialsForm value={credentials} onChange={setCredentials} disabled={isProcessing} autoFocus />

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setStep('payment');
                    setAuthError('');
                    setCredentials(emptyAuthorizerCredentials);
                  }}
                  disabled={isProcessing}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors disabled:opacity-50"
                >
                  Voltar
                </button>
                <button
                  onClick={handleAuthorizedSubmit}
                  disabled={isProcessing}
                  className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 size={20} className="animate-spin" />
                      Autorizando...
                    </>
                  ) : (
                    'Autorizar e Finalizar'
                  )}
                </button>
              </div>
            </>
          )}

          {/* ===== Estados do pagamento ===== */}
          {step === 'payment' && phase === 'PROCESSING' && (
            <div role="status" data-phase="PROCESSING" className="rounded-lg border border-blue-200 bg-blue-50 p-6 text-center text-blue-900">
              <Loader2 size={36} className="mx-auto animate-spin" />
              <p className="mt-3 text-lg font-bold">PROCESSANDO PAGAMENTO…</p>
              <p className="mt-1 text-sm">Não feche a tela e não repita a cobrança. Aguarde a resposta do servidor.</p>
            </div>
          )}

          {step === 'payment' && phase === 'APPROVED' && (
            <div role="status" data-phase="APPROVED" className="rounded-lg border border-green-200 bg-green-50 p-6 text-center text-green-900">
              <CheckCircle2 size={36} className="mx-auto" />
              <p className="mt-3 text-lg font-bold">PAGAMENTO APROVADO — concluindo a venda…</p>
            </div>
          )}

          {step === 'payment' && phase === 'CARD_CONFIRM' && (
            <div data-phase="CARD_CONFIRM" className="space-y-4">
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-indigo-900">
                <p className="text-lg font-bold">Passe o cartão na maquininha</p>
                <p className="mt-1">
                  Cobrar <strong>{formatBRL(saleTotal)}</strong> no <strong>{PAYMENT_METHOD_LABELS[paymentMethod]}</strong>
                  {paymentMethod === 'CREDIT_CARD' && installments > 1 ? ` em ${installments}x` : ''}. Depois informe aqui o que a maquininha
                  respondeu. Nada é registrado antes disso.
                </p>
              </div>
              <div>
                <label htmlFor="card-auth-code" className="block text-sm font-medium text-gray-700 mb-1">
                  Código de autorização / NSU do comprovante (opcional)
                </label>
                <input
                  id="card-auth-code"
                  type="text"
                  value={cardAuthCode}
                  onChange={(e) => setCardAuthCode(e.target.value.slice(0, 40))}
                  disabled={isProcessing}
                  className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 outline-none"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={backToForm}
                  disabled={isProcessing}
                  className="px-4 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold disabled:opacity-50"
                >
                  Voltar
                </button>
                <button
                  onClick={handleCardDeclined}
                  disabled={isProcessing}
                  className="px-4 py-3 border-2 border-red-500 text-red-700 rounded-lg hover:bg-red-50 font-semibold disabled:opacity-50"
                >
                  Maquininha RECUSOU
                </button>
                <button
                  onClick={handleCardApproved}
                  disabled={isProcessing}
                  className="px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold disabled:opacity-50"
                >
                  Maquininha APROVOU
                </button>
              </div>
            </div>
          )}

          {step === 'payment' && (phase === 'DECLINED' || phase === 'CANCELLED') && (
            <div role="alert" data-phase={phase} className="space-y-4">
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
                <p className="flex items-center gap-2 text-lg font-bold">
                  <XCircle size={22} />
                  {phase === 'DECLINED' ? 'PAGAMENTO RECUSADO' : 'PAGAMENTO CANCELADO'} — VENDA NÃO CONCLUÍDA
                </p>
                <p className="mt-1 text-sm">{statusInfo?.message}</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={backToForm}
                  className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold"
                  autoFocus
                >
                  Escolher forma de pagamento
                </button>
              </div>
            </div>
          )}

          {step === 'payment' && phase === 'UNCONFIRMED' && (
            <div role="alert" data-phase="UNCONFIRMED" className="space-y-4">
              <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-amber-900">
                <p className="flex items-center gap-2 text-lg font-bold">
                  {statusInfo?.reason === 'NO_RESPONSE' ? <WifiOff size={22} /> : <Clock size={22} />}
                  PAGAMENTO NÃO CONFIRMADO — VENDA NÃO CONCLUÍDA
                </p>
                <p className="mt-1 text-sm">{statusInfo?.message}</p>
                {statusInfo?.checkedAt && <p className="mt-1 text-xs opacity-80">Última verificação: {statusInfo.checkedAt}</p>}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleCheckAgain}
                  disabled={isProcessing}
                  className="flex-1 min-w-[10rem] px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold disabled:opacity-50"
                  autoFocus
                >
                  {isProcessing ? 'Verificando...' : 'Verificar de novo'}
                </button>
                {statusInfo?.reason === 'PENDING' ? (
                  <>
                    <button
                      onClick={handleCancelPending}
                      disabled={isProcessing}
                      className="flex-1 min-w-[10rem] px-6 py-3 border-2 border-red-500 text-red-700 rounded-lg hover:bg-red-50 font-semibold disabled:opacity-50"
                    >
                      Cancelar pagamento pendente
                    </button>
                    <button
                      onClick={leavePending}
                      disabled={isProcessing}
                      className="flex-1 min-w-[10rem] px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold disabled:opacity-50"
                    >
                      Sair (venda fica pendente)
                    </button>
                  </>
                ) : (
                  <button
                    onClick={backToForm}
                    disabled={isProcessing}
                    className="flex-1 min-w-[10rem] px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold disabled:opacity-50"
                  >
                    Voltar
                  </button>
                )}
              </div>
            </div>
          )}

          {step === 'payment' && phase === 'FORM' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleConfirmPayment();
            }}
            className="space-y-6"
          >
          {staleSale && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              A venda Nº {staleSale.saleNumber ?? '?'} foi registrada antes com outros itens e não foi paga. Ao confirmar, uma NOVA venda
              é registrada para este carrinho; a anterior fica Pendente no Histórico (cancelamento pela gerência).
            </div>
          )}

          {/* Payment Method */}
          <div>
            <p className="block text-sm font-medium text-gray-700 mb-3">
              Forma de Pagamento
            </p>
            <div className="grid grid-cols-2 gap-3">
              {paymentMethods.map((method) => (
                <button
                  type="button"
                  key={method.value}
                  aria-pressed={paymentMethod === method.value}
                  disabled={!!method.unavailable}
                  title={method.unavailable}
                  onClick={() => {
                    setPaymentMethod(method.value);
                    if (method.value !== paymentMethod) setAgreement(null);
                  }}
                  className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-all text-left ${
                    method.unavailable
                      ? 'border-gray-200 bg-gray-50 cursor-not-allowed opacity-60'
                      : paymentMethod === method.value
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <method.icon size={24} className={paymentMethod === method.value ? 'text-primary-600' : 'text-gray-400'} />
                  <span className={`font-medium ${paymentMethod === method.value ? 'text-primary-600' : 'text-gray-700'}`}>
                    {method.label}
                    {method.unavailable && <span className="block text-xs font-normal text-gray-600">{method.unavailable}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Convênio funcionário / empresa */}
          {isAgreement && (
            <AgreementPaymentPanel
              kind={paymentMethod === 'EMPLOYEE_AGREEMENT' ? 'EMPLOYEE' : 'COMPANY'}
              total={saleTotal}
              value={agreement}
              onChange={setAgreement}
              disabled={isProcessing}
            />
          )}

          {/* Installments (Credit Card) */}
          {paymentMethod === 'CREDIT_CARD' && (
            <div>
              <label htmlFor="card-installments" className="block text-sm font-medium text-gray-700 mb-2">
                Parcelas
              </label>
              <select
                id="card-installments"
                value={installments}
                onChange={(e) => setInstallments(parseInt(e.target.value))}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                  <option key={n} value={n} disabled={!installmentPreview(saleTotal, n)}>
                    {installmentPreview(saleTotal, n)?.label ?? `${n}x (valor pequeno demais para parcelar)`} {n === 1 ? '(à vista)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {paymentMethod === 'PIX' && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              Sem integração de PIX: o pagamento fica <strong>aguardando confirmação</strong> e a venda só é concluída quando ele for confirmado.
            </p>
          )}

          {/* Cédulas recebidas (controle de cédulas ligado) */}
          {paymentMethod === 'CASH' && cashControl && (
            <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">Cédulas e moedas recebidas</p>
              <div className="grid grid-cols-4 gap-2">
                {DENOMINATIONS.map((value) => (
                  <label key={value} className="flex flex-col gap-1 rounded-lg border border-gray-200 p-2 text-xs text-gray-600">
                    {formatBRL(value)}
                    <input
                      type="number"
                      min={0}
                      step={1}
                      aria-label={`Quantidade de ${formatBRL(value)}`}
                      value={notes[value] || ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [value]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
                      className="w-full rounded border border-gray-300 px-2 py-1 text-base text-gray-900 outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-sm text-gray-700">
                Total recebido: <span className="font-semibold">{formatBRL(notesTotal)}</span>
              </p>
            </div>
          )}

          {/* Paid Amount (Cash) */}
          {paymentMethod === 'CASH' && (
            <div>
              <label htmlFor="paid-amount" className="block text-sm font-medium text-gray-700 mb-2">
                Valor Pago
              </label>
              <input
                id="paid-amount"
                type="number"
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
                readOnly={cashControl}
                min={saleTotal}
                step="0.01"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
                autoFocus
              />

              {change >= 0 && (
                <div className="mt-4 bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-600 mb-1">Troco</p>
                  <p className="text-2xl font-bold text-gray-900">{formatBRL(change)}</p>
                </div>
              )}
            </div>
          )}

          {/* Quick Cash Buttons */}
          {paymentMethod === 'CASH' && !cashControl && (
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Valores Rápidos</p>
              <div className="grid grid-cols-4 gap-2">
                {[10, 20, 50, 100].map((value) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => setPaidAmount(value.toFixed(2))}
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium text-gray-700 transition-colors"
                  >
                    R$ {value}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Itens:</span>
              <span className="font-medium">{items.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Forma:</span>
              <span className="font-medium">{PAYMENT_METHOD_LABELS[paymentMethod]}</span>
            </div>
            {((paymentMethod === 'CREDIT_CARD' && installments > 1) || (paymentMethod === 'EMPLOYEE_AGREEMENT' && (agreement?.installments ?? 1) > 1)) && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Parcelas:</span>
                <span className="font-medium">{paymentMethod === 'CREDIT_CARD' ? installments : agreement?.installments}x</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={requestClose}
              disabled={isProcessing}
              className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={
                locked ||
                (paymentMethod === 'CASH' && !(parseFloat(paidAmount) >= saleTotal)) ||
                (isAgreement && (!agreement || (agreement.available !== null && agreement.available < saleTotal)))
              }
              className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  Processando...
                </>
              ) : (
                'Confirmar Pagamento'
              )}
            </button>
          </div>
          </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default PaymentModal;
