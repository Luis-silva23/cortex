import { useState, useEffect, useRef } from 'react';
import { Search, ShoppingCart, Trash2, Plus, Minus, User, DollarSign, Percent, Hash } from 'lucide-react';
import { useCartStore } from '../store/cart.store';
import { useAuthStore } from '../store/auth.store';
import { useCashRegisterStore } from '../store/cashRegister.store';
import { useCheckoutStore } from '../store/checkout.store';
import { api } from '../services/api';
import toast from 'react-hot-toast';
import PaymentModal, { SaleCompletion } from '../components/PaymentModal';
import CustomerSearchModal from '../components/CustomerSearchModal';
import { formatBRL } from '../services/money';

// Pequeno badge visual usado ao lado do rótulo de cada botão/campo para
// indicar seu atalho de teclado equivalente — mesmo texto mostrado na barra
// inferior fixa, só que junto do controle a que se refere.
function ShortcutBadge({ label }: { label: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-300 text-[10px] font-mono font-semibold text-gray-500">
      {label}
    </span>
  );
}

function POSPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [products, setProducts] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showQuantityModal, setShowQuantityModal] = useState(false);
  const [quantityInput, setQuantityInput] = useState('1');
  const [globalDiscount, setGlobalDiscount] = useState('0');
  const [partners, setPartners] = useState<any[]>([]);
  // Resultado da última venda (concluída ou deixada pendente): troco e cupom ficam visíveis sem travar o próximo
  // atendimento — o foco volta à busca, então o leitor de código de barras já pode ler o próximo item.
  const [lastSale, setLastSale] = useState<SaleCompletion | null>(null);
  // Enter repetido na busca (ou leitor enviando Enter duas vezes) não adiciona o item em dobro.
  const searchingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const discountInputRef = useRef<HTMLInputElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);

  const { user } = useAuthStore();
  const openSale = useCheckoutStore((s) => s.sale);
  const { currentCashRegister, setCurrentCashRegister } = useCashRegisterStore();
  const {
    items,
    customer,
    subtotal,
    discountAmount,
    discountPercent,
    partner,
    partnerDiscountEstimate,
    total,
    addItem,
    removeItem,
    updateQuantity,
    applyGlobalDiscount,
    setPartner,
    setCustomer,
    clearCart,
  } = useCartStore();

  // Focar no input de busca ao carregar
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // O caixa aberto normalmente é carregado pela página "Caixa", mas a rota
  // inicial do app é /pos — se o operador nunca visitar /cash-register nesta
  // sessão o store fica vazio mesmo com um caixa realmente aberto no
  // servidor, bloqueando vendas indevidamente. Busca aqui também, sem
  // sobrescrever um caixa que já esteja carregado no store.
  useEffect(() => {
    if (currentCashRegister?.id || !user?.branchId) return;
    api
      .getCurrentCashRegister(user.branchId)
      .then((result) => setCurrentCashRegister(result))
      .catch(() => {
        // 404 = sem caixa aberto; nada a fazer, handleFinishSale já bloqueia.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Convênios (Partner) da filial — usados no F4 como alternativa ao
  // desconto manual digitado. Carregado uma vez ao entrar no PDV; a
  // validade/ativação real de cada convênio é sempre reconferida pelo
  // backend no momento da venda (partner.service.ts).
  useEffect(() => {
    if (!user?.branchId) return;
    api
      .getPartners(user.branchId)
      .then((result) => setPartners((result || []).filter((p: any) => p.isActive)))
      .catch(() => {
        // Falha ao listar convênios não deve bloquear o PDV — o operador
        // ainda pode vender normalmente sem convênio.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecionar/limpar convênio no F4 — mutuamente exclusivo com o desconto
  // manual quando o convênio não é empilhável (cart.store.ts já resolve
  // isso limpando o outro campo).
  const handleSelectPartner = (partnerId: string) => {
    if (!partnerId) {
      setPartner(null);
      return;
    }
    const selected = partners.find((p) => p.id === partnerId);
    if (!selected) return;
    setPartner({
      id: selected.id,
      name: selected.name,
      discountType: selected.discountType,
      discountValue: Number(selected.discountValue),
      maxDiscountAmount: selected.maxDiscountAmount != null ? Number(selected.maxDiscountAmount) : null,
      stackable: !!selected.stackable,
    });
    toast.success(`Convênio "${selected.name}" selecionado`);
  };

  // Buscar produtos
  const handleSearch = async () => {
    if (!searchTerm.trim() || searchingRef.current) return;

    searchingRef.current = true;
    setIsSearching(true);
    try {
      // Primeiro tenta buscar por código específico
      if (searchTerm.length <= 20) {
        try {
          const product = await api.getProductByCode(searchTerm);
          if (product && product.isActive === false) {
            // encontrado pelo código, mas desativado no cadastro: não entra no carrinho
            toast.error(`${product.name} está inativo e não pode ser vendido`);
            setSearchTerm('');
            searchInputRef.current?.focus();
            return;
          }
          if (product) {
            addItem(product, 1);
            setSearchTerm('');
            searchInputRef.current?.focus();
            toast.success(`${product.name} adicionado`);
            return;
          }
        } catch (error) {
          // Se não encontrar por código, busca por nome
        }
      }

      // Busca por nome
      // GET /products responde { products, pagination } — nunca houve `.data`: a busca por NOME
      // lançava TypeError, o render do POS quebrava (`products.length` de undefined) e, sem error
      // boundary, a tela inteira do PDV ficava em branco. Só o código exato (/products/search/:code) funcionava.
      const result = await api.searchProducts(searchTerm);
      const found: any[] = result.products ?? [];
      setProducts(found);

      if (found.length === 0) {
        toast('Nenhum produto encontrado', { icon: '🔍' });
      } else if (found.length === 1) {
        // já adicionado: a lista não fica aberta (um clique nela adicionava o item de novo, em dobro)
        setProducts([]);
        addItem(found[0], 1);
        setSearchTerm('');
        searchInputRef.current?.focus();
        toast.success(`${found[0].name} adicionado`);
      }
    } catch (error: any) {
      console.error('Search error:', error);
    } finally {
      searchingRef.current = false;
      setIsSearching(false);
    }
  };

  // Adicionar produto da lista de resultados
  const handleAddProduct = (product: any) => {
    addItem(product, 1);
    setProducts([]);
    setSearchTerm('');
    searchInputRef.current?.focus();
    toast.success(`${product.name} adicionado`);
  };

  // Aplicar desconto global
  const handleApplyDiscount = () => {
    const discount = parseFloat(globalDiscount) || 0;
    if (discount < 0 || discount > 100) {
      toast.error('Desconto deve estar entre 0 e 100%');
      return;
    }
    applyGlobalDiscount(discount);
    toast.success(`Desconto de ${discount}% aplicado`);
  };

  // Finalizar venda
  const handleFinishSale = () => {
    if (items.length === 0) {
      toast.error('Adicione produtos ao carrinho');
      return;
    }
    // Operação de pagamento nunca pode ocorrer contra um caixa fechado/
    // inexistente — sem o caixa aberto não há cashRegisterId real para
    // enviar na venda (o backend rejeita a venda se o caixa não estiver
    // aberto, ver saleService.createSale).
    if (!currentCashRegister?.id) {
      toast.error('Abra o caixa antes de iniciar uma venda');
      return;
    }
    setShowPaymentModal(true);
  };

  // F2 - Pesquisar produto: foca (e seleciona) o campo de busca para o
  // operador digitar/escanear o próximo produto. Mesma função chamada pelo
  // atalho de teclado e pelo badge/botão de busca.
  const handleFocusSearch = () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };

  // F3 - Cliente
  const handleOpenCustomer = () => {
    setShowCustomerModal(true);
  };

  // F4 - Desconto: foca o campo de desconto global para digitar o valor.
  const handleFocusDiscount = () => {
    discountInputRef.current?.focus();
    discountInputRef.current?.select();
  };

  // F5 - Quantidade: abre o editor de quantidade para o último item do
  // carrinho (o mais recém adicionado/alterado) — é o alvo mais previsível
  // quando não há um mecanismo de seleção de linha na tela.
  const handleOpenQuantity = () => {
    if (items.length === 0) {
      toast.error('Carrinho vazio');
      return;
    }
    const lastItem = items[items.length - 1];
    setQuantityInput(String(lastItem.quantity));
    setShowQuantityModal(true);
  };

  const handleConfirmQuantity = () => {
    if (items.length === 0) return;
    const lastItem = items[items.length - 1];
    const qty = parseFloat(quantityInput);
    if (!(qty > 0)) {
      toast.error('Quantidade inválida');
      return;
    }
    updateQuantity(lastItem.id, qty);
    setShowQuantityModal(false);
    searchInputRef.current?.focus();
  };

  // ESC - Voltar/fechar: fecha só o painel/modal mais "no topo" no momento,
  // nunca limpa o carrinho silenciosamente. Prioridade: modais > resultados
  // de busca abertos > texto digitado na busca.
  const handleEscape = () => {
    if (showQuantityModal) {
      setShowQuantityModal(false);
      return;
    }
    if (showCustomerModal) {
      setShowCustomerModal(false);
      return;
    }
    if (showPaymentModal) {
      // O próprio PaymentModal trata o ESC: fechar por fora escondia uma cobrança em processamento/pendente e,
      // ao finalizar de novo, criava outra venda.
      return;
    }
    if (products.length > 0) {
      setProducts([]);
      return;
    }
    if (searchTerm) {
      setSearchTerm('');
    }
    searchInputRef.current?.focus();
  };

  // Esvaziar carrinho — ação explícita e separada do ESC (que nunca limpa o
  // carrinho silenciosamente); ainda pede confirmação por ser destrutiva.
  const handleClearCart = () => {
    if (items.length === 0) return;
    if (confirm('Deseja esvaziar o carrinho da venda atual?')) {
      clearCart();
      setProducts([]);
      setSearchTerm('');
      setGlobalDiscount('0');
      searchInputRef.current?.focus();
      toast.success('Carrinho esvaziado');
    }
  };

  // Atalhos de teclado — cada tecla chama exatamente a mesma função usada
  // pelo botão/campo correspondente na tela, nunca uma lógica paralela.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTypingField = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;

      // Teclas de função (F1–F12) NUNCA inserem texto, então funcionam também com o foco num campo.
      // Antes o handler ignorava TODA tecla com o foco num <input> — e o POS devolve o foco ao campo
      // de busca depois de cada item adicionado, então F3/F4/F5 ficavam mortos quase o tempo todo
      // (e o F5 sem preventDefault RECARREGAVA a janela do Electron, perdendo o carrinho).
      const isFunctionKey = /^F([1-9]|1[0-2])$/.test(e.key);

      // Com um modal aberto (cliente, quantidade, pagamento) os atalhos de tela não valem — senão
      // F5 abriria o editor de quantidade POR CIMA do pagamento. O preventDefault continua, para
      // o F5 não recarregar a janela. ESC segue funcionando (fecha o modal do topo).
      if ((showQuantityModal || showCustomerModal || showPaymentModal) && e.key !== 'Escape') {
        if (isFunctionKey) e.preventDefault();
        return;
      }

      // Teclas que digitam (letras, números...) nunca disparam atalho dentro de um campo de texto.
      if (isTypingField && !isFunctionKey && e.key !== 'Escape') {
        return;
      }

      switch (e.key) {
        case 'F2':
          e.preventDefault();
          handleFocusSearch();
          break;
        case 'F3':
          e.preventDefault();
          handleOpenCustomer();
          break;
        case 'F4':
          e.preventDefault();
          handleFocusDiscount();
          break;
        case 'F5':
          e.preventDefault();
          handleOpenQuantity();
          break;
        case 'F10':
          e.preventDefault();
          handleFinishSale();
          break;
        case 'Escape':
          if (showPaymentModal) break;
          e.preventDefault();
          handleEscape();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, products, searchTerm, showQuantityModal, showCustomerModal, showPaymentModal]);

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Ponto de Venda</h2>
            <p className="text-sm text-gray-600">Operador: {user?.name}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleOpenCustomer}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors flex items-center gap-2"
            >
              <User size={18} />
              Cliente
              <ShortcutBadge label="F3" />
            </button>
            <button
              onClick={handleOpenQuantity}
              disabled={items.length === 0}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Hash size={18} />
              Quantidade
              <ShortcutBadge label="F5" />
            </button>
            <button
              onClick={handleClearCart}
              disabled={items.length === 0}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Esvaziar Carrinho
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Product Search */}
        <div className="flex-1 flex flex-col p-6">
          {/* Última venda: concluída (troco/cupom) ou NÃO concluída (pagamento pendente) */}
          {lastSale && (
            <div
              role="status"
              data-testid="last-sale"
              className={`mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
                lastSale.pending ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-green-300 bg-green-50 text-green-900'
              }`}
            >
              <div>
                <p className="font-bold">
                  {lastSale.pending
                    ? `VENDA Nº ${lastSale.saleNumber ?? ''} NÃO CONCLUÍDA — pagamento pendente (acompanhe no Histórico)`
                    : `VENDA Nº ${lastSale.saleNumber ?? ''} CONCLUÍDA — ${lastSale.methodLabel} ${formatBRL(lastSale.total)}`}
                </p>
                {!lastSale.pending && lastSale.change > 0 && (
                  <p className="text-lg font-bold">Troco: {formatBRL(lastSale.change)}</p>
                )}
                <p>{lastSale.printNote}</p>
              </div>
              <button type="button" onClick={() => setLastSale(null)} aria-label="Dispensar aviso" className="text-lg leading-none opacity-70 hover:opacity-100">
                ×
              </button>
            </div>
          )}

          {/* Search Bar */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <label className="text-sm font-medium text-gray-700">Pesquisar Produto</label>
              <ShortcutBadge label="F2" />
            </div>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="Digite o código ou nome do produto..."
                  className="w-full px-4 py-3 pl-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
                />
                <Search className="absolute left-4 top-3.5 text-gray-400" size={20} />
              </div>
              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 font-semibold"
              >
                {isSearching ? 'Buscando...' : 'Buscar'}
              </button>
            </div>
          </div>

          {/* Search Results */}
          {products.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">Resultados ({products.length})</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {products.map((product) => (
                  <button
                    key={product.id}
                    onClick={() => handleAddProduct(product)}
                    className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-primary-50 rounded-lg transition-colors text-left"
                  >
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{product.name}</p>
                      <p className="text-sm text-gray-600">SKU: {product.sku}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-primary-600">
                        {formatBRL(Number(product.salePrice))}
                      </p>
                      {/* `|| 'N/A'` mostrava "N/A" também para estoque ZERO */}
                      <p className="text-xs text-gray-500">Estoque: {product.stock ?? '—'}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Shopping Cart */}
          <div className="flex-1 bg-white rounded-lg shadow-sm p-4 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <ShoppingCart size={20} />
                Carrinho ({items.length})
              </h3>
              {customer && (
                <div className="text-sm text-gray-600 flex items-center gap-2">
                  <span>
                    <span className="font-medium">Cliente:</span> {customer.name}
                    {customer.document ? ` · ${customer.document}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomer(null);
                      searchInputRef.current?.focus();
                    }}
                    className="text-xs text-red-600 hover:underline"
                  >
                    remover
                  </button>
                </div>
              )}
            </div>

            {openSale && (
              <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="open-sale">
                Venda Nº {openSale.saleNumber ?? '?'} já registrada e <strong>aguardando pagamento</strong>. Finalizar (F10) cobra a mesma venda;
                alterar os itens gera uma venda nova e esta fica pendente no Histórico.
              </p>
            )}

            {items.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <ShoppingCart size={64} className="mx-auto mb-4 opacity-20" />
                  <p>Carrinho vazio</p>
                  <p className="text-sm mt-2">Adicione produtos para começar</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-2">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{item.productName}</p>
                      <p className="text-sm text-gray-600">
                        {formatBRL(item.unitPrice)} x {item.quantity}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity - 1)}
                        className="w-8 h-8 bg-gray-200 hover:bg-gray-300 rounded flex items-center justify-center"
                      >
                        <Minus size={16} />
                      </button>
                      <span className="w-12 text-center font-semibold">{item.quantity}</span>
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        className="w-8 h-8 bg-gray-200 hover:bg-gray-300 rounded flex items-center justify-center"
                      >
                        <Plus size={16} />
                      </button>
                    </div>

                    <div className="text-right w-24">
                      <p className="font-bold text-gray-900">
                        {formatBRL(item.totalPrice)}
                      </p>
                    </div>

                    <button
                      onClick={() => removeItem(item.id)}
                      className="w-8 h-8 bg-red-100 hover:bg-red-200 text-red-600 rounded flex items-center justify-center"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Summary */}
        <div className="w-96 bg-white border-l border-gray-200 p-6 flex flex-col">
          {/* Discount */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <label className="text-sm font-medium text-gray-700">Desconto Global (%)</label>
              <ShortcutBadge label="F4" />
            </div>
            <div className="flex gap-2">
              <input
                ref={discountInputRef}
                type="number"
                value={globalDiscount}
                onChange={(e) => setGlobalDiscount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleApplyDiscount()}
                min="0"
                max="100"
                step="0.01"
                disabled={!!partner && !partner.stackable}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none disabled:opacity-50 disabled:bg-gray-100"
              />
              <button
                onClick={handleApplyDiscount}
                disabled={!!partner && !partner.stackable}
                className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Percent size={18} />
              </button>
            </div>

            <label className="block text-sm font-medium text-gray-700 mt-3 mb-2">Convênio</label>
            <select
              value={partner?.id || ''}
              onChange={(e) => handleSelectPartner(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
            >
              <option value="">Nenhum</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.discountType === 'PERCENTAGE' ? `${Number(p.discountValue)}%` : formatBRL(Number(p.discountValue))})
                </option>
              ))}
            </select>
          </div>

          {/* Totals */}
          <div className="flex-1 space-y-4 mb-6">
            <div className="flex justify-between text-lg">
              <span className="text-gray-600">Subtotal:</span>
              <span className="font-semibold">{formatBRL(subtotal)}</span>
            </div>

            {discountAmount > 0 && (
              <div className="flex justify-between text-lg text-gray-700">
                <span>Desconto:</span>
                <span className="font-semibold">- {formatBRL(discountAmount)}</span>
              </div>
            )}

            {partner && partnerDiscountEstimate > 0 && (
              <div className="flex justify-between text-lg text-gray-700">
                <span>Convênio ({partner.name}):</span>
                <span className="font-semibold">- {formatBRL(partnerDiscountEstimate)}</span>
              </div>
            )}

            <div className="border-t-2 border-gray-300 pt-4">
              <div className="flex justify-between text-3xl font-bold">
                <span className="text-gray-900">TOTAL:</span>
                <span className="text-primary-600">{formatBRL(total)}</span>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            <button
              onClick={handleFinishSale}
              disabled={items.length === 0}
              className="w-full py-4 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-bold text-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <DollarSign size={24} />
              Finalizar Venda
              <span className="ml-1 px-1.5 py-0.5 rounded bg-white/20 text-[11px] font-mono">F10</span>
            </button>
          </div>
        </div>
      </div>

      {/* Barra de atalhos fixa */}
      <footer className="bg-white border-t border-gray-200 px-6 py-2 flex items-center justify-center gap-6 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="F2" /> Pesquisar produto
        </span>
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="F3" /> Cliente
        </span>
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="F4" /> Desconto
        </span>
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="F5" /> Quantidade
        </span>
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="F10" /> Finalizar venda
        </span>
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="ESC" /> Voltar/fechar
        </span>
        <span className="flex items-center gap-1.5">
          <ShortcutBadge label="ENTER" /> Confirmar/adicionar
        </span>
      </footer>

      {/* Modals */}
      {showPaymentModal && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          total={total}
          subtotal={subtotal}
          discountAmount={discountAmount}
          discountPercent={discountPercent}
          partnerId={partner?.id}
          items={items}
          customer={customer}
          cashRegisterId={currentCashRegister?.id}
          onSuccess={(result) => {
            clearCart();
            setGlobalDiscount('0');
            setShowPaymentModal(false);
            setLastSale(result ?? null);
            searchInputRef.current?.focus();
          }}
        />
      )}

      {showCustomerModal && (
        <CustomerSearchModal
          isOpen={showCustomerModal}
          onClose={() => {
            setShowCustomerModal(false);
            searchInputRef.current?.focus();
          }}
          onSelect={(selectedCustomer) => {
            setCustomer(selectedCustomer);
            setShowCustomerModal(false);
            toast.success(`Cliente ${selectedCustomer.name} selecionado`);
            // campo de leitura pronto de novo para o próximo código de barras
            searchInputRef.current?.focus();
          }}
        />
      )}

      {showQuantityModal && items.length > 0 && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-sm p-6 animate-slide-in">
            <h3 className="text-xl font-bold text-gray-900 mb-1">Alterar Quantidade</h3>
            <p className="text-sm text-gray-600 mb-6">{items[items.length - 1].productName}</p>

            <input
              ref={quantityInputRef}
              type="number"
              value={quantityInput}
              onChange={(e) => setQuantityInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConfirmQuantity()}
              min="0.001"
              step="1"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg text-center mb-6"
              autoFocus
            />

            <div className="flex gap-3">
              <button
                onClick={() => setShowQuantityModal(false)}
                className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirmQuantity}
                className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default POSPage;
