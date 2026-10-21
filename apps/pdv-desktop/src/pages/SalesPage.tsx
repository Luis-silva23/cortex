import { useState, useEffect } from 'react';
import { Search, Eye, XCircle, FileText, Undo2 } from 'lucide-react';
import { api } from '../services/api';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import CancelSaleModal from '../components/CancelSaleModal';
import ReturnSaleModal from '../components/ReturnSaleModal';
import { formatBRL } from '../services/money';
import { saleStatusLabel } from '../services/sale-status';

// A API cancela venda paga, parcialmente paga ou PENDENTE (com autorizador). Antes só a paga tinha o botão: a venda
// deixada com PIX pendente no PDV ("acompanhe no Histórico") não tinha nenhuma ação possível aqui.
const CANCELLABLE = ['PAID', 'PARTIALLY_PAID', 'PENDING'];

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Aprovado',
  PENDING: 'Aguardando confirmação',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Estornado',
};
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Débito',
  CREDIT_CARD: 'Crédito',
  PIX: 'PIX',
  EMPLOYEE_AGREEMENT: 'Convênio funcionário',
  COMPANY_AGREEMENT: 'Convênio empresa',
};

function SalesPage() {
  const [sales, setSales] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSale, setSelectedSale] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [saleToCancel, setSaleToCancel] = useState<any>(null);
  const [saleToReturn, setSaleToReturn] = useState<any>(null);

  useEffect(() => {
    loadSales();
  }, [statusFilter]);

  const loadSales = async () => {
    setIsLoading(true);
    try {
      const result = await api.getSales({
        status: statusFilter || undefined,
        page: 1,
        limit: 50,
      });
      // GET /sales responde { sales, pagination } — não existe `.data` (o histórico nunca listava nada).
      setSales(result.sales ?? []);
    } catch (error: any) {
      console.error('Load sales error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleViewSale = async (saleId: string) => {
    try {
      const sale = await api.getSaleById(saleId);
      setSelectedSale(sale);
    } catch (error: any) {
      console.error('View sale error:', error);
    }
  };

  // Cancelamento de venda já criada exige dupla autorização (um segundo
  // usuário, gerência+, autoriza com as próprias credenciais) — abre o
  // modal dedicado em vez do prompt() antigo, que só pedia o motivo e
  // chamava a rota antiga (sem autorização) que o backend já não aceita
  // mais nesse formato.
  const handleCancelSale = (sale: any) => {
    setSaleToCancel(sale);
  };

  const handleCancelSaleSuccess = (_cancelledSale: any) => {
    toast.success('Venda cancelada com sucesso');
    loadSales();
    setSelectedSale(null);
  };

  // Devolução de venda já criada exige dupla autorização (mesmo padrão do
  // cancelamento — devolução faz o mesmo estorno financeiro: pagamento
  // aprovado vira REFUNDED, caixa é ajustado) — abre o modal dedicado em
  // vez do prompt() antigo, que só pedia o motivo e chamava a rota sem
  // autorização nenhuma (e que o backend, à parte disso, nem aceitava mais
  // sem os campos do autorizador — todo clique retornava 400).
  const handleReturnSale = (sale: any) => {
    setSaleToReturn(sale);
  };

  const handleReturnSaleSuccess = (_returnedSale: any) => {
    toast.success('Devolução registrada com sucesso');
    loadSales();
    setSelectedSale(null);
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      PENDING: 'bg-yellow-100 text-yellow-800',
      PAID: 'bg-green-100 text-green-800',
      PARTIALLY_PAID: 'bg-amber-100 text-amber-800',
      CANCELLED: 'bg-red-100 text-red-800',
      RETURNED: 'bg-gray-100 text-gray-800',
    };

    return (
      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${styles[status as keyof typeof styles]}`}>
        {saleStatusLabel(status)}
      </span>
    );
  };

  const filteredSales = sales.filter(sale =>
    searchTerm === '' ||
    sale.saleNumber.toString().includes(searchTerm) ||
    sale.customer?.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="h-full bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Histórico de Vendas</h1>
          <p className="text-gray-600 mt-1">Consulte e gerencie as vendas realizadas</p>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <div className="relative">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar por número da venda ou cliente..."
                  className="w-full px-4 py-2 pl-10 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                />
                <Search className="absolute left-3 top-2.5 text-gray-400" size={20} />
              </div>
            </div>

            <div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
              >
                <option value="">Todos os status</option>
                <option value="PAID">Pagas</option>
                <option value="PENDING">Pendentes</option>
                <option value="PARTIALLY_PAID">Parcialmente pagas</option>
                <option value="CANCELLED">Canceladas</option>
              </select>
            </div>
          </div>
        </div>

        {/* Sales List */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Carregando vendas...</p>
            </div>
          ) : filteredSales.length === 0 ? (
            <div className="p-12 text-center text-gray-400">
              <FileText size={64} className="mx-auto mb-4 opacity-20" />
              <p>Nenhuma venda encontrada</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Número
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Data/Hora
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Cliente
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Itens
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                      Total
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold text-gray-600 uppercase">
                      Status
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold text-gray-600 uppercase">
                      Ações
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredSales.map((sale) => (
                    <tr key={sale.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-semibold text-gray-900">#{sale.saleNumber}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {format(new Date(sale.saleDate), "dd/MM/yyyy HH:mm")}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {sale.customer?.name || 'Sem cliente'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {sale.items?.length || 0} item(ns)
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right font-semibold text-gray-900">
                        {formatBRL(Number(sale.totalAmount))}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        {getStatusBadge(sale.status)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleViewSale(sale.id)}
                            className="p-2 text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                            title="Ver detalhes"
                          >
                            <Eye size={18} />
                          </button>
                          {CANCELLABLE.includes(sale.status) && (
                            <button
                              onClick={() => handleCancelSale(sale)}
                              className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Cancelar"
                            >
                              <XCircle size={18} />
                            </button>
                          )}
                          {sale.status === 'PAID' && (
                            <button
                              onClick={() => handleReturnSale(sale)}
                              className="p-2 text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
                              title="Devolver"
                            >
                              <Undo2 size={18} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Sale Details Modal */}
        {selectedSale && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b border-gray-200">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">
                    Venda #{selectedSale.saleNumber}
                  </h2>
                  <p className="text-sm text-gray-600">
                    {format(new Date(selectedSale.saleDate), "dd/MM/yyyy 'às' HH:mm")}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedSale(null)}
                  className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
                >
                  <XCircle size={24} />
                </button>
              </div>

              <div className="p-6 space-y-6">
                {/* Customer */}
                {selectedSale.customer && (
                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="text-sm text-gray-600 mb-1">Cliente</p>
                    <p className="font-semibold text-gray-900">{selectedSale.customer.name}</p>
                    {selectedSale.customer.document && (
                      <p className="text-sm text-gray-600">{selectedSale.customer.document}</p>
                    )}
                  </div>
                )}

                {/* Items */}
                <div>
                  <p className="font-semibold text-gray-900 mb-3">Itens da Venda</p>
                  <div className="space-y-2">
                    {selectedSale.items?.map((item: any, index: number) => (
                      <div key={index} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                        <div className="flex-1">
                          <p className="font-medium text-gray-900">{item.productName}</p>
                          <p className="text-sm text-gray-600">
                            {item.quantity}x {formatBRL(Number(item.unitPrice))}
                          </p>
                        </div>
                        <p className="font-bold text-gray-900">
                          {formatBRL(Number(item.totalPrice))}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Totals */}
                <div className="border-t border-gray-200 pt-4 space-y-2">
                  <div className="flex justify-between text-gray-600">
                    <span>Subtotal:</span>
                    <span className="font-semibold">{formatBRL(Number(selectedSale.subtotal))}</span>
                  </div>
                  {selectedSale.discountAmount > 0 && (
                    <div className="flex justify-between text-gray-700">
                      <span>Desconto:</span>
                      <span className="font-semibold">- {formatBRL(Number(selectedSale.discountAmount))}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xl font-bold text-gray-900 pt-2 border-t">
                    <span>TOTAL:</span>
                    <span className="text-primary-600">{formatBRL(Number(selectedSale.totalAmount))}</span>
                  </div>
                </div>

                {/* Status */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <span className="text-gray-700 font-medium">Status:</span>
                  {getStatusBadge(selectedSale.status)}
                </div>

                {/* Pagamentos: mostra qual está aguardando confirmação/recusado — antes só o status da venda aparecia */}
                {Array.isArray(selectedSale.payments) && selectedSale.payments.length > 0 && (
                  <div>
                    <p className="font-semibold text-gray-900 mb-2">Pagamentos</p>
                    <ul className="space-y-1 text-sm">
                      {selectedSale.payments.map((p: any) => (
                        <li key={p.id} className="flex justify-between rounded bg-gray-50 px-3 py-2">
                          <span>
                            {PAYMENT_METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod} · {PAYMENT_STATUS_LABEL[p.status] ?? p.status}
                          </span>
                          <span className="font-semibold">{formatBRL(Number(p.amount))}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {CANCELLABLE.includes(selectedSale.status) && (
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleCancelSale(selectedSale)}
                      className="flex-1 px-4 py-2 border-2 border-red-500 text-red-600 rounded-lg hover:bg-red-50 font-semibold transition-colors flex items-center justify-center gap-2"
                    >
                      <XCircle size={18} />
                      Cancelar Venda
                    </button>
                    {selectedSale.status === 'PAID' && (
                    <button
                      onClick={() => handleReturnSale(selectedSale)}
                      className="flex-1 px-4 py-2 border-2 border-amber-700 text-amber-700 rounded-lg hover:bg-amber-50 font-semibold transition-colors flex items-center justify-center gap-2"
                    >
                      <Undo2 size={18} />
                      Devolver Venda
                    </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Cancel Sale Modal (dupla autorização) */}
        <CancelSaleModal
          isOpen={!!saleToCancel}
          onClose={() => setSaleToCancel(null)}
          sale={saleToCancel}
          onSuccess={handleCancelSaleSuccess}
        />

        {/* Return Sale Modal (dupla autorização) */}
        <ReturnSaleModal
          isOpen={!!saleToReturn}
          onClose={() => setSaleToReturn(null)}
          sale={saleToReturn}
          onSuccess={handleReturnSaleSuccess}
        />
      </div>
    </div>
  );
}

export default SalesPage;
