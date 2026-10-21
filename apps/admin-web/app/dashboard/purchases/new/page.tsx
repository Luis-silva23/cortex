'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Save, Plus, Trash2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';

interface Supplier {
  id: string;
  name: string;
  document: string;
}

interface Branch {
  id: string;
  name: string;
  isActive: boolean;
}

interface ProductOption {
  id: string;
  name: string;
  sku: string;
  costPrice: number;
}

interface ItemRow {
  key: string;
  productId: string;
  productLabel: string;
  quantity: string;
  unitCost: string;
  search: string;
  results: ProductOption[];
  searching: boolean;
  showResults: boolean;
}

function newRow(): ItemRow {
  return {
    key: Math.random().toString(36).slice(2),
    productId: '',
    productLabel: '',
    quantity: '1',
    unitCost: '0',
    search: '',
    results: [],
    searching: false,
    showResults: false,
  };
}

export default function NewPurchaseOrderPage() {
  const router = useRouter();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchId, setBranchId] = useState('');

  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierResults, setSupplierResults] = useState<Supplier[]>([]);
  const [supplierSearching, setSupplierSearching] = useState(false);
  const [showSupplierResults, setShowSupplierResults] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);

  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<ItemRow[]>([newRow()]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadBranches = async () => {
      setBranchesLoading(true);
      try {
        const result = await api.getBranches();
        const list: Branch[] = (result?.data ?? []).filter((b: Branch) => b.isActive !== false);
        setBranches(list);
        if (list.length === 1) {
          setBranchId(list[0].id);
        }
      } catch (err) {
        console.error('Erro ao carregar filiais:', err);
        setBranches([]);
      } finally {
        setBranchesLoading(false);
      }
    };
    loadBranches();
  }, []);

  useEffect(() => {
    if (!supplierSearch.trim()) {
      setSupplierResults([]);
      return;
    }
    setSupplierSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const result = await api.getSuppliers({ search: supplierSearch, limit: 10 });
        setSupplierResults(result?.suppliers ?? []);
      } catch (err) {
        console.error('Erro ao buscar fornecedores:', err);
        setSupplierResults([]);
      } finally {
        setSupplierSearching(false);
      }
    }, 350);
    return () => clearTimeout(timeout);
  }, [supplierSearch]);

  const updateItem = (key: string, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const searchProducts = (key: string, term: string) => {
    updateItem(key, { search: term, showResults: true });
  };

  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];
    items.forEach((row) => {
      if (!row.search.trim() || row.productId) return;
      const timer = setTimeout(async () => {
        updateItem(row.key, { searching: true });
        try {
          const result = await api.getProducts({ search: row.search, limit: 10 });
          updateItem(row.key, { results: result?.products ?? [], searching: false });
        } catch (err) {
          console.error('Erro ao buscar produtos:', err);
          updateItem(row.key, { results: [], searching: false });
        }
      }, 350);
      timers.push(timer);
    });
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.search).join('|')]);

  const addRow = () => setItems((prev) => [...prev, newRow()]);
  const removeRow = (key: string) =>
    setItems((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev));

  const selectProduct = (key: string, product: ProductOption) => {
    updateItem(key, {
      productId: product.id,
      productLabel: `${product.name} (${product.sku})`,
      search: `${product.name} (${product.sku})`,
      unitCost: String(product.costPrice ?? 0),
      showResults: false,
      results: [],
    });
  };

  const total = items.reduce((sum, row) => {
    const qty = parseFloat(row.quantity) || 0;
    const cost = parseFloat(row.unitCost) || 0;
    return sum + qty * cost;
  }, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedSupplier) {
      setError('Selecione um fornecedor');
      return;
    }
    if (!branchId) {
      setError('Selecione a filial');
      return;
    }
    const validItems = items.filter((row) => row.productId && parseFloat(row.quantity) > 0);
    if (validItems.length === 0) {
      setError('Adicione pelo menos um item válido');
      return;
    }

    setSaving(true);
    try {
      await api.createPurchaseOrder({
        branchId,
        supplierId: selectedSupplier.id,
        // Mesmo achado de auditoria do campo dueDate em financial/page.tsx:
        // <input type="date"> devolve "YYYY-MM-DD" puro, que `new Date()`
        // interpreta como meia-noite UTC, não local — exibia um dia a
        // menos para usuários em UTC-3. "T23:59:59" (sem fuso, portanto
        // horário local) corrige.
        expectedDelivery: expectedDelivery ? new Date(`${expectedDelivery}T23:59:59`).toISOString() : undefined,
        notes: notes || undefined,
        items: validItems.map((row) => ({
          productId: row.productId,
          quantity: parseFloat(row.quantity),
          unitCost: parseFloat(row.unitCost),
        })),
      });
      router.push('/dashboard/purchases');
    } catch (err: any) {
      console.error('Erro ao criar pedido de compra:', err);
      setError(getApiErrorMessage(err, 'Erro ao criar pedido de compra'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/purchases">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Novo Pedido de Compra</h1>
          <p className="text-gray-500 mt-1">Crie um pedido de compra para um fornecedor</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="space-y-6">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Fornecedor e Filial</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 relative">
                <label className="text-sm font-medium">Fornecedor *</label>
                {selectedSupplier ? (
                  <div className="flex items-center justify-between rounded-md border border-gray-300 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">{selectedSupplier.name}</p>
                      <p className="text-xs text-gray-500">{selectedSupplier.document}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedSupplier(null);
                        setSupplierSearch('');
                      }}
                    >
                      Trocar
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input
                        placeholder="Buscar fornecedor por nome ou CPF/CNPJ..."
                        className="pl-10"
                        value={supplierSearch}
                        onChange={(e) => {
                          setSupplierSearch(e.target.value);
                          setShowSupplierResults(true);
                        }}
                        onFocus={() => setShowSupplierResults(true)}
                      />
                    </div>
                    {showSupplierResults && supplierSearch.trim() && (
                      <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg max-h-56 overflow-auto">
                        {supplierSearching ? (
                          <div className="p-3 text-sm text-gray-500">Buscando...</div>
                        ) : supplierResults.length === 0 ? (
                          <div className="p-3 text-sm text-gray-500">Nenhum fornecedor encontrado</div>
                        ) : (
                          supplierResults.map((s) => (
                            <button
                              type="button"
                              key={s.id}
                              className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                              onClick={() => {
                                setSelectedSupplier(s);
                                setShowSupplierResults(false);
                              }}
                            >
                              <p className="font-medium">{s.name}</p>
                              <p className="text-xs text-gray-500">{s.document}</p>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </>
                )}
                <p className="text-xs text-gray-500">
                  Não encontrou?{' '}
                  <Link href="/dashboard/suppliers/new" className="text-blue-600 hover:underline">
                    Cadastre um novo fornecedor
                  </Link>
                </p>
              </div>

              {!branchesLoading && branches.length > 1 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Filial *</label>
                  <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
                    <option value="">Selecione a filial</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {!branchesLoading && branches.length === 0 && (
                <p className="text-sm text-red-600">
                  Nenhuma filial ativa encontrada. Cadastre uma filial antes de criar um pedido.
                </p>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">Previsão de Entrega</label>
                <Input
                  type="date"
                  value={expectedDelivery}
                  onChange={(e) => setExpectedDelivery(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Observações</label>
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  placeholder="Observações sobre o pedido"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Itens do Pedido</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {items.map((row, index) => (
                <div key={row.key} className="grid gap-3 md:grid-cols-[1fr_120px_140px_40px] items-start border-b pb-4 last:border-b-0 last:pb-0">
                  <div className="relative">
                    <label className="text-xs font-medium text-gray-500 md:hidden">Produto</label>
                    <Input
                      placeholder="Buscar produto por nome ou SKU..."
                      value={row.search}
                      onChange={(e) => {
                        updateItem(row.key, { productId: '', productLabel: '' });
                        searchProducts(row.key, e.target.value);
                      }}
                      onFocus={() => updateItem(row.key, { showResults: true })}
                    />
                    {row.showResults && row.search.trim() && !row.productId && (
                      <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg max-h-56 overflow-auto">
                        {row.searching ? (
                          <div className="p-3 text-sm text-gray-500">Buscando...</div>
                        ) : row.results.length === 0 ? (
                          <div className="p-3 text-sm text-gray-500">Nenhum produto encontrado</div>
                        ) : (
                          row.results.map((p) => (
                            <button
                              type="button"
                              key={p.id}
                              className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                              onClick={() => selectProduct(row.key, p)}
                            >
                              <p className="font-medium">{p.name}</p>
                              <p className="text-xs text-gray-500">SKU: {p.sku}</p>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 md:hidden">Quantidade</label>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Qtd"
                      value={row.quantity}
                      onChange={(e) => updateItem(row.key, { quantity: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 md:hidden">Custo Unit.</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Custo unit."
                      value={row.unitCost}
                      onChange={(e) => updateItem(row.key, { unitCost: e.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={items.length === 1}
                    onClick={() => removeRow(row.key)}
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              ))}

              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-4 w-4 mr-2" />
                Adicionar Item
              </Button>

              <div className="flex justify-end border-t pt-4">
                <p className="text-lg font-semibold">
                  Total: {formatCurrency(total)}
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Link href="/dashboard/purchases">
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </Link>
            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Salvando...' : 'Salvar Pedido'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
