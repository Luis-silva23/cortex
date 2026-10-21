'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save, ArrowLeft, Search, Check } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface CustomerOption {
  id: string;
  name: string;
  document?: string | null;
}

export default function NewMotorcyclePage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [customerSearch, setCustomerSearch] = useState('');
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  const [formData, setFormData] = useState({
    brand: '',
    model: '',
    year: '',
    licensePlate: '',
    chassisNumber: '',
    color: '',
    engineNumber: '',
    kilometerReading: '0',
  });

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    if (!customerSearch.trim() || selectedCustomer) {
      setCustomerOptions([]);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const result = await api.searchCustomers(customerSearch, 10);
        setCustomerOptions(result?.customers ?? []);
      } catch (error) {
        console.error('Erro ao buscar clientes:', error);
        setCustomerOptions([]);
      } finally {
        setSearchingCustomers(false);
      }
    }, 350);

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [customerSearch, selectedCustomer]);

  const handleSelectCustomer = (customer: CustomerOption) => {
    setSelectedCustomer(customer);
    setCustomerSearch(customer.name);
    setCustomerOptions([]);
  };

  const handleClearCustomer = () => {
    setSelectedCustomer(null);
    setCustomerSearch('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedCustomer) {
      alert('Selecione o proprietário da moto');
      return;
    }

    setSaving(true);
    try {
      await api.createMotorcycle({
        customerId: selectedCustomer.id,
        brand: formData.brand,
        model: formData.model,
        year: formData.year ? Number(formData.year) : undefined,
        licensePlate: formData.licensePlate || undefined,
        chassisNumber: formData.chassisNumber || undefined,
        color: formData.color || undefined,
        engineNumber: formData.engineNumber || undefined,
        kilometerReading: formData.kilometerReading ? Number(formData.kilometerReading) : 0,
      });
      alert('Moto cadastrada com sucesso!');
      router.push('/dashboard/motorcycles');
    } catch (error) {
      console.error('Erro ao cadastrar moto:', error);
      alert('Erro ao cadastrar moto');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/motorcycles">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nova Moto</h1>
          <p className="text-gray-500 mt-1">Cadastre uma motocicleta para um cliente</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Proprietário</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <label className="text-sm font-medium">Cliente *</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  required
                  placeholder="Buscar por nome ou CPF/CNPJ..."
                  className="pl-10"
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value);
                    if (selectedCustomer) setSelectedCustomer(null);
                  }}
                />
                {selectedCustomer && (
                  <Check className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-600" />
                )}
              </div>

              {selectedCustomer && (
                <div className="flex items-center justify-between rounded-md border bg-blue-50 px-3 py-2 text-sm">
                  <span>
                    Selecionado: <strong>{selectedCustomer.name}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={handleClearCustomer}
                    className="text-blue-600 hover:underline"
                  >
                    Alterar
                  </button>
                </div>
              )}

              {!selectedCustomer && customerSearch && (
                <div className="rounded-md border divide-y max-h-56 overflow-auto">
                  {searchingCustomers ? (
                    <div className="p-3 text-sm text-gray-500">Buscando...</div>
                  ) : customerOptions.length === 0 ? (
                    <div className="p-3 text-sm text-gray-500">Nenhum cliente encontrado</div>
                  ) : (
                    customerOptions.map((customer) => (
                      <button
                        type="button"
                        key={customer.id}
                        onClick={() => handleSelectCustomer(customer)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        <div className="font-medium">{customer.name}</div>
                        {customer.document && (
                          <div className="text-gray-500 text-xs">{customer.document}</div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dados da Moto</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Marca *</label>
                  <Input
                    required
                    placeholder="Honda"
                    value={formData.brand}
                    onChange={(e) => handleChange('brand', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Modelo *</label>
                  <Input
                    required
                    placeholder="CG 160"
                    value={formData.model}
                    onChange={(e) => handleChange('model', e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Ano</label>
                  <Input
                    placeholder="2023"
                    value={formData.year}
                    onChange={(e) => handleChange('year', e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Placa</label>
                  <Input
                    placeholder="ABC1D23"
                    value={formData.licensePlate}
                    onChange={(e) => handleChange('licensePlate', e.target.value.toUpperCase())}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Cor</label>
                  <Input
                    placeholder="Preta"
                    value={formData.color}
                    onChange={(e) => handleChange('color', e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Chassi</label>
                  <Input
                    placeholder="Número do chassi"
                    value={formData.chassisNumber}
                    onChange={(e) => handleChange('chassisNumber', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Número do motor</label>
                  <Input
                    placeholder="Número do motor"
                    value={formData.engineNumber}
                    onChange={(e) => handleChange('engineNumber', e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2 md:w-1/2">
                <label className="text-sm font-medium">Quilometragem</label>
                <Input
                  placeholder="0"
                  value={formData.kilometerReading}
                  onChange={(e) =>
                    handleChange('kilometerReading', e.target.value.replace(/\D/g, ''))
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Link href="/dashboard/motorcycles">
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </Link>
            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Salvando...' : 'Salvar Moto'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
