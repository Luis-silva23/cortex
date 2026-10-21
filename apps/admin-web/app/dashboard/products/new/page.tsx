'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Save, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { buildProductCreatePayload } from '@/lib/cadastros';

export default function NewProductPage() {
  const router = useRouter();
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
    minStock: '',
    maxStock: '',
    unit: 'UN',
    categoryId: '',
  });

  useEffect(() => {
    loadCategories();
  }, []);

  const loadCategories = async () => {
    try {
      const data = await api.getCategories();
      setCategories(data);
    } catch (error) {
      console.error('Erro ao carregar categorias:', error);
    }
  };

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      // ACHADO DE AUDITORIA: sem categoria escolhida o formulário mandava
      // `categoryId: ''`; o schema aceita string vazia e o Prisma gravava ''
      // violando a FK de Category (400). O payload agora omite o campo vazio.
      await api.createProduct(buildProductCreatePayload(formData));
      alert('Produto criado com sucesso!');
      router.push('/dashboard/products');
    } catch (error) {
      console.error('Erro ao criar produto:', error);
      // A API responde {error} OU {message}; o texto genérico escondia motivos
      // como SKU duplicado.
      alert(getApiErrorMessage(error, 'Erro ao criar produto'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/products">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Novo Produto</h1>
          <p className="text-gray-500 mt-1">Cadastre um novo produto</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="space-y-6">
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle>Informações Básicas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Nome *</label>
                <Input
                  required
                  placeholder="Nome do produto"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">SKU *</label>
                  <Input
                    required
                    placeholder="SKU-001"
                    value={formData.sku}
                    onChange={(e) => handleChange('sku', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Código de Barras</label>
                  <Input
                    placeholder="7891234567890"
                    value={formData.barcode}
                    onChange={(e) => handleChange('barcode', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Unidade</label>
                  <select
                    className="w-full px-3 py-2 border rounded-md"
                    value={formData.unit}
                    onChange={(e) => handleChange('unit', e.target.value)}
                  >
                    <option value="UN">Unidade</option>
                    <option value="KG">Quilograma</option>
                    <option value="L">Litro</option>
                    <option value="M">Metro</option>
                    <option value="CX">Caixa</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Descrição</label>
                <textarea
                  className="w-full px-3 py-2 border rounded-md"
                  rows={3}
                  placeholder="Descrição detalhada do produto"
                  value={formData.description}
                  onChange={(e) => handleChange('description', e.target.value)}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Marca</label>
                  <Input
                    placeholder="Ex: Honda, NGK, Fras-le"
                    value={formData.brand}
                    onChange={(e) => handleChange('brand', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Aplicação</label>
                  <Input
                    placeholder="Ex: CG 160 2016-2022, Titan 160"
                    value={formData.application}
                    onChange={(e) => handleChange('application', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Localização</label>
                  <Input
                    placeholder="Ex: Corredor 3, Prateleira B"
                    value={formData.location}
                    onChange={(e) => handleChange('location', e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Categoria</label>
                <select
                  className="w-full px-3 py-2 border rounded-md"
                  value={formData.categoryId}
                  onChange={(e) => handleChange('categoryId', e.target.value)}
                >
                  <option value="">Selecione uma categoria</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Pricing */}
          <Card>
            <CardHeader>
              <CardTitle>Preços</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Preço de Custo *</label>
                  <Input
                    required
                    type="number"
                    step="0.01"
                    placeholder="0,00"
                    value={formData.costPrice}
                    onChange={(e) => handleChange('costPrice', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Preço de Venda *</label>
                  <Input
                    required
                    type="number"
                    step="0.01"
                    placeholder="0,00"
                    value={formData.salePrice}
                    onChange={(e) => handleChange('salePrice', e.target.value)}
                  />
                </div>
              </div>

              {formData.costPrice && formData.salePrice && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm font-medium text-blue-900">
                    Margem de Lucro:{' '}
                    {(
                      ((parseFloat(formData.salePrice) - parseFloat(formData.costPrice)) /
                        parseFloat(formData.costPrice)) *
                      100
                    ).toFixed(2)}
                    %
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stock */}
          <Card>
            <CardHeader>
              <CardTitle>Estoque</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Estoque Mínimo</label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={formData.minStock}
                    onChange={(e) => handleChange('minStock', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Estoque Máximo</label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={formData.maxStock}
                    onChange={(e) => handleChange('maxStock', e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Link href="/dashboard/products">
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </Link>
            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Salvando...' : 'Salvar Produto'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
