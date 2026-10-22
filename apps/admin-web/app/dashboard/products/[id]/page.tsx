'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import BarcodesCard from '@/components/products/BarcodesCard';
import ImageCard from '@/components/products/ImageCard';
import {
  buildProductUpdatePayload,
  numberToInput,
  statusFromIsActive,
} from '@/lib/cadastros';

export default function EditProductPage() {
  const params = useParams() as { id: string };
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    name: '',
    sku: '',
    barcode: '',
    description: '',
    brand: '',
    application: '',
    location: '',
    costPrice: '',
    salePrice: '',
    minStock: '0',
    maxStock: '0',
    unit: 'UN',
    categoryId: '',
    status: 'ACTIVE',
  });

  useEffect(() => {
    loadData();
  }, [params.id]);

  const loadData = async () => {
    try {
      const [product, cats] = await Promise.all([
        api.getProduct(params.id),
        api.getCategories(),
      ]);

      setFormData({
        name: product.name,
        sku: product.sku,
        barcode: product.barcode || '',
        description: product.description || '',
        brand: product.brand || '',
        application: product.application || '',
        location: product.location || '',
        costPrice: numberToInput(product.costPrice),
        salePrice: numberToInput(product.salePrice),
        minStock: numberToInput(product.minStock) || '0',
        // ACHADO DE AUDITORIA: maxStock é Int? no banco; `.toString()` direto
        // estourava TypeError ao abrir qualquer produto sem estoque máximo.
        maxStock: numberToInput(product.maxStock),
        unit: product.unit,
        categoryId: product.categoryId || '',
        // O produto não tem `status`: o campo real é o boolean `isActive`
        // (ler `product.status` deixava o select sempre vazio/errado).
        status: statusFromIsActive(product.isActive),
      });
      setCategories(cats);
    } catch (error) {
      console.error('Erro ao carregar produto:', error);
      alert('Erro ao carregar produto');
      router.push('/dashboard/products');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      // O payload converte o select de status em `isActive` e manda
      // `categoryId: null` para remover a categoria (contrato do PUT /products/:id).
      await api.updateProduct(params.id, buildProductUpdatePayload(formData));
      router.push('/dashboard/products');
    } catch (error) {
      // A API responde {error} OU {message}; ler só `.message` mostrava sempre
      // o texto genérico nas rotas que usam {error}.
      alert(getApiErrorMessage(error, 'Erro ao atualizar produto'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Deseja realmente excluir este produto?')) return;

    try {
      await api.deleteProduct(params.id);
      router.push('/dashboard/products');
    } catch (error) {
      alert(getApiErrorMessage(error, 'Erro ao excluir produto'));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full">Carregando...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/products">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold">Editar Produto</h1>
            <p className="text-gray-500 mt-1">{formData.name}</p>
          </div>
        </div>
        <Button variant="destructive" onClick={handleDelete}>
          <Trash2 className="w-4 h-4 mr-2" />
          Excluir
        </Button>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Informações Básicas</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Nome *</label>
                  <Input
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">SKU *</label>
                    <Input
                      name="sku"
                      value={formData.sku}
                      onChange={handleChange}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Código de Barras</label>
                    <Input
                      name="barcode"
                      value={formData.barcode}
                      onChange={handleChange}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Descrição</label>
                  <textarea
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    rows={3}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Marca</label>
                    <Input
                      name="brand"
                      placeholder="Ex: Honda, NGK, Fras-le"
                      value={formData.brand}
                      onChange={handleChange}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Aplicação</label>
                    <Input
                      name="application"
                      placeholder="Ex: CG 160 2016-2022, Titan 160"
                      value={formData.application}
                      onChange={handleChange}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Localização</label>
                  <Input
                    name="location"
                    placeholder="Ex: Corredor 3, Prateleira B"
                    value={formData.location}
                    onChange={handleChange}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Preços</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Preço de Custo *</label>
                    <Input
                      name="costPrice"
                      type="number"
                      step="0.01"
                      value={formData.costPrice}
                      onChange={handleChange}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Preço de Venda *</label>
                    <Input
                      name="salePrice"
                      type="number"
                      step="0.01"
                      value={formData.salePrice}
                      onChange={handleChange}
                      required
                    />
                  </div>
                </div>
                {formData.costPrice && formData.salePrice && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <p className="text-sm font-medium text-blue-900">
                      Margem de Lucro: {' '}
                      {(((parseFloat(formData.salePrice) - parseFloat(formData.costPrice)) / parseFloat(formData.salePrice)) * 100).toFixed(2)}%
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
              </CardHeader>
              <CardContent>
                <select
                  name="status"
                  value={formData.status}
                  onChange={handleChange}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="ACTIVE">Ativo</option>
                  <option value="INACTIVE">Inativo</option>
                </select>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Categoria</CardTitle>
              </CardHeader>
              <CardContent>
                <select
                  name="categoryId"
                  value={formData.categoryId}
                  onChange={handleChange}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Sem categoria</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Estoque</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Estoque Mínimo</label>
                  {/* minStock/maxStock são colunas Int: step 0.01 deixava digitar
                      fração que o banco rejeitaria. */}
                  <Input
                    name="minStock"
                    type="number"
                    step="1"
                    min="0"
                    value={formData.minStock}
                    onChange={handleChange}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Estoque Máximo</label>
                  <Input
                    name="maxStock"
                    type="number"
                    step="1"
                    min="0"
                    placeholder="Sem máximo"
                    value={formData.maxStock}
                    onChange={handleChange}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Unidade</label>
                  <select
                    name="unit"
                    value={formData.unit}
                    onChange={handleChange}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="UN">Unidade</option>
                    <option value="KG">Quilograma</option>
                    <option value="L">Litro</option>
                    <option value="M">Metro</option>
                    <option value="CX">Caixa</option>
                    <option value="PC">Peça</option>
                  </select>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2">
              <Link href="/dashboard/products" className="flex-1">
                <Button type="button" variant="outline" className="w-full">
                  Cancelar
                </Button>
              </Link>
              <Button type="submit" disabled={saving} className="flex-1">
                <Save className="w-4 h-4 mr-2" />
                {saving ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        </div>
      </form>
      <BarcodesCard productId={params.id} onChanged={loadData} />
      <ImageCard productId={params.id} />
    </div>
  );
}
