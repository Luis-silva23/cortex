import { useState } from 'react';
import { X, Search, Plus, User } from 'lucide-react';
import { api } from '../services/api';
import toast from 'react-hot-toast';

interface CustomerSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (customer: any) => void;
}

function CustomerSearchModal({ isOpen, onClose, onSelect }: CustomerSearchModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  // Cadastro rápido de balcão: só o nome é obrigatório. WhatsApp e contato preferencial (docs/CORTEX/policies/CLIENTE.md)
  // ficam na mesma tela, sem passo extra; a API confere o CPF/CNPJ e a coerência do contato preferencial.
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    document: '',
    phone: '',
    whatsapp: '',
    preferredContact: '',
    email: '',
  });

  if (!isOpen) return null;

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;

    setIsSearching(true);
    try {
      // GET /customers responde { customers, pagination } — nunca houve
      // `.data` nesta rota, então a busca sempre lançava TypeError aqui e o
      // operador nunca via resultado (nem "nenhum cliente encontrado").
      const result = await api.searchCustomers(searchTerm);
      const found: any[] = result.customers ?? [];
      setCustomers(found);

      if (found.length === 0) {
        toast('Nenhum cliente encontrado', { icon: '🔍' });
      }
    } catch (error: any) {
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateCustomer = async () => {
    if (!newCustomer.name.trim()) {
      toast.error('Nome é obrigatório');
      return;
    }
    if (newCustomer.preferredContact === 'WHATSAPP' && !newCustomer.whatsapp.trim()) {
      toast.error('Para preferir WhatsApp, informe o WhatsApp');
      return;
    }
    if (newCustomer.preferredContact === 'EMAIL' && !newCustomer.email.trim()) {
      toast.error('Para preferir e-mail, informe o e-mail');
      return;
    }
    if (newCustomer.preferredContact === 'PHONE' && !newCustomer.phone.trim()) {
      toast.error('Para preferir telefone, informe o telefone');
      return;
    }

    try {
      const customer = await api.createCustomer(newCustomer);
      toast.success('Cliente cadastrado com sucesso!');
      onSelect(customer);
    } catch (error: any) {
      console.error('Create customer error:', error);
    }
  };

  const handleSelectCustomer = (customer: any) => {
    onSelect(customer);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">Buscar Cliente</h2>
          <button
            onClick={onClose}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {!showNewForm ? (
            <>
              {/* Search */}
              <div>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Nome, CPF/CNPJ ou telefone..."
                      className="w-full px-4 py-3 pl-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                      autoFocus
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

              {/* Results */}
              {customers.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-700">
                    {customers.length} cliente(s) encontrado(s)
                  </p>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {customers.map((customer) => (
                      <button
                        key={customer.id}
                        onClick={() => handleSelectCustomer(customer)}
                        className="w-full flex items-center gap-4 p-4 bg-gray-50 hover:bg-primary-50 rounded-lg transition-colors text-left border border-transparent hover:border-primary-200"
                      >
                        <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
                          <User size={24} className="text-primary-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-gray-900">{customer.name}</p>
                          <div className="flex gap-4 text-sm text-gray-600 mt-1">
                            {customer.document && <span>CPF/CNPJ: {customer.document}</span>}
                            {customer.phone && <span>Tel: {customer.phone}</span>}
                            {customer.whatsapp && <span>WhatsApp: {customer.whatsapp}</span>}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* No Customer */}
              <div className="text-center py-8">
                <button
                  onClick={() => setShowNewForm(true)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors font-semibold"
                >
                  <Plus size={20} />
                  Cadastrar Novo Cliente
                </button>
              </div>

              {/* Remove Customer */}
              <div className="text-center pt-4 border-t border-gray-200">
                <button
                  onClick={() => onSelect(null)}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium"
                >
                  Continuar sem cliente
                </button>
              </div>
            </>
          ) : (
            <>
              {/* New Customer Form */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Nome Completo *
                  </label>
                  <input
                    type="text"
                    value={newCustomer.name}
                    onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    CPF/CNPJ
                  </label>
                  <input
                    type="text"
                    value={newCustomer.document}
                    onChange={(e) => setNewCustomer({ ...newCustomer, document: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="pdv-customer-phone" className="block text-sm font-medium text-gray-700 mb-2">
                      Telefone
                    </label>
                    <input
                      id="pdv-customer-phone"
                      type="text"
                      value={newCustomer.phone}
                      onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="pdv-customer-whatsapp" className="block text-sm font-medium text-gray-700 mb-2">
                      WhatsApp
                    </label>
                    <input
                      id="pdv-customer-whatsapp"
                      type="text"
                      value={newCustomer.whatsapp}
                      onChange={(e) => setNewCustomer({ ...newCustomer, whatsapp: e.target.value })}
                      placeholder="(00) 00000-0000"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="pdv-customer-preferred" className="block text-sm font-medium text-gray-700 mb-2">
                    Contato preferencial
                  </label>
                  <select
                    id="pdv-customer-preferred"
                    value={newCustomer.preferredContact}
                    onChange={(e) => setNewCustomer({ ...newCustomer, preferredContact: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none bg-white"
                  >
                    <option value="">Não informado</option>
                    <option value="WHATSAPP">WhatsApp</option>
                    <option value="PHONE">Telefone</option>
                    <option value="EMAIL">E-mail</option>
                    <option value="IN_PERSON">Presencial</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    E-mail
                  </label>
                  <input
                    type="email"
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={() => setShowNewForm(false)}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-semibold transition-colors"
                >
                  Voltar
                </button>
                <button
                  onClick={handleCreateCustomer}
                  className="flex-1 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors"
                >
                  Cadastrar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CustomerSearchModal;
